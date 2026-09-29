/**
 * Competition lifecycle: creation (admin), listing, details, registration and the state machine.
 *
 * Timing is always derived from the server clock plus stored timestamps — the student's device
 * clock is never trusted, and it can never move a competition into a state the server does not
 * agree with.
 */
import * as db from '../../db/index.js';
import { nowIso, uuid } from '../../db/index.js';
import { HttpError } from '../../middleware/errors.js';
import { PROVIDER_IDS } from '../../config/models.js';
import type {
  ArenaAttemptRow,
  ArenaBlueprint,
  ArenaCompetitionDetail,
  ArenaCompetitionRow,
  ArenaCompetitionSummary,
  ArenaRegistrationStatus,
  CompetitionState,
  CompetitionStatus,
} from '../../types/arena.js';
import { CATEGORIES, blueprintView, categoryLabel, maxScore, normaliseBlueprint, totalQuestions } from './blueprint.js';
import { reviewCounts } from './questions.js';

const DEFAULT_RULES = [
  'This is an independent Vroqn competitive mock examination — it is not an official JEE/NEET examination.',
  'The competition opens and closes at the times shown. The server clock decides everything.',
  'Your answers are saved on the server as you go, so a lost connection does not lose your work.',
  'Submitting early ends your attempt. It cannot be restarted.',
  'Wrong answers carry negative marks; leaving a question blank never costs you marks.',
  'Results are published after submissions close and every attempt is scored.',
];

const DEFAULT_INSTRUCTIONS = [
  'Attempt the paper in one sitting; the timer starts when you enter.',
  'Use the question palette to move around, and mark anything you want to revisit.',
  'You can change any answer until you press Submit.',
  'Keep an eye on the timer — when the paper time runs out the server submits what you have saved.',
];

/* ------------------------------------------------------------------ */
/* State machine                                                       */
/* ------------------------------------------------------------------ */

export interface StateInput {
  status: CompetitionStatus;
  registration_opens_at: string;
  registration_closes_at: string;
  starts_at: string;
  ends_at: string;
  results_published_at: string | null;
}

/**
 * Derives the student-visible state.
 *
 * Stored status records administrative decisions (published for registration, closed by staff,
 * processing, archived); the clock decides UPCOMING → REGISTRATION_OPEN → LIVE → SUBMISSION_CLOSED.
 */
export function computeState(row: StateInput, now: Date = new Date()): CompetitionState {
  if (row.status === 'archived') return 'ARCHIVED';
  if (row.results_published_at || row.status === 'results_published') return 'RESULTS_PUBLISHED';
  if (row.status === 'processing') return 'PROCESSING_RESULTS';

  const starts = new Date(row.starts_at).getTime();
  const ends = new Date(row.ends_at).getTime();
  const t = now.getTime();

  if (row.status === 'draft') return 'UPCOMING';
  if (t >= starts && t < ends) return 'LIVE';
  if (t >= ends || row.status === 'submission_closed') return 'SUBMISSION_CLOSED';

  // Registration window (also honours an explicit admin close).
  if (row.status === 'registration_closed') return 'UPCOMING';
  const opens = new Date(row.registration_opens_at).getTime();
  const closes = new Date(row.registration_closes_at).getTime();
  if (t >= opens && t < closes) return 'REGISTRATION_OPEN';
  return 'UPCOMING';
}

/** Single definition of "results are visible to students", used by both the routes and the UI. */
export function isPublished(row: StateInput, now: Date = new Date()): boolean {
  const state = computeState(row, now);
  return state === 'RESULTS_PUBLISHED' || state === 'ARCHIVED';
}

export function stateLabel(state: CompetitionState): string {
  const map: Record<CompetitionState, string> = {
    UPCOMING: 'Upcoming',
    REGISTRATION_OPEN: 'Registration open',
    LIVE: 'Live now',
    SUBMISSION_CLOSED: 'Submissions closed',
    PROCESSING_RESULTS: 'Processing results',
    RESULTS_PUBLISHED: 'Results published',
    ARCHIVED: 'Archived',
  };
  return map[state];
}

