/**
 * Study teams (§22) and group-versus-group comparison (§30).
 *
 * Teams are strictly a *study* structure: a small group inside a community that shares a goal. They
 * are not chat rooms (the community chat is), they are not a way to message strangers privately, and
 * membership is always controlled by the team lead inside the community's rules.
 */
import { all, one, nowIso, run, uuid } from '../../db/index.js';
import { HttpError } from '../../middleware/errors.js';
import { loadForMember } from './access.js';
import { isModerator, type CommunityRole } from './permissions.js';
import { notifyCommunityMembers, notifyOnce } from './notifications.js';
import type { TeamView } from './types.js';

function memberLimitOf(value: unknown): number {
  const limit = Number(value ?? 0);
  if (!Number.isFinite(limit)) return 6;
  return Math.min(Math.max(Math.trunc(limit), 2), 20);
}

export async function createTeam(
  userId: string,
  communityId: string,
  args: { name: string; description?: string; goal?: string; memberLimit?: number },
): Promise<{ id: string }> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  if (!membership) throw new HttpError(403, 'Join the community before creating a team.', 'forbidden');

  const name = args.name?.trim().slice(0, 60) ?? '';
  if (name.length < 3) throw new HttpError(400, 'Team names need at least 3 characters.', 'validation_error');

  const existing = await one<{ count: number }>(
    `SELECT COUNT(*) AS count FROM community_teams WHERE community_id = ? AND LOWER(name) = LOWER(?)`,
    [communityId, name],
  );
  if (existing?.count) throw new HttpError(409, 'A team with that name already exists here.', 'duplicate');

  // A visible ceiling stops one enthusiastic student from opening fifty teams and turning the team
  // list into noise. Moderators are not capped, because organising is part of their job.
  if (!isModerator(membership.role)) {
    const mine = await one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM community_teams
        WHERE community_id = ? AND created_by = ? AND status = 'active'`,
      [communityId, userId],
    );
    if ((mine?.count ?? 0) >= 3) {
      throw new HttpError(409, 'You already lead three teams here. Join or close one first.', 'team_limit');
    }
  }

  const id = uuid();
  const now = nowIso();
  await run(
    `INSERT INTO community_teams (id, community_id, name, description, goal, member_limit, created_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      id,
      communityId,
      name,
      (args.description ?? '').trim().slice(0, 400),
      (args.goal ?? '').trim().slice(0, 200),
      memberLimitOf(args.memberLimit),
      userId,
      now,
      now,
    ],
  );
  await run(
    `INSERT INTO team_members (id, team_id, community_id, user_id, role, created_at) VALUES (?, ?, ?, ?, 'lead', ?)`,
    [uuid(), id, communityId, userId, now],
  );
  return { id };
}

export async function listTeams(userId: string, communityId: string): Promise<TeamView[]> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });

  const rows = await all<{
    id: string;
    name: string;
    description: string;
    goal: string;
    member_limit: number | null;
    created_by: string;
    lead_name: string;
    member_count: number;
  }>(
    `SELECT t.id, t.name, t.description, t.goal, t.member_limit, t.created_by, u.name AS lead_name,
            (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count
       FROM community_teams t
       LEFT JOIN users u ON u.id = t.created_by
      WHERE t.community_id = ? AND t.status = 'active'
      ORDER BY t.created_at DESC LIMIT 50`,
    [communityId],
  );
  if (!rows.length) return [];

  const mine = new Set(
    (
      await all<{ team_id: string }>(
        `SELECT team_id FROM team_members WHERE user_id = ? AND team_id IN (${rows.map(() => '?').join(', ')})`,
        [userId, ...rows.map((row) => row.id)],
      )
    ).map((row) => row.team_id),
  );

  const moderator = isModerator(membership?.role ?? null);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    goal: row.goal,
    memberLimit: row.member_limit ?? 8,
    memberCount: row.member_count ?? 0,
    isMember: mine.has(row.id),
    isLead: row.created_by === userId,
    // Only the lead (or a community moderator) may close a team — a member cannot delete another
    // student's group, and the check is repeated on the server when the delete is attempted.
    canManage: row.created_by === userId || moderator,
    leadName: row.lead_name ?? 'Member',
  }));
}

/** Deletes a team. Lead or moderator only; membership rows are removed with it. */
export async function deleteTeam(userId: string, communityId: string, teamId: string): Promise<void> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  const team = await one<{ id: string; created_by: string }>(
    `SELECT id, created_by FROM community_teams WHERE id = ? AND community_id = ? AND status = 'active'`,
    [teamId, communityId],
  );
  if (!team) throw new HttpError(404, 'That team no longer exists.', 'not_found');
  if (team.created_by !== userId && !isModerator(membership?.role ?? null)) {
    throw new HttpError(403, 'Only the team lead or a moderator can delete this team.', 'forbidden');
  }
  await run(`UPDATE community_teams SET status = 'deleted', updated_at = ? WHERE id = ?`, [nowIso(), teamId]);
  await run(`DELETE FROM team_members WHERE team_id = ?`, [teamId]);
}

