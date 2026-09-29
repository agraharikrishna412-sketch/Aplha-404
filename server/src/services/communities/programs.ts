/**
 * Scheduled and structured community activity: announcements, challenges, study plans, events and
 * study rooms.
 *
 * A shared rule runs through all of them: **progress is per-student and never written on their
 * behalf.** §24 is explicit that completion must not be falsely marked, so nothing in this file
 * infers progress from time passing — a day is complete only when that student says so, and the
 * record is theirs alone (an admin can create the plan but cannot complete somebody else's task).
 */
import { all, bool, nowIso, one, run, uuid } from '../../db/index.js';
import { HttpError } from '../../middleware/errors.js';
import { addContribution, assertCanPost, recordModeration } from './communities.js';
import { loadForMember } from './access.js';
import { publishCommunity } from './bus.js';
import { createNotification, notifyCommunityMembers } from './notifications.js';
import { assertCan, type CommunityRole } from './permissions.js';
import {
  EVENT_KINDS,
  type AnnouncementView,
  type ChallengeDay,
  type ChallengeView,
  type EventKind,
  type EventView,
  type StudyPlanView,
  type StudyRoomView,
} from './types.js';

function isModerator(role: CommunityRole | null): boolean {
  return role === 'owner' || role === 'admin' || role === 'moderator';
}

/* ------------------------------------------------------------------ announcements ---------------- */