export function isRegistrationOpen(state: CompetitionState): boolean {
  return state === 'REGISTRATION_OPEN' || state === 'UPCOMING';
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

function toSummary(
  row: ArenaCompetitionRow,
  ctx: {
    now?: Date;
    participantCount: number;
    registration: { id: string; status: ArenaRegistrationStatus; registeredAt: string } | null;
    review?: ArenaCompetitionSummary['reviewCounts'];
    /** The signed-in student, used only to mark the creator as the host of this paper. */
    viewerId?: string;
  },
): ArenaCompetitionSummary {
  const blueprint = normaliseBlueprint(JSON.parse(row.blueprint || '{}'));
  const state = computeState(row, ctx.now ?? new Date());
  const questionCount = totalQuestions(blueprint);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    categoryLabel: categoryLabel(row.category),
    status: row.status,
    state,
    registrationOpensAt: row.registration_opens_at,
    registrationClosesAt: row.registration_closes_at,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    durationMin: Number(row.duration_min),
    questionCount,
    difficulty: row.difficulty,
    subjects: blueprint.subjects.map((s) => s.subject),
    difficultyMix: blueprint.difficulty,
    typeMix: blueprint.types,
    marksPerQuestion: blueprint.marksPerQuestion,
    negativeMarks: blueprint.negativeMarks,
    maxScore: maxScore(blueprint),
    isDemo: row.is_demo === 1,
    visibility: (row.visibility as 'public' | 'private') ?? 'public',
    resultsPublishedAt: row.results_published_at,
    participantCount: ctx.participantCount,
    registration: ctx.registration,
    reviewCounts: ctx.review,
    isHost: Boolean(ctx.viewerId && row.created_by === ctx.viewerId),
  };
}

/** Registered participants — never personal data, just a count. */
async function participantCounts(competitionIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!competitionIds.length) return out;
  const placeholders = competitionIds.map(() => '?').join(', ');
  const rows = await db.all<{ competition_id: string; c: number }>(
    `SELECT competition_id, COUNT(*) AS c FROM arena_registrations
      WHERE status = 'registered' AND competition_id IN (${placeholders})
      GROUP BY competition_id`,
    competitionIds,
  );
  for (const row of rows) out.set(row.competition_id, Number(row.c));
  return out;
}

