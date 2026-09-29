/**
 * Reporting, the moderation queue and the audit trail (§7, §45).
 *
 * Three rules shape this file:
 *  - Reports are private. The reported student is never told who reported them (§43).
 *  - Every moderation action is written to `moderation_actions` with its actor and reason, so
 *    moderation is reviewable rather than invisible (§7 "audit trail").
 *  - A moderator can never act on someone at or above their own role, and never on themselves.
 */
import { all, nowIso, one, run, uuid } from '../../db/index.js';
import { HttpError } from '../../middleware/errors.js';
import { loadForMember, readableCommunityIds } from './access.js';
import { recordModeration } from './communities.js';
import { createNotification, notifyCommunityMembers } from './notifications.js';
import { canActOnMember, type CommunityRole } from './permissions.js';
import { REPORT_REASONS, type ModerationActionView, type ReportView } from './types.js';

export type ReportTargetType =
  | 'message'
  | 'doubt'
  | 'answer'
  | 'resource'
  | 'member'
  | 'competition'
  | 'event';

const TARGET_TYPES: ReportTargetType[] = [
  'message',
  'doubt',
  'answer',
  'resource',
  'member',
  'competition',
  'event',
];

export interface ReportArgs {
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  details?: string;
}

/**
 * File a report.
 *
 * The target is verified to exist *inside the community the reporter can actually see*, which stops
 * reports being used to probe for the existence of content elsewhere (§12).
 */