export async function createAnnouncement(
  userId: string,
  communityId: string,
  args: { title: string; body: string; isPinned?: boolean; expiresAt?: string | null },
): Promise<AnnouncementView> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCan(membership?.role ?? null, 'create_announcement');

  const title = (args.title ?? '').trim().slice(0, 160);
  const body = (args.body ?? '').trim().slice(0, 4000);
  if (title.length < 3) throw new HttpError(400, 'Give the announcement a title.', 'validation_error');
  if (body.length < 3) throw new HttpError(400, 'Write the announcement.', 'validation_error');

  const id = uuid();
  const now = nowIso();
  await run(
    `INSERT INTO community_announcements (id, community_id, title, body, is_pinned, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      communityId,
      title,
      body,
      args.isPinned === false ? 0 : 1,
      args.expiresAt ? new Date(args.expiresAt).toISOString() : null,
      userId,
      now,
    ],
  );

  // Announcements are one of the few things worth notifying every member about, and the fan-out
  // dedupes so two similar announcements do not double-notify.
  await notifyCommunityMembers({
    communityId,
    kind: 'announcement',
    title: `📣 ${title}`,
    body: body.slice(0, 140),
    link: `/communities/${communityId}?tab=home`,
    excludeUserId: userId,
  });

  publishCommunity(communityId, { type: 'announcement', communityId, announcementId: id });

  const community = await one<{ name: string }>(`SELECT name FROM communities WHERE id = ?`, [communityId]);
  const author = await one<{ name: string }>(`SELECT name FROM users WHERE id = ?`, [userId]);
  return {
    id,
    communityId,
    title,
    body,
    isPinned: args.isPinned !== false,
    expiresAt: args.expiresAt ?? null,
    createdBy: userId,
    authorName: author?.name ?? community?.name ?? 'A Vroqn student',
    createdAt: now,
    isExpired: false,
  };
}

export async function listAnnouncements(
  userId: string,
  communityId: string,
  limit = 30,
): Promise<AnnouncementView[]> {
  await loadForMember(userId, communityId, { requireMembership: true });
  const rows = await all<{
    id: string;
    title: string;
    body: string;
    is_pinned: number | null;
    expires_at: string | null;
    created_by: string;
    author_name: string | null;
    created_at: string;
  }>(
    `SELECT a.id, a.title, a.body, a.is_pinned, a.expires_at, a.created_by, u.name AS author_name, a.created_at
       FROM community_announcements a LEFT JOIN users u ON u.id = a.created_by
      WHERE a.community_id = ?
      ORDER BY a.is_pinned DESC, a.created_at DESC
      LIMIT ?`,
    [communityId, Math.min(Math.max(limit, 1), 60)],
  );
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    communityId,
    title: row.title,
    body: row.body,
    isPinned: bool(row.is_pinned),
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    authorName: row.author_name ?? 'A Vroqn student',
    createdAt: row.created_at,
    isExpired: Boolean(row.expires_at && new Date(row.expires_at).getTime() < now),
  }));
}

export async function deleteAnnouncement(
  userId: string,
  communityId: string,
  announcementId: string,
): Promise<void> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  const row = await one<{ created_by: string }>(
    `SELECT created_by FROM community_announcements WHERE id = ? AND community_id = ?`,
    [announcementId, communityId],
  );
  if (!row) throw new HttpError(404, 'That announcement no longer exists.', 'not_found');
  if (row.created_by !== userId && !isModerator(membership!.role)) {
    throw new HttpError(403, 'Only a moderator can remove this announcement.', 'forbidden');
  }
  await run(`DELETE FROM community_announcements WHERE id = ?`, [announcementId]);
  publishCommunity(communityId, { type: 'announcement', communityId, announcementId });
}

/* ------------------------------------------------------------------ challenges ------------------ */

function parseDays(raw: string): ChallengeDay[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry, index) => ({
        index: typeof entry?.index === 'number' ? entry.index : index + 1,
        title: String(entry?.title ?? '').slice(0, 140),
        description: String(entry?.description ?? '').slice(0, 600),
      }))
      .filter((day) => day.title.length > 0)
      .slice(0, 60);
  } catch {
    return [];
  }
}

export async function createChallenge(
  userId: string,
  communityId: string,
  args: {
    title: string;
    description?: string;
    subject?: string | null;
    startsAt: string;
    endsAt: string;
    days: { title: string; description?: string }[];
  },
): Promise<ChallengeView> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCan(membership?.role ?? null, 'create_challenge');

  const title = (args.title ?? '').trim().slice(0, 160);
  if (title.length < 3) throw new HttpError(400, 'Give the challenge a title.', 'validation_error');

  const days = (args.days ?? [])
    .map((day, index) => ({
      index: index + 1,
      title: String(day.title ?? '').trim().slice(0, 140),
      description: String(day.description ?? '').trim().slice(0, 600),
    }))
    .filter((day) => day.title.length > 0)
    .slice(0, 60);
  if (days.length < 1) throw new HttpError(400, 'Add at least one day to the challenge.', 'validation_error');

  const startsAt = new Date(args.startsAt);
  const endsAt = new Date(args.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new HttpError(400, 'Choose valid start and end dates.', 'validation_error');
  }
  if (endsAt <= startsAt) throw new HttpError(400, 'The end date must be after the start date.', 'validation_error');

  const id = uuid();
  await run(
    `INSERT INTO community_challenges
       (id, community_id, title, description, subject, days, status, starts_at, ends_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    [
      id,
      communityId,
      title,
      (args.description ?? '').trim().slice(0, 1500),
      args.subject?.slice(0, 60) ?? null,
      JSON.stringify(days),
      startsAt.toISOString(),
      endsAt.toISOString(),
      userId,
      nowIso(),
    ],
  );

  await notifyCommunityMembers({
    communityId,
    kind: 'challenge',
    title: `🏆 New challenge: ${title}`,
    body: `${days.length} day${days.length === 1 ? '' : 's'} of focused practice.`,
    link: `/communities/${communityId}?tab=challenges`,
    excludeUserId: userId,
  });
  publishCommunity(communityId, { type: 'challenge', communityId, challengeId: id });

  return (await challengeView(userId, communityId, id))!;
}

async function challengeView(
  userId: string,
  communityId: string,
  challengeId: string,
): Promise<ChallengeView | null> {
  const row = await one<{
    id: string;
    title: string;
    description: string;
    subject: string | null;
    days: string;
    status: string;
    starts_at: string;
    ends_at: string;
    created_by: string;
    created_at: string;
  }>(
    `SELECT id, title, description, subject, days, status, starts_at, ends_at, created_by, created_at
       FROM community_challenges WHERE id = ? AND community_id = ?`,
    [challengeId, communityId],
  );
  if (!row) return null;

  const days = parseDays(row.days);
  const [participants, mine] = await Promise.all([
    one<{ count: number }>(
      `SELECT COUNT(DISTINCT user_id) AS count FROM challenge_progress WHERE challenge_id = ?`,
      [challengeId],
    ),
    all<{ day_index: number }>(
      `SELECT day_index FROM challenge_progress WHERE challenge_id = ? AND user_id = ?`,
      [challengeId, userId],
    ),
  ]);

  const completedDays = mine.map((entry) => entry.day_index).sort((a, b) => a - b);
  return {
    id: row.id,
    communityId,
    title: row.title,
    description: row.description,
    subject: row.subject,
    days,
    status: row.status === 'active' ? 'active' : row.status === 'draft' ? 'draft' : 'ended',
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    participantCount: participants?.count ?? 0,
    completedDays,
    progressPercent: days.length ? Math.round((completedDays.length / days.length) * 100) : 0,
    isJoined: completedDays.length > 0,
    isMine: row.created_by === userId,
    canDelete: row.created_by === userId || false,
  };
}