async function registrationFor(userId: string, competitionId: string) {
  const row = await db.one<{ id: string; status: string; registered_at: string }>(
    'SELECT id, status, registered_at FROM arena_registrations WHERE competition_id = ? AND user_id = ?',
    [competitionId, userId],
  );
  return row ? { id: row.id, status: row.status as ArenaRegistrationStatus, registeredAt: row.registered_at } : null;
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export interface ListOptions {
  /** Include drafts and demos — only for admins. */
  includeUnpublished?: boolean;
  /** Restrict to competitions this student registered for. */
  onlyRegisteredFor?: string;
  limit?: number;
}

/**
 * Who may *see* a competition that is not public.
 *
 * Public papers are for everyone. A private or invite-only paper is listed and readable only by the
 * host, by a student who is already registered, by someone who may administer the site, and — since a
 * community can host a paper — by the members of that community.
 *
 * Without this every non-draft paper was in the public list, so a community's members-only paper was
 * announced to the whole site and its title, rules and participant count were readable by anybody who
 * guessed the id (§17, §53).
 */
function visibilityClause(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  /*
   * Three placeholders, in order: the host, a registered student, a member of the hosting community.
   * The caller supplies the same user id three times.
   */
  return `(${prefix}visibility = 'public'
            OR ${prefix}created_by = ?
            OR ${prefix}id IN (SELECT competition_id FROM arena_registrations WHERE user_id = ?)
            OR ${prefix}id IN (SELECT cc.competition_id FROM community_competitions cc
                                 JOIN community_members m ON m.community_id = cc.community_id
                                WHERE m.user_id = ? AND m.status IN ('active','muted')))`;
}

/** True when this student may read the given paper. The rule itself is `visibilityClause`. */
async function canViewCompetition(userId: string, competitionId: string): Promise<boolean> {
  const row = await db.one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM arena_competitions a WHERE a.id = ? AND ${visibilityClause('a')}`,
    [competitionId, userId, userId, userId],
  );
  return (row?.total ?? 0) > 0;
}

export async function listCompetitions(userId: string, opts: ListOptions = {}): Promise<ArenaCompetitionSummary[]> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (!opts.includeUnpublished) {
    clauses.push("status != 'draft'");
  }
  if (opts.onlyRegisteredFor) {
    clauses.push('id IN (SELECT competition_id FROM arena_registrations WHERE user_id = ? AND status = ?)');
    params.push(opts.onlyRegisteredFor, 'registered');
  }
  if (!opts.includeUnpublished) {
    // `includeUnpublished` is the admin flag throughout this module: an admin sees drafts too, and
    // therefore also everything else.
    clauses.push(visibilityClause());
    params.push(userId, userId, userId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.all<ArenaCompetitionRow>(
    `SELECT * FROM arena_competitions ${where} ORDER BY starts_at ASC LIMIT ?`,
    [...params, Math.min(Math.max(opts.limit ?? 50, 1), 200)],
  );

  const counts = await participantCounts(rows.map((r) => r.id));
  const mine = await db.all<{ competition_id: string; id: string; status: string; registered_at: string }>(
    'SELECT competition_id, id, status, registered_at FROM arena_registrations WHERE user_id = ?',
    [userId],
  );
  const mineMap = new Map(mine.map((m) => [m.competition_id, m]));
  const now = new Date();

  const summaries: ArenaCompetitionSummary[] = [];
  for (const row of rows) {
    const reg = mineMap.get(row.id);
    summaries.push(
      toSummary(row, {
        now,
        participantCount: counts.get(row.id) ?? 0,
        registration: reg ? { id: reg.id, status: reg.status as ArenaRegistrationStatus, registeredAt: reg.registered_at } : null,
        review: opts.includeUnpublished ? await reviewCounts(row.id) : undefined,
        viewerId: userId,
      }),
    );
  }

  // Live first, then registration-open, then the rest — by start time inside each group.
  const order: Record<CompetitionState, number> = {
    LIVE: 0,
    REGISTRATION_OPEN: 1,
    UPCOMING: 2,
    PROCESSING_RESULTS: 3,
    RESULTS_PUBLISHED: 4,
    SUBMISSION_CLOSED: 5,
    ARCHIVED: 6,
  };
  return summaries.sort((a, b) => {
    const byState = order[a.state] - order[b.state];
    if (byState !== 0) return byState;
    return a.startsAt.localeCompare(b.startsAt);
  });
}

export async function getCompetition(
  userId: string,
  competitionId: string,
  opts: { includeUnpublished?: boolean } = {},
): Promise<ArenaCompetitionDetail | null> {
  const row = await db.one<ArenaCompetitionRow>('SELECT * FROM arena_competitions WHERE id = ?', [competitionId]);
  if (!row) return null;
  if (row.status === 'draft' && !opts.includeUnpublished) return null;
  // A 404, not a 403: the caller is not told that a private paper with this id exists.
  if (!opts.includeUnpublished && !(await canViewCompetition(userId, competitionId))) return null;

  const counts = await participantCounts([row.id]);
  const summary = toSummary(row, {
    participantCount: counts.get(row.id) ?? 0,
    registration: await registrationFor(userId, row.id),
    review: opts.includeUnpublished ? await reviewCounts(row.id) : undefined,
    viewerId: userId,
  });

  return {
    ...summary,
    rules: row.rules ? (JSON.parse(row.rules) as string[]) : DEFAULT_RULES,
    instructions: row.instructions ? (JSON.parse(row.instructions) as string[]) : DEFAULT_INSTRUCTIONS,
    serverNow: nowIso(),
  };
}

export async function myCompetitions(userId: string): Promise<{
  upcoming: ArenaCompetitionSummary[];
  live: ArenaCompetitionSummary[];
  completed: ArenaCompetitionSummary[];
  attempts: Record<string, { attemptId: string; status: string; submittedAt: string | null; resultId: string | null; resultsPublished: boolean }>;
}> {
  const all = await listCompetitions(userId, { onlyRegisteredFor: userId });
  const attemptRows = await db.all<ArenaAttemptRow & { result_id: string | null; results_published_at: string | null }>(
    `SELECT a.*, r.id AS result_id, c.results_published_at AS results_published_at
       FROM arena_attempts a
       LEFT JOIN arena_results r ON r.attempt_id = a.id
       JOIN arena_competitions c ON c.id = a.competition_id
      WHERE a.user_id = ?`,
    [userId],
  );

  const attempts: Record<string, { attemptId: string; status: string; submittedAt: string | null; resultId: string | null; resultsPublished: boolean }> = {};
  for (const row of attemptRows) {
    attempts[row.competition_id] = {
      attemptId: row.id,
      status: row.status,
      submittedAt: row.submitted_at,
      resultId: row.result_id,
      resultsPublished: Boolean(row.results_published_at),
    };
  }

  const now = new Date();
  const live: ArenaCompetitionSummary[] = [];
  const upcoming: ArenaCompetitionSummary[] = [];
  const completed: ArenaCompetitionSummary[] = [];
  for (const competition of all) {
    const state = computeState(
      {
        status: competition.status,
        registration_opens_at: competition.registrationOpensAt,
        registration_closes_at: competition.registrationClosesAt,
        starts_at: competition.startsAt,
        ends_at: competition.endsAt,
        results_published_at: competition.resultsPublishedAt,
      },
      now,
    );
    if (state === 'LIVE') live.push(competition);
    else if (state === 'RESULTS_PUBLISHED' || state === 'SUBMISSION_CLOSED' || state === 'PROCESSING_RESULTS' || state === 'ARCHIVED') {
      completed.push(competition);
    } else upcoming.push(competition);
  }

  return { upcoming, live, completed, attempts };
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export interface RegisterResult {
  registrationId: string;
  competitionId: string;
  alreadyRegistered: boolean;
  registeredAt: string;
  participantCount: number;
  state: CompetitionState;
}

/**
 * Registers the signed-in student. Re-registering is not an error — it returns the existing row so
 * the UI can simply say "You are registered." (spec §4, no duplicate rows either way).
 */
export async function register(
  userId: string,
  competitionId: string,
  opts: { inviteCode?: string } = {},
): Promise<RegisterResult> {
  const row = await db.one<ArenaCompetitionRow>('SELECT * FROM arena_competitions WHERE id = ?', [competitionId]);
  if (!row) throw new HttpError(404, 'That competition was not found.', 'not_found');

  const state = computeState(row);
  if (row.status === 'draft') throw new HttpError(404, 'That competition was not found.', 'not_found');
  if (state === 'ARCHIVED') throw new HttpError(409, 'This competition has been archived.', 'archived');

  if (row.visibility === 'private') {
    const provided = (opts.inviteCode ?? '').trim().toUpperCase();
    if (!row.invite_code || provided !== row.invite_code.toUpperCase()) {
      throw new HttpError(403, 'This is a private competition — you need the invite code from its creator.', 'invite_required');
    }
  }

  const existing = await db.one<{ id: string; registered_at: string }>(
    'SELECT id, registered_at FROM arena_registrations WHERE competition_id = ? AND user_id = ?',
    [competitionId, userId],
  );

  const deadline = new Date(row.registration_closes_at).getTime();
  const canRegister = state === 'REGISTRATION_OPEN' || state === 'UPCOMING';
  if (existing) {
    // Already in: idempotent success even after the window closes.
    const counts = await participantCounts([competitionId]);
    return {
      registrationId: existing.id,
      competitionId,
      alreadyRegistered: true,
      registeredAt: existing.registered_at,
      participantCount: counts.get(competitionId) ?? 0,
      state,
    };
  }
  if (!canRegister || Date.now() > deadline) {
    throw new HttpError(409, 'Registration for this competition has closed.', 'registration_closed');
  }

  const id = uuid();
  const registeredAt = nowIso();
  await db.run(
    'INSERT INTO arena_registrations (id, competition_id, user_id, status, registered_at) VALUES (?, ?, ?, ?, ?)',
    [id, competitionId, userId, 'registered', registeredAt],
  );
  const counts = await participantCounts([competitionId]);
  return {
    registrationId: id,
    competitionId,
    alreadyRegistered: false,
    registeredAt,
    participantCount: counts.get(competitionId) ?? 0,
    state,
  };
}

export async function withdraw(userId: string, competitionId: string): Promise<boolean> {
  const row = await db.one<ArenaCompetitionRow>('SELECT * FROM arena_competitions WHERE id = ?', [competitionId]);
  if (!row) return false;
  const state = computeState(row);
  if (state !== 'REGISTRATION_OPEN' && state !== 'UPCOMING') {
    throw new HttpError(409, 'You can only withdraw before the competition starts.', 'too_late');
  }
  const attempt = await db.one<ArenaAttemptRow>('SELECT * FROM arena_attempts WHERE competition_id = ? AND user_id = ?', [
    competitionId,
    userId,
  ]);
  if (attempt && attempt.status !== 'in_progress') {
    throw new HttpError(409, 'You have already submitted an attempt for this competition.', 'already_attempted');
  }
  await db.run('DELETE FROM arena_registrations WHERE competition_id = ? AND user_id = ?', [competitionId, userId]);
  return true;
}

/* ------------------------------------------------------------------ */
/* Admin: creation and lifecycle                                       */
/* ------------------------------------------------------------------ */

export interface CreateCompetitionArgs {
  title: string;
  description: string;
  category: string;
  blueprint: unknown;
  registrationOpensAt: string;
  registrationClosesAt: string;
  startsAt: string;
  endsAt: string;
  difficulty?: string;
  rules?: string[];
  instructions?: string[];
  visibility?: 'public' | 'private';
  inviteCode?: string;
  isDemo?: boolean;
  createdBy?: string;
  publish?: boolean;
}

function assertSchedule(args: { registrationOpensAt: string; registrationClosesAt: string; startsAt: string; endsAt: string }): void {
  const regOpens = new Date(args.registrationOpensAt).getTime();
  const regCloses = new Date(args.registrationClosesAt).getTime();
  const starts = new Date(args.startsAt).getTime();
  const ends = new Date(args.endsAt).getTime();
  if ([regOpens, regCloses, starts, ends].some((v) => Number.isNaN(v))) {
    throw new HttpError(400, 'One of the dates could not be read.', 'bad_schedule');
  }
  if (regCloses <= regOpens) throw new HttpError(400, 'Registration must close after it opens.', 'bad_schedule');
  if (starts < regCloses) throw new HttpError(400, 'The competition cannot start before registration closes.', 'bad_schedule');
  if (ends <= starts) throw new HttpError(400, 'The competition must end after it starts.', 'bad_schedule');
}

export async function createCompetition(args: CreateCompetitionArgs): Promise<ArenaCompetitionSummary> {
  assertSchedule(args);
  const blueprint = normaliseBlueprint(args.blueprint);
  if (totalQuestions(blueprint) < 1) throw new HttpError(400, 'The blueprint needs at least one question.', 'bad_blueprint');
  if (totalQuestions(blueprint) > 120) throw new HttpError(400, 'A single paper is limited to 120 questions.', 'bad_blueprint');

  const id = uuid();
  const now = nowIso();
  const durationMin = blueprint.durationMin;
  await db.run(
    `INSERT INTO arena_competitions
       (id, title, description, category, status, registration_opens_at, registration_closes_at, starts_at, ends_at,
        duration_min, difficulty, blueprint, rules, instructions, visibility, invite_code, is_demo, created_by,
        published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      args.title.trim().slice(0, 140),
      args.description.trim().slice(0, 1200),
      args.category,
      args.publish ? 'registration_open' : 'draft',
      args.registrationOpensAt,
      args.registrationClosesAt,
      args.startsAt,
      args.endsAt,
      durationMin,
      (args.difficulty ?? 'mixed').slice(0, 20),
      JSON.stringify(blueprint),
      JSON.stringify(args.rules ?? DEFAULT_RULES),
      JSON.stringify(args.instructions ?? DEFAULT_INSTRUCTIONS),
      args.visibility ?? 'public',
      args.inviteCode ? args.inviteCode.trim().toUpperCase().slice(0, 24) : null,
      args.isDemo ? 1 : 0,
      args.createdBy ?? null,
      args.publish ? now : null,
      now,
      now,
    ],
  );

  const created = await getCompetition(args.createdBy ?? '', id, { includeUnpublished: true });
  return created!;
}

