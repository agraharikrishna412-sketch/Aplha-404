/**
 * Competition result engine.
 *
 * All authoritative numbers are produced here, on the server, from the stored paper and the saved
 * answers: score (with negative marking), accuracy, unanswered count, time, and the subject / topic /
 * difficulty / question-type breakdowns. Benchmarking (rank + percentile) is computed only from
 * *valid submitted attempts* in the same competition, and is clearly labelled as an independent
 * Vroqn mock benchmark — never as a prediction of a real JEE/NEET rank.
 */
import * as db from '../../db/index.js';
import { nowIso, uuid } from '../../db/index.js';
import { HttpError } from '../../middleware/errors.js';
import type {
  ArenaAnswerRow,
  ArenaAttemptRow,
  ArenaBenchmark,
  ArenaBreakdownItem,
  ArenaCompetitionRow,
  ArenaDifficulty,
  ArenaHistoryEntry,
  ArenaPerformanceReport,
  ArenaPracticeSuggestion,
  ArenaQuestionRecord,
  ArenaQuestionReviewItem,
  ArenaResultPayload,
  ArenaResultRecord,
  ArenaStanding,
  ArenaTimeAnalysis,
} from '../../types/arena.js';
import { gradeAnswer, resolveTolerance } from './grading.js';
import { recordActivity } from '../activity.js';
import { ARENA_DIFFICULTIES, blueprintView, normaliseBlueprint, totalQuestions } from './blueprint.js';
import { computeState, isPublished } from './competitions.js';
import { listQuestions } from './questions.js';

/* ------------------------------------------------------------------ */
/* Answer comparison                                                   */
/* ------------------------------------------------------------------ */

/**
 * Grading lives in grading.ts so the comparison rules (option letters, exponent notation, the
 * configurable numerical tolerance) are testable on their own. Re-exported here because other
 * modules already import them from this file.
 */
export { normalise, numericValue, gradeAnswer, resolveTolerance, describeTolerance } from './grading.js';

/* ------------------------------------------------------------------ */
/* Breakdowns                                                          */
/* ------------------------------------------------------------------ */

function emptyBreakdown(key: string, label: string): ArenaBreakdownItem {
  return { key, label, correct: 0, incorrect: 0, unanswered: 0, total: 0, accuracy: 0, attempted: 0 };
}

function finalise(items: Map<string, ArenaBreakdownItem>): ArenaBreakdownItem[] {
  return [...items.values()]
    .map((item) => ({
      ...item,
      attempted: item.correct + item.incorrect,
      accuracy: item.correct + item.incorrect ? Math.round((item.correct / (item.correct + item.incorrect)) * 1000) / 1000 : 0,
    }))
    .sort((a, b) => a.accuracy - b.accuracy || b.total - a.total);
}

/* ------------------------------------------------------------------ */
/* Benchmarking                                                        */
/* ------------------------------------------------------------------ */

/**
 * Rank and percentile against valid submitted attempts only (in-progress, invalidated and unsubmitted
 * attempts are excluded — they are not evidence of anything).
 */
export function benchmarkFromScores(scores: number[], own: number): ArenaBenchmark {
  const pool = scores.filter((score) => Number.isFinite(score));
  const participantCount = pool.length;
  const below = pool.filter((score) => score < own).length;
  const equal = pool.filter((score) => score === own).length;
  // Mid-rank for ties keeps the percentile fair when many students share a score.
  const rank = pool.filter((score) => score > own).length + 1;
  const percentile = participantCount ? Math.round(((below + equal / 2) / participantCount) * 1000) / 10 : 100;

  return {
    percentile: Math.min(100, Math.max(0, percentile)),
    rank,
    participantCount,
    populationLabel: `Independent Vroqn mock · ${participantCount} valid submitted ${participantCount === 1 ? 'attempt' : 'attempts'}`,
    band: bandFor(percentile),
  };
}

function bandFor(percentile: number): string {
  if (percentile >= 90) return 'Top 10% of this Vroqn mock';
  if (percentile >= 75) return 'Upper quartile of this Vroqn mock';
  if (percentile >= 50) return 'Above the middle of this Vroqn mock';
  if (percentile >= 25) return 'Building steadily — plenty of room to climb';
  return 'Early days — the revision plan below is where the gains are';
}

/* ------------------------------------------------------------------ */
/* Time analysis                                                       */
/* ------------------------------------------------------------------ */

function buildTimeAnalysis(
  questions: ArenaQuestionRecord[],
  answers: Map<string, ArenaAnswerRow>,
  totalMs: number,
): ArenaTimeAnalysis {
  const perQuestion = questions.map((q) => ({
    topic: q.topic,
    ms: Number(answers.get(q.id)?.time_spent_ms ?? 0),
    order: Number(q.position),
  }));

  const attempted = perQuestion.filter((entry) => entry.ms > 0);
  const avgMsPerQuestion = attempted.length ? Math.round(attempted.reduce((sum, e) => sum + e.ms, 0) / attempted.length) : 0;

  const byTopic = new Map<string, { total: number; count: number }>();
  for (const entry of attempted) {
    const bucket = byTopic.get(entry.topic) ?? { total: 0, count: 0 };
    bucket.total += entry.ms;
    bucket.count += 1;
    byTopic.set(entry.topic, bucket);
  }
  const slowestTopics = [...byTopic.entries()]
    .map(([topic, value]) => ({ topic, avgMs: Math.round(value.total / value.count) }))
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 3);

  const third = Math.max(1, Math.floor(perQuestion.length / 3));
  const first = perQuestion.slice(0, third);
  const last = perQuestion.slice(-third);
  const avg = (list: typeof perQuestion) => {
    const withTime = list.filter((entry) => entry.ms > 0);
    return withTime.length ? Math.round(withTime.reduce((sum, e) => sum + e.ms, 0) / withTime.length) : 0;
  };
  const firstThirdAvgMs = avg(first);
  const lastThirdAvgMs = avg(last);

  return {
    totalMs,
    avgMsPerQuestion,
    slowestTopics,
    firstThirdAvgMs,
    lastThirdAvgMs,
    // A clear slowdown (or dropping questions) at the end is the evidence for time pressure.
    timePressure: firstThirdAvgMs > 0 && lastThirdAvgMs > 0 && lastThirdAvgMs > firstThirdAvgMs * 1.35,
  };
}

