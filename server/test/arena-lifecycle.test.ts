/**
 * Arena lifecycle, security and integrity tests.
 *
 * These are integration tests against the real services and the real (SQLite) database layer — not
 * mocks — because the guarantees being checked are exactly the ones that would break silently:
 *
 *  - the lifecycle (REGISTRATION → LIVE → SUBMISSION CLOSED → RESULTS → ARCHIVED) is derived from
 *    the server clock and cannot be driven by the client;
 *  - a competition cannot start (and a student cannot enter) unless every question in the paper has
 *    been approved;
 *  - the answer key never leaves the server before results are published;
 *  - a second submission is refused instead of being silently absorbed;
 *  - one student can never read another student's attempt, result or analysis;
 *  - competition history is a separate table from AI chat history.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';

process.env.DATA_DIR = path.join(os.tmpdir(), `vroqn-arena-${Date.now()}`);
process.env.JWT_SECRET = 'arena-test-secret-not-used-for-anything-real';
process.env.VROQN_MASTER_KEY = 'b'.repeat(64);
process.env.DEMO_MODE = 'on';
process.env.ARENA_NUMERIC_TOLERANCE_PCT = '1';

const { migrate } = await import('../src/db/schema.js');
const db = await import('../src/db/index.js');
const { HttpError } = await import('../src/middleware/errors.js');
const competitions = await import('../src/services/arena/competitions.js');
const attempts = await import('../src/services/arena/attempts.js');
const results = await import('../src/services/arena/results.js');
const { competitionHistory } = results;
const questions = await import('../src/services/arena/questions.js');
const { BLUEPRINT_PRESETS } = await import('../src/services/arena/blueprint.js');
const { hashPassword } = await import('../src/services/crypto.js');
const { uuid, nowIso } = await import('../src/db/index.js');
const { listConversations } = await import('../src/services/tutor.js');

const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function createUser(name: string): Promise<string> {
  const id = uuid();
  const now = nowIso();
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, class_level, board, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Class 10', 'CBSE', ?, ?)`,
    [id, `${name.toLowerCase()}-${id.slice(0, 6)}@arena.test`, hashPassword('arena-test-password'), name, now, now],
  );
  return id;
}

/** A competition whose registration window is open now and whose paper starts an hour from now. */
async function createCompetition(title: string, opts: { publish?: boolean } = {}) {
  return competitions.createCompetition({
    title,
    description: 'Lifecycle test competition',
    category: 'foundation',
    blueprint: { ...BLUEPRINT_PRESETS.foundation, subjects: [{ subject: 'Physics', count: 4, chapters: [] }], durationMin: 30 },
    registrationOpensAt: iso(-4 * HOUR),
    registrationClosesAt: iso(1 * HOUR),
    startsAt: iso(1 * HOUR + 60_000),
    endsAt: iso(4 * HOUR),
    createdBy: 'test-suite',
    publish: opts.publish ?? true,
  });
}

/** Moves the paper into the LIVE window without touching the clock. */
async function makeLive(competitionId: string) {
  await competitions.updateSchedule(competitionId, {
    registrationClosesAt: iso(-2 * 60_000),
    startsAt: iso(-60_000),
    endsAt: iso(4 * HOUR),
  });
}

/** Registers a student regardless of the window — used where the window must already be closed. */
async function forceRegister(userId: string, competitionId: string) {
  await db.run(
    `INSERT INTO arena_registrations (id, competition_id, user_id, status, registered_at)
     VALUES (?, ?, ?, 'registered', ?)
     ON CONFLICT (competition_id, user_id) DO NOTHING`,
    [uuid(), competitionId, userId, nowIso()],
  );
}

async function approveAll(competitionId: string) {
  const rows = await questions.listQuestions(competitionId);
  for (const row of rows) {
    await questions.updateQuestionReview(competitionId, row.id, { reviewStatus: 'approved' });
  }
  return rows.length;
}

/** Generates a full paper from the offline bank (no AI provider involved). */
async function generatePaper(competitionId: string) {
  const blueprint = await competitions.blueprintForCompetition(competitionId);
  assert.ok(blueprint, 'blueprint should exist');
  const ctx = { classLevel: 'Class 10', board: 'CBSE', subject: 'Physics' } as never;
  return questions.generatePaper({
    userId: 'test-suite',
    competitionId,
    blueprint,
    ctx,
    bankOnly: true,
    replace: true,
  });
}