async function setStatus(competitionId: string, patch: Partial<Record<'status' | 'results_published_at' | 'published_at' | 'starts_at' | 'ends_at' | 'registration_closes_at' | 'registration_opens_at', string>>): Promise<void> {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as [string, string][];
  if (!entries.length) return;
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  await db.run(`UPDATE arena_competitions SET ${assignments}, updated_at = ? WHERE id = ?`, [
    ...entries.map(([, value]) => value),
    nowIso(),
    competitionId,
  ]);
}

export async function updateSchedule(
  competitionId: string,
  patch: { title?: string; description?: string; registrationClosesAt?: string; startsAt?: string; endsAt?: string; rules?: string[]; instructions?: string[] },
): Promise<void> {
  const row = await db.one<ArenaCompetitionRow>('SELECT * FROM arena_competitions WHERE id = ?', [competitionId]);
  if (!row) throw new HttpError(404, 'That competition was not found.', 'not_found');
  const next = {
    registrationClosesAt: patch.registrationClosesAt ?? row.registration_closes_at,
    startsAt: patch.startsAt ?? row.starts_at,
    endsAt: patch.endsAt ?? row.ends_at,
  };
  assertSchedule({ registrationOpensAt: row.registration_opens_at, ...next });

  const assignments: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (patch.title !== undefined) set('title', patch.title.trim().slice(0, 140));
  if (patch.description !== undefined) set('description', patch.description.trim().slice(0, 1200));
  if (patch.registrationClosesAt !== undefined) set('registration_closes_at', patch.registrationClosesAt);
  if (patch.startsAt !== undefined) set('starts_at', patch.startsAt);
  if (patch.endsAt !== undefined) set('ends_at', patch.endsAt);
  if (patch.rules !== undefined) set('rules', JSON.stringify(patch.rules.slice(0, 12)));
  if (patch.instructions !== undefined) set('instructions', JSON.stringify(patch.instructions.slice(0, 12)));
  if (!assignments.length) return;
  set('updated_at', nowIso());
  values.push(competitionId);
  await db.run(`UPDATE arena_competitions SET ${assignments.join(', ')} WHERE id = ?`, values);
}