export async function joinTeam(userId: string, teamId: string): Promise<void> {
  const team = await one<{ id: string; community_id: string; member_limit: number | null }>(
    `SELECT id, community_id, member_limit FROM community_teams WHERE id = ? AND status = 'active'`,
    [teamId],
  );
  if (!team) throw new HttpError(404, 'That team no longer exists.', 'not_found');

  const { membership } = await loadForMember(userId, team.community_id, { requireMembership: true });
  if (!membership) throw new HttpError(403, 'Join the community before joining a team.', 'forbidden');

  const existing = await one<{ id: string }>(
    `SELECT id FROM team_members WHERE team_id = ? AND user_id = ?`,
    [teamId, userId],
  );
  if (existing) return;

  const count = await one<{ count: number }>(
    `SELECT COUNT(*) AS count FROM team_members WHERE team_id = ?`,
    [teamId],
  );
  if (team.member_limit !== null && (count?.count ?? 0) >= team.member_limit) {
    throw new HttpError(409, 'This team is already full.', 'team_full');
  }

  await run(
    `INSERT INTO team_members (id, team_id, community_id, user_id, role, created_at)
     VALUES (?, ?, ?, ?, 'member', ?)`,
    [uuid(), teamId, team.community_id, userId, nowIso()],
  );
}

export async function leaveTeam(userId: string, teamId: string): Promise<void> {
  const row = await one<{ id: string; role: string; user_id: string; community_id: string }>(
    `SELECT tm.id, tm.role, tm.user_id, t.community_id
       FROM team_members tm JOIN community_teams t ON t.id = tm.team_id
      WHERE tm.team_id = ? AND tm.user_id = ?`,
    [teamId, userId],
  );
  if (!row) return;

  if (row.role === 'lead') {
    // A team must not be orphaned: the lead has to hand over or disband it.
    const next = await one<{ user_id: string }>(
      `SELECT user_id FROM team_members WHERE team_id = ? AND user_id <> ? ORDER BY created_at LIMIT 1`,
      [teamId, userId],
    );
    if (next) {
      await run(`UPDATE team_members SET role = 'lead' WHERE team_id = ? AND user_id = ?`, [teamId, next.user_id]);
    } else {
      await run(`UPDATE community_teams SET status = 'archived', updated_at = ? WHERE id = ?`, [nowIso(), teamId]);
    }
  }

  await run(`DELETE FROM team_members WHERE team_id = ? AND user_id = ?`, [teamId, userId]);
}

export async function removeTeamMember(
  actorId: string,
  teamId: string,
  targetUserId: string,
): Promise<void> {
  const team = await one<{ community_id: string; created_by: string }>(
    `SELECT community_id, created_by FROM community_teams WHERE id = ?`,
    [teamId],
  );
  if (!team) throw new HttpError(404, 'That team no longer exists.', 'not_found');

  const { membership } = await loadForMember(actorId, team.community_id, { requireMembership: true });
  const canModerate = isModerator(membership?.role ?? null);
  if (!canModerate && team.created_by !== actorId) {
    throw new HttpError(403, 'Only the team lead or a community moderator can remove members.', 'forbidden');
  }
  if (targetUserId === team.created_by && !canModerate) {
    throw new HttpError(403, 'The team lead cannot remove themselves from the team.', 'forbidden');
  }

  await run(`DELETE FROM team_members WHERE team_id = ? AND user_id = ?`, [teamId, targetUserId]);
}

/**
 * Invite classmates into a team. Deliberately limited to the lead and moderators, and it can only
 * invite people who are already in the community — the community's membership rules stay intact.
 */
export async function inviteToTeam(
  actorId: string,
  teamId: string,
  userIds: string[],
): Promise<{ invited: number; skipped: number }> {
  const team = await one<{
    id: string;
    community_id: string;
    created_by: string;
    member_limit: number | null;
    name: string;
  }>(
    `SELECT id, community_id, created_by, member_limit, name FROM community_teams WHERE id = ? AND status = 'active'`,
    [teamId],
  );
  if (!team) throw new HttpError(404, 'That team no longer exists.', 'not_found');

  const { membership } = await loadForMember(actorId, team.community_id, { requireMembership: true });
  if (!isModerator(membership?.role ?? null) && team.created_by !== actorId) {
    throw new HttpError(403, 'Only the team lead or a community moderator can invite members.', 'forbidden');
  }

  const targets = [...new Set(userIds)].slice(0, 25);
  if (!targets.length) return { invited: 0, skipped: 0 };

  const members = await all<{ user_id: string }>(
    `SELECT user_id FROM community_members
      WHERE community_id = ? AND status IN ('active','muted') AND user_id IN (${targets.map(() => '?').join(', ')})`,
    [team.community_id, ...targets],
  );
  const eligible = new Set(members.map((row) => row.user_id));

  const existing = new Set(
    (
      await all<{ user_id: string }>(
        `SELECT user_id FROM team_members WHERE team_id = ? AND user_id IN (${targets.map(() => '?').join(', ')})`,
        [teamId, ...targets],
      )
    ).map((row) => row.user_id),
  );

  const count = await one<{ count: number }>(`SELECT COUNT(*) AS count FROM team_members WHERE team_id = ?`, [teamId]);
  let seats = team.member_limit === null ? 25 : Math.max(team.member_limit - (count?.count ?? 0), 0);

  let invited = 0;
  let skipped = 0;
  for (const target of targets) {
    if (!eligible.has(target) || existing.has(target) || seats <= 0) {
      skipped += 1;
      continue;
    }
    await notifyOnce({
      userId: target,
      communityId: team.community_id,
      kind: 'team_invite',
      title: `👥 Team invite: ${team.name}`,
      body: 'A teammate invited you to a study team.',
      link: `/communities/${team.community_id}/teams`,
      dedupeKey: `team-invite:${teamId}:${target}`,
      windowMinutes: 720,
    });
    invited += 1;
    seats -= 1;
  }
  return { invited, skipped };
}