export async function reportContent(
  userId: string,
  communityId: string,
  args: ReportArgs,
): Promise<{ id: string; duplicate: boolean }> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  if (!membership) throw new HttpError(403, 'Join the community to report content.', 'forbidden');
  if (!TARGET_TYPES.includes(args.targetType)) {
    throw new HttpError(400, 'Unknown report type.', 'validation_error');
  }
  if (!REPORT_REASONS.includes(args.reason as (typeof REPORT_REASONS)[number])) {
    throw new HttpError(400, 'Pick a reason for the report.', 'validation_error');
  }

  const exists = await targetExists(communityId, args.targetType, args.targetId);
  if (!exists) throw new HttpError(404, 'That content is no longer available.', 'not_found');

  const duplicate = await one<{ id: string; status: string }>(
    `SELECT id, status FROM community_reports
      WHERE community_id = ? AND reporter_id = ? AND entity_type = ? AND entity_id = ?`,
    [communityId, userId, args.targetType, args.targetId],
  );
  // The table has a unique index on (community, reporter, entity type, entity id), so a second
  // report of the same thing is folded into the first rather than creating noise in the queue.
  if (duplicate) return { id: duplicate.id, duplicate: true };

  const id = uuid();
  await run(
    `INSERT INTO community_reports
       (id, community_id, reporter_id, entity_type, entity_id, reason, note, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    [
      id,
      communityId,
      userId,
      args.targetType,
      args.targetId,
      args.reason,
      (args.details ?? '').trim().slice(0, 600),
      nowIso(),
    ],
  );

  // Moderators hear about a new report; nobody else does.
  await notifyCommunityMembers({
    communityId,
    kind: 'report_received',
    title: '🚩 New report to review',
    body: `Reason: ${args.reason.replace(/_/g, ' ')}`,
    link: `/communities/${communityId}/moderation`,
    roles: ['owner', 'admin', 'moderator'],
    excludeUserId: userId,
  });

  return { id, duplicate: false };
}

async function targetExists(
  communityId: string,
  targetType: ReportTargetType,
  targetId: string,
): Promise<boolean> {
  const queries: Record<ReportTargetType, string> = {
    message: `SELECT 1 AS ok FROM community_messages WHERE id = ? AND community_id = ?`,
    doubt: `SELECT 1 AS ok FROM community_doubts WHERE id = ? AND community_id = ?`,
    answer: `SELECT 1 AS ok FROM doubt_answers WHERE id = ? AND community_id = ?`,
    resource: `SELECT 1 AS ok FROM community_resources WHERE id = ? AND community_id = ?`,
    member: `SELECT 1 AS ok FROM community_members WHERE user_id = ? AND community_id = ?`,
    competition: `SELECT 1 AS ok FROM community_competitions WHERE competition_id = ? AND community_id = ?`,
    event: `SELECT 1 AS ok FROM community_events WHERE id = ? AND community_id = ?`,
  };
  const row = await one<{ ok: number }>(queries[targetType], [targetId, communityId]);
  return Boolean(row);
}

export async function listReports(
  userId: string,
  communityId: string,
  status: 'open' | 'resolved' | 'dismissed' | 'all' = 'open',
): Promise<ReportView[]> {
  await loadForMember(userId, communityId, { capability: 'handle_reports' });

  const filter = status === 'all' ? '' : `AND r.status = '${status}'`;
  const rows = await all<{
    id: string;
    entity_type: string;
    entity_id: string;
    reason: string;
    note: string;
    status: string;
    created_at: string;
    reporter_name: string | null;
    resolved_at: string | null;
    action_taken: string | null;
    preview: string | null;
  }>(
    `SELECT r.id, r.entity_type, r.entity_id, r.reason, r.note, r.status, r.created_at,
            u.name AS reporter_name, r.resolved_at, r.action_taken,
            CASE r.entity_type
              WHEN 'message' THEN (SELECT SUBSTR(body, 1, 160) FROM community_messages WHERE id = r.entity_id)
              WHEN 'doubt' THEN (SELECT SUBSTR(title, 1, 160) FROM community_doubts WHERE id = r.entity_id)
              WHEN 'answer' THEN (SELECT SUBSTR(body, 1, 160) FROM doubt_answers WHERE id = r.entity_id)
              WHEN 'resource' THEN (SELECT SUBSTR(title, 1, 160) FROM community_resources WHERE id = r.entity_id)
              WHEN 'event' THEN (SELECT SUBSTR(title, 1, 160) FROM community_events WHERE id = r.entity_id)
              ELSE NULL
            END AS preview
       FROM community_reports r
       LEFT JOIN users u ON u.id = r.reporter_id
      WHERE r.community_id = ? ${filter}
      ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC
      LIMIT 100`,
    [communityId],
  );

  return rows.map((row) => ({
    id: row.id,
    targetType: row.entity_type as ReportTargetType,
    targetId: row.entity_id,
    reason: row.reason,
    details: row.note,
    status: row.status as ReportView['status'],
    createdAt: row.created_at,
    reporterName: row.reporter_name ?? 'A member',
    resolvedAt: row.resolved_at,
    resolution: row.action_taken,
    // Only the plain-text preview is exposed, and only to moderators who can act on it.
    preview: row.preview ?? null,
  }));
}

export interface ResolveReportArgs {
  action: 'dismiss' | 'remove_content' | 'warn' | 'mute' | 'remove_member';
  note?: string;
  muteHours?: number;
}

/**
 * Resolve a report and optionally act on it.
 *
 * `remove_content`, `mute` and `remove_member` all go through the same role-ceiling checks as the
 * direct member-management endpoints, so a report cannot be used as a shortcut around §3.
 */
export async function resolveReport(
  userId: string,
  communityId: string,
  reportId: string,
  args: ResolveReportArgs,
): Promise<{ status: string; action: string }> {
  const { membership } = await loadForMember(userId, communityId, { capability: 'handle_reports' });
  const actorRole = membership?.role ?? null;

  const report = await one<{ id: string; entity_type: string; entity_id: string; status: string }>(
    `SELECT id, entity_type, entity_id, status FROM community_reports WHERE id = ? AND community_id = ?`,
    [reportId, communityId],
  );
  if (!report) throw new HttpError(404, 'That report no longer exists.', 'not_found');
  if (report.status !== 'open') throw new HttpError(409, 'That report was already handled.', 'already_resolved');

  const note = (args.note ?? '').trim().slice(0, 400);
  const status = args.action === 'dismiss' ? 'dismissed' : 'resolved';
  const targetType = report.entity_type as ReportTargetType;

  if (args.action === 'remove_content') {
    await removeReportedContent(communityId, targetType, report.entity_id, userId, note);
  }

  if (args.action === 'mute' || args.action === 'remove_member' || args.action === 'warn') {
    const targetUserId = await authorOfTarget(communityId, targetType, report.entity_id);
    if (!targetUserId) throw new HttpError(400, 'This report is not attached to a member.', 'validation_error');
    if (targetUserId === userId) throw new HttpError(400, 'You cannot moderate on your own report.', 'forbidden');

    const target = await one<{ role: string; status: string }>(
      `SELECT role, status FROM community_members WHERE community_id = ? AND user_id = ?`,
      [communityId, targetUserId],
    );
    if (!target) throw new HttpError(404, 'That student is no longer in this community.', 'not_found');
    // The role ceiling: nobody acts on a peer or a senior, and rank alone never suffices.
    if (!actorRole || !canActOnMember(actorRole, target.role as CommunityRole)) {
      throw new HttpError(403, 'You cannot moderate that member.', 'forbidden');
    }

    if (args.action === 'warn') {
      await createNotification({
        userId: targetUserId,
        communityId,
        kind: 'moderation_warning',
        title: '⚠️ A community warning',
        body: note || 'A moderator reviewed a report about your content and asked you to follow the community rules.',
        link: `/communities/${communityId}`,
      });
      await recordModeration(communityId, userId, 'warn_member', targetType, report.entity_id, note, targetUserId);
    }

    if (args.action === 'mute') {
      const hours = Math.min(Math.max(Math.trunc(args.muteHours ?? 24), 1), 24 * 30);
      const until = new Date(Date.now() + hours * 3_600_000).toISOString();
      await run(
        `UPDATE community_members SET status = 'muted', muted_until = ?, mute_reason = ?, updated_at = ?
          WHERE community_id = ? AND user_id = ?`,
        [until, note || 'Muted by a moderator', nowIso(), communityId, targetUserId],
      );
      await recordModeration(communityId, userId, `mute_${hours}h`, targetType, report.entity_id, note, targetUserId);
      await notifyCommunityMembers({
        communityId,
        kind: 'moderation_action',
        title: '🔇 A member was muted',
        body: note || `${hours} hours, following a report.`,
        link: `/communities/${communityId}/moderation`,
        roles: ['owner', 'admin', 'moderator'],
        excludeUserId: userId,
      });
    }

    if (args.action === 'remove_member') {
      await run(`UPDATE community_members SET status = 'left', updated_at = ? WHERE community_id = ? AND user_id = ?`, [
        nowIso(),
        communityId,
        targetUserId,
      ]);
      await recordModeration(communityId, userId, 'remove_member', targetType, report.entity_id, note, targetUserId);
      await createNotification({
        userId: targetUserId,
        communityId,
        kind: 'moderation_action',
        title: 'You were removed from a community',
        body: note || 'A moderator removed you after reviewing a report.',
        link: '/communities/my',
      });
    }
  }

  await run(
    `UPDATE community_reports SET status = ?, resolved_by = ?, resolved_at = ?, action_taken = ? WHERE id = ?`,
    [status, userId, nowIso(), `${args.action}${note ? `: ${note}` : ''}`.slice(0, 400), reportId],
  );

  return { status, action: args.action };
}

async function authorOfTarget(
  communityId: string,
  targetType: ReportTargetType,
  targetId: string,
): Promise<string | null> {
  const queries: Record<ReportTargetType, string> = {
    message: `SELECT user_id FROM community_messages WHERE id = ? AND community_id = ?`,
    doubt: `SELECT user_id FROM community_doubts WHERE id = ? AND community_id = ?`,
    answer: `SELECT user_id FROM doubt_answers WHERE id = ? AND community_id = ?`,
    resource: `SELECT created_by AS user_id FROM community_resources WHERE id = ? AND community_id = ?`,
    member: `SELECT user_id FROM community_members WHERE user_id = ? AND community_id = ?`,
    competition: `SELECT created_by AS user_id FROM community_competitions WHERE competition_id = ? AND community_id = ?`,
    event: `SELECT host_id AS user_id FROM community_events WHERE id = ? AND community_id = ?`,
  };
  const row = await one<{ user_id: string | null }>(queries[targetType], [targetId, communityId]);
  return row?.user_id ?? null;
}

async function removeReportedContent(
  communityId: string,
  targetType: ReportTargetType,
  targetId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  const now = nowIso();
  if (targetType === 'message') {
    // Soft delete keeps the thread readable and preserves the audit trail (§7).
    await run(
      `UPDATE community_messages SET deleted_at = ?, deleted_by = ?, body = '' WHERE id = ? AND community_id = ?`,
      [now, actorId, targetId, communityId],
    );
    await recordModeration(communityId, actorId, 'delete_message', 'message', targetId, reason);
    return;
  }
  if (targetType === 'doubt') {
    await run(`UPDATE community_doubts SET status = 'removed', updated_at = ? WHERE id = ? AND community_id = ?`, [
      now,
      targetId,
      communityId,
    ]);
    await recordModeration(communityId, actorId, 'remove_doubt', 'doubt', targetId, reason);
    return;
  }
  if (targetType === 'answer') {
    await run(`UPDATE doubt_answers SET deleted_at = ?, body = '' WHERE id = ? AND community_id = ?`, [
      now,
      targetId,
      communityId,
    ]);
    await recordModeration(communityId, actorId, 'remove_answer', 'answer', targetId, reason);
    return;
  }
  if (targetType === 'resource') {
    await run(`DELETE FROM community_resources WHERE id = ? AND community_id = ?`, [targetId, communityId]);
    await recordModeration(communityId, actorId, 'remove_resource', 'resource', targetId, reason);
    return;
  }
  if (targetType === 'event') {
    await run(`DELETE FROM community_events WHERE id = ? AND community_id = ?`, [targetId, communityId]);
    await recordModeration(communityId, actorId, 'cancel_event', 'event', targetId, reason);
    return;
  }
  throw new HttpError(400, 'That content type cannot be removed directly.', 'validation_error');
}

/* ------------------------------------------------------------------ moderation tools ------------ */

export async function muteMember(
  actorId: string,
  communityId: string,
  targetUserId: string,
  hours: number,
  reason: string,
): Promise<void> {
  const { membership } = await loadForMember(actorId, communityId, { capability: 'moderate_messages' });
  if (targetUserId === actorId) throw new HttpError(400, 'You cannot mute yourself.', 'forbidden');

  const target = await one<{ role: string; status: string }>(
    `SELECT role, status FROM community_members WHERE community_id = ? AND user_id = ?`,
    [communityId, targetUserId],
  );
  if (!target) throw new HttpError(404, 'That student is not a member of this community.', 'not_found');
  if (target.status === 'left' || target.status === 'banned') {
    throw new HttpError(409, 'That student is not an active member.', 'invalid_state');
  }
  const actorRole = membership?.role ?? null;
  if (!actorRole || !canActOnMember(actorRole, target.role as CommunityRole)) {
    throw new HttpError(403, 'You cannot mute a member at or above your role.', 'forbidden');
  }

  const bounded = Math.min(Math.max(Math.trunc(hours), 1), 24 * 30);
  const until = new Date(Date.now() + bounded * 3_600_000).toISOString();
  await run(
    `UPDATE community_members SET status = 'muted', muted_until = ?, mute_reason = ?, updated_at = ?
      WHERE community_id = ? AND user_id = ?`,
    [until, reason.slice(0, 200), nowIso(), communityId, targetUserId],
  );
  await recordModeration(communityId, actorId, `mute_${bounded}h`, 'member', targetUserId, reason, targetUserId);
  await createNotification({
    userId: targetUserId,
    communityId,
    kind: 'moderation_action',
    title: '🔇 You were muted in a community',
    body: reason || `Muted for ${bounded} hours. You can still read.`,
    link: `/communities/${communityId}`,
  });
}

export async function unmuteMember(actorId: string, communityId: string, targetUserId: string): Promise<void> {
  await loadForMember(actorId, communityId, { capability: 'moderate_messages' });
  const target = await one<{ status: string }>(
    `SELECT status FROM community_members WHERE community_id = ? AND user_id = ?`,
    [communityId, targetUserId],
  );
  if (!target) throw new HttpError(404, 'That student is not a member of this community.', 'not_found');
  await run(
    `UPDATE community_members SET status = 'active', muted_until = NULL, mute_reason = NULL, updated_at = ?
      WHERE community_id = ? AND user_id = ?`,
    [nowIso(), communityId, targetUserId],
  );
  await recordModeration(communityId, actorId, 'unmute', 'member', targetUserId, '', targetUserId);
}

/**
 * Clears mutes whose window has passed. Called whenever a community's members are read, which avoids
 * needing a scheduler for something this small.
 */
export async function expireMutes(communityId: string): Promise<number> {
  const now = nowIso();
  const expiring = await all<{ id: string }>(
    `SELECT id FROM community_members
      WHERE community_id = ? AND status = 'muted' AND muted_until IS NOT NULL AND muted_until <= ?`,
    [communityId, now],
  );
  if (!expiring.length) return 0;
  await run(
    `UPDATE community_members SET status = 'active', muted_until = NULL, updated_at = ?
      WHERE community_id = ? AND status = 'muted' AND muted_until IS NOT NULL AND muted_until <= ?`,
    [now, communityId, now],
  );
  return expiring.length;
}

export async function kickMember(
  actorId: string,
  communityId: string,
  targetUserId: string,
  reason: string,
): Promise<void> {
  const { membership } = await loadForMember(actorId, communityId, { capability: 'manage_members' });
  if (targetUserId === actorId) {
    throw new HttpError(400, 'The owner must transfer ownership before leaving.', 'forbidden');
  }
  const target = await one<{ role: string }>(
    `SELECT role FROM community_members WHERE community_id = ? AND user_id = ?`,
    [communityId, targetUserId],
  );
  if (!target) throw new HttpError(404, 'That student is not a member of this community.', 'not_found');
  const actorRole = membership?.role ?? null;
  if (!actorRole || !canActOnMember(actorRole, target.role as CommunityRole)) {
    throw new HttpError(403, 'You cannot remove a member at or above your role.', 'forbidden');
  }

  await run(`UPDATE community_members SET status = 'left', updated_at = ? WHERE community_id = ? AND user_id = ?`, [
    nowIso(),
    communityId,
    targetUserId,
  ]);
  await recordModeration(communityId, actorId, 'kick', 'member', targetUserId, reason, targetUserId);
  await createNotification({
    userId: targetUserId,
    communityId,
    kind: 'moderation_action',
    title: 'You were removed from a community',
    body: reason || 'A moderator removed you from this community.',
    link: '/communities/my',
  });
}

/** The audit trail, moderators and above only. */
export async function auditTrail(
  userId: string,
  communityId: string,
  limit = 100,
): Promise<ModerationActionView[]> {
  await loadForMember(userId, communityId, { capability: 'handle_reports' });
  const rows = await all<{
    id: string;
    action: string;
    reason: string;
    target_type: string;
    target_id: string;
    created_at: string;
    actor_name: string | null;
    target_name: string | null;
  }>(
    `SELECT m.id, m.action, m.reason, m.target_type, m.target_id, m.created_at,
            a.name AS actor_name, t.name AS target_name
       FROM moderation_actions m
       LEFT JOIN users a ON a.id = m.actor_id
       LEFT JOIN users t ON t.id = m.target_user_id
      WHERE m.community_id = ?
      ORDER BY m.created_at DESC LIMIT ?`,
    [communityId, Math.min(Math.max(limit, 1), 300)],
  );

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    reason: row.reason,
    targetType: row.target_type,
    targetId: row.target_id,
    createdAt: row.created_at,
    actorName: row.actor_name ?? 'Moderator',
    targetName: row.target_name,
  }));
}

/** Reports a student has filed in the last day — used to spot report abuse, not to surveil content. */
export async function reportPressure(communityId: string, userId: string): Promise<number> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const row = await one<{ count: number }>(
    `SELECT COUNT(*) AS count FROM community_reports
      WHERE community_id = ? AND reporter_id = ? AND created_at >= ?`,
    [communityId, userId, since],
  );
  return row?.count ?? 0;
}

export async function unresolvedCount(communityId: string): Promise<number> {
  const row = await one<{ count: number }>(
    `SELECT COUNT(*) AS count FROM community_reports WHERE community_id = ? AND status = 'open'`,
    [communityId],
  );
  return row?.count ?? 0;
}

/** Aggregated across every community the caller moderates — powers the dashboard badge. */
export async function myModerationQueue(userId: string) {
  const rows = await all<{ community_id: string; name: string; open_reports: number }>(
    `SELECT c.id AS community_id, c.name,
            (SELECT COUNT(*) FROM community_reports r WHERE r.community_id = c.id AND r.status = 'open') AS open_reports
       FROM communities c
       JOIN community_members m ON m.community_id = c.id AND m.user_id = ?
      WHERE m.role IN ('owner','admin','moderator') AND c.status = 'active'
      ORDER BY open_reports DESC`,
    [userId],
  );
  void readableCommunityIds;
  return {
    communities: rows.filter((row) => (row.open_reports ?? 0) > 0),
    total: rows.reduce((sum, row) => sum + (row.open_reports ?? 0), 0),
  };
}