/**
 * Admin: remove a competition that never ran. Refuses once anyone has an attempt so a published
 * result can never be deleted out from under a student.
 */
export async function deleteCompetition(id: string): Promise<{ deleted: boolean; reason?: 'not_found' | 'has_attempts' }> {
  const row = await db.one<ArenaCompetitionRow>('SELECT * FROM arena_competitions WHERE id = ?', [id]);
  if (!row) return { deleted: false, reason: 'not_found' };
  const attempts = await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM arena_attempts WHERE competition_id = ?', [id]);
  if (Number(attempts?.n ?? 0) > 0) return { deleted: false, reason: 'has_attempts' };
  await db.run('DELETE FROM arena_registrations WHERE competition_id = ?', [id]);
  await db.run('DELETE FROM arena_questions WHERE competition_id = ?', [id]);
  await db.run('DELETE FROM arena_results WHERE competition_id = ?', [id]);
  await db.run('DELETE FROM arena_performance_reports WHERE competition_id = ?', [id]).catch(() => undefined);
  await db.run('DELETE FROM arena_competitions WHERE id = ?', [id]);
  return { deleted: true };
}

export type AdminAction =
  | 'publish'
  | 'open_registration'
  | 'close_registration'
  | 'start_now'
  | 'close_submissions'
  | 'publish_results'
  | 'archive';