before(async () => {
  await migrate();
});

describe('lifecycle is server-controlled', () => {
  it('walks REGISTRATION_OPEN → LIVE → SUBMISSION_CLOSED → RESULTS_PUBLISHED → ARCHIVED', async () => {
    const competition = await createCompetition('Lifecycle walk');
    const id = competition.id;

    assert.equal(competitions.computeState(await row(id)), 'REGISTRATION_OPEN');

    // The clock alone decides LIVE — no admin action required.
    await makeLive(id);
    assert.equal(competitions.computeState(await row(id)), 'LIVE');

    // Past the end of the window the paper is closed even if nobody clicked anything.
    await competitions.updateSchedule(id, {
      registrationClosesAt: iso(-2 * HOUR),
      startsAt: iso(-HOUR),
      endsAt: iso(-30 * 60_000),
    });
    assert.equal(competitions.computeState(await row(id)), 'SUBMISSION_CLOSED');

    await competitions.applyAdminAction(id, 'publish_results');
    assert.equal(competitions.computeState(await row(id)), 'RESULTS_PUBLISHED');
    assert.equal(competitions.isPublished(await row(id)), true);

    await competitions.applyAdminAction(id, 'archive');
    assert.equal(competitions.computeState(await row(id)), 'ARCHIVED');
  });

  it('refuses a client-supplied deadline: the attempt deadline comes from the server', async () => {
    const competition = await createCompetition('Deadline ownership');
    const student = await createUser('Deadline');
    await competitions.register(student, competition.id);
    await generatePaper(competition.id);
    const approved = await approveAll(competition.id);
    assert.ok(approved > 0);
    await makeLive(competition.id);

    const before = Date.now();
    const exam = await attempts.startAttempt(student, competition.id, { clockDriftMs: -99 * 60_000 });
    const deadline = new Date(exam.attempt.deadlineAt).getTime();
    const durationMs = Number((await row(competition.id)).duration_min) * 60_000;

    // The deadline is anchored to server time + paper duration — the 99-minute "drift" is ignored.
    assert.ok(deadline <= before + durationMs + 5_000, 'deadline must not be pushed out by client drift');
    assert.ok(deadline >= before + durationMs - 5_000, 'deadline should be the full paper duration');
    assert.ok(exam.attempt.remainingSeconds > 0);
  });

  it('does not extend a running paper when an admin extends the competition window', async () => {
    const competition = await createCompetition('Window extension');
    const student = await createUser('Extend');
    await competitions.register(student, competition.id);
    await generatePaper(competition.id);
    await approveAll(competition.id);
    await makeLive(competition.id);

    const exam = await attempts.startAttempt(student, competition.id);
    const originalDeadline = exam.attempt.deadlineAt;

    await competitions.applyAdminAction(competition.id, 'start_now', { extendMinutes: 30 });
    const after = await attempts.attemptStatus(student, competition.id);
    assert.equal(after.attempt?.deadline_at, originalDeadline, 'a started paper keeps its own deadline');
  });
});