/* ------------------------------------------------------------------ */
/* Practice suggestions (one-click improvement)                        */
/* ------------------------------------------------------------------ */

/**
 * Builds practice suggestions from the attempt itself: the weakest topics by accuracy, carrying over
 * the difficulty and question type where the student struggled. Consumed by the existing Practice
 * feature (POST /practice/generate) — no manual re-entry.
 */
export function buildPracticeSuggestions(
  topics: ArenaBreakdownItem[],
  questions: ArenaQuestionRecord[],
  answers: Map<string, ArenaAnswerRow>,
  limit = 4,
): ArenaPracticeSuggestion[] {
  const suggestions: ArenaPracticeSuggestion[] = [];
  const weak = topics.filter((topic) => topic.accuracy < 0.75 && topic.total > 0).slice(0, limit);

  for (const topic of weak) {
    const related = questions.filter((q) => q.topic === topic.key);
    const answered = related.map((q) => ({ q, row: answers.get(q.id) }));
    const wrong = answered.filter((entry) => entry.row?.answer && entry.row.is_correct === 0);
    const pool = wrong.length ? wrong : answered;
    // Prefer the difficulty/type the student actually got wrong.
    const difficulty = (pool[0]?.q.difficulty as ArenaDifficulty) ?? (related[0]?.difficulty as ArenaDifficulty) ?? 'medium';
    const type = (pool[0]?.q.question_type as PracticeSuggestionType) ?? 'mixed';
    const first = related[0];
    suggestions.push({
      subject: first?.subject ?? 'General',
      chapter: first?.chapter ?? null,
      topic: topic.key,
      difficulty,
      questionType: type,
      count: Math.max(5, Math.min(10, topic.total * 2)),
      reason:
        wrong.length > 0
          ? `You got ${wrong.length} of ${related.length} ${topic.key} questions wrong in this competition.`
          : `Your accuracy on ${topic.key} was ${Math.round(topic.accuracy * 100)}%.`,
    });
  }

  // Nothing weak? Suggest the student's slowest topics instead — still a real, data-backed suggestion.
  if (!suggestions.length) {
    const gentle = [...topics].sort((a, b) => b.total - a.total).slice(0, 2);
    for (const topic of gentle) {
      const first = questions.find((q) => q.topic === topic.key);
      if (!first) continue;
      suggestions.push({
        subject: first.subject,
        chapter: first.chapter,
        topic: topic.key,
        difficulty: 'hard',
        questionType: 'mixed',
        count: 5,
        reason: `Strong performance here (${Math.round(topic.accuracy * 100)}%) — try harder questions to push further.`,
      });
    }
  }

  return suggestions;
}

type PracticeSuggestionType = ArenaPracticeSuggestion['questionType'];

/* ------------------------------------------------------------------ */
/* Submission + scoring                                                */
/* ------------------------------------------------------------------ */

export interface SubmitArgs {
  userId: string;
  attemptId: string;
  /** Incremental answers from the client; anything missing stays as last saved. */
  answers: { questionId: string; answer: string; timeSpentMs?: number; flagged?: boolean }[];
  autoSubmitted?: boolean;
  reason?: string;
}

export interface SubmitOutcome {
  resultId: string;
  score: number;
  maxScore: number;
  correct: number;
  incorrect: number;
  unanswered: number;
  accuracy: number;
  timeUsedMs: number;
  autoSubmitted: boolean;
  resultsPublished: boolean;
  attemptId: string;
  competitionId: string;
}