export async function applyAdminAction(
  competitionId: string,
  action: AdminAction,
  opts: { extendMinutes?: number } = {},
): Promise<{ state: CompetitionState; note: string }> {
  const row = await db.one<ArenaCompetitionRow>('SELECT * FROM arena_competitions WHERE id = ?', [competitionId]);
  if (!row) throw new HttpError(404, 'That competition was not found.', 'not_found');
  const now = new Date();
  const nowStr = now.toISOString();
  const durationMs = Number(row.duration_min) * 60_000;

  /**
   * A competition may only go live with an approved paper: students must never open a paper that is
   * short, unreviewed or contains a question a reviewer flagged. (Approved questions are the only
   * ones served or graded, so an unapproved paper would silently shrink.)
   */
  if (action === 'start_now' || action === 'publish') {
    const { paperReadiness } = await import('./questions.js');
    const readiness = await paperReadiness(competitionId);
    if (!readiness.ready) {
      throw new HttpError(
        409,
        `This paper is not ready: ${readiness.approved}/${readiness.required} questions approved${
          readiness.pending ? `, ${readiness.pending} awaiting review` : ''
        }${readiness.flagged ? `, ${readiness.flagged} flagged` : ''}. Approve the paper before starting.`,
        'paper_not_ready',
      );
    }
  }

  switch (action) {
    case 'publish': {
      if (row.status !== 'draft') throw new HttpError(409, 'This competition is already published.', 'already_published');
      await setStatus(competitionId, {
        status: new Date(row.registration_opens_at) > now ? 'registration_open' : 'registration_open',
        published_at: nowStr,
      });
      return { state: computeState({ ...row, status: 'registration_open' }), note: 'Published. Students can see it in Arena.' };
    }
    case 'open_registration': {
      // Move the window to start now and keep the advertised registration lead time.
      const lead = Math.max(60_000, new Date(row.registration_closes_at).getTime() - new Date(row.registration_opens_at).getTime());
      await setStatus(competitionId, {
        status: 'registration_open',
        published_at: row.results_published_at ? undefined : nowStr,
        registration_opens_at: nowStr,
        registration_closes_at: new Date(now.getTime() + (lead || 7 * 86_400_000)).toISOString(),
      });
      return { state: 'REGISTRATION_OPEN', note: 'Registration is open.' };
    }
    case 'close_registration': {
      await setStatus(competitionId, { status: 'registration_closed', registration_closes_at: nowStr });
      return { state: computeState({ ...row, status: 'registration_closed', registration_closes_at: nowStr }), note: 'Registration closed.' };
    }
    case 'start_now': {
      await setStatus(competitionId, {
        status: 'live',
        starts_at: nowStr,
        ends_at: new Date(now.getTime() + durationMs + (opts.extendMinutes ?? 0) * 60_000).toISOString(),
        registration_closes_at: new Date(Math.min(new Date(row.registration_closes_at).getTime(), now.getTime())).toISOString(),
      });
      return { state: 'LIVE', note: 'The competition is live.' };
    }
    case 'close_submissions': {
      await setStatus(competitionId, { status: 'submission_closed', ends_at: nowStr });
      return { state: 'SUBMISSION_CLOSED', note: 'Submissions closed.' };
    }
    case 'publish_results': {
      await setStatus(competitionId, { status: 'results_published', results_published_at: nowStr });
      return { state: 'RESULTS_PUBLISHED', note: 'Results published.' };
    }
    case 'archive': {
      await setStatus(competitionId, { status: 'archived' });
      return { state: 'ARCHIVED', note: 'Competition archived.' };
    }
    default:
      throw new HttpError(400, 'Unknown action.', 'bad_action');
  }
}