export async function listChallenges(userId: string, communityId: string): Promise<ChallengeView[]> {
  await loadForMember(userId, communityId, { requireMembership: true });
  const rows = await all<{ id: string }>(
    `SELECT id FROM community_challenges WHERE community_id = ?
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, starts_at DESC
      LIMIT 40`,
    [communityId],
  );
  const views = await Promise.all(rows.map((row) => challengeView(userId, communityId, row.id)));
  return views.filter((view): view is ChallengeView => view !== null);
}

/**
 * Mark one day of a challenge complete — for the calling student only.
 *
 * There is no "mark for someone else" path by design, and completing a day twice is a no-op rather
 * than an error so a flaky connection retrying does not look like a failure.
 */
export async function setChallengeDay(
  userId: string,
  communityId: string,
  challengeId: string,
  dayIndex: number,
  done: boolean,
  note = '',
): Promise<ChallengeView> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCanPost(membership);

  const challenge = await challengeView(userId, communityId, challengeId);
  if (!challenge) throw new HttpError(404, 'That challenge no longer exists.', 'not_found');
  if (!challenge.days.some((day) => day.index === dayIndex)) {
    throw new HttpError(400, 'That day is not part of this challenge.', 'validation_error');
  }

  const existing = await one<{ id: string }>(
    `SELECT id FROM challenge_progress WHERE challenge_id = ? AND user_id = ? AND day_index = ?`,
    [challengeId, userId, dayIndex],
  );

  if (done && !existing) {
    await run(
      `INSERT INTO challenge_progress (id, challenge_id, community_id, user_id, day_index, status, note, completed_at)
       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`,
      [uuid(), challengeId, communityId, userId, dayIndex, note.slice(0, 300), nowIso()],
    );
    await addContribution(communityId, userId, 4);
    // Finishing the whole challenge is worth a badge; the badge is derived from this data, never
    // granted by hand (§26).
    if (challenge.completedDays.length + 1 >= challenge.days.length) {
      const { grantChallengesCompleted } = await import('./reputation.js');
      await grantChallengesCompleted(userId, communityId);
    }
  } else if (!done && existing) {
    await run(`DELETE FROM challenge_progress WHERE id = ?`, [existing.id]);
    await addContribution(communityId, userId, -4);
  }

  publishCommunity(communityId, { type: 'challenge', communityId, challengeId });
  return (await challengeView(userId, communityId, challengeId))!;
}

export async function deleteChallenge(
  userId: string,
  communityId: string,
  challengeId: string,
): Promise<void> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  const row = await one<{ created_by: string }>(
    `SELECT created_by FROM community_challenges WHERE id = ? AND community_id = ?`,
    [challengeId, communityId],
  );
  if (!row) throw new HttpError(404, 'That challenge no longer exists.', 'not_found');
  if (row.created_by !== userId && !isModerator(membership!.role)) {
    throw new HttpError(403, 'Only the creator or a moderator can remove this challenge.', 'forbidden');
  }

  await run(`DELETE FROM challenge_progress WHERE challenge_id = ?`, [challengeId]);
  await run(`DELETE FROM community_challenges WHERE id = ?`, [challengeId]);
  await recordModeration(communityId, userId, 'challenge_deleted', 'challenge', challengeId, '');
  publishCommunity(communityId, { type: 'challenge', communityId, challengeId });
}

/* ------------------------------------------------------------------ study plans ----------------- */

