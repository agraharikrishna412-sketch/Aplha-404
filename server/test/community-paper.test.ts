/**
 * Community papers: the two ways to fill one, and the promise that neither can leak.
 *
 * The claim being tested is narrow enough to be checkable: **the questions that run are not the
 * questions that were uploaded.** A host pastes a paper, the server parses it, rewrites every question
 * (values scaled by a common factor, options reordered with the key following) and stores only the
 * rewrite. So:
 *
 *   · the uploaded wording and numbers are not in the database,
 *   · the stored key is still a correct option after the rewrite,
 *   · the response a host gets back contains counts and no question text,
 *   · a student who starts the paper never receives the key or the explanation,
 *   · a second upload is refused, because a paper that already ran must not be swapped underneath it.
 *
 * The AI path is exercised too, with `bankOnly` behaviour standing in for "no provider key configured"
 * — the same code path a school without API keys will use.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { SessionUser } from '../src/middleware/auth.js';

process.env.DATA_DIR = path.join(os.tmpdir(), `vroqn-community-paper-${Date.now()}`);
process.env.JWT_SECRET = 'community-paper-test-secret-not-used-anywhere-real';
process.env.VROQN_MASTER_KEY = 'p'.repeat(64);
process.env.DEMO_MODE = 'on';
process.env.RATE_LIMIT_DISABLED = '1';
delete process.env.ARENA_ADMIN_EMAILS;

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { migrate } = await import('../src/db/schema.js');
const db = await import('../src/db/index.js');
const { hashPassword } = await import('../src/services/crypto.js');
const { attachUser, signSession } = await import('../src/middleware/auth.js');
const { errorHandler, notFoundHandler } = await import('../src/middleware/errors.js');
const { communitiesRouter } = await import('../src/routes/communities.js');
const { arenaRouter } = await import('../src/routes/arena.js');
const { parseUploadedPaper, rewriteQuestion, scaleNumbers } = await import('../src/services/communities/paper.js');

await migrate();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(attachUser);
app.use('/api/communities', communitiesRouter);
app.use('/api/arena', arenaRouter);
app.use(notFoundHandler);
app.use(errorHandler);

let server: import('node:http').Server;
let base = '';

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const PASSWORD = 'Community-Paper1';

async function createUser(name: string, role: 'student' | 'admin' = 'student'): Promise<{ id: string; token: string; email: string }> {
  const id = db.uuid();
  const now = db.nowIso();
  const email = `${name.toLowerCase().replace(/[^a-z]/g, '')}-${id.slice(0, 6)}@paper.test`;
  const user: SessionUser = { id, email, name, role };
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, class_level, board, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Class 10', 'CBSE', ?, ?, ?)`,
    [id, email, hashPassword(PASSWORD), name, role, now, now],
  );
  return { id, token: signSession(user), email };
}

async function call<T = Record<string, unknown>>(
  token: string | null,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T; raw: string }> {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: (raw ? JSON.parse(raw) : null) as T, raw };
}

const PAPER = `1) A car covers 150 m in 10 s. What is its average speed?
A) 10 m/s
B) 15 m/s
C) 20 m/s
D) 25 m/s
Answer: B
Explanation: Speed is distance divided by time.

2) A force of 24 N acts on a 6 kg body. What is the acceleration produced?
A) 0.25 m/s2
B) 4 m/s2
C) 18 m/s2
D) 144 m/s2
Answer: B

3) As we go deeper into the ocean the pressure
A) Decreases
B) Increases
C) Stays the same
D) Becomes zero
Answer: B`;

const imAWeek = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe('Community papers', () => {
  it('parses the plain-text paper format a school actually writes', () => {
    const { questions, skipped } = parseUploadedPaper(PAPER);
    assert.equal(questions.length, 3);
    assert.equal(skipped, 0);
    assert.equal(questions[0].options.length, 4);
    assert.equal(questions[0].answer, '15 m/s');
    assert.match(questions[0].explanation, /distance divided by time/i);
    assert.equal(questions[1].answer, '4 m/s2');
  });

  it('rewrites an uploaded question so the original cannot be used as a key', () => {
    const [first] = parseUploadedPaper(PAPER).questions;
    const rewritten = rewriteQuestion(first, 1, 'Physics');
    assert.notEqual(rewritten.prompt, first.prompt, 'the stem must change');
    assert.notEqual(rewritten.answer, first.answer, 'the key text must change with the values');
    assert.ok(rewritten.options?.includes(rewritten.answer), 'the key must still be one of the options');
    assert.equal(rewritten.options?.length, 4);
    assert.equal(new Set(rewritten.options).size, 4, 'no duplicated options after the permutation');
    /* Every number is scaled by one common factor, so the physics still holds. */
    assert.ok(!/\b150\b/.test(rewritten.prompt), 'the original distance must not survive verbatim');
    assert.equal(scaleNumbers('150 m in 10 s', 3), '450 m in 30 s');
  });

  it('lets a host fill the paper, and never hands the questions back', async () => {
    const owner = await createUser('Owner');
    const community = await call<{ id: string }>(owner.token, 'POST', '/api/communities', {
      name: 'Paper Test Circle',
      description: 'Community created by the paper test.',
      category: 'physics',
      visibility: 'public',
    });
    assert.ok([200, 201].includes(community.status), JSON.stringify(community.body));
    const communityId = community.body.id;

    const created = await call<{ id: string }>(owner.token, 'POST', `/api/communities/${communityId}/competitions`, {
      title: 'Uploaded Paper Sprint',
      category: 'physics',
      visibility: 'private',
      blueprint: {
        /* The form says eight; the uploaded paper has three. The paper must win. */
        subjects: [{ subject: 'Physics', count: 8, chapters: [] }],
        difficulty: { easy: 34, medium: 33, hard: 33 },
        types: { mcq: 100, numerical: 0, conceptual: 0 },
        marksPerQuestion: 4,
        negativeMarks: 1,
        durationMin: 30,
      },
      registrationOpensAt: new Date(Date.now() - 60_000).toISOString(),
      registrationClosesAt: imAWeek(1),
      startsAt: imAWeek(2),
      endsAt: imAWeek(3),
    });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const competitionId = created.body.id;

    /* Before any paper: not ready, and that is visible to the host. */
    const status0 = await call<{ ready: boolean; total: number }>(owner.token, 'GET', `/api/communities/${communityId}/competitions/${competitionId}/paper`);
    assert.equal(status0.status, 200);
    assert.equal(status0.body.ready, false);
    assert.equal(status0.body.total, 0);

    const uploaded = await call<{ accepted: number; method: string; ready: boolean; note: string }>(
      owner.token,
      'POST',
      `/api/communities/${communityId}/competitions/${competitionId}/paper`,
      { mode: 'upload', text: PAPER, subject: 'Physics' },
    );
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.accepted, 3);
    assert.equal(uploaded.body.ready, true, 'the competition must be startable with the paper that was uploaded');
    assert.equal(uploaded.body.required, 3, 'readiness follows the uploaded paper, not the form');
    assert.equal(uploaded.body.method, 'deterministic');

    /* …and the stored blueprint now describes the paper that will actually run. */
    const storedBlueprint = await db.one<{ blueprint: string }>(
      'SELECT blueprint FROM arena_competitions WHERE id = ?',
      [competitionId],
    );
    const parsedBlueprint = JSON.parse(storedBlueprint?.blueprint ?? '{}') as {
      subjects: { subject: string; count: number }[];
      marksPerQuestion: number;
      durationMin: number;
    };
    assert.equal(parsedBlueprint.subjects.reduce((sum, slot) => sum + slot.count, 0), 3);
    assert.equal(parsedBlueprint.subjects[0].subject, 'Physics');
    assert.equal(parsedBlueprint.marksPerQuestion, 4, 'the marks the host chose are kept');
    assert.equal(parsedBlueprint.durationMin, 30, 'and so is the duration');

    /* The response is counts and prose — no stem, no option, no key. */
    for (const tell of ['150 m', '15 m/s', 'Average speed', 'acceleration produced', 'Correct answer']) {
      assert.ok(!uploaded.raw.includes(tell), `the response must not leak "${tell}"`);
    }

    /* What is stored is the rewrite, approved, and its key is a real option. */
    const rows = await db.all<{ prompt: string; options: string; correct_answer: string; review_status: string }>(
      'SELECT prompt, options, correct_answer, review_status FROM arena_questions WHERE competition_id = ? ORDER BY position',
      [competitionId],
    );
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.review_status, 'approved');
      const options = JSON.parse(row.options) as string[];
      assert.ok(options.includes(row.correct_answer), `key "${row.correct_answer}" must be one of its options`);
      assert.ok(!row.prompt.includes('150 m'), 'the original wording must not be stored');
    }
  });

  it('keeps the key secret from students, and refuses a second paper', async () => {
    const owner = await createUser('SecondOwner');
    const member = await createUser('Member');

    const community = await call<{ id: string }>(owner.token, 'POST', '/api/communities', {
      name: 'Secret Paper Circle',
      description: 'Testing that the key never reaches a student.',
      category: 'physics',
      visibility: 'public',
    });
    const communityId = community.body.id;

    /* The member joins, so they can register and sit the paper. */
    await call(member.token, 'POST', `/api/communities/${communityId}/join`, {});

    assert.ok([200, 201].includes(community.status), `community: ${JSON.stringify(community.body).slice(0, 200)}`);
    const created = await call<{ id: string }>(owner.token, 'POST', `/api/communities/${communityId}/competitions`, {
      title: 'Secret Sprint',
      category: 'physics',
      visibility: 'private',
      blueprint: {
        subjects: [{ subject: 'Physics', count: 3, chapters: [] }],
        difficulty: { easy: 34, medium: 33, hard: 33 },
        types: { mcq: 100, numerical: 0, conceptual: 0 },
        marksPerQuestion: 4,
        negativeMarks: 1,
        durationMin: 30,
      },
      registrationOpensAt: new Date(Date.now() - 60_000).toISOString(),
      registrationClosesAt: imAWeek(1),
      startsAt: imAWeek(2),
      endsAt: imAWeek(4),
    });
    assert.ok([200, 201].includes(created.status), `competition: ${JSON.stringify(created.body).slice(0, 300)}`);
    const competitionId = created.body.id;

    const prepared = await call(owner.token, 'POST', `/api/communities/${communityId}/competitions/${competitionId}/paper`, {
      mode: 'upload',
      text: PAPER,
      subject: 'Physics',
    });
    assert.equal(prepared.status, 201, `prepare: ${JSON.stringify(prepared.body).slice(0, 300)}`);

    /* A non-host cannot prepare a paper, and cannot read one either. */
    const refused = await call(member.token, 'POST', `/api/communities/${communityId}/competitions/${competitionId}/paper`, {
      mode: 'upload',
      text: PAPER,
    });
    assert.equal(refused.status, 403);

    const replaceAttempt = await call(owner.token, 'POST', `/api/communities/${communityId}/competitions/${competitionId}/paper`, {
      mode: 'upload',
      text: PAPER,
    });
    assert.equal(replaceAttempt.status, 409, 'a paper that already exists must not be swapped');
    assert.equal((replaceAttempt.body as { error: { code: string } }).error.code, 'paper_exists');

    /* Register while the window is open… */
    const registered = await call(member.token, 'POST', `/api/communities/${communityId}/competitions/${competitionId}/register`, {});
    assert.ok([200, 201].includes(registered.status), JSON.stringify(registered.body));

    /* …then move the exam window to now, the way a host would wait for the clock to arrive. */
    await db.run(
      'UPDATE arena_competitions SET registration_closes_at = ?, starts_at = ?, ends_at = ? WHERE id = ?',
      [new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 60_000).toISOString(), imAWeek(1), competitionId],
    );

    const started = await call<{ exam?: { questions?: { prompt: string; options?: string[] }[] } }>(
      member.token,
      'POST',
      `/api/arena/competitions/${competitionId}/start`,
      {},
    );
    assert.ok([200, 201].includes(started.status), JSON.stringify(started.body).slice(0, 300));
    const handed = started.body.exam?.questions;
    assert.ok(Array.isArray(handed), `start payload: ${started.raw.slice(0, 300)}`);
    assert.equal(handed.length, 3, 'the student receives the paper they are sitting');
    for (const question of handed) {
      assert.ok(question.prompt.length > 0 && (question.options?.length ?? 0) === 4);
    }
    assert.ok(!started.raw.includes('correct_answer'), 'the key must not be in the payload');
    assert.ok(!started.raw.includes('"answer"'), 'no answer field either');
    assert.ok(!/Explanation/i.test(started.raw), 'and no explanations before submission');
  });

  it('twists the uploaded paper: the file it came from cannot serve as a key', async () => {
    const owner = await createUser('TwistOwner');
    const community = await call<{ id: string }>(owner.token, 'POST', '/api/communities', {
      name: 'Twist Circle',
      description: 'Checks that an uploaded paper is rewritten, not merely re-hosted.',
      category: 'physics',
      visibility: 'public',
    });
    assert.ok([200, 201].includes(community.status), JSON.stringify(community.body).slice(0, 200));
    const communityId = community.body.id;

    const created = await call<{ id: string }>(owner.token, 'POST', `/api/communities/${communityId}/competitions`, {
      title: 'Twist Sprint',
      category: 'physics',
      visibility: 'private',
      blueprint: {
        subjects: [{ subject: 'Physics', count: 3, chapters: [] }],
        difficulty: { easy: 34, medium: 33, hard: 33 },
        types: { mcq: 100, numerical: 0, conceptual: 0 },
        marksPerQuestion: 4,
        negativeMarks: 1,
        durationMin: 30,
      },
      registrationOpensAt: new Date(Date.now() - 60_000).toISOString(),
      registrationClosesAt: imAWeek(1),
      startsAt: imAWeek(2),
      endsAt: imAWeek(3),
    });
    assert.ok([200, 201].includes(created.status), `competition: ${JSON.stringify(created.body).slice(0, 200)}`);
    const competitionId = created.body.id;

    const uploaded = await call<{ method: string; accepted: number; note: string; rewrittenByModel?: number }>(
      owner.token,
      'POST',
      `/api/communities/${communityId}/competitions/${competitionId}/paper`,
      { mode: 'upload', text: PAPER, subject: 'Physics' },
    );
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body).slice(0, 300));
    assert.ok(['ai', 'mixed', 'deterministic'].includes(uploaded.body.method));

    /*
     * Whatever path ran, the stored paper must not contain the uploaded questions. This is the "leak 0"
     * claim stated as a fact about the database: no stem, no option and no answer from the file survives.
     */
    const rows = await db.all<{ prompt: string; options: string; correct_answer: string; explanation: string }>(
      'SELECT prompt, options, correct_answer, explanation FROM arena_questions WHERE competition_id = ?',
      [competitionId],
    );
    assert.equal(rows.length, uploaded.body.accepted);
    const uploadedNumbers = ['150', '10 s', '24 N', '6 kg'];
    for (const row of rows) {
      for (const number of uploadedNumbers) {
        assert.ok(!row.prompt.includes(number), `"${number}" from the uploaded file survived in: ${row.prompt}`);
      }
      const options = JSON.parse(row.options) as string[];
      assert.ok(options.includes(row.correct_answer), 'the key must still be one of the options');
      assert.equal(new Set(options).size, 4, 'options must stay distinct after the twist');
    }
    /* An upload with no provider configured is twisted on the server, and says so. */
    if (uploaded.body.method === 'deterministic') {
      assert.match(uploaded.body.note, /twisted on the server|cannot be used as an answer key/i);
      assert.equal(uploaded.body.rewrittenByModel, 0);
    } else {
      assert.match(uploaded.body.note, /rewritten by the AI/i);
      assert.ok((uploaded.body.rewrittenByModel ?? 0) > 0, 'the reply must say how many the model rewrote');
    }
    /* Either way, the note must never carry question text. */
    assert.ok(!/450 m|45 m\/s|average speed/i.test(uploaded.body.note), 'the note must stay prose');
  });

  it('hides a community paper from the platform console while its window is open', async () => {
    const owner = await createUser('SealedOwner');
    const operator = await createUser('Operator', 'admin');

    const community = await call<{ id: string }>(owner.token, 'POST', '/api/communities', {
      name: 'Sealed Paper Circle',
      description: 'Checks that not even an arena admin can read a live community paper.',
      category: 'physics',
      visibility: 'public',
    });
    assert.ok([200, 201].includes(community.status), JSON.stringify(community.body).slice(0, 200));
    const communityId = community.body.id;

    const created = await call<{ id: string }>(owner.token, 'POST', `/api/communities/${communityId}/competitions`, {
      title: 'Sealed Sprint',
      category: 'physics',
      visibility: 'private',
      blueprint: {
        subjects: [{ subject: 'Physics', count: 3, chapters: [] }],
        difficulty: { easy: 34, medium: 33, hard: 33 },
        types: { mcq: 100, numerical: 0, conceptual: 0 },
        marksPerQuestion: 4,
        negativeMarks: 1,
        durationMin: 30,
      },
      registrationOpensAt: new Date(Date.now() - 60_000).toISOString(),
      registrationClosesAt: imAWeek(1),
      startsAt: imAWeek(2),
      endsAt: imAWeek(3),
    });
    assert.ok([200, 201].includes(created.status), `competition: ${JSON.stringify(created.body).slice(0, 200)}`);
    const competitionId = created.body.id;

    const prepared = await call(owner.token, 'POST', `/api/communities/${communityId}/competitions/${competitionId}/paper`, {
      mode: 'upload',
      text: PAPER,
      subject: 'Physics',
    });
    assert.equal(prepared.status, 201, `prepare: ${JSON.stringify(prepared.body).slice(0, 200)}`);

    /* Open the exam window but leave it running: the console must be blind. */
    await db.run('UPDATE arena_competitions SET status = ?, starts_at = ?, ends_at = ? WHERE id = ?', [
      'published',
      new Date(Date.now() - 60_000).toISOString(),
      imAWeek(1),
      competitionId,
    ]);

    const sealed = await call<{ error: { code: string } }>(
      operator.token,
      'GET',
      `/api/arena/admin/competitions/${competitionId}/questions`,
    );
    assert.equal(sealed.status, 403, JSON.stringify(sealed.body).slice(0, 200));
    assert.equal(sealed.body.error.code, 'community_paper_sealed');
    assert.ok(!sealed.raw.includes('15 m/s'), 'not even the refusal may echo a question');

    /* A competition that is not community-hosted is untouched: the console still works. */
    const arenaOwn = await call<{ id: string }>(operator.token, 'POST', '/api/arena/admin/competitions', {
      title: 'Console Sprint',
      category: 'physics',
      blueprint: {
        subjects: [{ subject: 'Physics', count: 3, chapters: [] }],
        difficulty: { easy: 34, medium: 33, hard: 33 },
        types: { mcq: 100, numerical: 0, conceptual: 0 },
        marksPerQuestion: 4,
        negativeMarks: 1,
        durationMin: 30,
      },
      registrationOpensAt: new Date(Date.now() - 60_000).toISOString(),
      registrationClosesAt: imAWeek(1),
      startsAt: imAWeek(2),
      endsAt: imAWeek(3),
    });
    if ([200, 201].includes(arenaOwn.status) && arenaOwn.body?.id) {
      const open = await call(operator.token, 'GET', `/api/arena/admin/competitions/${arenaOwn.body.id}/questions`);
      assert.equal(open.status, 200, 'the console still reads its own competitions');
    }

    /* Once the window is over, the console opens again — every attempt is already recorded. */
    await db.run('UPDATE arena_competitions SET ends_at = ? WHERE id = ?', [
      new Date(Date.now() - 60_000).toISOString(),
      competitionId,
    ]);
    const reopened = await call(operator.token, 'GET', `/api/arena/admin/competitions/${competitionId}/questions`);
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body).slice(0, 200));
  });

  it('stores the exact dates a host picks for registration and the exam', async () => {
    const owner = await createUser('CalendarOwner');
    const community = await call<{ id: string }>(owner.token, 'POST', '/api/communities', {
      name: 'Calendar Circle',
      description: 'Checks that chosen dates survive to the database unchanged.',
      category: 'physics',
      visibility: 'public',
    });
    assert.ok([200, 201].includes(community.status), JSON.stringify(community.body).slice(0, 200));
    const communityId = community.body.id;

    /* A school's calendar: registration opens Monday, closes Friday, exam Saturday 10:00–13:00. */
    const opens = new Date('2027-01-04T09:00:00.000Z').toISOString();
    const closes = new Date('2027-01-08T18:00:00.000Z').toISOString();
    const starts = new Date('2027-01-09T10:00:00.000Z').toISOString();
    const ends = new Date('2027-01-09T13:00:00.000Z').toISOString();

    const created = await call<{ id: string }>(owner.token, 'POST', `/api/communities/${communityId}/competitions`, {
      title: 'Saturday Test',
      category: 'physics',
      visibility: 'private',
      blueprint: {
        subjects: [{ subject: 'Physics', count: 3, chapters: [] }],
        difficulty: { easy: 34, medium: 33, hard: 33 },
        types: { mcq: 100, numerical: 0, conceptual: 0 },
        marksPerQuestion: 4,
        negativeMarks: 1,
        durationMin: 180,
      },
      registrationOpensAt: opens,
      registrationClosesAt: closes,
      startsAt: starts,
      endsAt: ends,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 200));

    const stored = await db.one<{
      registration_opens_at: string;
      registration_closes_at: string;
      starts_at: string;
      ends_at: string;
      duration_min: number;
    }>(
      'SELECT registration_opens_at, registration_closes_at, starts_at, ends_at, duration_min FROM arena_competitions WHERE id = ?',
      [created.body.id],
    );
    assert.equal(stored?.registration_opens_at, opens);
    assert.equal(stored?.registration_closes_at, closes);
    assert.equal(stored?.starts_at, starts);
    assert.equal(stored?.ends_at, ends);
    assert.equal(Number(stored?.duration_min), 180);

    /* The same three rules the dialog checks first are enforced by the server as well. */
    const backwards = await call<{ error: { code: string } }>(owner.token, 'POST', `/api/communities/${communityId}/competitions`, {
      title: 'Backwards Test',
      category: 'physics',
      visibility: 'private',
      blueprint: {
        subjects: [{ subject: 'Physics', count: 3, chapters: [] }],
        difficulty: { easy: 34, medium: 33, hard: 33 },
        types: { mcq: 100, numerical: 0, conceptual: 0 },
        marksPerQuestion: 4,
        negativeMarks: 1,
        durationMin: 60,
      },
      /* Registration closes after the exam has already started. */
      registrationOpensAt: opens,
      registrationClosesAt: ends,
      startsAt: starts,
      endsAt: ends,
    });
    assert.equal(backwards.status, 400, JSON.stringify(backwards.body).slice(0, 200));
    assert.equal(backwards.body.error.code, 'bad_schedule');
  });

  it('writes an AI paper from the blueprint and approves it, so the competition can actually run', async () => {
    const owner = await createUser('AiOwner');
    const community = await call<{ id: string }>(owner.token, 'POST', '/api/communities', {
      name: 'AI Paper Circle',
      description: 'Checks the AI/bank path of the paper pipeline.',
      category: 'physics',
      visibility: 'public',
    });
    const communityId = community.body.id;

    const created = await call<{ id: string }>(owner.token, 'POST', `/api/communities/${communityId}/competitions`, {
      title: 'AI Sprint',
      category: 'physics',
      visibility: 'private',
      blueprint: {
        subjects: [{ subject: 'Physics', count: 5, chapters: [] }],
        difficulty: { easy: 40, medium: 40, hard: 20 },
        types: { mcq: 100, numerical: 0, conceptual: 0 },
        marksPerQuestion: 4,
        negativeMarks: 1,
        durationMin: 20,
      },
      registrationOpensAt: new Date(Date.now() - 60_000).toISOString(),
      registrationClosesAt: imAWeek(1),
      startsAt: imAWeek(2),
      endsAt: imAWeek(3),
    });
    const competitionId = created.body.id;

    const outcome = await call<{ accepted: number; method: string; ready: boolean; rejected: number }>(
      owner.token,
      'POST',
      `/api/communities/${communityId}/competitions/${competitionId}/paper`,
      {
        mode: 'ai',
        subject: 'Physics',
        blueprint: {
          subjects: [{ subject: 'Physics', count: 5, chapters: [] }],
          difficulty: { easy: 40, medium: 40, hard: 20 },
          types: { mcq: 100, numerical: 0, conceptual: 0 },
          marksPerQuestion: 4,
          negativeMarks: 1,
          durationMin: 20,
        },
      },
    );
    assert.equal(outcome.status, 201, JSON.stringify(outcome.body).slice(0, 300));
    assert.ok(outcome.body.accepted >= 1, 'at least one question must survive validation');
    assert.equal(outcome.body.ready, true, 'an AI/bank paper is approved so the competition can start');

    const approved = await db.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM arena_questions WHERE competition_id = ? AND review_status = 'approved'",
      [competitionId],
    );
    assert.equal(approved?.n, outcome.body.accepted);
  });

  it('refuses text that is not a paper, and lets the host remove the competition', async () => {
    const owner = await createUser('Remover');
    const community = await call<{ id: string }>(owner.token, 'POST', '/api/communities', {
      name: 'Removal Circle',
      description: 'Checks the delete control that was missing.',
      category: 'physics',
      visibility: 'public',
    });
    const communityId = community.body.id;

    const created = await call<{ id: string }>(owner.token, 'POST', `/api/communities/${communityId}/competitions`, {
      title: 'Removable Sprint',
      category: 'physics',
      visibility: 'private',
      blueprint: {
        subjects: [{ subject: 'Physics', count: 3, chapters: [] }],
        difficulty: { easy: 34, medium: 33, hard: 33 },
        types: { mcq: 100, numerical: 0, conceptual: 0 },
        marksPerQuestion: 4,
        negativeMarks: 1,
        durationMin: 20,
      },
      registrationOpensAt: new Date(Date.now() - 60_000).toISOString(),
      registrationClosesAt: imAWeek(1),
      startsAt: imAWeek(2),
      endsAt: imAWeek(3),
    });
    const competitionId = created.body.id;

    const junk = await call(owner.token, 'POST', `/api/communities/${communityId}/competitions/${competitionId}/paper`, {
      mode: 'upload',
      text: 'These are my notes about photosynthesis and why leaves are green, but not a single question with options.',
    });
    assert.equal(junk.status, 400, JSON.stringify(junk.body));
    assert.equal((junk.body as { error: { code: string } }).error.code, 'unreadable_paper');

    const removed = await call(owner.token, 'DELETE', `/api/communities/${communityId}/competitions/${competitionId}`);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const link = await db.one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM community_competitions WHERE community_id = ? AND competition_id = ?',
      [communityId, competitionId],
    );
    assert.equal(link?.n, 0, 'the hosting link is gone');

    /* A member with no hosting rights cannot remove someone else's competition. */
    const stranger = await createUser('Stranger');
    await call(stranger.token, 'POST', `/api/communities/${communityId}/join`, {});
    const refused = await call(stranger.token, 'DELETE', `/api/communities/${communityId}/competitions/${competitionId}`);
    assert.equal(refused.status, 403);
  });
});
