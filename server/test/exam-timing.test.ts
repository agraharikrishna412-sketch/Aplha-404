/**
 * Mock Exam timing, autosave and duplicate-submission guarantees.
 *
 * These are integration tests against the real service and the real (SQLite) database layer, because
 * every rule below is one that already broke silently in this codebase:
 *
 *  1. The countdown was initialised in the browser on every mount, so refreshing the runner handed
 *     the student a brand-new full-length timer. The deadline now lives on the server and is written
 *     exactly once.
 *  2. Answers were held only in component state, so a reload lost the whole attempt. They are now
 *     autosaved per question and restored on resume.
 *  3. `submitExam` had no duplicate check: submitting twice inserted a second `exam_results` row and
 *     re-ran the per-question loop, which recorded every topic stat twice and skewed the weak-area
 *     diagnosis.
 *  4. `timeSpentMs` was taken from the request body, so a client could report any elapsed time it
 *     liked.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';

process.env.DATA_DIR = path.join(os.tmpdir(), `vroqn-examtiming-${Date.now()}`);
process.env.JWT_SECRET = 'exam-timing-test-secret-not-used-for-real';
process.env.VROQN_MASTER_KEY = 'c'.repeat(64);
process.env.DEMO_MODE = 'on';

const { migrate } = await import('../src/db/schema.js');
const db = await import('../src/db/index.js');
const exams = await import('../src/services/exams.js');
const { HttpError } = await import('../src/middleware/errors.js');

const MINUTE = 60_000;

async function makeUser(email: string): Promise<string> {
  const id = db.uuid();
  const now = db.nowIso();
  await db.run(
    'INSERT INTO users (id, email, name, class_level, board, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, email, 'Exam Tester', 'class11_12', 'CBSE', 'x'.repeat(60), now, now],
  );
  return id;
}

/** A paper built straight from the offline bank, so no AI call is needed. */
async function makeExam(userId: string, durationMin = 15) {
  const { exam } = await exams.createExam({
    userId,
    subject: 'Physics',
    chapters: ['Motion'],
    difficulty: 'easy',
    questionCount: 4,
    questionType: 'mcq',
    durationMin,
  });
  return exam;
}

/** Moves a paper's deadline into the past, as if the student walked away and never came back. */
async function backDate(examId: string, msAgo: number) {
  const past = new Date(Date.now() - msAgo).toISOString();
  await db.run('UPDATE exams SET started_at = ?, expires_at = ? WHERE id = ?', [past, past, examId]);
}

/** Rewinds the start of an attempt without touching its deadline, i.e. "5 of 15 minutes used". */
async function elapse(examId: string, elapsedMs: number, durationMin: number) {
  const startedAt = new Date(Date.now() - elapsedMs);
  const expiresAt = new Date(startedAt.getTime() + durationMin * 60_000);
  await db.run('UPDATE exams SET started_at = ?, expires_at = ? WHERE id = ?', [
    startedAt.toISOString(),
    expiresAt.toISOString(),
    examId,
  ]);
}

let owner = '';
let other = '';

before(async () => {
  await migrate();
  owner = await makeUser('exam-owner@test.local');
  other = await makeUser('exam-other@test.local');
});

