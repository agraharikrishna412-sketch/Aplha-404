/**
 * Arena demo seeder (development only).
 *
 *   npm run seed:arena --workspace server
 *
 * Creates three clearly-labelled demo competitions so the whole Arena flow can be demonstrated
 * without a live AI key or real participants:
 *
 *   1. registration open  → test Register + My Competitions
 *   2. live now           → test the competition exam, autosave and submission
 *   3. results published  → test benchmarking (rank/percentile) + AI analysis + weak-area practice
 *
 * Everything it writes is marked as demo: competitions carry is_demo = 1, and synthetic aspirants
 * live on the reserved @demo.vroqn.local domain. Re-running replaces the previous demo data only —
 * it never touches real students, real competitions or the AI Tutor history.
 *
 * Refuses to run when NODE_ENV=production unless ARENA_SEED_DEMO=1 is set explicitly.
 */
import { migrate } from './schema.js';
import * as db from './index.js';
import { nowIso, uuid } from './index.js';
import { hashPassword } from '../services/crypto.js';
import { createCompetition, applyAdminAction, register, updateSchedule } from '../services/arena/competitions.js';
import { generatePaper, listQuestions, paperReadiness, updateQuestionReview } from '../services/arena/questions.js';
import { submitAttempt, recalculateBenchmarks, generatePerformanceReport } from '../services/arena/results.js';
import { startAttempt } from '../services/arena/attempts.js';
import { BLUEPRINT_PRESETS, normaliseBlueprint } from '../services/arena/blueprint.js';
import type { ArenaBlueprint, ArenaQuestionRecord } from '../types/arena.js';
import type { PromptContext } from '../services/ai/prompts.js';
import { DEFAULT_SETTINGS } from '../types/domain.js';

const DEMO_DOMAIN = 'demo.vroqn.local';
const STUDENT_EMAIL = process.env.SEED_EMAIL ?? 'demo@vroqn.dev';
const ASPIRANT_COUNT = 60;

if (process.env.NODE_ENV === 'production' && process.env.ARENA_SEED_DEMO !== '1') {
  console.error('[seed:arena] Refusing to seed demo competitions in production. Set ARENA_SEED_DEMO=1 to override.');
  process.exit(1);
}