export async function createStudyPlan(
  userId: string,
  communityId: string,
  args: {
    title: string;
    description?: string;
    subject?: string | null;
    tasks: { dayIndex: number; title: string; description?: string }[];
  },
): Promise<StudyPlanView> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCan(membership?.role ?? null, 'create_study_plan');

  const title = (args.title ?? '').trim().slice(0, 160);
  if (title.length < 3) throw new HttpError(400, 'Give the plan a title.', 'validation_error');

  const tasks = (args.tasks ?? [])
    .map((task, index) => ({
      dayIndex: Number.isFinite(task.dayIndex) ? Math.max(1, Math.floor(task.dayIndex)) : index + 1,
      title: String(task.title ?? '').trim().slice(0, 160),
      description: String(task.description ?? '').trim().slice(0, 800),
    }))
    .filter((task) => task.title.length > 0)
    .slice(0, 200);
  if (!tasks.length) throw new HttpError(400, 'Add at least one task to the plan.', 'validation_error');

  const id = uuid();
  const now = nowIso();
  await run(
    `INSERT INTO study_plans (id, community_id, title, description, subject, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      communityId,
      title,
      (args.description ?? '').trim().slice(0, 1200),
      args.subject?.slice(0, 60) ?? null,
      userId,
      now,
      now,
    ],
  );

  let position = 0;
  for (const task of tasks) {
    await run(
      `INSERT INTO study_plan_tasks (id, plan_id, day_index, title, description, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), id, task.dayIndex, task.title, task.description, position, now],
    );
    position += 1;
  }

  await notifyCommunityMembers({
    communityId,
    kind: 'study_plan',
    title: `📚 New study plan: ${title}`,
    body: `${tasks.length} tasks. Track your own progress as you go.`,
    link: `/communities/${communityId}?tab=plans`,
    excludeUserId: userId,
  });

  return (await studyPlanView(userId, communityId, id))!;
}

async function studyPlanView(
  userId: string,
  communityId: string,
  planId: string,
): Promise<StudyPlanView | null> {
  const row = await one<{
    id: string;
    title: string;
    description: string;
    subject: string | null;
    created_by: string;
    author_name: string | null;
    created_at: string;
  }>(
    `SELECT p.id, p.title, p.description, p.subject, p.created_by, p.created_at,
            u.name AS author_name
       FROM study_plans p
       LEFT JOIN users u ON u.id = p.created_by
      WHERE p.id = ? AND p.community_id = ?`,
    [planId, communityId],
  );
  if (!row) return null;

  const [tasks, progress] = await Promise.all([
    all<{ id: string; day_index: number; title: string; description: string; position: number }>(
      `SELECT id, day_index, title, description, position FROM study_plan_tasks
        WHERE plan_id = ? ORDER BY day_index, position`,
      [planId],
    ),
    all<{ task_id: string }>(
      `SELECT task_id FROM study_plan_progress WHERE plan_id = ? AND user_id = ?`,
      [planId, userId],
    ),
  ]);

  const done = new Set(progress.map((entry) => entry.task_id));
  return {
    id: row.id,
    communityId,
    title: row.title,
    description: row.description,
    subject: row.subject,
    createdBy: row.created_by,
    authorName: (row.author_name ?? '').trim() || 'A community member',
    createdAt: row.created_at,
    tasks: tasks.map((task) => ({
      id: task.id,
      dayIndex: task.day_index,
      title: task.title,
      description: task.description,
      position: task.position,
      done: done.has(task.id),
    })),
    doneCount: done.size,
    totalCount: tasks.length,
    percent: tasks.length ? Math.round((done.size / tasks.length) * 100) : 0,
    isMine: row.created_by === userId,
    canDelete: row.created_by === userId || false,
  };
}

export async function listStudyPlans(userId: string, communityId: string): Promise<StudyPlanView[]> {
  await loadForMember(userId, communityId, { requireMembership: true });
  const rows = await all<{ id: string }>(
    `SELECT id FROM study_plans WHERE community_id = ? ORDER BY created_at DESC LIMIT 40`,
    [communityId],
  );
  const views = await Promise.all(rows.map((row) => studyPlanView(userId, communityId, row.id)));
  return views.filter((view): view is StudyPlanView => view !== null);
}