export async function submitAttempt(args: SubmitArgs): Promise<SubmitOutcome> {
  const attempt = await db.one<ArenaAttemptRow>('SELECT * FROM arena_attempts WHERE id = ?', [args.attemptId]);
  if (!attempt) throw new HttpError(404, 'That attempt was not found.', 'not_found');
  if (attempt.user_id !== args.userId) throw new HttpError(403, 'That attempt belongs to another account.', 'forbidden');

  const competition = await db.one<ArenaCompetitionRow>('SELECT * FROM arena_competitions WHERE id = ?', [
    attempt.competition_id,
  ]);
  if (!competition) throw new HttpError(404, 'That competition was not found.', 'not_found');

  /**
   * Duplicate submissions are refused outright (not silently ignored): the first submission is the
   * only one that counts, and the caller is told where the existing result lives. The error carries
   * the attempt id so a client can navigate to it instead of showing a dead end.
   */
  if (attempt.status !== 'in_progress') {
    const existing = await db.one<{ id: string }>('SELECT id FROM arena_results WHERE attempt_id = ?', [attempt.id]);
    throw new HttpError(409, 'This paper was already submitted — the first submission is the one that counts.', 'already_submitted', {
      attemptId: attempt.id,
      resultId: existing?.id ?? null,
    });
  }

  const now = new Date();
  const questions = await listQuestions(competition.id, { onlyApproved: true });
  if (!questions.length) throw new HttpError(409, 'This competition has no approved questions yet.', 'no_questions');
  /**
   * Late answers are ignored *here*, not only in the route: once the attempt deadline or the
   * competition end has passed, the paper is graded from what the server already holds. Otherwise a
   * client (or a stale tab) could keep answering after time by posting a final answer set.
   */
  const pastDeadline = now.getTime() >= new Date(attempt.deadline_at).getTime();
  const pastCompetition = now.getTime() >= new Date(competition.ends_at).getTime();
  const closingLate = pastDeadline || pastCompetition;
  // Tolerance is a competition-level setting (blueprint override → server default).
  const tolerance = resolveTolerance(normaliseBlueprint(JSON.parse(competition.blueprint || '{}')));

  // Persist any final answers first so nothing is lost, then grade the stored set.
  const stored = await db.all<ArenaAnswerRow>('SELECT * FROM arena_answers WHERE attempt_id = ?', [attempt.id]);
  const byQuestion = new Map(stored.map((row) => [row.question_id, row]));
  const nowStr = nowIso();
  for (const update of closingLate ? [] : args.answers) {
    if (!questions.some((q) => q.id === update.questionId)) continue;
    const previous = byQuestion.get(update.questionId);
    const answer = (update.answer ?? previous?.answer ?? '').slice(0, 600);
    const flagged = update.flagged ?? previous?.flagged === 1;
    const timeSpentMs = Math.round(Math.max(0, Math.min(Number(update.timeSpentMs ?? previous?.time_spent_ms ?? 0), 86_400_000)));
    if (previous) {
      await db.run('UPDATE arena_answers SET answer = ?, flagged = ?, time_spent_ms = ?, updated_at = ? WHERE id = ?', [
        answer,
        flagged ? 1 : 0,
        timeSpentMs,
        nowStr,
        previous.id,
      ]);
      previous.answer = answer;
      previous.flagged = flagged ? 1 : 0;
      previous.time_spent_ms = timeSpentMs;
    } else {
      const row: ArenaAnswerRow = {
        id: uuid(),
        attempt_id: attempt.id,
        question_id: update.questionId,
        answer,
        is_correct: 0,
        marks_awarded: 0,
        time_spent_ms: timeSpentMs,
        flagged: flagged ? 1 : 0,
        updated_at: nowStr,
      };
      await db.run(
        `INSERT INTO arena_answers (id, attempt_id, question_id, answer, is_correct, marks_awarded, time_spent_ms, flagged, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`,
        [row.id, row.attempt_id, row.question_id, row.answer, row.time_spent_ms, row.flagged, row.updated_at],
      );
      byQuestion.set(update.questionId, row);
    }
  }

  /* ------------------------------- grading ------------------------------- */
  let score = 0;
  let correct = 0;
  let incorrect = 0;
  let unanswered = 0;
  let maxScore = 0;

  const subject = new Map<string, ArenaBreakdownItem>();
  const topic = new Map<string, ArenaBreakdownItem>();
  const difficulty = new Map<string, ArenaBreakdownItem>();
  const type = new Map<string, ArenaBreakdownItem>();

  for (const question of questions) {
    const row = byQuestion.get(question.id);
    const answer = row?.answer?.trim() ?? '';
    maxScore += Number(question.marks);
    const isAnswered = answer.length > 0;
    const graded = gradeAnswer(question, answer, tolerance);

    if (isAnswered) {
      if (graded.isCorrect) correct += 1;
      else incorrect += 1;
    } else {
      unanswered += 1;
    }
    score += graded.marks;

    if (row) {
      await db.run('UPDATE arena_answers SET is_correct = ?, marks_awarded = ?, updated_at = ? WHERE id = ?', [
        graded.isCorrect ? 1 : 0,
        graded.marks,
        nowStr,
        row.id,
      ]);
      row.is_correct = graded.isCorrect ? 1 : 0;
      row.marks_awarded = graded.marks;
    }

    const buckets: [Map<string, ArenaBreakdownItem>, string][] = [
      [subject, question.subject],
      [topic, question.topic],
      [difficulty, question.difficulty],
      [type, question.question_type],
    ];
    for (const [map, key] of buckets) {
      const item = map.get(key) ?? emptyBreakdown(key, key);
      item.total += 1;
      if (!isAnswered) item.unanswered += 1;
      else if (graded.isCorrect) item.correct += 1;
      else item.incorrect += 1;
      map.set(key, item);
    }
  }

  const attempted = correct + incorrect;
  const accuracy = attempted ? Math.round((correct / attempted) * 1000) / 1000 : 0;
  const startedMs = new Date(attempt.started_at).getTime();
  const submittedMs = Math.min(now.getTime(), new Date(attempt.deadline_at).getTime());
  const timeUsedMs = Math.max(0, submittedMs - startedMs);

  const subjectAnalysis = finalise(subject);
  const topicAnalysis = finalise(topic);
  const difficultyAnalysis = finalise(difficulty).sort(
    (a, b) => ARENA_DIFFICULTIES.indexOf(a.key as ArenaDifficulty) - ARENA_DIFFICULTIES.indexOf(b.key as ArenaDifficulty),
  );
  const typeAnalysis = finalise(type);
  const timeAnalysis = buildTimeAnalysis(questions, byQuestion, timeUsedMs);

  /* ---------------------------- benchmarking ---------------------------- */
  const published = Boolean(competition.results_published_at);
  let benchmark: ArenaBenchmark | null = null;
  if (published) {
    const pool = await db.all<{ score: number | null }>(
      "SELECT score FROM arena_attempts WHERE competition_id = ? AND status IN ('submitted', 'auto_submitted') AND score IS NOT NULL",
      [competition.id],
    );
    const scores = pool.map((row) => Number(row.score ?? 0)).concat(score);
    benchmark = benchmarkFromScores(scores, score);
  }

  const autoSubmitted = args.autoSubmitted || closingLate;
  const status = autoSubmitted ? 'auto_submitted' : 'submitted';
  await db.run(
    `UPDATE arena_attempts
        SET submitted_at = ?, status = ?, score = ?, max_score = ?, correct = ?, incorrect = ?, unanswered = ?,
            accuracy = ?, time_used_ms = ?, auto_submitted = ?
      WHERE id = ?`,
    [
      nowStr,
      status,
      score,
      maxScore,
      correct,
      incorrect,
      unanswered,
      accuracy,
      timeUsedMs,
      autoSubmitted ? 1 : 0,
      attempt.id,
    ],
  );

  // Results row is written once; benchmarking values are refreshed as more attempts arrive.
  const existingResult = await db.one<ArenaResultRecord>('SELECT * FROM arena_results WHERE attempt_id = ?', [attempt.id]);
  const resultId = existingResult?.id ?? uuid();
  const payload = {
    score,
    max_score: maxScore,
    correct,
    incorrect,
    unanswered,
    accuracy,
    time_used_ms: timeUsedMs,
    percentile: benchmark?.percentile ?? null,
    rank: benchmark?.rank ?? null,
    participant_count: benchmark?.participantCount ?? null,
    subject_analysis: JSON.stringify(subjectAnalysis),
    topic_analysis: JSON.stringify(topicAnalysis),
    difficulty_analysis: JSON.stringify(difficultyAnalysis),
    type_analysis: JSON.stringify(typeAnalysis),
    time_analysis: JSON.stringify(timeAnalysis),
    computed_at: nowStr,
  };

  if (existingResult) {
    await db.run(
      `UPDATE arena_results SET score = ?, max_score = ?, correct = ?, incorrect = ?, unanswered = ?, accuracy = ?,
          time_used_ms = ?, percentile = ?, rank = ?, participant_count = ?, subject_analysis = ?, topic_analysis = ?,
          difficulty_analysis = ?, type_analysis = ?, time_analysis = ?, computed_at = ? WHERE id = ?`,
      [
        payload.score,
        payload.max_score,
        payload.correct,
        payload.incorrect,
        payload.unanswered,
        payload.accuracy,
        payload.time_used_ms,
        payload.percentile,
        payload.rank,
        payload.participant_count,
        payload.subject_analysis,
        payload.topic_analysis,
        payload.difficulty_analysis,
        payload.type_analysis,
        payload.time_analysis,
        payload.computed_at,
        resultId,
      ],
    );
  } else {
    await db.run(
      `INSERT INTO arena_results
         (id, attempt_id, competition_id, user_id, score, max_score, correct, incorrect, unanswered, accuracy,
          time_used_ms, percentile, rank, participant_count, subject_analysis, topic_analysis, difficulty_analysis,
          type_analysis, time_analysis, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        resultId,
        attempt.id,
        competition.id,
        args.userId,
        payload.score,
        payload.max_score,
        payload.correct,
        payload.incorrect,
        payload.unanswered,
        payload.accuracy,
        payload.time_used_ms,
        payload.percentile,
        payload.rank,
        payload.participant_count,
        payload.subject_analysis,
        payload.topic_analysis,
        payload.difficulty_analysis,
        payload.type_analysis,
        payload.time_analysis,
        payload.computed_at,
      ],
    );
  }

  /* ------------------- activity + topic stats integration ------------------- */
  for (const item of topicAnalysis) {
    await db.run(
      `INSERT INTO topic_stats (id, user_id, subject, topic, attempted, correct, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, subject, topic) DO UPDATE SET
         attempted = topic_stats.attempted + excluded.attempted,
         correct = topic_stats.correct + excluded.correct,
         last_seen_at = excluded.last_seen_at`,
      [
        uuid(),
        args.userId,
        subjectAnalysis[0]?.key ?? competition.category,
        item.key,
        item.attempted,
        item.correct,
        nowStr,
      ],
    );
  }

  await recordActivity({
    userId: args.userId,
    kind: 'exam',
    subject: subjectAnalysis[0]?.key ?? null,
    topic: topicAnalysis[0]?.key ?? null,
    durationMs: timeUsedMs,
    correct,
    total: questions.length,
    label: `${competition.title}: ${score}/${maxScore}${autoSubmitted ? ' (auto-submitted)' : ''}`,
    meta: {
      arenaCompetitionId: competition.id,
      attemptId: attempt.id,
      resultId,
      percentile: benchmark?.percentile ?? null,
      rank: benchmark?.rank ?? null,
      autoSubmitted,
    },
  });

  return {
    resultId,
    score,
    maxScore,
    correct,
    incorrect,
    unanswered,
    accuracy,
    timeUsedMs,
    autoSubmitted,
    resultsPublished: published,
    attemptId: attempt.id,
    competitionId: competition.id,
  };
}

/**
 * Refreshes rank/percentile for every valid attempt in a competition.
 * Called when results are published, so benchmark numbers are consistent for all students.
 */
export async function recalculateBenchmarks(competitionId: string): Promise<number> {
  const rows = await db.all<{ id: string; score: number | null }>(
    "SELECT id, score FROM arena_attempts WHERE competition_id = ? AND status IN ('submitted', 'auto_submitted') AND score IS NOT NULL ORDER BY id",
    [competitionId],
  );
  const scores = rows.map((row) => Number(row.score ?? 0));
  for (const row of rows) {
    const benchmark = benchmarkFromScores(scores, Number(row.score ?? 0));
    await db.run(
      'UPDATE arena_results SET percentile = ?, rank = ?, participant_count = ? WHERE attempt_id = ?',
      [benchmark.percentile, benchmark.rank, benchmark.participantCount, row.id],
    );
  }
  return rows.length;
}

/* ------------------------------------------------------------------ */
/* Reading results                                                     */
/* ------------------------------------------------------------------ */

async function standings(competitionId: string, ownAttemptId: string, limit = 10): Promise<ArenaStanding[]> {
  const rows = await db.all<{ id: string; score: number | null }>(
    "SELECT id, score FROM arena_attempts WHERE competition_id = ? AND status IN ('submitted', 'auto_submitted') AND score IS NOT NULL ORDER BY score DESC",
    [competitionId],
  );
  const scores = rows.map((row) => Number(row.score ?? 0));
  const youIndex = rows.findIndex((row) => row.id === ownAttemptId);

  // Anonymised labels only: never names, never emails, never user ids (spec §24).
  const labelled = rows.map((row, index) => ({
    row,
    index,
    label: `Aspirant ${index + 1}`,
    score: Number(row.score ?? 0),
  }));

  const top = labelled.slice(0, limit);
  if (youIndex >= 0 && youIndex >= limit) top.push(labelled[youIndex]);

  return top.map((entry) => ({
    label: entry.row.id === ownAttemptId ? 'You' : entry.label,
    rank: scores.filter((s) => s > entry.score).length + 1,
    score: Number(entry.row.score ?? 0),
    percentile: benchmarkFromScores(scores, entry.score).percentile,
    isYou: entry.row.id === ownAttemptId,
  }));
}

export async function getResultForUser(userId: string, attemptId: string): Promise<ArenaResultPayload> {
  const attempt = await db.one<ArenaAttemptRow>('SELECT * FROM arena_attempts WHERE id = ?', [attemptId]);
  if (!attempt) throw new HttpError(404, 'That attempt was not found.', 'not_found');
  // Authorization: a student can only ever read their own attempt.
  if (attempt.user_id !== userId) throw new HttpError(403, 'That result belongs to another account.', 'forbidden');

  const competition = await db.one<ArenaCompetitionRow>('SELECT * FROM arena_competitions WHERE id = ?', [
    attempt.competition_id,
  ]);
  if (!competition) throw new HttpError(404, 'That competition was not found.', 'not_found');

  const result = await db.one<ArenaResultRecord>('SELECT * FROM arena_results WHERE attempt_id = ?', [attemptId]);
  if (!result) throw new HttpError(409, 'This attempt has not been scored yet.', 'not_scored');

  const published = Boolean(competition.results_published_at);
  const answers = await db.all<ArenaAnswerRow>('SELECT * FROM arena_answers WHERE attempt_id = ?', [attemptId]);
  const answerMap = new Map(answers.map((row) => [row.question_id, row]));
  const questions = await listQuestions(competition.id, { onlyApproved: true });

  const blueprint = normaliseBlueprint(JSON.parse(competition.blueprint || '{}'));
  const review: ArenaQuestionReviewItem[] | null = published
    ? questions.map((question) => {
        const row = answerMap.get(question.id);
        return {
          ...studentViewForReview(question),
          yourAnswer: row?.answer ?? '',
          isCorrect: row?.is_correct === 1,
          marksAwarded: Number(row?.marks_awarded ?? 0),
          correctAnswer: question.correct_answer,
          explanation: question.explanation,
          timeSpentMs: Number(row?.time_spent_ms ?? 0),
        };
      })
    : null;

  const reportRow = await db.one<{ report: string; generated_at: string }>(
    'SELECT report, generated_at FROM arena_performance_reports WHERE attempt_id = ?',
    [attemptId],
  );

  const benchmark: ArenaBenchmark | null = published
    ? {
        percentile: Number(result.percentile ?? 0),
        rank: Number(result.rank ?? 1),
        participantCount: Number(result.participant_count ?? 1),
        populationLabel: `Independent Vroqn mock · ${Number(result.participant_count ?? 1)} valid submitted ${Number(result.participant_count ?? 1) === 1 ? 'attempt' : 'attempts'}`,
        band: bandFor(Number(result.percentile ?? 0)),
      }
    : null;

  const topicAnalysis = safeParse<ArenaBreakdownItem[]>(result.topic_analysis, []);
  const subjectAnalysis = safeParse<ArenaBreakdownItem[]>(result.subject_analysis, []);

  return {
    result: {
      id: result.id,
      attemptId: attempt.id,
      competitionId: competition.id,
      competitionTitle: competition.title,
      category: competition.category,
      isDemo: competition.is_demo === 1,
      submittedAt: attempt.submitted_at ?? result.computed_at,
      autoSubmitted: attempt.auto_submitted === 1,
      score: Number(result.score),
      maxScore: Number(result.max_score),
      correct: Number(result.correct),
      incorrect: Number(result.incorrect),
      unanswered: Number(result.unanswered),
      attempted: Number(result.correct) + Number(result.incorrect),
      accuracy: Number(result.accuracy),
      timeUsedMs: Number(result.time_used_ms),
      durationMin: blueprint.durationMin,
    },
    state: computeState(competition),
    benchmark,
    subjectAnalysis,
    topicAnalysis,
    difficultyAnalysis: safeParse<ArenaBreakdownItem[]>(result.difficulty_analysis, []),
    typeAnalysis: safeParse<ArenaBreakdownItem[]>(result.type_analysis, []),
    timeAnalysis: safeParse<ArenaTimeAnalysis>(result.time_analysis, {
      totalMs: Number(result.time_used_ms),
      avgMsPerQuestion: 0,
      slowestTopics: [],
      firstThirdAvgMs: 0,
      lastThirdAvgMs: 0,
      timePressure: false,
    }),
    report: reportRow ? safeParse<ArenaPerformanceReport | null>(reportRow.report, null) : null,
    practiceSuggestions: buildPracticeSuggestions(topicAnalysis, questions, answerMap),
    standings: published ? await standings(competition.id, attempt.id, Number(result.score)) : null,
    review,
    reviewAvailable: published,
    /**
     * The paper's own marking rule (marks, negative marks, numerical tolerance). Sent with the result
     * so the analysis screen can explain *how* an answer was judged — in particular why a numerical
     * answer within the tolerance was accepted.
     */
    blueprint: blueprintView(blueprint),
  };
}

function studentViewForReview(question: ArenaQuestionRecord) {
  return {
    id: question.id,
    position: Number(question.position),
    prompt: question.prompt,
    options: question.options ? (JSON.parse(question.options) as string[]) : null,
    subject: question.subject,
    topic: question.topic,
    difficulty: question.difficulty as ArenaDifficulty,
    type: question.question_type as ArenaPracticeSuggestion['questionType'] extends 'mixed' ? never : never,
    marks: Number(question.marks),
    negativeMarks: Number(question.negative_marks),
  };
}

function safeParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Performance report (AI)                                             */
/* ------------------------------------------------------------------ */

/** Compact, honest evidence block handed to the model — the only thing it can base conclusions on. */
function evidenceBlock(args: {
  competition: ArenaCompetitionRow;
  result: ArenaResultRecord;
  subjectAnalysis: ArenaBreakdownItem[];
  topicAnalysis: ArenaBreakdownItem[];
  difficultyAnalysis: ArenaBreakdownItem[];
  typeAnalysis: ArenaBreakdownItem[];
  timeAnalysis: ArenaTimeAnalysis;
  perQuestion: string[];
  published: boolean;
}): string {
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  return [
    `Competition: ${args.competition.title} (${args.competition.category}) — an independent Vroqn mock, not an official exam.`,
    `Score: ${args.result.score}/${args.result.max_score} · correct ${args.result.correct} · incorrect ${args.result.incorrect} · unanswered ${args.result.unanswered} · accuracy ${pct(Number(args.result.accuracy))}`,
    `Time used: ${Math.round(Number(args.result.time_used_ms) / 60000)} of ${args.competition.duration_min} minutes.`,
    args.published
      ? `Benchmark: rank ${args.result.rank} of ${args.result.participant_count} valid submitted attempts, percentile ${args.result.percentile}.`
      : 'Benchmark: results not published yet — do not mention rank or percentile.',
    '',
    'Subject accuracy:',
    ...args.subjectAnalysis.map((s) => `- ${s.label}: ${pct(s.accuracy)} (${s.correct}/${s.total}, ${s.unanswered} left blank)`),
    'Topic accuracy:',
    ...args.topicAnalysis.map((t) => `- ${t.label}: ${pct(t.accuracy)} (${t.correct}/${t.total}, ${t.unanswered} left blank)`),
    'Difficulty accuracy:',
    ...args.difficultyAnalysis.map((d) => `- ${d.label}: ${pct(d.accuracy)} (${d.correct}/${d.total})`),
    'Question type accuracy:',
    ...args.typeAnalysis.map((t) => `- ${t.label}: ${pct(t.accuracy)} (${t.correct}/${t.total})`),
    '',
    `Time: average ${Math.round(args.timeAnalysis.avgMsPerQuestion / 1000)}s per question; first third ${Math.round(args.timeAnalysis.firstThirdAvgMs / 1000)}s, last third ${Math.round(args.timeAnalysis.lastThirdAvgMs / 1000)}s${args.timeAnalysis.timePressure ? ' (clear slowdown at the end)' : ''}.`,
    args.timeAnalysis.slowestTopics.length
      ? `Slowest topics: ${args.timeAnalysis.slowestTopics.map((t) => `${t.topic} (${Math.round(t.avgMs / 1000)}s)`).join(', ')}.`
      : '',
    '',
    'Per-question evidence:',
    ...args.perQuestion,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export async function generatePerformanceReport(userId: string, attemptId: string): Promise<ArenaPerformanceReport> {
  const attempt = await db.one<ArenaAttemptRow>('SELECT * FROM arena_attempts WHERE id = ?', [attemptId]);
  if (!attempt) throw new HttpError(404, 'That attempt was not found.', 'not_found');
  if (attempt.user_id !== userId) throw new HttpError(403, 'That attempt belongs to another account.', 'forbidden');

  const competition = await db.one<ArenaCompetitionRow>('SELECT * FROM arena_competitions WHERE id = ?', [
    attempt.competition_id,
  ]);
  const result = await db.one<ArenaResultRecord>('SELECT * FROM arena_results WHERE attempt_id = ?', [attemptId]);
  if (!competition || !result) throw new HttpError(409, 'This attempt has not been scored yet.', 'not_scored');

  const published = isPublished(competition);
  const questions = await listQuestions(competition.id, { onlyApproved: true });
  const answers = await db.all<ArenaAnswerRow>('SELECT * FROM arena_answers WHERE attempt_id = ?', [attemptId]);
  const answerMap = new Map(answers.map((row) => [row.question_id, row]));

  const subjectAnalysis = safeParse<ArenaBreakdownItem[]>(result.subject_analysis, []);
  const topicAnalysis = safeParse<ArenaBreakdownItem[]>(result.topic_analysis, []);
  const difficultyAnalysis = safeParse<ArenaBreakdownItem[]>(result.difficulty_analysis, []);
  const typeAnalysis = safeParse<ArenaBreakdownItem[]>(result.type_analysis, []);
  const timeAnalysis = safeParse<ArenaTimeAnalysis>(result.time_analysis, {
    totalMs: Number(result.time_used_ms),
    avgMsPerQuestion: 0,
    slowestTopics: [],
    firstThirdAvgMs: 0,
    lastThirdAvgMs: 0,
    timePressure: false,
  });

  const perQuestion = questions.map((question) => {
    const row = answerMap.get(question.id);
    const answered = Boolean(row?.answer?.trim());
    const state = !answered ? 'blank' : row?.is_correct === 1 ? 'correct' : 'wrong';
    const seconds = Math.round(Number(row?.time_spent_ms ?? 0) / 1000);
    return `- [${state}] ${question.subject} · ${question.topic} · ${question.difficulty} · ${question.question_type} · ${seconds}s${answered ? ` · answered "${String(row?.answer).slice(0, 40)}"` : ''}`;
  });

  const evidence = evidenceBlock({
    competition,
    result,
    subjectAnalysis,
    topicAnalysis,
    difficultyAnalysis,
    typeAnalysis,
    timeAnalysis,
    perQuestion,
    published,
  });

  const local = localReport({ result, subjectAnalysis, topicAnalysis, difficultyAnalysis, typeAnalysis, timeAnalysis, questions, answerMap });

  try {
    const { completeJson: complete } = await import('../ai/router.js');
    const { competitionAnalysisSystem } = await import('../ai/prompts.js');
    const { promptContextFor } = await import('../tutor.js');
    const ctx = await promptContextFor(userId, subjectAnalysis[0]?.key);
    const { data, summary } = await complete<{
      summary?: string;
      strongAreas?: unknown[];
      needsImprovement?: unknown[];
      patterns?: { pattern?: string; evidence?: string; suggestion?: string }[];
      recommendations?: unknown[];
    }>({
      userId,
      task: 'exam',
      system: competitionAnalysisSystem(ctx),
      temperature: 0.4,
      maxTokens: 1400,
      messages: [{ role: 'user', content: evidence }],
    });

    const report: ArenaPerformanceReport = {
      summary: String(data.summary ?? local.summary).slice(0, 2000),
      strongAreas: (data.strongAreas ?? local.strongAreas).map(String).filter(Boolean).slice(0, 6),
      needsImprovement: (data.needsImprovement ?? local.needsImprovement).map(String).filter(Boolean).slice(0, 6),
      patterns: (data.patterns ?? local.patterns)
        .map((p) => ({
          pattern: String(p?.pattern ?? '').slice(0, 120),
          evidence: String(p?.evidence ?? '').slice(0, 300),
          suggestion: String(p?.suggestion ?? '').slice(0, 300),
        }))
        .filter((p) => p.pattern)
        .slice(0, 6),
      recommendations: (data.recommendations ?? local.recommendations).map(String).filter(Boolean).slice(0, 8),
      source: summary.demo ? 'local' : 'ai',
      generatedAt: nowIso(),
    };

    // A model that returns nothing usable falls back to the deterministic report.
    if (!report.summary || (!report.needsImprovement.length && !report.strongAreas.length)) {
      throw new Error('incomplete-analysis');
    }

    /**
     * Attribution has to be truthful. When the offline sample library answered, `summary.provider`
     * still names the provider that *would* have been used, so storing it would read as a real model
     * call in the audit trail. Sample output is recorded as such instead.
     */
    const usedSample = summary.demo === true;
    const provider = usedSample ? 'sample' : (summary.provider ?? null);
    const model = usedSample ? 'vroqn-sample' : (summary.model ?? null);
    report.provider = provider;
    report.model = model;

    await db.run(
      `INSERT INTO arena_performance_reports (id, attempt_id, user_id, report, provider, model, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (attempt_id) DO UPDATE SET report = excluded.report, provider = excluded.provider,
         model = excluded.model, generated_at = excluded.generated_at`,
      [uuid(), attemptId, userId, JSON.stringify(report), provider, model, report.generatedAt],
    );
    return report;
  } catch {
    await db.run(
      `INSERT INTO arena_performance_reports (id, attempt_id, user_id, report, provider, model, generated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT (attempt_id) DO UPDATE SET report = excluded.report, provider = NULL, model = NULL,
         generated_at = excluded.generated_at`,
      [uuid(), attemptId, userId, JSON.stringify(local), local.generatedAt],
    );
    return local;
  }
}

/**
 * Deterministic analysis derived purely from the attempt.
 * Used when no AI is available, and as the fallback if the model returns something unusable.
 */
export function localReport(args: {
  result: ArenaResultRecord;
  subjectAnalysis: ArenaBreakdownItem[];
  topicAnalysis: ArenaBreakdownItem[];
  difficultyAnalysis: ArenaBreakdownItem[];
  typeAnalysis: ArenaBreakdownItem[];
  timeAnalysis: ArenaTimeAnalysis;
  questions: ArenaQuestionRecord[];
  answerMap: Map<string, ArenaAnswerRow>;
}): ArenaPerformanceReport {
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const weak = args.topicAnalysis.filter((t) => t.accuracy < 0.75).slice(0, 3);
  const strong = [...args.topicAnalysis].filter((t) => t.accuracy >= 0.75 && t.total >= 1).sort((a, b) => b.accuracy - a.accuracy).slice(0, 3);

  const patterns: ArenaPerformanceReport['patterns'] = [];

  const numerical = args.typeAnalysis.find((t) => t.key === 'numerical');
  if (numerical && numerical.incorrect > 0) {
    const blanks = args.questions.filter(
      (q) => q.question_type === 'numerical' && !(args.answerMap.get(q.id)?.answer ?? '').trim(),
    ).length;
    patterns.push({
      pattern: blanks >= 1 ? 'Calculation practice and time on numericals' : 'Calculation slips in numericals',
      evidence: `${numerical.correct} of ${numerical.total} numerical questions were correct${blanks ? `, and ${blanks} were left blank` : ''}.`,
      suggestion: 'Do 5 numerical questions per day and write every step before substituting values.',
    });
  }

  const easy = args.difficultyAnalysis.find((d) => d.key === 'easy');
  const hard = args.difficultyAnalysis.find((d) => d.key === 'hard');
  if (easy && hard && easy.accuracy - hard.accuracy >= 0.25) {
    patterns.push({
      pattern: 'Confident basics, weaker on multi-step questions',
      evidence: `Easy questions ${pct(easy.accuracy)} vs hard questions ${pct(hard.accuracy)}.`,
      suggestion: 'Move from single-step practice to two-step and then multi-step questions on the topics you already know.',
    });
  }

  if (args.timeAnalysis.timePressure) {
    patterns.push({
      pattern: 'Time pressure at the end of the paper',
      evidence: `Average ${Math.round(args.timeAnalysis.firstThirdAvgMs / 1000)}s per question in the first third vs ${Math.round(args.timeAnalysis.lastThirdAvgMs / 1000)}s in the last third.`,
      suggestion: 'Practise with a timer and aim to finish the first 60% of the paper in half the time.',
    });
  }

  const blanks = args.questions.filter((q) => !(args.answerMap.get(q.id)?.answer ?? '').trim());
  if (blanks.length >= Math.max(2, Math.round(args.questions.length * 0.15))) {
    patterns.push({
      pattern: 'Leaving questions unattempted',
      evidence: `${blanks.length} of ${args.questions.length} questions were left blank (no negative marks for blanks).`,
      suggestion: 'Attempt every question you can eliminate one option from — a blank is a guaranteed zero.',
    });
  }

  const incorrectTopics = args.topicAnalysis.filter((t) => t.incorrect > 0);
  if (incorrectTopics.length > args.topicAnalysis.length / 2 && args.topicAnalysis.length > 2) {
    patterns.push({
      pattern: 'Spread thin across topics',
      evidence: `Mistakes appeared in ${incorrectTopics.length} of ${args.topicAnalysis.length} topics rather than one or two.`,
      suggestion: 'Pick two weak topics this week and master them completely before moving on.',
    });
  }

  const subjectLine = args.subjectAnalysis.map((s) => `${s.label} ${pct(s.accuracy)}`).join(', ');

  return {
    summary: [
      `You scored ${Number(args.result.score)} out of ${Number(args.result.max_score)} with ${pct(Number(args.result.accuracy))} accuracy (${args.result.correct} correct, ${args.result.incorrect} wrong, ${args.result.unanswered} blank).`,
      subjectLine ? `Subject-wise: ${subjectLine}.` : '',
      weak.length ? `The clear improvement areas are ${weak.map((t) => t.label).join(', ')}.` : 'No topic stood out as a clear weakness.',
      'This is an independent Vroqn mock analysis, not a prediction of any official exam rank.',
    ]
      .filter(Boolean)
      .join(' '),
    strongAreas: strong.map((t) => `${t.label} (${pct(t.accuracy)})`),
    needsImprovement: weak.map((t) => `${t.label} (${pct(t.accuracy)})`),
    patterns,
    recommendations: [
      ...weak.slice(0, 3).map((t) => `Practise 5–10 ${t.label} questions in Practice, then re-take a short timed test on it.`),
      args.timeAnalysis.timePressure ? 'Run one full-length timed paper this week to build pace.' : 'Keep practising under a timer so pace stays comfortable.',
      ...strong.slice(0, 1).map((t) => `Push ${t.label} to exam-hard level to convert a strength into marks.`),
    ].slice(0, 6),
    source: 'local',
    generatedAt: nowIso(),
  };
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

export async function competitionHistory(userId: string, limit = 30): Promise<ArenaHistoryEntry[]> {
  const rows = await db.all<
    ArenaResultRecord & {
      title: string;
      category: string;
      is_demo: number;
      results_published_at: string | null;
      submitted_at: string | null;
      auto_submitted: number;
    }
  >(
    `SELECT r.*, c.title, c.category, c.is_demo, c.results_published_at, a.submitted_at, a.auto_submitted
       FROM arena_results r
       JOIN arena_competitions c ON c.id = r.competition_id
       JOIN arena_attempts a ON a.id = r.attempt_id
      WHERE r.user_id = ?
      ORDER BY COALESCE(a.submitted_at, r.computed_at) DESC
      LIMIT ?`,
    [userId, Math.min(Math.max(limit, 1), 100)],
  );

  const entries: ArenaHistoryEntry[] = rows.map((row) => ({
    attemptId: row.attempt_id,
    competitionId: row.competition_id,
    title: row.title,
    category: row.category,
    isDemo: row.is_demo === 1,
    submittedAt: row.submitted_at ?? row.computed_at,
    score: Number(row.score),
    maxScore: Number(row.max_score),
    accuracy: Number(row.accuracy),
    percentile: row.results_published_at ? (row.percentile === null ? null : Number(row.percentile)) : null,
    rank: row.results_published_at ? (row.rank === null ? null : Number(row.rank)) : null,
    participantCount: row.results_published_at ? (row.participant_count === null ? null : Number(row.participant_count)) : null,
    resultsPublished: Boolean(row.results_published_at),
    accuracyDelta: null,
    scoreDelta: null,
  }));

  // Improvement over time, compared with the previous published attempt (oldest → newest).
  const published = [...entries].filter((e) => e.resultsPublished).reverse();
  for (let i = 1; i < published.length; i += 1) {
    const previous = published[i - 1];
    const current = published[i];
    if (current.category !== previous.category) continue;
    current.accuracyDelta = Math.round((current.accuracy - previous.accuracy) * 1000) / 10;
    current.scoreDelta = Math.round((current.score - previous.score) * 100) / 100;
  }

  return entries;
}

export { totalQuestions };
