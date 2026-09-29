/**
 * Learning analytics — tested at the HTTP layer against a real database, because the failure mode of
 * an analytics screen is not a crash. It is a screen that quietly says something untrue: a 100% score
 * built on one lucky answer, a trend that hides a week of nothing, or — worst — another student's
 * numbers appearing in your report.
 *
 * The tests below pin down the three promises the screen makes:
 *
 *  1. it counts only the caller's own events (`/api/activity/analytics` takes no user id, and a second
 *     student's attempts must never move the first student's numbers);
 *  2. every figure is derived, not estimated — totals, per-subject accuracy, the daily trend and the
 *     quiet days all reconcile with the rows that were written;
 *  3. small samples are labelled `provisional` instead of being shown as a confident rate, and a topic
 *     is only "weak" or "strong" once it has enough attempts behind it.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { SessionUser } from '../src/middleware/auth.js';

process.env.DATA_DIR = path.join(os.tmpdir(), `vroqn-analytics-${Date.now()}`);
process.env.JWT_SECRET = 'analytics-test-secret-not-used-anywhere-real';
process.env.VROQN_MASTER_KEY = 'd'.repeat(64);
process.env.DEMO_MODE = 'on';

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { migrate } = await import('../src/db/schema.js');
const db = await import('../src/db/index.js');
const { hashPassword } = await import('../src/services/crypto.js');
const { attachUser, signSession } = await import('../src/middleware/auth.js');
const { errorHandler, notFoundHandler } = await import('../src/middleware/errors.js');
const { activityRouter } = await import('../src/routes/activity.js');

/* ------------------------------------------------------------------ harness --------------------- */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(attachUser);
app.use('/api/activity', activityRouter);
app.use(notFoundHandler);
app.use(errorHandler);

let server: import('node:http').Server;
let base = '';

async function call<T = Record<string, unknown>>(
  token: string | null,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

async function createStudent(name: string): Promise<{ id: string; token: string }> {
  const id = db.uuid();
  const now = db.nowIso();
  const user: SessionUser = {
    id,
    email: `${name.toLowerCase().replace(/[^a-z]/g, '')}-${id.slice(0, 6)}@analytics.test`,
    name,
    role: 'student',
  };
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, class_level, board, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Class 12', 'CBSE', ?, ?)`,
    [id, user.email, hashPassword('analytics-test-password'), name, now, now],
  );
  return { id, token: signSession(user) };
}

