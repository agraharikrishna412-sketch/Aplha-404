/**
 * Contribution reputation, badges, the leaderboard and community profiles.
 *
 * The organising principle is §36: **contribution > popularity.** Nothing here counts likes,
 * followers, views or time-on-site. Every signal is an academic contribution — a helpful answer, a
 * finished challenge, a shared resource, a competition sat — and every badge is *derived* from those
 * records. There is deliberately no function that lets a user grant themselves a badge (§26).
 */
import { all, bool, nowIso, one, run, uuid } from '../../db/index.js';
import { HttpError } from '../../middleware/errors.js';
import { loadForMember } from './access.js';
import { addContribution } from './communities.js';
import { isCommunityRole, type CommunityRole } from './permissions.js';
/*
 * Visibility has exactly one definition, shared with the profile screen (`services/profile.ts`).
 * Two copies of "is this profile visible to me" is how a privacy switch ends up telling the truth on
 * one screen and lying on another.
 */
import { sharesCommunity, visibilityOf } from '../profile.js';
import type { BadgeView, LeaderboardEntry, ProfileView } from './types.js';

/* ------------------------------------------------------------------ badge catalogue ------------ */

interface BadgeDefinition {
  key: string;
  label: string;
  emoji: string;
  description: string;
  criteria: string;
}

/**
 * The catalogue is fixed in code rather than seeded as data, so a badge can never be created by a
 * hostile row and every one of them has a written criterion a student can read.
 */
export const BADGES: BadgeDefinition[] = [
  {
    key: 'first_help',
    label: 'First Help',
    emoji: '💡',
    description: 'Your first answer was marked helpful.',
    criteria: '1 helpful answer',
  },
  {
    key: 'top_solver',
    label: 'Top Solver',
    emoji: '🧠',
    description: 'You have become a reliable source of answers.',
    criteria: '10 helpful answers',
  },
  {
    key: 'challenge_finisher',
    label: 'Challenge Finisher',
    emoji: '🎯',
    description: 'You completed every day of a community challenge.',
    criteria: 'Finish all days of one challenge',
  },
  {
    key: 'competition_winner',
    label: 'Competition Winner',
    emoji: '🏆',
    description: 'You finished in the top three of a Vroqn competition.',
    criteria: 'Top 3 in a competition',
  },
  {
    key: 'competition_finalist',
    label: 'Competition Finalist',
    emoji: '🥈',
    description: 'You sat a timed Vroqn competition and finished in the top 25%.',
    criteria: 'Top 25% in a competition',
  },
  {
    key: 'consistent_learner',
    label: 'Consistent Learner',
    emoji: '📚',
    description: 'You contributed across several weeks without disappearing.',
    criteria: 'Active on 7 different days',
  },
  {
    key: 'resource_contributor',
    label: 'Resource Contributor',
    emoji: '📎',
    description: 'You shared study material with your community.',
    criteria: '3 shared resources',
  },
  {
    key: 'streak_7',
    label: '7-Day Streak',
    emoji: '⚡',
    description: 'You studied seven days in a row.',
    criteria: '7-day learning streak',
  },
];

export function badgeDefinition(key: string): BadgeDefinition | null {
  return BADGES.find((badge) => badge.key === key) ?? null;
}

/** All badges with this user's earned state. Unearned badges report `earnedAt: null`. */
export async function badgesFor(userId: string, communityId?: string | null): Promise<BadgeView[]> {
  const rows = await all<{ badge_key: string; earned_at: string; community_id: string | null }>(
    `SELECT badge_key, earned_at, community_id FROM user_badges
      WHERE user_id = ? AND (community_id = ? OR community_id IS NULL)`,
    [userId, communityId ?? null],
  );
  const earned = new Map(rows.map((row) => [row.badge_key, row]));
  return BADGES.map((badge) => {
    const record = earned.get(badge.key);
    return {
      key: badge.key,
      label: badge.label,
      emoji: badge.emoji,
      description: badge.description,
      criteria: badge.criteria,
      earnedAt: record?.earned_at ?? null,
      communityId: record?.community_id ?? null,
    };
  });
}

/**
 * Grants a badge if the user does not already hold it. Idempotent: calling it on every check is
 * cheap and safe, which is what lets badges be evaluated on an ordinary page load rather than
 * needing a background job.
 */