export async function setStudyPlanTask(
  userId: string,
  communityId: string,
  planId: string,
  taskId: string,
  done: boolean,
): Promise<StudyPlanView> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCanPost(membership);

  const task = await one<{ id: string }>(
    `SELECT t.id FROM study_plan_tasks t JOIN study_plans p ON p.id = t.plan_id
      WHERE t.id = ? AND p.id = ? AND p.community_id = ?`,
    [taskId, planId, communityId],
  );
  if (!task) throw new HttpError(404, 'That task no longer exists.', 'not_found');

  const existing = await one<{ id: string }>(
    `SELECT id FROM study_plan_progress WHERE task_id = ? AND user_id = ?`,
    [taskId, userId],
  );

  if (done && !existing) {
    await run(
      `INSERT INTO study_plan_progress (id, plan_id, task_id, user_id, status, completed_at)
       VALUES (?, ?, ?, ?, 'done', ?)`,
      [uuid(), planId, taskId, userId, nowIso()],
    );
    await addContribution(communityId, userId, 2);
  } else if (!done && existing) {
    await run(`DELETE FROM study_plan_progress WHERE id = ?`, [existing.id]);
    await addContribution(communityId, userId, -2);
  }

  return (await studyPlanView(userId, communityId, planId))!;
}

export async function deleteStudyPlan(
  userId: string,
  communityId: string,
  planId: string,
): Promise<void> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  const row = await one<{ created_by: string }>(
    `SELECT created_by FROM study_plans WHERE id = ? AND community_id = ?`,
    [planId, communityId],
  );
  if (!row) throw new HttpError(404, 'That study plan no longer exists.', 'not_found');
  if (row.created_by !== userId && !isModerator(membership!.role)) {
    throw new HttpError(403, 'Only the creator or a moderator can remove this plan.', 'forbidden');
  }

  await run(`DELETE FROM study_plan_progress WHERE plan_id = ?`, [planId]);
  await run(`DELETE FROM study_plan_tasks WHERE plan_id = ?`, [planId]);
  await run(`DELETE FROM study_plans WHERE id = ?`, [planId]);
  recordModeration(communityId, userId, 'study_plan_deleted', 'study_plan', planId, '');
}

/* ------------------------------------------------------------------ events ---------------------- */

export async function createEvent(
  userId: string,
  communityId: string,
  args: {
    title: string;
    description?: string;
    kind?: string;
    startsAt: string;
    endsAt: string;
    meetingUrl?: string | null;
    participantLimit?: number | null;
  },
): Promise<EventView> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCan(membership?.role ?? null, 'create_event');

  const title = (args.title ?? '').trim().slice(0, 160);
  if (title.length < 3) throw new HttpError(400, 'Give the event a title.', 'validation_error');

  const startsAt = new Date(args.startsAt);
  const endsAt = new Date(args.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new HttpError(400, 'Choose valid start and end times.', 'validation_error');
  }
  if (endsAt <= startsAt) throw new HttpError(400, 'The event must end after it starts.', 'validation_error');

  /*
   * An event that has already finished cannot be announced to anybody — it would send every member a
   * notification for something they have missed, and the "coming up" lists would show a date in the
   * past. A short grace window is allowed so a session that is starting right now can still be posted.
   */
  const graceMs = 30 * 60_000;
  if (startsAt.getTime() + graceMs < Date.now()) {
    throw new HttpError(400, 'Choose a start time in the future — students cannot attend an event that has already passed.', 'validation_error');
  }

  let meetingUrl: string | null = null;
  if (args.meetingUrl?.trim()) {
    const candidate = args.meetingUrl.trim().slice(0, 500);
    if (!/^https?:\/\//i.test(candidate)) {
      throw new HttpError(400, 'Meeting links must start with http:// or https://', 'validation_error');
    }
    meetingUrl = candidate;
  }

  const kind: EventKind = (EVENT_KINDS as readonly string[]).includes(args.kind ?? '')
    ? (args.kind as EventKind)
    : 'study_session';

  const id = uuid();
  await run(
    `INSERT INTO community_events
       (id, community_id, title, description, kind, starts_at, ends_at, host_id, meeting_url, participant_limit, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      communityId,
      title,
      (args.description ?? '').trim().slice(0, 1500),
      kind,
      startsAt.toISOString(),
      endsAt.toISOString(),
      userId,
      meetingUrl,
      args.participantLimit && args.participantLimit > 0 ? Math.min(args.participantLimit, 10000) : null,
      nowIso(),
    ],
  );

  await notifyCommunityMembers({
    communityId,
    kind: 'event',
    title: `📅 ${title}`,
    body: `Starts ${startsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    link: `/communities/${communityId}?tab=events`,
    excludeUserId: userId,
  });
  publishCommunity(communityId, { type: 'event', communityId, eventId: id });

  return (await eventView(userId, communityId, id))!;
}