describe('the paper clock is server-owned', () => {
  it('starts the clock on first open and records a matching deadline', async () => {
    const exam = await makeExam(owner, 15);
    assert.equal(exam.startedAt, null, 'a freshly created paper has not started');

    const opened = await exams.openExam(owner, exam.id);
    assert.ok(opened?.startedAt, 'opening the paper starts the clock');
    assert.ok(opened?.expiresAt, 'and stamps a deadline');

    const clock = exams.clockFor(opened!);
    assert.equal(clock.durationMs, 15 * MINUTE);
    assert.ok(clock.remainingMs > 14 * MINUTE, 'the full duration is still available');
    assert.equal(clock.expired, false);
    assert.equal(
      Date.parse(opened!.expiresAt!) - Date.parse(opened!.startedAt!),
      15 * MINUTE,
      'the deadline is exactly one duration after the start',
    );
  });

  it('does not restart the clock when the paper is reopened (refresh recovery)', async () => {
    const exam = await makeExam(owner, 15);
    const first = await exams.openExam(owner, exam.id);
    const before = exams.clockFor(first!);

    // Let real time pass, then "refresh": the runner re-issues the same GET.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const reopened = await exams.openExam(owner, exam.id);
    const after = exams.clockFor(reopened!);

    assert.equal(reopened?.startedAt, first!.startedAt, 'the original start time survives a reload');
    assert.equal(reopened?.expiresAt, first!.expiresAt, 'and the deadline never moves');
    assert.ok(
      after.remainingMs < before.remainingMs,
      `elapsed time is deducted, not refunded (${before.remainingMs} → ${after.remainingMs})`,
    );
    assert.ok(after.remainingMs >= before.remainingMs - 5000, 'but only by the time actually spent');
  });

  it('deducts time already spent when the attempt is resumed later', async () => {
    const exam = await makeExam(owner, 15);
    await exams.openExam(owner, exam.id);
    await elapse(exam.id, 5 * MINUTE, 15);

    const clock = exams.clockFor((await exams.openExam(owner, exam.id))!);
    assert.equal(clock.expired, false);
    assert.ok(clock.remainingMs <= 10 * MINUTE + 1000, 'five minutes are gone');
    assert.ok(clock.remainingMs > 9 * MINUTE, 'roughly ten minutes remain');
  });

  it('reports a paper as expired once the deadline has passed', async () => {
    const exam = await makeExam(owner, 10);
    await exams.openExam(owner, exam.id);
    await backDate(exam.id, 20 * MINUTE);

    const clock = exams.clockFor((await exams.openExam(owner, exam.id))!);
    assert.equal(clock.expired, true);
    assert.equal(clock.remainingMs, 0, 'remaining time is floored at zero, never negative');
  });
});

describe('answers are autosaved and restored', () => {
  it('stores a single answer and hands it back on resume', async () => {
    const exam = await makeExam(owner);
    await exams.openExam(owner, exam.id);
    const questionId = exam.questions[0].id;

    await exams.saveExamAnswer({ userId: owner, examId: exam.id, questionId, answer: '42 metres' });
    const saved = await exams.getExamAnswers(exam.id);

    assert.deepEqual(saved.answers, { [questionId]: '42 metres' });
    assert.deepEqual(saved.flagged, []);
  });

  it('updates an existing answer instead of duplicating the row', async () => {
    const exam = await makeExam(owner);
    await exams.openExam(owner, exam.id);
    const questionId = exam.questions[0].id;

    await exams.saveExamAnswer({ userId: owner, examId: exam.id, questionId, answer: 'first' });
    await exams.saveExamAnswer({ userId: owner, examId: exam.id, questionId, answer: 'second' });

    const rows = await db.all('SELECT * FROM exam_answers WHERE exam_id = ?', [exam.id]);
    assert.equal(rows.length, 1, 'one row per question');
    assert.equal((await exams.getExamAnswers(exam.id)).answers[questionId], 'second');
  });

  it('keeps the answer when only the flag changes, and vice versa', async () => {
    const exam = await makeExam(owner);
    await exams.openExam(owner, exam.id);
    const questionId = exam.questions[1].id;

    await exams.saveExamAnswer({ userId: owner, examId: exam.id, questionId, answer: 'kept' });
    await exams.saveExamAnswer({ userId: owner, examId: exam.id, questionId, flagged: true });

    const saved = await exams.getExamAnswers(exam.id);
    assert.equal(saved.answers[questionId], 'kept', 'flagging must not wipe the answer');
    assert.deepEqual(saved.flagged, [questionId]);
  });

  it('refuses a question that is not part of the paper', async () => {
    const exam = await makeExam(owner);
    await exams.openExam(owner, exam.id);
    await assert.rejects(
      () => exams.saveExamAnswer({ userId: owner, examId: exam.id, questionId: 'not-a-question', answer: 'x' }),
      (err: unknown) => err instanceof HttpError && err.code === 'unknown_question',
    );
  });

  it('refuses answers after the server deadline but still accepts a harmless flag', async () => {
    const exam = await makeExam(owner, 10);
    await exams.openExam(owner, exam.id);
    const questionId = exam.questions[0].id;
    await backDate(exam.id, 30 * MINUTE);

    await assert.rejects(
      () => exams.saveExamAnswer({ userId: owner, examId: exam.id, questionId, answer: 'too late' }),
      (err: unknown) => err instanceof HttpError && err.code === 'time_up',
    );

    await exams.saveExamAnswer({ userId: owner, examId: exam.id, questionId, flagged: true });
    const saved = await exams.getExamAnswers(exam.id);
    assert.deepEqual(saved.answers, {}, 'nothing was written after time expired');
  });

  it('cannot be used to write into another student\u2019s paper', async () => {
    const exam = await makeExam(owner);
    await exams.openExam(owner, exam.id);
    await assert.rejects(
      () =>
        exams.saveExamAnswer({
          userId: other,
          examId: exam.id,
          questionId: exam.questions[0].id,
          answer: 'intruder',
        }),
      (err: unknown) => err instanceof HttpError && err.status === 404,
    );
    assert.deepEqual((await exams.getExamAnswers(exam.id)).answers, {}, 'and nothing was stored');
  });
});

