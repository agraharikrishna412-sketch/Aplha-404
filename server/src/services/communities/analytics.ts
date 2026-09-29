/**
 * Creator dashboard and analytics (§39, §40).
 *
 * Two commitments keep this honest:
 *
 *  - **Aggregate only.** Nothing here returns an individual student's activity, message history or
 *    time-on-platform. A creator sees "42 members were active this week", never "Riya was online for
 *    3 hours" (§40 "avoid unnecessary surveillance"). The counts that *are* per-student — the
 *    leaderboard and the member list — are the two the student already knows are public inside their
 *    community, and both are governed by their own privacy rules.
 *
 *  - **Real numbers or nothing.** Every figure is a `COUNT`/`AVG` over rows that exist. Where there is
 *    not enough data to say something meaningful, the field is `null` rather than a made-up value.
 */
import { all, bool, one } from '../../db/index.js';
import { loadForMember } from './access.js';
import type { CommunityAnalytics } from './types.js';

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/**
 * Headline numbers for a community. Requires the `view_analytics` capability (owner/admin) — a
 * moderator gets the moderation queue, not the creator dashboard.
 */
export async function communityAnalytics(userId: string, communityId: string): Promise<CommunityAnalytics> {
  await loadForMember(userId, communityId, { capability: 'view_analytics' });
  const week = daysAgo(7);

  const [
    members,
    newMembers,
    activeMembers,
    competitionParticipation,
    challengeRows,
    resourceCount,
    doubtCount,
    helpfulAnswerCount,
    eventParticipation,
    messages7d,
  ] = await Promise.all([
    one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM community_members WHERE community_id = ? AND status IN ('active','muted')`,
      [communityId],
    ),
    one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM community_members
        WHERE community_id = ? AND status IN ('active','muted') AND joined_at >= ?`,
      [communityId, week],
    ),
    // "Active" means the student produced something here in the last week — not that they opened a
    // page. Two signals are combined: writing in the community and answering a doubt.
    one<{ count: number }>(
      `SELECT COUNT(DISTINCT user_id) AS count FROM (
          SELECT user_id FROM community_messages WHERE community_id = ? AND created_at >= ?
          UNION
          SELECT user_id FROM doubt_answers WHERE community_id = ? AND created_at >= ?
          UNION
          SELECT created_by AS user_id FROM community_resources WHERE community_id = ? AND created_at >= ?
          UNION
          SELECT p.user_id FROM challenge_progress p
            JOIN community_challenges c ON c.id = p.challenge_id
           WHERE c.community_id = ? AND p.completed_at >= ?
        ) AS active`,
      [communityId, week, communityId, week, communityId, week, communityId, week],
    ),
    one<{ count: number }>(
      `SELECT COUNT(DISTINCT a.user_id) AS count
         FROM community_competitions cc JOIN arena_attempts a ON a.competition_id = cc.competition_id
        WHERE cc.community_id = ?`,
      [communityId],
    ),
    all<{ challenge_id: string; days: string; done: number; participants: number }>(
      `SELECT ch.id AS challenge_id, ch.days,
              (SELECT COUNT(*) FROM challenge_progress p WHERE p.challenge_id = ch.id) AS done,
              (SELECT COUNT(DISTINCT p.user_id) FROM challenge_progress p WHERE p.challenge_id = ch.id) AS participants
         FROM community_challenges ch WHERE ch.community_id = ? AND ch.status <> 'draft'`,
      [communityId],
    ),
    one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM community_resources WHERE community_id = ?`,
      [communityId],
    ),
    one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM community_doubts WHERE community_id = ? AND status <> 'removed'`,
      [communityId],
    ),
    one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM doubt_answers WHERE community_id = ? AND is_helpful = 1 AND deleted_at IS NULL`,
      [communityId],
    ),
    one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM event_participants p
         JOIN community_events e ON e.id = p.event_id
        WHERE e.community_id = ? AND p.status = 'going'`,
      [communityId],
    ),
    one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM community_messages WHERE community_id = ? AND created_at >= ? AND deleted_at IS NULL`,
      [communityId, week],
    ),
  ]);

  // Challenge completion is the share of *possible* day-completions that actually happened, across
  // every participant. With no challenges or no days there is nothing to report, so it is null.
  let possible = 0;
  let completed = 0;
  for (const row of challengeRows) {
    let days = 0;
    try {
      const parsed = JSON.parse(row.days);
      days = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      days = 0;
    }
    possible += days * (row.participants ?? 0);
    completed += row.done ?? 0;
  }

  return {
    totalMembers: members?.count ?? 0,
    newMembers7d: newMembers?.count ?? 0,
    activeMembers: activeMembers?.count ?? 0,
    competitionParticipation: competitionParticipation?.count ?? 0,
    // `null` when no challenge has any participant yet - an invented 0% would read as failure.
    challengeCompletionPercent: possible > 0 ? Math.round((completed / possible) * 1000) / 10 : null,
    resourceCount: resourceCount?.count ?? 0,
    doubtCount: doubtCount?.count ?? 0,
    helpfulAnswerCount: helpfulAnswerCount?.count ?? 0,
    eventParticipation: eventParticipation?.count ?? 0,
    messages7d: messages7d?.count ?? 0,
  };
}

/**
 * Fourteen-day activity trend.
 *
 * Small enough to compute in one pass, and it is deliberately a *count of contributions* per day,
 * not per-student activity, because that is what a creator can act on without surveilling anyone.
 */
export async function activityTrend(userId: string, communityId: string): Promise<
  Array<{ day: string; messages: number; doubts: number; answers: number; resources: number; challengeDays: number }>
> {
  await loadForMember(userId, communityId, { capability: 'view_analytics' });
  const since = daysAgo(14);

  const [messages, doubts, answers, resources, challengeDays] = await Promise.all([
    all<{ day: string; count: number }>(
      `SELECT SUBSTR(created_at, 1, 10) AS day, COUNT(*) AS count FROM community_messages
        WHERE community_id = ? AND created_at >= ? AND deleted_at IS NULL GROUP BY day`,
      [communityId, since],
    ),
    all<{ day: string; count: number }>(
      `SELECT SUBSTR(created_at, 1, 10) AS day, COUNT(*) AS count FROM community_doubts
        WHERE community_id = ? AND created_at >= ? AND status <> 'removed' GROUP BY day`,
      [communityId, since],
    ),
    all<{ day: string; count: number }>(
      `SELECT SUBSTR(created_at, 1, 10) AS day, COUNT(*) AS count FROM doubt_answers
        WHERE community_id = ? AND created_at >= ? AND deleted_at IS NULL GROUP BY day`,
      [communityId, since],
    ),
    all<{ day: string; count: number }>(
      `SELECT SUBSTR(created_at, 1, 10) AS day, COUNT(*) AS count FROM community_resources
        WHERE community_id = ? AND created_at >= ? GROUP BY day`,
      [communityId, since],
    ),
    all<{ day: string; count: number }>(
      `SELECT SUBSTR(p.completed_at, 1, 10) AS day, COUNT(*) AS count
         FROM challenge_progress p JOIN community_challenges c ON c.id = p.challenge_id
        WHERE c.community_id = ? AND p.completed_at >= ? GROUP BY day`,
      [communityId, since],
    ),
  ]);

  const toMap = (rows: Array<{ day: string; count: number }>) =>
    new Map(rows.map((row) => [row.day, row.count]));
  const maps = [messages, doubts, answers, resources, challengeDays].map(toMap);

  const out: Array<{ day: string; messages: number; doubts: number; answers: number; resources: number; challengeDays: number }> = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const day = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    out.push({
      day,
      messages: maps[0].get(day) ?? 0,
      doubts: maps[1].get(day) ?? 0,
      answers: maps[2].get(day) ?? 0,
      resources: maps[3].get(day) ?? 0,
      challengeDays: maps[4].get(day) ?? 0,
    });
  }
  return out;
}

/**
 * The contributions that moved the community forward this week. This is the creator dashboard's
 * "what happened here" panel, and it is intentionally contribution-based: no login counts, no
 * time-on-site, nothing that rewards being online.
 */
export async function weeklyDigest(userId: string, communityId: string) {
  await loadForMember(userId, communityId, { capability: 'view_analytics' });
  const week = daysAgo(7);

  const [topContributors, newMembers, upcoming] = await Promise.all([
    all<{ name: string; points: number; helpful: number }>(
      `SELECT u.name, m.contribution_points AS points, m.helpful_answers AS helpful
         FROM community_members m JOIN users u ON u.id = m.user_id
        WHERE m.community_id = ? AND m.status IN ('active','muted')
        ORDER BY m.helpful_answers DESC, m.contribution_points DESC LIMIT 5`,
      [communityId],
    ),
    all<{ name: string; joined_at: string; role: string }>(
      `SELECT u.name, m.joined_at, m.role FROM community_members m JOIN users u ON u.id = m.user_id
        WHERE m.community_id = ? AND m.joined_at >= ? AND m.status IN ('active','muted')
        ORDER BY m.joined_at DESC LIMIT 10`,
      [communityId, week],
    ),
    all<{ kind: string; title: string; at: string }>(
      `SELECT 'competition' AS kind, a.title, a.starts_at AS at
         FROM community_competitions cc JOIN arena_competitions a ON a.id = cc.competition_id
        WHERE cc.community_id = ? AND a.ends_at >= ?
        UNION ALL
       SELECT 'event' AS kind, e.title, e.starts_at AS at
         FROM community_events e WHERE e.community_id = ? AND e.ends_at >= ?
        ORDER BY at LIMIT 6`,
      [communityId, new Date().toISOString(), communityId, new Date().toISOString()],
    ),
  ]);

  return {
    topContributors: topContributors.map((row) => ({
      name: row.name,
      contributionPoints: row.points ?? 0,
      helpfulAnswers: row.helpful ?? 0,
    })),
    newMembers,
    upcoming,
  };
}

/**
 * Membership growth per day for the last 30 days, plus the totals a creator actually cares about.
 * Used by the "Growth" card in the creator dashboard.
 */
export async function growth(userId: string, communityId: string) {
  const { community } = await loadForMember(userId, communityId, { capability: 'view_analytics' });
  const since = daysAgo(30);

  const [rows, totals, left] = await Promise.all([
    all<{ day: string; count: number }>(
      `SELECT SUBSTR(joined_at, 1, 10) AS day, COUNT(*) AS count FROM community_members
        WHERE community_id = ? AND joined_at >= ? GROUP BY day`,
      [communityId, since],
    ),
    one<{ total: number; active: number; muted: number; banned: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'muted' THEN 1 ELSE 0 END) AS muted,
              SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END) AS banned
         FROM community_members WHERE community_id = ?`,
      [communityId],
    ),
    one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM community_members WHERE community_id = ? AND status = 'left' AND updated_at >= ?`,
      [communityId, since],
    ),
  ]);

  const map = new Map(rows.map((row) => [row.day, row.count]));
  const series: Array<{ day: string; joined: number }> = [];
  for (let offset = 29; offset >= 0; offset -= 1) {
    const day = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    series.push({ day, joined: map.get(day) ?? 0 });
  }

  return {
    series,
    joins30d: rows.reduce((sum, row) => sum + row.count, 0),
    leaves30d: left?.count ?? 0,
    total: totals?.total ?? 0,
    active: totals?.active ?? 0,
    muted: totals?.muted ?? 0,
    banned: totals?.banned ?? 0,
    memberLimit: community.member_limit === null ? null : Number(community.member_limit),
    isLeaderboardEnabled: bool(community.is_leaderboard_enabled),
  };
}