/** Writes one activity event exactly the way a practice or exam session would. */
async function recordEvent(
  userId: string,
  event: {
    kind: string;
    subject?: string | null;
    topic?: string | null;
    minutes?: number;
    correct?: number | null;
    total?: number | null;
    daysAgo?: number;
    label?: string;
  },
): Promise<void> {
  const at = new Date(Date.now() - (event.daysAgo ?? 0) * 86_400_000).toISOString();
  await db.run(
    `INSERT INTO activity_events (id, user_id, kind, subject, topic, duration_ms, correct, total, label, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      db.uuid(),
      userId,
      event.kind,
      event.subject ?? null,
      event.topic ?? null,
      Math.round((event.minutes ?? 0) * 60_000),
      event.correct ?? null,
      event.total ?? null,
      event.label ?? 'Test event',
      at,
    ],
  );
}

async function recordTopic(userId: string, subject: string, topic: string, attempted: number, correct: number): Promise<void> {
  await db.run(
    `INSERT INTO topic_stats (id, user_id, subject, topic, attempted, correct, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [db.uuid(), userId, subject, topic, attempted, correct, db.nowIso()],
  );
}

interface Analytics {
  days: number;
  notes: string[];
  totals: {
    minutes: number;
    questions: number;
    correct: number;
    accuracy: number;
    activeDays: number;
    quietDays: number;
    sessions: number;
  };
  trend: { date: string; minutes: number; questions: number; correct: number }[];
  subjects: { subject: string; questions: number; accuracy: number; provisional: boolean }[];
  topics: {
    weak: { subject: string; topic: string; accuracy: number; attempts: number }[];
    strong: { subject: string; topic: string; accuracy: number; attempts: number }[];
    all: { topic: string; provisional: boolean }[];
  };
  exams: { id: string; score: number }[];
}

before(async () => {
  await migrate();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const connection = await db.getDb();
  await connection.close().catch(() => undefined);
});

/* ------------------------------------------------------------------ tests ----------------------- */

describe('learning analytics recounts the student’s own record', () => {
  it('requires a session — the endpoint never accepts a user id', async () => {
    const anonymous = await call(null, 'GET', '/api/activity/analytics');
    assert.equal(anonymous.status, 401);

    // Passing someone else's id as a query parameter must change nothing.
    const student = await createStudent('Solo Student');
    const reply = await call<Analytics>(student.token, 'GET', `/api/activity/analytics?days=30&userId=someone-else`);
    assert.equal(reply.status, 200);
    assert.equal(reply.body.totals.questions, 0, 'a fabricated user id must not import another student’s work');
  });

  it('adds up exactly what was recorded, and counts quiet days as zero', async () => {
    const student = await createStudent('Accurate Student');
    await recordEvent(student.id, { kind: 'practice', subject: 'Physics', minutes: 25, correct: 8, total: 10 });
    await recordEvent(student.id, { kind: 'practice', subject: 'Physics', minutes: 15, correct: 6, total: 10, daysAgo: 2 });
    await recordEvent(student.id, { kind: 'tutor', subject: null, minutes: 10, correct: null, total: null, daysAgo: 4 });

    const reply = await call<Analytics>(student.token, 'GET', '/api/activity/analytics?days=7');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const { totals, trend } = reply.body;

    assert.equal(totals.minutes, 50, 'minutes must be the sum of the recorded durations');
    assert.equal(totals.questions, 20);
    assert.equal(totals.correct, 14);
    assert.equal(Math.round(totals.accuracy * 1000) / 1000, 0.7);
    assert.equal(totals.sessions, 3);
    assert.equal(totals.activeDays, 3);
    assert.equal(totals.quietDays, 4, 'a week with three active days has four quiet ones, stated plainly');

    assert.equal(trend.length, 7, 'the trend covers every day in the window');
    const summed = trend.reduce((acc, point) => acc + point.minutes, 0);
    assert.equal(summed, 50, 'the chart must total the same as the headline figure');
    assert.equal(trend.filter((point) => point.minutes === 0).length, 4);
  });

  it('marks a rate from one attempt as provisional instead of printing a confident 100%', async () => {
    const student = await createStudent('Single Attempt');
    await recordEvent(student.id, { kind: 'practice', subject: 'Chemistry', minutes: 5, correct: 1, total: 1 });

    const reply = await call<Analytics>(student.token, 'GET', '/api/activity/analytics?days=7');
    const chemistry = reply.body.subjects.find((row) => row.subject === 'Chemistry');
    assert.ok(chemistry, 'the subject must still be listed');
    assert.equal(chemistry.provisional, true, 'one attempt is not a score');
    assert.ok(reply.body.notes.some((note) => note.includes('provisional')), 'the screen is told to say so');
  });

  it('only calls a topic weak or strong once there are enough attempts', async () => {
    const student = await createStudent('Topic Shapes');
    // One correct answer: 100% but provisional, so it must not be a "strength".
    await recordTopic(student.id, 'Biology', 'Single guess', 1, 1);
    // Four attempts at 50%: fairly weak, and enough attempts to say so.
    await recordTopic(student.id, 'Biology', 'Cell division', 4, 2);
    // Four attempts at 100%: a strength.
    await recordTopic(student.id, 'Physics', 'Units', 4, 4);

    const reply = await call<Analytics>(student.token, 'GET', '/api/activity/analytics?days=30');
    assert.deepEqual(
      reply.body.topics.weak.map((row) => row.topic),
      ['Cell division'],
    );
    assert.deepEqual(
      reply.body.topics.strong.map((row) => row.topic),
      ['Units'],
    );
    const single = reply.body.topics.all.find((row) => row.topic === 'Single guess');
    assert.equal(single?.provisional, true, 'an unproven topic is labelled, not promoted');
  });

  it('never mixes two students’ numbers together', async () => {
    const one = await createStudent('First Person');
    const two = await createStudent('Second Person');
    await recordEvent(one.id, { kind: 'exam', subject: 'Mathematics', minutes: 40, correct: 3, total: 5 });
    await recordEvent(two.id, { kind: 'exam', subject: 'Mathematics', minutes: 90, correct: 9, total: 10 });

    const first = await call<Analytics>(one.token, 'GET', '/api/activity/analytics?days=7');
    const second = await call<Analytics>(two.token, 'GET', '/api/activity/analytics?days=7');
    assert.equal(first.body.totals.questions, 5);
    assert.equal(second.body.totals.questions, 10);
    assert.equal(first.body.totals.minutes, 40, 'the other student’s 90 minutes must not appear here');
  });

  it('rejects a window outside the supported range', async () => {
    const student = await createStudent('Window Check');
    assert.equal((await call(student.token, 'GET', '/api/activity/analytics?days=3')).status, 400);
    assert.equal((await call(student.token, 'GET', '/api/activity/analytics?days=999')).status, 400);
    assert.equal((await call(student.token, 'GET', '/api/activity/analytics?days=90')).status, 200);
  });

  it('reports an empty record honestly rather than inventing a baseline', async () => {
    const student = await createStudent('Brand New');
    const reply = await call<Analytics>(student.token, 'GET', '/api/activity/analytics?days=30');
    assert.equal(reply.status, 200);
    assert.equal(reply.body.totals.sessions, 0);
    assert.equal(reply.body.totals.accuracy, 0);
    assert.equal(reply.body.subjects.length, 0, 'no attempts means no subject rows at all');
    assert.equal(reply.body.trend.length, 30);
    assert.ok(reply.body.trend.every((point) => point.minutes === 0 && point.questions === 0));
  });
});
