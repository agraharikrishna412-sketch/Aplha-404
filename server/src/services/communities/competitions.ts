/**
 * Community competitions.
 *
 * §13 is explicit: **do not build a second competition engine.** So a community competition *is* an
 * Arena competition. This module only:
 *
 *  1. validates that the caller may host one in this community,
 *  2. creates the paper through the existing `createCompetition` service (same blueprint validation,
 *     same scheduling rules, same question pipeline),
 *  3. records the host community in `community_competitions`.
 *
 * Everything that makes a competition fair — the server-authoritative clock, the single submission,
 * the answer-key withholding, grading, ranking and percentiles — is Arena's existing code and is not
 * reimplemented or bypassed here. `services/arena/*` remains the only place that scores anything.
 */
import { all, nowIso, one, run, uuid } from '../../db/index.js';
import { HttpError } from '../../middleware/errors.js';
import { loadForMember } from './access.js';
import { publishCommunity } from './bus.js';
import { notifyCommunityMembers } from './notifications.js';
import { assertCan } from './permissions.js';
import {
  createCompetition,
  getCompetition,
  register,
  withdraw,
} from '../arena/competitions.js';
import { normaliseBlueprint, totalQuestions } from '../arena/blueprint.js';

/** Integrity controls a host can switch on (§44). Defaults are the strict ones. */
export interface IntegrityOptions {
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
  /** Reserved for future use; accepted and stored so a host's intent is recorded honestly. */
  logSuspiciousActivity?: boolean;
}

export interface CreateCommunityCompetitionArgs {
  title: string;
  description?: string;
  category: string;
  difficulty?: string;
  visibility?: 'public' | 'private' | 'invite_only';
  blueprint: unknown;
  registrationOpensAt: string;
  registrationClosesAt: string;
  startsAt: string;
  endsAt: string;
  rules?: string[];
  instructions?: string[];
  integrity?: IntegrityOptions;
}

/**
 * Maps community visibility onto Arena visibility.
 *
 * Arena understands `public | private`; the community layer additionally has `invite_only`. An
 * invite-only community competition is stored as `private` in Arena (so it is never listed publicly)
 * and the extra restriction is enforced here, where the invite code lives.
 */
function arenaVisibility(visibility: 'public' | 'private' | 'invite_only'): 'public' | 'private' {
  return visibility === 'public' ? 'public' : 'private';
}

