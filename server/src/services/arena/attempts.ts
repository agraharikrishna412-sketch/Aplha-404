/**
 * Competition attempts: entering the paper, saving answers, and submitting.
 *
 * Everything time-related is decided here, on the server:
 *  - a student may only start while the competition is LIVE and they are registered;
 *  - the attempt deadline is stored at start time (min(competition end, start + duration)) and never
 *    re-negotiated with the client;
 *  - a student may read their paper only before the deadline;
 *  - answers are graded when they are saved, but the score is only revealed after results publish.
 *
 * The frontend never receives correct answers or explanations for a paper it can still submit.
 */
import * as db from '../../db/index.js';
import { nowIso, uuid } from '../../db/index.js';
import { HttpError } from '../../middleware/errors.js';
import type {
  ArenaAnswerRow,
  ArenaAttemptRow,
  ArenaCompetitionRow,
  ArenaExamPayload,
  ArenaQuestionForStudent,
  CompetitionState,
} from '../../types/arena.js';
import { recordActivity } from '../activity.js';
import { computeState } from './competitions.js';
import { maxScore as blueprintMaxScore, normaliseBlueprint } from './blueprint.js';
import { listQuestions, paperReadiness, studentView } from './questions.js';

export interface AttemptState {
  attempt: ArenaAttemptRow | null;
  competition: ArenaCompetitionRow;
  state: CompetitionState;
  /** Server clock at the moment of the check. */
  now: string;
  remainingSeconds: number;
  /** True while the student may still read and answer the paper. */
  canAnswer: boolean;
  /** True once the attempt exists but the paper can no longer be answered. */
  expired: boolean;
  closedReason: 'not_started' | 'not_live' | 'deadline_passed' | 'competition_over' | 'submitted' | null;
}

function competitionMaxScore(row: ArenaCompetitionRow): number {
  return blueprintMaxScore(normaliseBlueprint(JSON.parse(row.blueprint || '{}')));
}

export async function findAttempt(userId: string, competitionId: string): Promise<ArenaAttemptRow | null> {
  return db.one<ArenaAttemptRow>('SELECT * FROM arena_attempts WHERE competition_id = ? AND user_id = ?', [
    competitionId,
    userId,
  ]);
}

function evaluateState(competition: ArenaCompetitionRow, attempt: ArenaAttemptRow | null, now: Date): AttemptState {
  const state = computeState(competition, now);
  const deadlineMs = attempt ? new Date(attempt.deadline_at).getTime() : NaN;
  const competitionEndMs = new Date(competition.ends_at).getTime();
  const pastDeadline = Number.isFinite(deadlineMs) && now.getTime() >= deadlineMs;
  const pastCompetition = now.getTime() >= competitionEndMs;

  const remainingSeconds = attempt && Number.isFinite(deadlineMs)
    ? Math.max(0, Math.floor((deadlineMs - now.getTime()) / 1000))
    : 0;

  if (!attempt) {
    return {
      attempt: null,
      competition,
      state,
      now: nowIso(),
      remainingSeconds: 0,
      canAnswer: false,
      expired: false,
      closedReason: state === 'LIVE' ? 'not_started' : 'not_live',
    };
  }

  if (attempt.status !== 'in_progress') {
    return { attempt, competition, state, now: nowIso(), remainingSeconds, canAnswer: false, expired: false, closedReason: 'submitted' };
  }
  if (pastCompetition) {
    return { attempt, competition, state, now: nowIso(), remainingSeconds, canAnswer: false, expired: true, closedReason: 'competition_over' };
  }
  if (pastDeadline) {
    return { attempt, competition, state, now: nowIso(), remainingSeconds, canAnswer: false, expired: true, closedReason: 'deadline_passed' };
  }
  return { attempt, competition, state, now: nowIso(), remainingSeconds, canAnswer: true, expired: false, closedReason: null };
}

export async function attemptStatus(userId: string, competitionId: string): Promise<AttemptState> {
  const competition = await db.one<ArenaCompetitionRow>('SELECT * FROM arena_competitions WHERE id = ?', [competitionId]);
  if (!competition) throw new HttpError(404, 'That competition was not found.', 'not_found');
  const attempt = await findAttempt(userId, competitionId);
  return evaluateState(competition, attempt, new Date());
}

/**
 * Starts (or resumes) an attempt. Starting twice is safe: the existing attempt and its original
 * deadline are returned, so refreshing the page never buys extra time.
 */