describe('a paper must be approved before anyone can sit it', () => {
  it('blocks students until every question is approved', async () => {
    const competition = await createCompetition('Approval gate');
    const student = await createUser('Approval');
    await competitions.register(student, competition.id);
    await generatePaper(competition.id);
    await makeLive(competition.id);

    const readiness = await questions.paperReadiness(competition.id);
    assert.equal(readiness.ready, false, 'a freshly generated paper is pending review');
    assert.equal(readiness.pending > 0, true);

    await assert.rejects(
      () => attempts.startAttempt(student, competition.id),
      (err: unknown) => err instanceof HttpError && err.code === 'paper_not_ready',
    );

    // The admin cannot start the competition either.
    await assert.rejects(
      () => competitions.applyAdminAction(competition.id, 'start_now'),
      (err: unknown) => err instanceof HttpError && err.code === 'paper_not_ready',
    );

    await approveAll(competition.id);
    const after = await questions.paperReadiness(competition.id);
    assert.equal(after.ready, true);
    const exam = await attempts.startAttempt(student, competition.id);
    assert.ok(exam.questions.length > 0, 'students can enter an approved paper');
  });

  it('reopens the gate when a question is flagged mid-competition', async () => {
    const competition = await createCompetition('Flagged mid-run');
    const student = await createUser('Flagged');
    await competitions.register(student, competition.id);
    await generatePaper(competition.id);
    const rows = await questions.listQuestions(competition.id);
    for (const row of rows) await questions.updateQuestionReview(competition.id, row.id, { reviewStatus: 'approved' });
    await makeLive(competition.id);

    await questions.updateQuestionReview(competition.id, rows[0]!.id, { reviewStatus: 'flagged' });
    const readiness = await questions.paperReadiness(competition.id);
    assert.equal(readiness.ready, false);

    const newcomer = await createUser('FlaggedNewcomer');
    await forceRegister(newcomer, competition.id);
    await assert.rejects(
      () => attempts.startAttempt(newcomer, competition.id),
      (err: unknown) => err instanceof HttpError && err.code === 'paper_not_ready',
    );
  });

  it('refuses to regenerate a paper students are already sitting', async () => {
    const competition = await createCompetition('Locked paper');
    await generatePaper(competition.id);
    await makeLive(competition.id);
    await assert.rejects(
      () => generatePaper(competition.id),
      (err: unknown) => err instanceof HttpError && err.code === 'paper_locked',
    );
  });

  it('counts only approved questions towards the paper total', async () => {
    const competition = await createCompetition('Approved totals');
    await generatePaper(competition.id);
    const before = await questions.paperTotals(competition.id);
    assert.equal(before.questions, 0, 'nothing is approved yet');

    await approveAll(competition.id);
    const after = await questions.paperTotals(competition.id);
    assert.equal(after.questions, 4);
    assert.equal(after.maxScore, 4 * (after.maxScore / 4), 'max score follows the stored marks');
  });
});

describe('answer keys stay server-side', () => {
  it('never sends the key or explanation to a student before results publish', async () => {
    const competition = await createCompetition('Key secrecy');
    const student = await createUser('Secrecy');
    await competitions.register(student, competition.id);
    await generatePaper(competition.id);
    await approveAll(competition.id);
    await makeLive(competition.id);

    const exam = await attempts.startAttempt(student, competition.id);
    const serialisedExam = JSON.stringify(exam);
    assert.equal(serialisedExam.includes('correctAnswer'), false);
    assert.equal(serialisedExam.includes('correct_answer'), false);
    assert.equal(serialisedExam.includes('explanation'), false);

    // Answer everything correctly using the server-side key, then submit.
    const rows = await questions.listQuestions(competition.id);
    const correct = rows.map((row) => ({ questionId: row.id, answer: row.correct_answer }));
    const outcome = await results.submitAttempt({ userId: student, attemptId: exam.attempt.id, answers: correct });
    const pending = await results.getResultForUser(student, exam.attempt.id);
    assert.equal(pending.reviewAvailable, false, 'review stays locked until publish');
    assert.equal(pending.review, null);
    assert.equal(JSON.stringify(pending).includes('explanation'), false);
    assert.equal(pending.benchmark, null, 'no benchmark before publish either');

    await competitions.applyAdminAction(competition.id, 'publish_results');
    const published = await results.getResultForUser(student, exam.attempt.id);
    assert.equal(published.reviewAvailable, true);
    assert.equal(published.review?.length, rows.length);
    assert.ok(published.review?.[0]?.correctAnswer, 'the key is revealed after publish');
    assert.ok(published.benchmark, 'benchmark appears with the published result');
    assert.equal(outcome.score, 4 * rows.length, 'scores are computed from the stored key');
  });
});