async function grant(
  userId: string,
  badgeKey: string,
  communityId: string | null,
  evidence: Record<string, unknown> = {},
): Promise<boolean> {
  const existing = await one<{ id: string }>(
    `SELECT id FROM user_badges WHERE user_id = ? AND badge_key = ? AND ${communityId ? 'community_id = ?' : 'community_id IS NULL'}`,
    communityId ? [userId, badgeKey, communityId] : [userId, badgeKey],
  );
  if (existing) return false;

  await run(
    `INSERT INTO user_badges (id, user_id, badge_key, community_id, evidence, earned_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuid(), userId, badgeKey, communityId, JSON.stringify(evidence), nowIso()],
  );

  // Earning a badge is worth telling the student about, once.
  const { createNotification } = await import('./notifications.js');
  const badge = badgeDefinition(badgeKey);
  if (badge) {
    await createNotification({
      userId,
      communityId,
      kind: 'badge',
      title: `${badge.emoji} Badge earned: ${badge.label}`,
      body: badge.description,
      link: communityId ? `/communities/${communityId}` : '/communities/my',
    });
  }
  return true;
}

/** Called by the challenge service when the final day is ticked off. */
export async function grantChallengesCompleted(userId: string, communityId: string): Promise<void> {
  await grant(userId, 'challenge_finisher', communityId, { reason: 'completed a challenge' });
}

/** Distinct days on which this student did something in Vroqn — the honest streak basis. */
async function activeDayCount(userId: string, days = 30): Promise<number> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await all<{ day: string }>(
    `SELECT DISTINCT SUBSTR(created_at, 1, 10) AS day FROM activity_events
      WHERE user_id = ? AND created_at >= ?`,
    [userId, since],
  );
  return rows.length;
}

/** Consecutive days ending today (or yesterday, so an evening streak is not lost at midnight). */
export async function learningStreak(userId: string): Promise<number> {
  const rows = await all<{ day: string }>(
    `SELECT DISTINCT SUBSTR(created_at, 1, 10) AS day FROM activity_events
      WHERE user_id = ? ORDER BY day DESC LIMIT 400`,
    [userId],
  );
  if (!rows.length) return 0;

  const days = rows.map((row) => row.day);
  const set = new Set(days);
  const today = new Date();
  const key = (date: Date) => date.toISOString().slice(0, 10);

  let cursor = new Date(today);
  if (!set.has(key(cursor))) {
    // Allow the streak to still count if today has not started yet.
    cursor = new Date(today.getTime() - 86_400_000);
    if (!set.has(key(cursor))) return 0;
  }

  let streak = 0;
  while (set.has(key(cursor)) && streak < 400) {
    streak += 1;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  return streak;
}

/**
 * Re-evaluate every badge for this student. Called on profile load and after relevant actions, so a
 * badge appears as soon as the underlying work exists — and never before.
 */
export async function evaluateBadges(userId: string, communityId?: string | null): Promise<void> {
  const community = communityId ?? null;

  const [helpful, resources, completedChallenges, activeDays, streak, competition] = await Promise.all([
    community
      ? one<{ total: number | null }>(
          `SELECT SUM(helpful_answers) AS total FROM community_members WHERE user_id = ? AND community_id = ?`,
          [userId, community],
        )
      : one<{ total: number | null }>(
          `SELECT SUM(helpful_answers) AS total FROM community_members WHERE user_id = ?`,
          [userId],
        ),
    one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM community_resources WHERE created_by = ?${community ? ' AND community_id = ?' : ''}`,
      community ? [userId, community] : [userId],
    ),
    all<{ challenge_id: string; days: string }>(
      `SELECT c.id AS challenge_id, c.days
         FROM community_challenges c
         JOIN challenge_progress p ON p.challenge_id = c.id AND p.user_id = ?
        WHERE 1 = 1${community ? ' AND c.community_id = ?' : ''}
        GROUP BY c.id, c.days`,
      community ? [userId, community] : [userId],
    ),
    activeDayCount(userId),
    learningStreak(userId),
    // Arena stores the rank and percentile it computed server-side; we read them, never recompute.
    one<{ percentile: number | null; rank: number | null; participant_count: number | null }>(
      `SELECT percentile, rank, participant_count FROM arena_results
        WHERE user_id = ? ORDER BY percentile DESC LIMIT 1`,
      [userId],
    ),
  ]);

  const helpfulCount = helpful?.total ?? 0;
  if (helpfulCount >= 1) await grant(userId, 'first_help', community, { helpfulAnswers: helpfulCount });
  if (helpfulCount >= 10) await grant(userId, 'top_solver', community, { helpfulAnswers: helpfulCount });
  if ((resources?.count ?? 0) >= 3) await grant(userId, 'resource_contributor', community, { resources: resources?.count });
  if (activeDays >= 7) await grant(userId, 'consistent_learner', community, { activeDays });
  if (streak >= 7) await grant(userId, 'streak_7', community, { streak });

  // "Finished every day" is decided from the stored day list, not from a percentage.
  for (const entry of completedChallenges) {
    let total = 0;
    try {
      const parsed = JSON.parse(entry.days);
      total = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      total = 0;
    }
    const done = await one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM challenge_progress WHERE challenge_id = ? AND user_id = ?`,
      [entry.challenge_id, userId],
    );
    if (total > 0 && (done?.count ?? 0) >= total) {
      await grant(userId, 'challenge_finisher', community, { challengeId: entry.challenge_id });
    }
  }

  // Arena already computes rank and percentile server-side, so a badge can trust them.
  if (competition?.percentile !== null && competition?.percentile !== undefined) {
    const percentile = competition.percentile;
    if (percentile >= 75) await grant(userId, 'competition_finalist', community, { percentile });
    if (percentile >= 97 || (competition.rank !== null && competition.rank <= 3)) {
      await grant(userId, 'competition_winner', community, { rank: competition.rank, percentile });
    }
  }
}

/* ------------------------------------------------------------------ leaderboard ----------------- */

export interface LeaderboardOptions {
  limit?: number;
  /** `contribution` (default) or `helpful`. Both are contribution metrics, not popularity. */
  metric?: 'contribution' | 'helpful';
}

export async function leaderboard(
  userId: string,
  communityId: string,
  options: LeaderboardOptions = {},
): Promise<{ entries: LeaderboardEntry[]; enabled: boolean }> {
  const { community, membership } = await loadForMember(userId, communityId, { requireMembership: true });

  // An owner can switch the leaderboard off (§25), and when it is off nobody's ranking is computed
  // or returned — not merely hidden in the UI.
  if (!bool(community.is_leaderboard_enabled)) {
    return { entries: [], enabled: false };
  }

  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const order = options.metric === 'helpful' ? 'm.helpful_answers DESC' : 'm.contribution_points DESC';

  const rows = await all<{
    user_id: string;
    name: string;
    role: string;
    contribution_points: number | null;
    helpful_answers: number | null;
    challenges: number;
    competitions: number;
    resources: number;
  }>(
    `SELECT m.user_id, u.name, m.role, m.contribution_points, m.helpful_answers,
            (SELECT COUNT(*) FROM challenge_progress p
              JOIN community_challenges c ON c.id = p.challenge_id
             WHERE p.user_id = m.user_id AND c.community_id = m.community_id) AS challenges,
            (SELECT COUNT(*) FROM arena_attempts a
              JOIN community_competitions cc ON cc.competition_id = a.competition_id
             WHERE a.user_id = m.user_id AND cc.community_id = m.community_id) AS competitions,
            (SELECT COUNT(*) FROM community_resources r
             WHERE r.created_by = m.user_id AND r.community_id = m.community_id) AS resources
       FROM community_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.community_id = ? AND m.status IN ('active','muted')
      ORDER BY ${order}, m.helpful_answers DESC, m.joined_at
      LIMIT ?`,
    [communityId, limit],
  );

  void membership;
  return {
    enabled: true,
    entries: rows.map((row, index) => ({
      userId: row.user_id,
      name: row.name,
      role: isCommunityRole(row.role) ? (row.role as CommunityRole) : 'member',
      contributionPoints: row.contribution_points ?? 0,
      helpfulAnswers: row.helpful_answers ?? 0,
      challengesCompleted: row.challenges ?? 0,
      competitionsParticipated: row.competitions ?? 0,
      resourcesContributed: row.resources ?? 0,
      rank: index + 1,
      isSelf: row.user_id === userId,
    })),
  };
}

/* ------------------------------------------------------------------ profiles -------------------- */

/**
 * A student's public community profile (§35).
 *
 * Privacy controls are honoured *server-side*: if the subject has turned off their activity, the
 * response simply does not contain it, rather than sending it and asking the UI to hide it.
 */
export async function profileView(viewerId: string, userId: string): Promise<ProfileView> {
  const [user, settings] = await Promise.all([
    one<{ id: string; name: string; class_level: string | null }>(
      `SELECT id, name, class_level FROM users WHERE id = ?`,
      [userId],
    ),
    one<{
      bio: string;
      interests: string;
      is_profile_public: number | null;
      profile_visibility: string | null;
      is_activity_visible: number | null;
      is_communities_visible: number | null;
    }>(
      `SELECT bio, interests, is_profile_public, profile_visibility,
              is_activity_visible, is_communities_visible
         FROM community_profile_settings WHERE user_id = ?`,
      [userId],
    ),
  ]);
  if (!user) throw new HttpError(404, 'That student does not exist.', 'not_found');

  const isSelf = viewerId === userId;
  const visibility = settings ? visibilityOf(settings) : 'public';
  const isProfilePublic = visibility === 'public';
  /*
   * 'members' (0011) means exactly what it says: a student in the same community sees this profile,
   * a stranger does not. Evaluated here as well as on the profile screen so the community member
   * list and the profile it opens never disagree.
   */
  const memberOfSameCommunity = visibility === 'members' && !isSelf ? await sharesCommunity(viewerId, userId) : false;
  /*
   * Two different questions, and conflating them is how privacy screens end up lying:
   *  - `activityVisible` / `communitiesVisible` report the *stored preference*, so a student who
   *    turned their activity off sees it as off rather than being told it is on.
   *  - `includeActivity` / `includeCommunities` decide what data this *response* may contain. The
   *    owner of the profile always gets their own data back, because hiding it from yourself would
   *    just make the screen look broken.
   */
  const activityVisible = settings ? bool(settings.is_activity_visible) : true;
  const communitiesVisible = settings ? bool(settings.is_communities_visible) : true;
  const includeActivity = isSelf || activityVisible;
  const includeCommunities = isSelf || communitiesVisible;

  // A private profile still responds — with an empty shell — so the UI can say "this profile is
  // private" without the server leaking whether the student exists elsewhere.
  if (!isSelf && !isProfilePublic && !memberOfSameCommunity) {
    return {
      userId,
      name: user.name,
      bio: '',
      interests: [],
      classLevel: null,
      isProfilePublic: false,
      isActivityVisible: false,
      isCommunitiesVisible: false,
      isSelf: false,
      joinedCommunities: [],
      createdCommunities: [],
      competitions: { participated: 0, completed: 0 },
      badges: [],
      streakDays: 0,
    };
  }

  const [joined, created, competitions] = await Promise.all([
    includeCommunities
      ? all<{ id: string; name: string; slug: string; role: string }>(
          `SELECT c.id, c.name, c.slug, m.role
             FROM community_members m JOIN communities c ON c.id = m.community_id
            WHERE m.user_id = ? AND m.status IN ('active','muted') AND c.status = 'active'
            ORDER BY c.name LIMIT 40`,
          [userId],
        )
      : Promise.resolve([]),
    communitiesVisible
      ? all<{ id: string; name: string; slug: string; member_count: number }>(
          // Communities the student runs — created by them, or handed over to them.
          `SELECT c.id, c.name, c.slug,
                  (SELECT COUNT(*) FROM community_members mm WHERE mm.community_id = c.id AND mm.status IN ('active','muted')) AS member_count
             FROM communities c
            WHERE c.status = 'active'
              AND (c.created_by = ?
                   OR c.id IN (SELECT community_id FROM community_members
                                WHERE user_id = ? AND role = 'owner' AND status IN ('active','muted')))
            ORDER BY c.created_at DESC LIMIT 20`,
          [userId, userId],
        )
      : Promise.resolve([]),
    includeActivity
      ? one<{ participated: number; completed: number }>(
          `SELECT COUNT(*) AS participated,
                  SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS completed
             FROM arena_attempts WHERE user_id = ?`,
          [userId],
        )
      : Promise.resolve(null),
  ]);

  return {
    userId,
    name: user.name,
    bio: settings?.bio ?? '',
    interests: parseInterests(settings?.interests ?? null),
    // Class level is shown only when the student is looking at their own profile or has left their
    // activity visible: it is mild personal information and there is no reason to volunteer it (§43).
    classLevel: includeActivity ? user.class_level : null,
    isProfilePublic,
    isActivityVisible: activityVisible,
    isCommunitiesVisible: communitiesVisible,
    isSelf,
    joinedCommunities: joined.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      role: isCommunityRole(row.role) ? (row.role as CommunityRole) : 'member',
    })),
    createdCommunities: created.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      memberCount: row.member_count ?? 0,
    })),
    competitions: {
      participated: competitions?.participated ?? 0,
      completed: competitions?.completed ?? 0,
    },
    badges: includeActivity ? (await badgesFor(userId, null)).filter((badge) => badge.earnedAt) : [],
    streakDays: includeActivity ? await learningStreak(userId) : 0,
  };
}

function parseInterests(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((i): i is string => typeof i === 'string').slice(0, 12) : [];
  } catch {
    return [];
  }
}

export async function updateProfileSettings(
  userId: string,
  patch: {
    bio?: string;
    interests?: unknown;
    isProfilePublic?: boolean;
    isActivityVisible?: boolean;
    isCommunitiesVisible?: boolean;
  },
): Promise<void> {
  const existing = await one<{ id: string }>(
    `SELECT id FROM community_profile_settings WHERE user_id = ?`,
    [userId],
  );

  const bio = (patch.bio ?? '').trim().slice(0, 400);
  const interests = Array.isArray(patch.interests)
    ? patch.interests
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 12)
    : [];

  const now = nowIso();
  if (existing) {
    const fields: string[] = [];
    const params: unknown[] = [];
    if (patch.bio !== undefined) {
      fields.push('bio = ?');
      params.push(bio);
    }
    if (patch.interests !== undefined) {
      fields.push('interests = ?');
      params.push(JSON.stringify(interests));
    }
    if (patch.isProfilePublic !== undefined) {
      fields.push('is_profile_public = ?');
      params.push(patch.isProfilePublic ? 1 : 0);
    }
    if (patch.isActivityVisible !== undefined) {
      fields.push('is_activity_visible = ?');
      params.push(patch.isActivityVisible ? 1 : 0);
    }
    if (patch.isCommunitiesVisible !== undefined) {
      fields.push('is_communities_visible = ?');
      params.push(patch.isCommunitiesVisible ? 1 : 0);
    }
    if (!fields.length) return;
    fields.push('updated_at = ?');
    params.push(now, userId);
    await run(`UPDATE community_profile_settings SET ${fields.join(', ')} WHERE user_id = ?`, params);
    return;
  }

  await run(
    `INSERT INTO community_profile_settings
       (id, user_id, bio, interests, is_profile_public, is_activity_visible, is_communities_visible, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid(),
      userId,
      bio,
      JSON.stringify(interests),
      patch.isProfilePublic === false ? 0 : 1,
      patch.isActivityVisible === false ? 0 : 1,
      patch.isCommunitiesVisible === false ? 0 : 1,
      now,
    ],
  );
}