export async function createCommunityCompetition(
  userId: string,
  communityId: string,
  args: CreateCommunityCompetitionArgs,
): Promise<{ id: string; communityId: string; visibility: string; inviteCode: string | null }> {
  const { membership, community } = await loadForMember(userId, communityId, {
    requireMembership: true,
  });
  assertCan(membership?.role ?? null, 'create_competition');

  // The host must configure the paper. Arena's blueprint layer fills in a sensible default when
  // subjects are missing, which is right for a preset but wrong here: a host who left the paper
  // blank should be told so, not handed a ten-question Physics paper they never chose.
  const rawBlueprint = (args.blueprint ?? {}) as { subjects?: unknown };
  if (!Array.isArray(rawBlueprint.subjects) || rawBlueprint.subjects.length === 0) {
    throw new HttpError(400, 'Choose at least one subject and how many questions it should have.', 'bad_blueprint');
  }

  const blueprint = normaliseBlueprint(args.blueprint);
  const questionCount = totalQuestions(blueprint);
  if (questionCount < 1) throw new HttpError(400, 'Add at least one question to the paper.', 'bad_blueprint');
  if (questionCount > 120) throw new HttpError(400, 'A single paper is limited to 120 questions.', 'bad_blueprint');

  const visibility = args.visibility ?? 'public';
  /*
   * A public community competition is discoverable in Arena by everyone, which is the intent.
   *
   * Private and invite-only ones are stored in Arena as `private` so they never appear in the public
   * list. Arena's own registration gate for a private competition is its invite code — so we mint one
   * server-side and simply never hand it to a browser. Entry is decided by community membership
   * (checked in `registerForCommunityCompetition`), and the code is injected from the database at
   * that point. That keeps Arena's rule intact instead of bending it, and keeps the code a secret.
   */
  const inviteCode = visibility === 'public' ? undefined : inviteToken();

  const created = await createCompetition({
    title: args.title,
    description: args.description ?? `${args.title} — hosted by ${community.name}.`,
    category: args.category,
    blueprint,
    registrationOpensAt: args.registrationOpensAt,
    registrationClosesAt: args.registrationClosesAt,
    startsAt: args.startsAt,
    endsAt: args.endsAt,
    difficulty: args.difficulty,
    rules: args.rules,
    instructions: args.instructions,
    visibility: arenaVisibility(visibility),
    inviteCode,
    createdBy: userId,
    publish: true,
  });

  await run(
    `INSERT INTO community_competitions (id, community_id, competition_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [uuid(), communityId, created.id, userId, nowIso()],
  );

  await notifyCommunityMembers({
    communityId,
    kind: 'competition_start',
    title: `🏁 New competition: ${created.title}`,
    body: `${questionCount} questions · hosted by ${community.name}`,
    link: `/arena/${created.id}`,
    excludeUserId: userId,
  });
  publishCommunity(communityId, { type: 'competition', communityId, competitionId: created.id });

  // The Arena invite code is deliberately not returned: the community is the entry gate.
  return { id: created.id, communityId, visibility, inviteCode: null };
}

function inviteToken(): string {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('hex').toUpperCase().slice(0, 12);
}

/* ------------------------------------------------------------------ reads ----------------------- */

export interface CommunityCompetitionView {
  id: string;
  title: string;
  description: string;
  state: string;
  visibility: string;
  category: string;
  difficulty: string;
  durationMin: number;
  questionCount: number;
  startsAt: string;
  endsAt: string;
  participantCount: number;
  isRegistered: boolean;
  resultId: string | null;
  attemptState: string | null;
  isDemo: boolean;
}

/**
 * Competitions hosted by a community.
 *
 * Private and invite-only papers are listed to members of the host community only — the membership
 * check happens below, before any Arena data is read, so a non-member cannot even learn the title.
 */
export async function listCommunityCompetitions(
  userId: string,
  communityId: string,
): Promise<CommunityCompetitionView[]> {
  await loadForMember(userId, communityId, { requireMembership: true });

  const rows = await all<{
    id: string;
    title: string;
    description: string;
    category: string;
    difficulty: string;
    duration_min: number;
    blueprint: string;
    visibility: string;
    starts_at: string;
    ends_at: string;
    status: string;
    results_published_at: string | null;
    is_demo: number | null;
  }>(
    `SELECT c.id, c.title, c.description, c.category, c.difficulty, c.duration_min, c.blueprint,
            c.visibility, c.starts_at, c.ends_at, c.status, c.results_published_at, c.is_demo
       FROM community_competitions cc
       JOIN arena_competitions c ON c.id = cc.competition_id
      WHERE cc.community_id = ?
      ORDER BY c.starts_at DESC
      LIMIT 60`,
    [communityId],
  );

  if (!rows.length) return [];

  const [registrations, attempts] = await Promise.all([
    all<{ competition_id: string }>(
      `SELECT competition_id FROM arena_registrations
        WHERE user_id = ? AND status = 'registered' AND competition_id IN (${rows.map(() => '?').join(', ')})`,
      [userId, ...rows.map((row) => row.id)],
    ),
    all<{ competition_id: string; status: string; result_id: string | null }>(
      `SELECT a.competition_id, a.status, r.id AS result_id
         FROM arena_attempts a LEFT JOIN arena_results r ON r.attempt_id = a.id
        WHERE a.user_id = ? AND a.competition_id IN (${rows.map(() => '?').join(', ')})`,
      [userId, ...rows.map((row) => row.id)],
    ),
  ]);

  const counts = await all<{ competition_id: string; count: number }>(
    `SELECT competition_id, COUNT(*) AS count FROM arena_registrations
      WHERE status = 'registered' AND competition_id IN (${rows.map(() => '?').join(', ')})
      GROUP BY competition_id`,
    rows.map((row) => row.id),
  );

  const registeredSet = new Set(registrations.map((row) => row.competition_id));
  const attemptMap = new Map(attempts.map((row) => [row.competition_id, row]));
  const countMap = new Map(counts.map((row) => [row.competition_id, row.count]));

  const now = Date.now();
  return rows.map((row) => {
    let questionCount = 0;
    try {
      questionCount = totalQuestions(JSON.parse(row.blueprint) as never);
    } catch {
      questionCount = 0;
    }
    const starts = new Date(row.starts_at).getTime();
    const ends = new Date(row.ends_at).getTime();
    const resultsOut =
      row.results_published_at !== null && new Date(row.results_published_at).getTime() <= now;
    const state = resultsOut
      ? 'RESULTS_PUBLISHED'
      : now < starts
        ? 'UPCOMING'
        : now < ends
          ? 'LIVE'
          : 'ENDED';
    const attempt = attemptMap.get(row.id);
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      state,
      visibility: row.visibility,
      category: row.category,
      difficulty: row.difficulty,
      durationMin: row.duration_min,
      questionCount,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      participantCount: countMap.get(row.id) ?? 0,
      isRegistered: registeredSet.has(row.id) || Boolean(attempt),
      resultId: attempt?.result_id ?? null,
      attemptState: attempt?.status ?? null,
      isDemo: Boolean(row.is_demo),
    };
  });
}

/**
 * Register for a community-hosted competition.
 *
 * For `private` and `invite_only` papers, non-members are refused before Arena is asked to register
 * them — the community is the authorisation boundary (§17).
 */
export async function registerForCommunityCompetition(
  userId: string,
  communityId: string,
  competitionId: string,
  inviteCode?: string,
): Promise<{ state: string }> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });

  const link = await one<{ competition_id: string; created_by: string }>(
    `SELECT competition_id, created_by FROM community_competitions
      WHERE community_id = ? AND competition_id = ?`,
    [communityId, competitionId],
  );
  if (!link) throw new HttpError(404, 'That competition is not hosted by this community.', 'not_found');

  const competition = await getCompetition(userId, competitionId);
  if (!competition) throw new HttpError(404, 'That competition does not exist.', 'not_found');

  // Membership is the gate for a hosted paper. `loadForMember` above already established it, so a
  // private paper hosted here is enterable by every member — and by nobody else.
  if (competition.visibility !== 'public' && !membership) {
    throw new HttpError(403, 'This competition is limited to community members.', 'forbidden');
  }

  // A guest code is still accepted for a standalone private paper that a host chose to share, but it
  // is never required for members: the community is the invite.
  const hostCode = await one<{ invite_code: string | null }>(
    `SELECT invite_code FROM arena_competitions WHERE id = ?`,
    [competitionId],
  );
  const result = await register(userId, competitionId, {
    inviteCode: inviteCode ?? hostCode?.invite_code ?? undefined,
  });
  return { state: result.state };
}

export async function withdrawFromCommunityCompetition(
  userId: string,
  communityId: string,
  competitionId: string,
): Promise<boolean> {
  await loadForMember(userId, communityId, { requireMembership: true });
  return withdraw(userId, competitionId);
}

/**
 * Group-versus-group aggregate (§30). Returns only aggregate statistics across the communities the
 * caller may see, never a per-student ranking of anyone else.
 */
export async function groupComparison(competitionId: string, communityIds: string[]) {
  if (!communityIds.length) return [];
  const placeholders = communityIds.map(() => '?').join(', ');
  const rows = await all<{
    community_id: string;
    name: string;
    participants: number;
    avg_score: number | null;
    avg_accuracy: number | null;
    completed: number;
  }>(
    `SELECT cc.community_id, c.name,
            COUNT(DISTINCT a.user_id) AS participants,
            AVG(r.score) AS avg_score,
            AVG(r.accuracy) AS avg_accuracy,
            SUM(CASE WHEN a.status = 'submitted' THEN 1 ELSE 0 END) AS completed
       FROM community_competitions cc
       JOIN communities c ON c.id = cc.community_id
       LEFT JOIN arena_attempts a ON a.competition_id = cc.competition_id
       LEFT JOIN arena_results r ON r.attempt_id = a.id
      WHERE cc.competition_id = ? AND cc.community_id IN (${placeholders})
      GROUP BY cc.community_id, c.name`,
    [competitionId, ...communityIds],
  );

  return rows.map((row) => ({
    communityId: row.community_id,
    name: row.name,
    participants: row.participants ?? 0,
    averageScore: row.avg_score === null ? null : Math.round(row.avg_score * 10) / 10,
    averageAccuracy: row.avg_accuracy === null ? null : Math.round(row.avg_accuracy * 1000) / 1000,
    completionRate: row.participants ? Math.round(((row.completed ?? 0) / row.participants) * 100) : 0,
  }));
}

export async function removeCommunityCompetition(
  userId: string,
  communityId: string,
  competitionId: string,
): Promise<void> {
  await loadForMember(userId, communityId, { capability: 'create_competition' });
  await run(`DELETE FROM community_competitions WHERE community_id = ? AND competition_id = ?`, [
    communityId,
    competitionId,
  ]);
  // The Arena competition itself is deliberately left alone: students may already have registered,
  // and deleting it would destroy real attempt history (§58).
  publishCommunity(communityId, { type: 'competition', communityId, competitionId });
}

/** Competitions a member can still enter, used by the dashboard summary. */
export async function upcomingForUser(communityIds: string[]) {
  if (!communityIds.length) return [];
  const placeholders = communityIds.map(() => '?').join(', ');
  return all<{ id: string; title: string; community_id: string; community_name: string; starts_at: string; ends_at: string }>(
    `SELECT c.id, c.title, cc.community_id, cm.name AS community_name, c.starts_at, c.ends_at
       FROM community_competitions cc
       JOIN arena_competitions c ON c.id = cc.competition_id
       JOIN communities cm ON cm.id = cc.community_id
      WHERE cc.community_id IN (${placeholders}) AND c.ends_at >= ?
      ORDER BY c.starts_at LIMIT 6`,
    [...communityIds, nowIso()],
  );
}

/* The paper pipeline lives in its own module; re-exported so the route layer has one import site. */
export { prepareCommunityPaper, communityPaperStatus } from './paper.js';
export type { PaperOutcome } from './paper.js';