/** The seeder has no AI keys to depend on; questions come from the verified offline bank. */
const ctx: PromptContext = { settings: DEFAULT_SETTINGS };

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function demoStudent(): Promise<{ id: string; email: string; name: string }> {
  const row = await db.one<{ id: string; email: string; name: string }>('SELECT id, email, name FROM users WHERE email = ?', [
    STUDENT_EMAIL,
  ]);
  if (row) return row;
  const id = uuid();
  const now = nowIso();
  await db.run(
    `INSERT INTO users (id, email, name, class_level, board, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'student', ?, ?)`,
    [id, STUDENT_EMAIL, 'Aarav', 'Class 12', 'CBSE', hashPassword(process.env.SEED_PASSWORD ?? 'nexus1234'), now, now],
  );
  await db.run(
    `INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [id, JSON.stringify(DEFAULT_SETTINGS), now],
  );
  return { id, email: STUDENT_EMAIL, name: 'Aarav' };
}

async function wipeDemoData(): Promise<void> {
  const competitions = await db.all<{ id: string }>('SELECT id FROM arena_competitions WHERE is_demo = 1');
  for (const { id } of competitions) {
    await db.run('DELETE FROM arena_answers WHERE attempt_id IN (SELECT id FROM arena_attempts WHERE competition_id = ?)', [id]);
    await db.run('DELETE FROM arena_performance_reports WHERE attempt_id IN (SELECT id FROM arena_attempts WHERE competition_id = ?)', [id]);
    await db.run('DELETE FROM arena_results WHERE competition_id = ?', [id]);
    await db.run('DELETE FROM arena_attempts WHERE competition_id = ?', [id]);
    await db.run('DELETE FROM arena_registrations WHERE competition_id = ?', [id]);
    await db.run('DELETE FROM arena_questions WHERE competition_id = ?', [id]);
    await db.run('DELETE FROM arena_competitions WHERE id = ?', [id]);
  }
  // Synthetic aspirants are confined to the reserved demo domain.
  const aspirants = await db.all<{ id: string }>('SELECT id FROM users WHERE email LIKE ?', [`%@${DEMO_DOMAIN}`]);
  for (const { id } of aspirants) {
    await db.run('DELETE FROM arena_answers WHERE attempt_id IN (SELECT id FROM arena_attempts WHERE user_id = ?)', [id]);
    await db.run('DELETE FROM arena_performance_reports WHERE user_id = ?', [id]);
    await db.run('DELETE FROM arena_results WHERE user_id = ?', [id]);
    await db.run('DELETE FROM arena_attempts WHERE user_id = ?', [id]);
    await db.run('DELETE FROM arena_registrations WHERE user_id = ?', [id]);
    await db.run('DELETE FROM topic_stats WHERE user_id = ?', [id]);
    await db.run('DELETE FROM activity_events WHERE user_id = ?', [id]);
    await db.run('DELETE FROM user_settings WHERE user_id = ?', [id]);
    await db.run('DELETE FROM users WHERE id = ?', [id]);
  }
  await db.run('DELETE FROM activity_events WHERE label LIKE ?', ['%Demo%']);
}

/**
 * Creates a synthetic aspirant so benchmarking is computed from real stored attempts.
 * Idempotent: the same index always maps to the same demo account.
 */
async function createAspirant(index: number): Promise<string> {
  const email = `aspirant-${index}@${DEMO_DOMAIN}`;
  const existing = await db.one<{ id: string }>('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return existing.id;
  const id = uuid();
  const now = nowIso();
  await db.run(
    `INSERT INTO users (id, email, name, class_level, board, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, 'Class 12', 'CBSE', ?, 'student', ?, ?)`,
    [id, email, `Aspirant ${index}`, hashPassword(uuid()), now, now],
  );
  return id;
}

/** Picks an answer with a target accuracy so the pool has a believable spread. */
function answerFor(question: ArenaQuestionRecord, correct: boolean, rng: () => number): string {
  const options = question.options ? (JSON.parse(question.options) as string[]) : [];
  const type = question.question_type;
  if (type === 'numerical') {
    if (correct) return question.correct_answer;
    const value = Number(question.correct_answer.replace(/[^\d.-]/g, ''));
    const drifted = Number.isFinite(value) ? value * (rng() > 0.5 ? 1.14 : 0.86) : 12;
    return String(Math.round(drifted * 100) / 100);
  }
  if (correct) return question.correct_answer;
  const wrong = options.filter((option) => option !== question.correct_answer);
  if (!wrong.length) return '';
  return wrong[Math.floor(rng() * wrong.length)]!;
}

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/**
 * Seeds a competition's paper and then reviews it, exactly the way an admin would.
 *
 * Generation deliberately leaves questions in `pending`, because a competition may not start until
 * every question has been approved (the server enforces this). The seeder therefore approves each
 * seeded question through the same review function the admin console uses — so a freshly seeded
 * demo behaves like a properly published paper, and the approval gate is never bypassed.
 */
async function seedQuestions(competitionId: string, blueprint: ArenaBlueprint, userId: string): Promise<number> {
  await generatePaper({
    userId,
    competitionId,
    blueprint,
    ctx,
    // The offline bank is used on purpose: seeding must never depend on a student's AI key,
    // and every seeded question still passes the same validation pipeline.
    bankOnly: true,
    replace: true,
  });

  const rows = await listQuestions(competitionId, { onlyApproved: false });
  let approved = 0;
  for (const row of rows) {
    if (row.review_status === 'approved') {
      approved += 1;
      continue;
    }
    const ok = await updateQuestionReview(competitionId, row.id, { reviewStatus: 'approved' });
    if (ok) approved += 1;
  }
  const readiness = await paperReadiness(competitionId);
  if (!readiness.ready) {
    throw new Error(
      `[seed:arena] refusing to seed an unready paper for ${competitionId}: ${readiness.blocker ?? 'unknown reason'}`,
    );
  }
  return approved;
}

async function main(): Promise<void> {
  await migrate();
  const student = await demoStudent();
  await wipeDemoData();
  console.log(`[seed:arena] demo student ${student.email}`);

  /* ------------------------- 1. registration open ------------------------- */
  const upcomingBlueprint = normaliseBlueprint(BLUEPRINT_PRESETS['pre-jee']);
  const upcoming = await createCompetition({
    title: 'Vroqn Pre-JEE Challenge — Demo',
    description:
      'An independent Vroqn competitive mock. Physics, Chemistry and Mathematics at JEE-style difficulty, seeded questions for demonstration purposes.',
    category: 'pre-jee',
    blueprint: upcomingBlueprint,
    registrationOpensAt: minutesFromNow(-60 * 24 * 3),
    registrationClosesAt: minutesFromNow(60 * 30),
    startsAt: minutesFromNow(60 * 34),
    endsAt: minutesFromNow(60 * 34 + 100),
    difficulty: 'mixed',
    isDemo: true,
    createdBy: student.id,
    publish: true,
  });
  const upcomingQuestions = await seedQuestions(upcoming.id, upcomingBlueprint, student.id);

  /* -------------------------------- 2. live -------------------------------- */
  const liveBlueprint = normaliseBlueprint({
    ...BLUEPRINT_PRESETS.foundation,
    subjects: [
      { subject: 'Physics', count: 8, chapters: [] },
      { subject: 'Mathematics', count: 7, chapters: [] },
    ],
    types: { mcq: 60, numerical: 20, conceptual: 20 },
    durationMin: 45,
  });
  const live = await createCompetition({
    title: 'Vroqn Physics Challenge — Demo (live now)',
    description:
      'A short live Vroqn mock so you can try the competition exam end to end: timer, question palette, autosave and submission.',
    category: 'foundation',
    blueprint: liveBlueprint,
    registrationOpensAt: minutesFromNow(-60 * 24),
    // Registration closes exactly when the paper opens (the seeder starts it immediately after).
    registrationClosesAt: minutesFromNow(5),
    startsAt: minutesFromNow(5),
    endsAt: minutesFromNow(5 + 120),
    difficulty: 'mixed',
    isDemo: true,
    createdBy: student.id,
    publish: true,
  });
  const liveQuestions = await seedQuestions(live.id, liveBlueprint, student.id);
  // Register first (registration genuinely closes when the paper opens), then start it, so the
  // demo student can enter the live competition with a single click.
  await register(student.id, live.id);
  for (let i = 1; i <= 12; i += 1) {
    const aspirant = await createAspirant(i);
    await register(aspirant, live.id);
  }
  await applyAdminAction(live.id, 'start_now', { extendMinutes: 110 });

  /* --------------------------- 3. results published -------------------------
   * The completed competition is built through the real lifecycle rather than by back-dating rows:
   * it opens, the paper is generated and approved, the aspirants register and sit it, submissions
   * close and results publish — and only then is its schedule moved into the past. That way the
   * seeded demo state is something the server itself produced, and the guards (approved paper,
   * answer-key secrecy, server-side timing) are exercised by the seeding run too.
   */
  const doneBlueprint = normaliseBlueprint(BLUEPRINT_PRESETS['pre-neet']);
  const done = await createCompetition({
    title: 'Vroqn Pre-NEET Challenge — Demo (results out)',
    description:
      'A completed independent Vroqn mock with a seeded participant pool, so benchmarking, percentile and the post-competition analysis can be demonstrated honestly.',
    category: 'pre-neet',
    blueprint: doneBlueprint,
    registrationOpensAt: minutesFromNow(-60 * 24 * 10),
    registrationClosesAt: minutesFromNow(30),
    startsAt: minutesFromNow(31),
    endsAt: minutesFromNow(160),
    difficulty: 'mixed',
    isDemo: true,
    createdBy: student.id,
    publish: true,
  });
  const doneQuestions = await seedQuestions(done.id, doneBlueprint, student.id);
  const questionRows = await db.all<ArenaQuestionRecord>(
    'SELECT * FROM arena_questions WHERE competition_id = ? ORDER BY position',
    [done.id],
  );

  // Everyone enters while registration is genuinely open, then the paper opens.
  const doneEntrants: string[] = [student.id];
  for (let i = 1; i <= ASPIRANT_COUNT; i += 1) {
    const aspirant = await createAspirant(i);
    await register(aspirant, done.id);
    doneEntrants.push(aspirant);
  }
  await register(student.id, done.id);
  await applyAdminAction(done.id, 'start_now', { extendMinutes: 100 });

  // Synthetic aspirants with a spread of scores.
  for (let i = 1; i <= ASPIRANT_COUNT; i += 1) {
    const aspirant = doneEntrants[i]!;
    const aspirantExam = await startAttempt(aspirant, done.id);
    const attemptId = aspirantExam.attempt.id;

    const rng = seededRng(i * 7919);
    // Accuracy spread roughly 0.2 → 0.95 so the benchmark pool has a believable top and tail.
    const skill = (i % 11 === 0 ? 0.18 : 0.25) + (i / ASPIRANT_COUNT) * 0.7 + (rng() - 0.5) * 0.12;
    const skipRate = rng() * 0.18;
    const answers = questionRows
      .filter(() => rng() > skipRate)
      .map((question) => {
        const correct = rng() < skill;
        return {
          questionId: question.id,
          answer: answerFor(question, correct, rng),
          timeSpentMs: Math.round(30_000 + rng() * 90_000),
        };
      });
    await submitAttempt({ userId: aspirant, attemptId, answers });
  }

  // The demo student's own attempt (comfortably mid-pack, with identifiable weak topics).
  const myExam = await startAttempt(student.id, done.id);
  const myAttemptId = myExam.attempt.id;

  const rng = seededRng(4242);
  // Real evidence for the analysis: strong on every third topic, weaker elsewhere, slower at the end
  // (which is what the time-pressure detector should notice).
  const topicNames = [...new Set(questionRows.map((q) => q.topic))];
  const strongTopics = topicNames.filter((_, index) => index % 3 === 0).slice(0, 6);
  const answers = questionRows.map((question, index) => {
    const strong = strongTopics.includes(question.topic);
    const latePaper = index > questionRows.length * 0.7;
    const correct = strong ? rng() < 0.9 : rng() < 0.6;
    const skip = !strong && rng() < 0.08;
    return {
      questionId: question.id,
      answer: skip ? '' : answerFor(question, correct, rng),
      timeSpentMs: Math.round((latePaper ? 90_000 : 55_000) + rng() * 40_000),
    };
  });
  await submitAttempt({ userId: student.id, attemptId: myAttemptId, answers });

  // Close submissions, publish results, then recompute the benchmark for every valid attempt.
  await applyAdminAction(done.id, 'close_submissions');
  await applyAdminAction(done.id, 'publish_results');
  const participants = await recalculateBenchmarks(done.id);
  await generatePerformanceReport(student.id, myAttemptId);
  // Now that everything has genuinely happened, back-date the schedule so the demo reads as a past
  // competition (three days ago, 100-minute paper). The published-results status is what governs
  // visibility, so the state machine still reports RESULTS_PUBLISHED.
  await updateSchedule(done.id, {
    registrationClosesAt: minutesFromNow(-60 * 24 * 4),
    startsAt: minutesFromNow(-60 * 24 * 3),
    endsAt: minutesFromNow(-60 * 24 * 3 + 100),
  });

  const myResult = await db.one<{ score: number; max_score: number; rank: number; percentile: number }>(
    'SELECT score, max_score, rank, percentile FROM arena_results WHERE attempt_id = ?',
    [myAttemptId],
  );

  console.log('');
  console.log('[seed:arena] demo competitions ready (all marked is_demo, questions flagged source=demo):');
  console.log(`  · ${upcoming.title} — registration open, ${upcomingQuestions} questions`);
  console.log(`  · ${live.title} — LIVE now, ${liveQuestions} questions (you are registered)`);
  console.log(`  · ${done.title} — results published, ${doneQuestions} questions, ${participants} valid attempts`);
  console.log(
    `  · your score there: ${myResult?.score}/${myResult?.max_score} · rank ${myResult?.rank}/${participants} · percentile ${myResult?.percentile}`,
  );
  console.log('');
  console.log(`[seed:arena] question sources: every seeded question passed the same validation pipeline as AI output.`);
}

await main();
process.exit(0);