export async function startAttempt(
  userId: string,
  competitionId: string,
  opts: { clockDriftMs?: number } = {},
): Promise<ArenaExamPayload> {
  const competition = await db.one<ArenaCompetitionRow>('SELECT * FROM arena_competitions WHERE id = ?', [competitionId]);
  if (!competition) throw new HttpError(404, 'That competition was not found.', 'not_found');

  const registration = await db.one<{ id: string; status: string }>(
    'SELECT id, status FROM arena_registrations WHERE competition_id = ? AND user_id = ?',
    [competitionId, userId],
  );
  if (!registration || registration.status !== 'registered') {
    throw new HttpError(403, 'Register for this competition before entering.', 'not_registered');
  }

  const now = new Date();
  const existing = await findAttempt(userId, competitionId);
  const state = evaluateState(competition, existing, now);

  /**
   * Ready check: a student may only enter a paper whose questions have all been reviewed and
   * approved. (The admin cannot start the competition either, but a competition could have been
   * started legitimately and then had a question flagged or deleted, so this is re-checked at the
   * moment of entry rather than trusted from earlier.)
   */
  if (!existing || existing.status === 'in_progress') {
    const readiness = await paperReadiness(competitionId);
    if (!readiness.ready) {
      throw new HttpError(
        409,
        'This paper is still being prepared — please try again shortly.',
        'paper_not_ready',
        { blocker: readiness.blocker, approved: readiness.approved, required: readiness.required },
      );
    }
  }

  if (existing && existing.status !== 'in_progress') {
    // Carry the attempt id so the client can open the existing result instead of dead-ending on a
    // message. Which result that is has to come from the server — the paper is closed either way.
    const result = await db.one<{ id: string }>('SELECT id FROM arena_results WHERE attempt_id = ?', [existing.id]);
    throw new HttpError(409, 'You have already submitted this competition. Open your result instead.', 'already_submitted', {
      attemptId: existing.id,
      resultId: result?.id ?? null,
    });
  }
  if (state.canAnswer) return buildPayload(competition, existing!, now);

  if (existing && state.expired) {
    // The paper closed while the attempt was open — settle it rather than leaking the questions.
    const settled = await finaliseExpired(existing, now);
    throw new HttpError(409, settled, 'attempt_expired');
  }
  if (state.state !== 'LIVE') {
    throw new HttpError(409, 'This competition is not open right now.', 'not_live');
  }

  const deadlineMs = Math.min(now.getTime() + Number(competition.duration_min) * 60_000, new Date(competition.ends_at).getTime());
  const id = uuid();
  const startedAt = now.toISOString();
  const deadlineAt = new Date(deadlineMs).toISOString();
  await db.run(
    `INSERT INTO arena_attempts
       (id, competition_id, user_id, registration_id, started_at, deadline_at, status, max_score, auto_submitted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, 0, ?)`,
    [id, competitionId, userId, registration.id, startedAt, deadlineAt, competitionMaxScore(competition), startedAt],
  );

  await recordActivity({
    userId,
    kind: 'exam',
    subject: competition.category,
    topic: null,
    durationMs: 0,
    label: `Entered ${competition.title}`,
    meta: { arenaCompetitionId: competitionId, attemptId: id, clockDriftMs: opts.clockDriftMs ?? 0 },
  });

  const attempt = (await findAttempt(userId, competitionId))!;
  return buildPayload(competition, attempt, now);
}

/** Auto-submits an attempt whose deadline passed (server-side close, spec §5). */
async function finaliseExpired(attempt: ArenaAttemptRow, now: Date): Promise<string> {
  const { submitAttempt } = await import('./results.js');
  try {
    await submitAttempt({
      userId: attempt.user_id,
      attemptId: attempt.id,
      answers: [],
      autoSubmitted: true,
      reason: 'The competition time ran out — your saved answers were submitted.',
    });
  } catch {
    // Even if scoring hiccups, mark it closed so the student is never left in limbo.
    await db.run("UPDATE arena_attempts SET status = 'auto_submitted', submitted_at = ? WHERE id = ?", [
      now.toISOString(),
      attempt.id,
    ]);
  }
  return 'The competition time ran out. Your saved answers have been submitted — open your result to see the outcome.';
}