/**
 * Block another student (§43). Blocking is one-directional and private: the blocked student is never
 * told, which is what makes it safe to use.
 */
export async function blockUser(userId: string, blockedUserId: string): Promise<void> {
  if (userId === blockedUserId) throw new HttpError(400, 'You cannot block yourself.', 'validation_error');
  const target = await one<{ id: string }>(`SELECT id FROM users WHERE id = ?`, [blockedUserId]);
  if (!target) throw new HttpError(404, 'That student does not exist.', 'not_found');

  const existing = await one<{ id: string }>(
    `SELECT id FROM community_blocks WHERE user_id = ? AND blocked_user_id = ?`,
    [userId, blockedUserId],
  );
  if (existing) return;
  await run(
    `INSERT INTO community_blocks (id, user_id, blocked_user_id, created_at) VALUES (?, ?, ?, ?)`,
    [uuid(), userId, blockedUserId, nowIso()],
  );
}

export async function unblockUser(userId: string, blockedUserId: string): Promise<void> {
  await run(`DELETE FROM community_blocks WHERE user_id = ? AND blocked_user_id = ?`, [
    userId,
    blockedUserId,
  ]);
}

export async function blockedUserIds(userId: string): Promise<string[]> {
  const rows = await all<{ blocked_user_id: string }>(
    `SELECT blocked_user_id FROM community_blocks WHERE user_id = ?`,
    [userId],
  );
  return rows.map((row) => row.blocked_user_id);
}

/** Contribution summary for a community, shown on the member's own view. */
export async function myContribution(userId: string, communityId: string) {
  await loadForMember(userId, communityId, { requireMembership: true });
  const row = await one<{ contribution_points: number | null; helpful_answers: number | null; role: string }>(
    `SELECT contribution_points, helpful_answers, role FROM community_members
      WHERE community_id = ? AND user_id = ?`,
    [communityId, userId],
  );
  const rank = await one<{ position: number }>(
    `SELECT COUNT(*) + 1 AS position FROM community_members
      WHERE community_id = ? AND status IN ('active','muted')
        AND contribution_points > COALESCE((SELECT contribution_points FROM community_members WHERE community_id = ? AND user_id = ?), 0)`,
    [communityId, communityId, userId],
  );

  return {
    contributionPoints: row?.contribution_points ?? 0,
    helpfulAnswers: row?.helpful_answers ?? 0,
    role: isCommunityRole(row?.role ?? '') ? (row!.role as CommunityRole) : 'member',
    rank: rank?.position ?? null,
  };
}

export { addContribution };