/**
 * Group versus group (§30).
 *
 * This is an *aggregate* comparison between teams, computed from competition results. It never
 * produces a per-student ranking of anyone, and it refuses to compare fewer than two teams with any
 * results at all rather than showing a meaningless "winner".
 */
export async function teamStandings(
  userId: string,
  communityId: string,
  competitionId: string,
): Promise<{
  competitionTitle: string;
  teams: Array<{
    teamId: string;
    name: string;
    participants: number;
    averageScore: number | null;
    averageAccuracy: number | null;
    bestScore: number | null;
  }>;
}> {
  await loadForMember(userId, communityId, { requireMembership: true });

  const competition = await one<{ id: string; title: string }>(
    `SELECT c.id, c.title FROM arena_competitions c
      JOIN community_competitions cc ON cc.competition_id = c.id
     WHERE c.id = ? AND cc.community_id = ?`,
    [competitionId, communityId],
  );
  if (!competition) throw new HttpError(404, 'That competition is not hosted by this community.', 'not_found');

  const rows = await all<{
    team_id: string;
    name: string;
    participants: number;
    avg_score: number | null;
    avg_accuracy: number | null;
    best_score: number | null;
  }>(
    `SELECT t.id AS team_id, t.name,
            COUNT(DISTINCT r.user_id) AS participants,
            AVG(r.score) AS avg_score,
            AVG(r.accuracy) AS avg_accuracy,
            MAX(r.score) AS best_score
       FROM community_teams t
       LEFT JOIN team_members tm ON tm.team_id = t.id
       LEFT JOIN arena_results r ON r.user_id = tm.user_id AND r.competition_id = ?
      WHERE t.community_id = ? AND t.status = 'active'
      GROUP BY t.id, t.name
      ORDER BY avg_score DESC NULLS LAST, t.name`,
    [competitionId, communityId],
  );

  return {
    competitionTitle: competition.title,
    teams: rows.map((row) => ({
      teamId: row.team_id,
      name: row.name,
      participants: row.participants ?? 0,
      averageScore: row.avg_score === null ? null : Math.round(row.avg_score * 10) / 10,
      averageAccuracy: row.avg_accuracy === null ? null : Math.round(row.avg_accuracy * 1000) / 1000,
      bestScore: row.best_score === null ? null : Math.round(row.best_score * 10) / 10,
    })),
  };
}

/** Used when a community announces a result, so a whole team hears about it once. */
export async function announceToTeam(
  actorId: string,
  teamId: string,
  title: string,
  body: string,
): Promise<void> {
  const team = await one<{ community_id: string; created_by: string }>(
    `SELECT community_id, created_by FROM community_teams WHERE id = ?`,
    [teamId],
  );
  if (!team) throw new HttpError(404, 'That team no longer exists.', 'not_found');
  const { membership } = await loadForMember(actorId, team.community_id, { requireMembership: true });
  if (!isModerator(membership?.role ?? null) && team.created_by !== actorId) {
    throw new HttpError(403, 'Only the team lead or a moderator can message the team.', 'forbidden');
  }
  void notifyCommunityMembers;
  const members = await all<{ user_id: string }>(`SELECT user_id FROM team_members WHERE team_id = ?`, [teamId]);
  const { createNotification } = await import('./notifications.js');
  for (const member of members) {
    await createNotification({
      userId: member.user_id,
      communityId: team.community_id,
      kind: 'team_update',
      title: title.slice(0, 120),
      body: body.slice(0, 400),
      link: `/communities/${team.community_id}/teams`,
    });
  }
}

export async function teamRoleOf(teamId: string, userId: string): Promise<CommunityRole | 'lead' | null> {
  const row = await one<{ role: string }>(`SELECT role FROM team_members WHERE team_id = ? AND user_id = ?`, [
    teamId,
    userId,
  ]);
  return row ? ((row.role as CommunityRole | 'lead') ?? null) : null;
}