async function buildPayload(
  competition: ArenaCompetitionRow,
  attempt: ArenaAttemptRow,
  now: Date,
): Promise<ArenaExamPayload> {
  const rows = await listQuestions(competition.id, { onlyApproved: true });
  const questions: ArenaQuestionForStudent[] = rows.map(studentView);
  const answerRows = await db.all<ArenaAnswerRow>('SELECT * FROM arena_answers WHERE attempt_id = ?', [attempt.id]);

  const answers: ArenaExamPayload['answers'] = {};
  for (const row of answerRows) {
    answers[row.question_id] = {
      answer: row.answer,
      flagged: row.flagged === 1,
      timeSpentMs: Number(row.time_spent_ms),
    };
  }

  return {
    attempt: {
      id: attempt.id,
      competitionId: competition.id,
      competitionTitle: competition.title,
      startedAt: attempt.started_at,
      deadlineAt: attempt.deadline_at,
      remainingSeconds: Math.max(0, Math.floor((new Date(attempt.deadline_at).getTime() - now.getTime()) / 1000)),
      status: attempt.status,
      autoSubmitted: attempt.auto_submitted === 1,
    },
    competition: {
      id: competition.id,
      title: competition.title,
      category: competition.category,
      state: computeState(competition, now),
      durationMin: Number(competition.duration_min),
      marksPerQuestion: normaliseBlueprint(JSON.parse(competition.blueprint || '{}')).marksPerQuestion,
      negativeMarks: normaliseBlueprint(JSON.parse(competition.blueprint || '{}')).negativeMarks,
      maxScore: competitionMaxScore(competition),
      isDemo: competition.is_demo === 1,
      serverNow: now.toISOString(),
    },
    questions,
    answers,
  };
}

/**
 * Saves answers. Calls are incremental (only what changed), and the server validates each question
 * belongs to this competition and that the attempt is still live before writing anything.
 */
export async function saveAnswers(args: {
  userId: string;
  competitionId: string;
  updates: { questionId: string; answer?: string; flagged?: boolean; timeSpentMs?: number }[];
}): Promise<{ saved: number; remainingSeconds: number; status: string }> {
  const competition = await db.one<ArenaCompetitionRow>('SELECT * FROM arena_competitions WHERE id = ?', [args.competitionId]);
  if (!competition) throw new HttpError(404, 'That competition was not found.', 'not_found');
  const attempt = await findAttempt(args.userId, args.competitionId);
  if (!attempt) throw new HttpError(409, 'Start the competition before saving answers.', 'not_started');

  const now = new Date();
  const state = evaluateState(competition, attempt, now);
  if (!state.canAnswer) {
    if (state.expired) await finaliseExpired(attempt, now);
    throw new HttpError(409, 'Time is up for this competition — answers can no longer be changed.', 'attempt_closed');
  }

  const rows = await listQuestions(competition.id, { onlyApproved: true });
  const valid = new Map(rows.map((row) => [row.id, row]));
  const existing = await db.all<ArenaAnswerRow>('SELECT * FROM arena_answers WHERE attempt_id = ?', [attempt.id]);
  const existingMap = new Map(existing.map((row) => [row.question_id, row]));

  let saved = 0;
  for (const update of args.updates) {
    const question = valid.get(update.questionId);
    if (!question) continue;
    const previous = existingMap.get(update.questionId);
    const answer = (update.answer ?? previous?.answer ?? '').slice(0, 600);
    const flagged = update.flagged ?? previous?.flagged === 1;
    const timeSpentMs = Math.max(0, Math.min(Number(update.timeSpentMs ?? previous?.time_spent_ms ?? 0), 86_400_000));
    const updatedAt = nowIso();

    if (previous) {
      await db.run(
        'UPDATE arena_answers SET answer = ?, flagged = ?, time_spent_ms = ?, updated_at = ? WHERE attempt_id = ? AND question_id = ?',
        [answer, flagged ? 1 : 0, Math.round(timeSpentMs), updatedAt, attempt.id, update.questionId],
      );
    } else {
      await db.run(
        `INSERT INTO arena_answers (id, attempt_id, question_id, answer, is_correct, marks_awarded, time_spent_ms, flagged, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`,
        [uuid(), attempt.id, update.questionId, answer, Math.round(timeSpentMs), flagged ? 1 : 0, updatedAt],
      );
    }
    saved += 1;
  }

  return {
    saved,
    remainingSeconds: Math.max(0, Math.floor((new Date(attempt.deadline_at).getTime() - now.getTime()) / 1000)),
    status: attempt.status,
  };
}