async function eventView(
  userId: string,
  communityId: string,
  eventId: string,
): Promise<EventView | null> {
  const row = await one<{
    id: string;
    title: string;
    description: string;
    kind: string;
    starts_at: string;
    ends_at: string;
    host_id: string;
    host_name: string | null;
    meeting_url: string | null;
    participant_limit: number | null;
  }>(
    `SELECT e.id, e.title, e.description, e.kind, e.starts_at, e.ends_at, e.host_id, u.name AS host_name,
            e.meeting_url, e.participant_limit
       FROM community_events e LEFT JOIN users u ON u.id = e.host_id
      WHERE e.id = ? AND e.community_id = ?`,
    [eventId, communityId],
  );
  if (!row) return null;

  const [count, mine] = await Promise.all([
    one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM event_participants WHERE event_id = ? AND status = 'going'`,
      [eventId],
    ),
    one<{ id: string }>(`SELECT id FROM event_participants WHERE event_id = ? AND user_id = ?`, [
      eventId,
      userId,
    ]),
  ]);

  return {
    id: row.id,
    communityId,
    title: row.title,
    description: row.description,
    kind: (EVENT_KINDS as readonly string[]).includes(row.kind) ? (row.kind as EventKind) : 'study_session',
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    hostId: row.host_id,
    hostName: row.host_name ?? 'A Vroqn student',
    meetingUrl: row.meeting_url,
    participantLimit: row.participant_limit,
    participantCount: count?.count ?? 0,
    isGoing: Boolean(mine),
    isPast: new Date(row.ends_at).getTime() < Date.now(),
    isMine: row.host_id === userId,
    canDelete: row.host_id === userId || false,
  };
}

export async function listEvents(
  userId: string,
  communityId: string,
  options: { includePast?: boolean; limit?: number } = {},
): Promise<EventView[]> {
  await loadForMember(userId, communityId, { requireMembership: true });
  const rows = await all<{ id: string }>(
    `SELECT id FROM community_events
      WHERE community_id = ?${options.includePast ? '' : ' AND ends_at >= ?'}
      ORDER BY starts_at ${options.includePast ? 'DESC' : 'ASC'}
      LIMIT ?`,
    options.includePast
      ? [communityId, Math.min(Math.max(options.limit ?? 40, 1), 100)]
      : [communityId, nowIso(), Math.min(Math.max(options.limit ?? 40, 1), 100)],
  );
  const views = await Promise.all(rows.map((row) => eventView(userId, communityId, row.id)));
  return views.filter((view): view is EventView => view !== null);
}

export async function setEventRsvp(
  userId: string,
  communityId: string,
  eventId: string,
  going: boolean,
): Promise<EventView> {
  await loadForMember(userId, communityId, { requireMembership: true });

  const event = await eventView(userId, communityId, eventId);
  if (!event) throw new HttpError(404, 'That event no longer exists.', 'not_found');

  if (going && event.participantLimit && event.participantCount >= event.participantLimit && !event.isGoing) {
    throw new HttpError(409, 'This event has reached its participant limit.', 'event_full');
  }

  const existing = await one<{ id: string }>(
    `SELECT id FROM event_participants WHERE event_id = ? AND user_id = ?`,
    [eventId, userId],
  );
  if (going && !existing) {
    await run(
      `INSERT INTO event_participants (id, event_id, community_id, user_id, status, created_at)
       VALUES (?, ?, ?, ?, 'going', ?)`,
      [uuid(), eventId, communityId, userId, nowIso()],
    );
  } else if (!going && existing) {
    await run(`DELETE FROM event_participants WHERE id = ?`, [existing.id]);
  }

  publishCommunity(communityId, { type: 'event', communityId, eventId });
  return (await eventView(userId, communityId, eventId))!;
}

export async function deleteEvent(userId: string, communityId: string, eventId: string): Promise<void> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  const row = await one<{ host_id: string }>(
    `SELECT host_id FROM community_events WHERE id = ? AND community_id = ?`,
    [eventId, communityId],
  );
  if (!row) throw new HttpError(404, 'That event no longer exists.', 'not_found');
  if (row.host_id !== userId && !isModerator(membership!.role)) {
    throw new HttpError(403, 'Only the host or a moderator can cancel this event.', 'forbidden');
  }

  // Tell the people who signed up, otherwise they would simply not show up.
  const attendees = await all<{ user_id: string }>(
    `SELECT user_id FROM event_participants WHERE event_id = ?`,
    [eventId],
  );
  for (const attendee of attendees) {
    if (attendee.user_id === userId) continue;
    await createNotification({
      userId: attendee.user_id,
      communityId,
      kind: 'event',
      title: 'An event you signed up for was cancelled',
      body: 'The host removed it from the community calendar.',
      link: `/communities/${communityId}?tab=events`,
    });
  }

  await run(`DELETE FROM event_participants WHERE event_id = ?`, [eventId]);
  await run(`DELETE FROM community_events WHERE id = ?`, [eventId]);
  publishCommunity(communityId, { type: 'event', communityId, eventId });
}

/* ------------------------------------------------------------------ study rooms ----------------- */

const DEFAULT_CHECKLIST = ['Set a goal for this session', 'Work with the timer on', 'Note what to review next'];

export async function createStudyRoom(
  userId: string,
  communityId: string,
  args: {
    title: string;
    topic?: string;
    goal?: string;
    startsAt: string;
    endsAt: string;
    checklist?: string[];
  },
): Promise<StudyRoomView> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCan(membership?.role ?? null, 'create_event');

  const title = (args.title ?? '').trim().slice(0, 160);
  if (title.length < 3) throw new HttpError(400, 'Give the study room a title.', 'validation_error');

  const startsAt = new Date(args.startsAt);
  const endsAt = new Date(args.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    throw new HttpError(400, 'Choose a valid start and end time.', 'validation_error');
  }

  const id = uuid();
  /*
   * The checklist the host typed is the room's own list — it is stored on the room so every joiner
   * receives exactly the same tasks. Without this the host's checklist was dropped at creation and
   * members got a generic default, so the group was not working through one list at all.
   */
  const template = (args.checklist ?? [])
    .map((label) => String(label ?? '').trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 20)
    .map((label, index) => ({ id: `c${index}`, label, done: false }));

  await run(
    `INSERT INTO study_rooms (id, community_id, title, topic, goal, starts_at, ends_at, created_by, created_at, checklist)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      communityId,
      title,
      (args.topic ?? '').trim().slice(0, 120),
      (args.goal ?? '').trim().slice(0, 400),
      startsAt.toISOString(),
      endsAt.toISOString(),
      userId,
      nowIso(),
      JSON.stringify(template),
    ],
  );

  // The host is in their own room, working from the list they wrote.
  await run(
    `INSERT INTO study_room_participants (id, room_id, community_id, user_id, checklist, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), id, communityId, userId, JSON.stringify(template), nowIso(), nowIso()],
  );

  publishCommunity(communityId, { type: 'event', communityId, eventId: id });
  return (await studyRoomView(userId, communityId, id))!;
}

async function studyRoomView(
  userId: string,
  communityId: string,
  roomId: string,
): Promise<StudyRoomView | null> {
  const row = await one<{
    id: string;
    title: string;
    topic: string;
    goal: string;
    starts_at: string;
    ends_at: string;
    created_by: string;
  }>(
    `SELECT id, title, topic, goal, starts_at, ends_at, created_by FROM study_rooms
      WHERE id = ? AND community_id = ?`,
    [roomId, communityId],
  );
  if (!row) return null;

  const [count, mine] = await Promise.all([
    one<{ count: number }>(`SELECT COUNT(*) AS count FROM study_room_participants WHERE room_id = ?`, [roomId]),
    one<{ checklist: string | null }>(
      `SELECT checklist FROM study_room_participants WHERE room_id = ? AND user_id = ?`,
      [roomId, userId],
    ),
  ]);

  let checklist: { id: string; label: string; done: boolean }[] = [];
  try {
    const parsed = mine?.checklist ? JSON.parse(mine.checklist) : null;
    if (Array.isArray(parsed)) {
      checklist = parsed.map((entry, index) => ({
        id: String(entry?.id ?? index),
        label: String(entry?.label ?? '').slice(0, 160),
        done: Boolean(entry?.done),
      }));
    }
  } catch {
    checklist = [];
  }

  return {
    id: row.id,
    communityId,
    title: row.title,
    topic: row.topic,
    goal: row.goal,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdBy: row.created_by,
    participantCount: count?.count ?? 0,
    isJoined: Boolean(mine),
    checklist,
  };
}

export async function listStudyRooms(userId: string, communityId: string): Promise<StudyRoomView[]> {
  await loadForMember(userId, communityId, { requireMembership: true });
  const rows = await all<{ id: string }>(
    `SELECT id FROM study_rooms WHERE community_id = ? AND ends_at >= ? ORDER BY starts_at LIMIT 40`,
    [communityId, nowIso()],
  );
  const views = await Promise.all(rows.map((row) => studyRoomView(userId, communityId, row.id)));
  return views.filter((view): view is StudyRoomView => view !== null);
}

/** Join a room, which seeds the student's own private checklist. */
export async function joinStudyRoom(
  userId: string,
  communityId: string,
  roomId: string,
  joined: boolean,
): Promise<StudyRoomView> {
  await loadForMember(userId, communityId, { requireMembership: true });
  const room = await studyRoomView(userId, communityId, roomId);
  if (!room) throw new HttpError(404, 'That study room no longer exists.', 'not_found');

  const existing = await one<{ id: string }>(
    `SELECT id FROM study_room_participants WHERE room_id = ? AND user_id = ?`,
    [roomId, userId],
  );

  if (joined && !existing) {
    // The room's own list, so everyone is working through the same tasks; the generic default is only
    // a fallback for a room created before checklists were stored.
    const stored = await one<{ checklist: string | null }>(`SELECT checklist FROM study_rooms WHERE id = ?`, [roomId]);
    let template: { id: string; label: string; done: boolean }[] = [];
    try {
      const parsed = stored?.checklist ? JSON.parse(stored.checklist) : null;
      if (Array.isArray(parsed) && parsed.length) {
        template = parsed.map((entry, index) => ({
          id: String(entry?.id ?? `c${index}`),
          label: String(entry?.label ?? '').slice(0, 160),
          done: false,
        }));
      }
    } catch {
      template = [];
    }
    const checklist = template.length
      ? template
      : DEFAULT_CHECKLIST.map((label, index) => ({ id: `c${index}`, label, done: false }));
    const now = nowIso();
    await run(
      `INSERT INTO study_room_participants (id, room_id, community_id, user_id, checklist, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), roomId, communityId, userId, JSON.stringify(checklist), now, now],
    );
  } else if (!joined && existing) {
    await run(`DELETE FROM study_room_participants WHERE id = ?`, [existing.id]);
  }

  return (await studyRoomView(userId, communityId, roomId))!;
}