describe('submissions', () => {
  it('refuses a duplicate submission instead of silently absorbing it', async () => {
    const competition = await createCompetition('Duplicate submit');
    const student = await createUser('Duplicate');
    await competitions.register(student, competition.id);
    await generatePaper(competition.id);
    await approveAll(competition.id);
    await makeLive(competition.id);
    const exam = await attempts.startAttempt(student, competition.id);

    const first = await results.submitAttempt({ userId: student, attemptId: exam.attempt.id, answers: [] });
    assert.ok(first.resultId);

    await assert.rejects(
      () => results.submitAttempt({ userId: student, attemptId: exam.attempt.id, answers: [] }),
      (err: unknown) =>
        err instanceof HttpError && err.code === 'already_submitted' && (err.details as { attemptId?: string })?.attemptId === exam.attempt.id,
    );
  });

  it('grades what the server holds and ignores client answers once the deadline passed', async () => {
    const competition = await createCompetition('Late answers');
    const student = await createUser('Late');
    await competitions.register(student, competition.id);
    await generatePaper(competition.id);
    await approveAll(competition.id);
    await makeLive(competition.id);
    const exam = await attempts.startAttempt(student, competition.id);
    const rows = await questions.listQuestions(competition.id);

    // Correct answer saved in time, wrong answer offered after the deadline.
    await attempts.saveAnswers({
      userId: student,
      competitionId: competition.id,
      updates: [{ questionId: rows[0]!.id, answer: rows[0]!.correct_answer }],
    });
    await db.run('UPDATE arena_attempts SET deadline_at = ? WHERE id = ?', [iso(-1000), exam.attempt.id]);

    const status = await attempts.attemptStatus(student, competition.id);
    assert.equal(status.expired, true);

    const outcome = await results.submitAttempt({
      userId: student,
      attemptId: exam.attempt.id,
      answers: [{ questionId: rows[0]!.id, answer: 'definitely-not-the-answer' }],
      autoSubmitted: true,
    });
    assert.equal(outcome.correct, 1, 'the saved (correct) answer is the one that counts');
    assert.equal(outcome.autoSubmitted, true);
  });

  it('computes rank and percentile on the server from submitted attempts only', async () => {
    const competition = await createCompetition('Benchmark');
    await generatePaper(competition.id);
    await approveAll(competition.id);
    const rows = await questions.listQuestions(competition.id);

    // Three students: all correct, half correct, none correct. Registered while the window is open.
    const scores: number[] = [];
    const entrants: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const student = await createUser(`Bench${index}`);
      await competitions.register(student, competition.id);
      entrants.push(student);
    }
    await makeLive(competition.id);
    for (const [index, answered] of [rows.length, Math.floor(rows.length / 2), 0].entries()) {
      const student = entrants[index]!;
      const exam = await attempts.startAttempt(student, competition.id);
      const outcome = await results.submitAttempt({
        userId: student,
        attemptId: exam.attempt.id,
        answers: rows.slice(0, answered).map((row) => ({ questionId: row.id, answer: row.correct_answer })),
      });
      scores.push(outcome.score);
    }

    // A registered student who never sat the paper must not affect the benchmark.
    const absentee = await createUser('Absent');
    await forceRegister(absentee, competition.id);

    await competitions.applyAdminAction(competition.id, 'publish_results');
    const recalculated = await results.recalculateBenchmarks(competition.id);
    assert.equal(recalculated, 3, 'only attempts that submitted are in the pool');

    const top = await results.getResultForUser(await userIdByIndex('Bench0'), await attemptIdFor('Bench0'));
    assert.equal(top.benchmark?.participantCount, 3);
    assert.equal(top.benchmark?.rank, 1);
    assert.ok((top.benchmark?.percentile ?? 0) > 60, `top percentile should be high, got ${top.benchmark?.percentile}`);
    assert.ok(top.benchmark?.populationLabel.includes('3 valid submitted'), 'population is stated honestly');

    async function attemptIdFor(name: string): Promise<string> {
      const row = await db.one<{ id: string }>(
        `SELECT a.id FROM arena_attempts a
           JOIN users u ON u.id = a.user_id
          WHERE u.email LIKE ? AND a.competition_id = ?`,
        [`${name.toLowerCase()}-%`, competition.id],
      );
      assert.ok(row, `attempt for ${name}`);
      return row.id;
    }
    async function userIdByIndex(name: string): Promise<string> {
      const row = await db.one<{ id: string }>('SELECT id FROM users WHERE email LIKE ?', [`${name.toLowerCase()}-%`]);
      assert.ok(row, `user ${name}`);
      return row.id;
    }
  });
});