/** Admin: pending submissions close → processing → published (the natural next step, one click). */
export function nextAction(state: CompetitionState): AdminAction | null {
  switch (state) {
    case 'UPCOMING':
    case 'REGISTRATION_OPEN':
      return 'start_now';
    case 'LIVE':
      return 'close_submissions';
    case 'SUBMISSION_CLOSED':
      return 'publish_results';
    case 'PROCESSING_RESULTS':
      return 'publish_results';
    default:
      return null;
  }
}

export function arenaCatalog() {
  return {
    categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label, blurb: c.blurb })),
    states: (['UPCOMING', 'REGISTRATION_OPEN', 'LIVE', 'SUBMISSION_CLOSED', 'PROCESSING_RESULTS', 'RESULTS_PUBLISHED', 'ARCHIVED'] as CompetitionState[]).map(
      (id) => ({ id, label: stateLabel(id), tone: stateTone(id) }),
    ),
    difficultyOrder: ['easy', 'medium', 'hard'] as const,
    questionTypes: [
      { id: 'mcq' as const, label: 'MCQ', hint: 'Four options, one correct' },
      { id: 'numerical' as const, label: 'Numerical', hint: 'Enter a value; precision matters' },
      { id: 'conceptual' as const, label: 'Conceptual', hint: 'Concept check with options' },
    ],
    providers: PROVIDER_IDS,
  };
}