/** Tick off one checklist item. Only the caller's own checklist can be written. */
export async function setStudyRoomChecklist(
  userId: string,
  communityId: string,
  roomId: string,
  itemId: string,
  done: boolean,
): Promise<StudyRoomView> {
  await loadForMember(userId, communityId, { requireMembership: true });

  const row = await one<{ id: string; checklist: string | null }>(
    `SELECT id, checklist FROM study_room_participants WHERE room_id = ? AND user_id = ?`,
    [roomId, userId],
  );
  if (!row) throw new HttpError(400, 'Join the study room first.', 'not_joined');

  let checklist: { id: string; label: string; done: boolean }[] = [];
  try {
    const parsed = row.checklist ? JSON.parse(row.checklist) : [];
    if (Array.isArray(parsed)) checklist = parsed;
  } catch {
    checklist = [];
  }

  const next = checklist.map((item) => (item.id === itemId ? { ...item, done } : item));
  if (!next.some((item) => item.id === itemId)) {
    throw new HttpError(404, 'That checklist item does not exist.', 'not_found');
  }

  await run(`UPDATE study_room_participants SET checklist = ?, updated_at = ? WHERE id = ?`, [
    JSON.stringify(next),
    nowIso(),
    row.id,
  ]);
  return (await studyRoomView(userId, communityId, roomId))!;
}