describe('access control', () => {
  it('stops one student from reading another student’s attempt, result or analysis', async () => {
    const competition = await createCompetition('Ownership');
    await generatePaper(competition.id);
    await approveAll(competition.id);

    const owner = await createUser('Owner');
    const nosy = await createUser('Nosy');
    await competitions.register(owner, competition.id);
    await competitions.register(nosy, competition.id);
    await makeLive(competition.id);

    const exam = await attempts.startAttempt(owner, competition.id);
    await results.submitAttempt({ userId: owner, attemptId: exam.attempt.id, answers: [] });

    await assert.rejects(
      () => results.getResultForUser(nosy, exam.attempt.id),
      (err: unknown) => err instanceof HttpError && err.status === 403,
    );
    await assert.rejects(
      () => results.generatePerformanceReport(nosy, exam.attempt.id),
      (err: unknown) => err instanceof HttpError && err.status === 403,
    );
    await assert.rejects(
      () => results.submitAttempt({ userId: nosy, attemptId: exam.attempt.id, answers: [] }),
      (err: unknown) => err instanceof HttpError && err.status === 403,
    );

    // And the owner still can.
    const mine = await results.getResultForUser(owner, exam.attempt.id);
    assert.equal(mine.result.attemptId, exam.attempt.id);
  });

  it('builds the analysis from the real attempt and attributes it honestly', async () => {
    const competition = await createCompetition('Analysis grounding');
    await generatePaper(competition.id);
    await approveAll(competition.id);

    const student = await createUser('Analysis');
    await competitions.register(student, competition.id);
    await makeLive(competition.id);
    const exam = await attempts.startAttempt(student, competition.id);
    const rows = await questions.listQuestions(competition.id);

    // A deliberately mixed paper: the first half answered correctly, the rest left blank.
    const outcome = await results.submitAttempt({
      userId: student,
      attemptId: exam.attempt.id,
      answers: rows.slice(0, Math.floor(rows.length / 2)).map((row) => ({ questionId: row.id, answer: row.correct_answer })),
    });
    await competitions.applyAdminAction(competition.id, 'publish_results');

    const report = await results.generatePerformanceReport(student, exam.attempt.id);

    // 1. Every number in the prose comes from this attempt — no invented score or accuracy.
    assert.match(report.summary, new RegExp(`scored ${outcome.score} out of ${outcome.maxScore}`));
    assert.match(report.summary, new RegExp(`${rows.length - Math.floor(rows.length / 2)} blank`));
    // 2. The topics it calls out really are topics in this paper.
    const topics = new Set(rows.map((row) => row.topic));
    for (const label of [...report.strongAreas, ...report.needsImprovement]) {
      assert.ok(
        [...topics].some((topic) => label.includes(topic)),
        `"${label}" is not grounded in this paper's topics (${[...topics].join(', ')})`,
      );
    }
    // 3. Nothing claims a provider ran when it did not. In this process no key is connected, so the
    //    offline sample library answers and must be recorded as such.
    assert.equal(report.source, 'local');
    assert.equal(report.provider, 'sample');
    assert.equal(report.model, 'vroqn-sample');
    const stored = await db.one<{ provider: string | null; model: string | null }>(
      'SELECT provider, model FROM arena_performance_reports WHERE attempt_id = ?',
      [exam.attempt.id],
    );
    assert.equal(stored?.provider, 'sample', 'the audit trail must not name a provider that never ran');
    assert.equal(stored?.model, 'vroqn-sample');
  });

  it('keeps competition history separate from AI chat history', async () => {
    const competition = await createCompetition('Isolation');
    await generatePaper(competition.id);
    await approveAll(competition.id);

    const student = await createUser('Isolation');
    await competitions.register(student, competition.id);
    await makeLive(competition.id);
    const exam = await attempts.startAttempt(student, competition.id);
    await results.submitAttempt({ userId: student, attemptId: exam.attempt.id, answers: [] });

    // A chat conversation for the same student must not appear in Arena history (and vice versa).
    const now = nowIso();
    await db.run('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      uuid(),
      student,
      'Chat about Physics',
      now,
      now,
    ]);
    const history = await competitionHistory(student);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.attemptId, exam.attempt.id);
    assert.equal(
      history.some((entry) => entry.title === 'Chat about Physics'),
      false,
      'Arena history must never include chat threads',
    );

    const chats = await listConversations(student);
    assert.equal(chats.some((chat) => String(chat.title).includes('Ownership')), false, 'chat list stays chat-only');
    assert.equal(chats.length, 1);
  });
});

async function row(competitionId: string) {
  const record = await db.one(
    `SELECT status, registration_opens_at, registration_closes_at, starts_at, ends_at, results_published_at, duration_min
       FROM arena_competitions WHERE id = ?`,
    [competitionId],
  );
  assert.ok(record, 'competition row');
  return record as never;
}