export function stateTone(state: CompetitionState): 'success' | 'warning' | 'error' | 'muted' | 'primary' {
  switch (state) {
    case 'LIVE':
      return 'success';
    case 'REGISTRATION_OPEN':
      return 'primary';
    case 'UPCOMING':
      return 'muted';
    case 'PROCESSING_RESULTS':
      return 'warning';
    case 'SUBMISSION_CLOSED':
      return 'warning';
    case 'RESULTS_PUBLISHED':
      return 'primary';
    default:
      return 'muted';
  }
}

export function blueprintOf(row: Pick<ArenaCompetitionRow, 'blueprint'>): ArenaBlueprint {
  return normaliseBlueprint(JSON.parse(row.blueprint || '{}'));
}

/** Reads the validated blueprint straight from the stored row (used by generation + details). */
export async function blueprintForCompetition(competitionId: string): Promise<ArenaBlueprint | null> {
  const row = await db.one<ArenaCompetitionRow>('SELECT * FROM arena_competitions WHERE id = ?', [competitionId]);
  return row ? blueprintOf(row) : null;
}

export { blueprintView };

/** Small helper used by the dashboard card and the Arena home header. */
export async function arenaOverview(userId: string): Promise<{
  live: number;
  open: number;
  upcoming: number;
  registered: number;
  completed: number;
  next: ArenaCompetitionSummary | null;
}> {
  const competitions = await listCompetitions(userId, { limit: 100 });
  const live = competitions.filter((c) => c.state === 'LIVE').length;
  const open = competitions.filter((c) => c.state === 'REGISTRATION_OPEN').length;
  const upcoming = competitions.filter((c) => c.state === 'UPCOMING').length;
  const completed = competitions.filter((c) => c.state === 'RESULTS_PUBLISHED' || c.state === 'ARCHIVED').length;
  const registered = competitions.filter((c) => c.registration?.status === 'registered').length;
  const next =
    competitions.find((c) => c.state === 'LIVE') ??
    competitions.find((c) => c.state === 'REGISTRATION_OPEN') ??
    competitions.find((c) => c.state === 'UPCOMING') ??
    null;
  return { live, open, upcoming, registered, completed, next };
}