describe('submission is idempotent and server-timed', () => {
  it('refuses a second submission and points at the result that already exists', async () => {
    const exam = await makeExam(owner);
    await exams.openExam(owner, exam.id);
    const answers = exam.questions.map((q) => ({ questionId: q.id, answer: 'x' }));

    const first = await exams.submitExam({ userId: owner, examId: exam.id, answers, timeSpentMs: 1000 });
    assert.ok(first.id);

    await assert.rejects(
      () => exams.submitExam({ userId: owner, examId: exam.id, answers, timeSpentMs: 1000 }),
      (err: unknown) => {
        assert.ok(err instanceof HttpError, 'a typed error, not a 500');
        assert.equal(err.status, 409);
        assert.equal(err.code, 'already_submitted');
        assert.deepEqual(err.details, { resultId: first.id });
        return true;
      },
    );

    const rows = await db.all('SELECT id FROM exam_results WHERE exam_id = ?', [exam.id]);
    assert.equal(rows.length, 1, 'exactly one result row — the diagnosis feed is not double-counted');
  });

  it('derives elapsed time from the server clock, not from the request body', async () => {
    const exam = await makeExam(owner, 30);
    await exams.openExam(owner, exam.id);
    await elapse(exam.id, 4 * MINUTE, 30);

    // The client claims it took no time at all; the server should ignore that.
    const result = await exams.submitExam({
      userId: owner,
      examId: exam.id,
      answers: exam.questions.map((q) => ({ questionId: q.id, answer: 'x' })),
      timeSpentMs: 0,
    });
    assert.ok(result.timeSpentMs >= 4 * MINUTE - 2000, `expected ~4 minutes, got ${result.timeSpentMs}`);
  });

  it('caps the recorded time so a forgotten tab is not a 14-hour attempt', async () => {
    const exam = await makeExam(owner, 10);
    await exams.openExam(owner, exam.id);
    await backDate(exam.id, 14 * 60 * MINUTE);

    const result = await exams.submitExam({
      userId: owner,
      examId: exam.id,
      answers: exam.questions.map((q) => ({ questionId: q.id, answer: 'x' })),
      timeSpentMs: 0,
    });
    assert.equal(result.timeSpentMs, 11 * MINUTE, 'capped at the 10-minute duration plus a 60s grace');
  });

  it('includes autosaved answers that never reached the submit payload', async () => {
    const exam = await makeExam(owner);
    await exams.openExam(owner, exam.id);
    const questionId = exam.questions[0].id;
    await exams.saveExamAnswer({ userId: owner, examId: exam.id, questionId, answer: 'saved before the crash' });

    // Submit with an empty payload, exactly as a client would after a reload with no local state.
    const result = await exams.submitExam({ userId: owner, examId: exam.id, answers: [], timeSpentMs: 0 });

    const stored = result.answers.find((a) => a.questionId === questionId);
    assert.equal(stored?.answer, 'saved before the crash', 'autosaved work is not thrown away at submit');
  });

  it('rejects a submission for a paper the caller does not own', async () => {
    const exam = await makeExam(owner);
    await exams.openExam(owner, exam.id);
    await assert.rejects(
      () => exams.submitExam({ userId: other, examId: exam.id, answers: [], timeSpentMs: 0 }),
      (err: unknown) => err instanceof HttpError && err.status === 404,
    );
  });

  it('clears the working copies once the paper is submitted', async () => {
    const exam = await makeExam(owner);
    await exams.openExam(owner, exam.id);
    await exams.saveExamAnswer({ userId: owner, examId: exam.id, questionId: exam.questions[0].id, answer: 'x' });
    await exams.submitExam({ userId: owner, examId: exam.id, answers: [], timeSpentMs: 0 });

    assert.deepEqual(
      await db.all('SELECT * FROM exam_answers WHERE exam_id = ?', [exam.id]),
      [],
      'answers live in the immutable result row after submission',
    );
  });
});
