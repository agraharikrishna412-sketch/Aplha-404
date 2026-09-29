/**
 * The AI path of the community paper pipeline, with a stubbed provider.
 *
 * `community-paper.test.ts` proves the guarantees (no leak either way) on the real database. This file
 * proves the *model* branch actually runs: a provider is stubbed to answer with a twist, a key is
 * stored for the host, and the paper that ends up in the database must be the model's rewrite — not the
 * uploaded text and not the deterministic fallback. It also checks the promise made to the host in the
 * reply ("N of M were rewritten by the AI") matches what really happened.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

process.env.DATA_DIR = path.join(os.tmpdir(), `vroqn-paper-ai-${Date.now()}`);
process.env.JWT_SECRET = 'paper-ai-test-secret-not-used-anywhere';
process.env.VROQN_MASTER_KEY = 'ab12'.repeat(16);
process.env.DEMO_MODE = 'off';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.AI_BETWEEN_ATTEMPTS_MS = '0';
delete process.env.ARENA_ADMIN_EMAILS;

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { migrate } = await import('../src/db/schema.js');
const db = await import('../src/db/index.js');
const { hashPassword } = await import('../src/services/crypto.js');
const { attachUser, signSession } = await import('../src/middleware/auth.js');
const { errorHandler, notFoundHandler } = await import('../src/middleware/errors.js');
const { communitiesRouter } = await import('../src/routes/communities.js');
const { addKey } = await import('../src/services/ai/keyManager.js');
const { providers } = await import('../src/services/ai/providers/index.js');

await migrate();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(attachUser);
app.use('/api/communities', communitiesRouter);
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

/* ------------------------------------------------------------------ the stub ---------------------- */

interface Seen {
  calls: number;
  /** Everything the router sent to the provider, as text — the test reads the questions out of it. */
  sent: string[];
  /** How many rewrites the stub should return for the next call. */
  want: number;
}

const seen: Seen = { calls: 0, sent: [], want: 2 };

/**
 * A provider that answers with a rewrite of what it was handed.
 *
 * The payload shape the router uses is deliberately not assumed here: the whole request is recorded as
 * text and searched, and the number of questions to return is set by the test. That keeps this stub
 * honest about *what the pipeline did* (it called a provider and stored its answer) without coupling the
 * test to the router's internal message layout.
 */
function stubAllProviders() {
  const scripted = async function* streamChat(input: unknown) {
    seen.calls += 1;
    seen.sent.push(JSON.stringify(input ?? {}));
    const questions = Array.from({ length: seen.want }, (_value, index) => ({
      prompt: `REWRITTEN ${index + 1} question about speed and acceleration`,
      options: ['751 m/s', '758 m/s', '764 m/s', '771 m/s'],
      answer: '758 m/s',
      explanation: 'Divide the new distance by the new time; the answer is 758 m/s.',
      subject: 'Physics',
      topic: 'Speed',
      difficulty: 'medium',
      type: 'mcq',
    }));
    yield JSON.stringify({ questions });
  };

  for (const id of ['gemini', 'groq', 'openrouter'] as const) {
    providers[id] = { ...providers[id], streamChat: scripted as never };
  }
}

stubAllProviders();

/* ------------------------------------------------------------------ helpers ----------------------- */

async function createUser(name: string) {
  const id = db.uuid();
  const now = db.nowIso();
  const email = `${name.toLowerCase()}-${id.slice(0, 6)}@paper-ai.test`;
  const user = { id, email, name, role: 'student' as const };
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, class_level, board, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Class 10', 'CBSE', 'student', ?, ?)`,
    [id, email, hashPassword('Community-Paper1'), name, now, now],
  );
  return { id, token: signSession(user), email };
}

async function call<T = Record<string, unknown>>(token: string, method: string, url: string, body?: unknown) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
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
Explanation: Acceleration is force divided by mass.`;

describe('Community papers — the AI twist', () => {
  it('runs the model over the uploaded paper and stores the model’s rewrite', async () => {
    const owner = await createUser('AiHost');
    await addKey(owner.id, 'gemini', 'AIzaTESTkeyfortheaitwistpass0001', 'Twist key');

    const community = await call<{ id: string }>(owner.token, 'POST', '/api/communities', {
      name: 'AI Twist Circle',
      description: 'Checks the model pass of the paper pipeline.',
      category: 'physics',
      visibility: 'public',
    });
    assert.ok([200, 201].includes(community.status), JSON.stringify(community.body).slice(0, 200));
    const communityId = community.body.id;

    const created = await call<{ id: string }>(owner.token, 'POST', `/api/communities/${communityId}/competitions`, {
      title: 'AI Twist Sprint',
      category: 'physics',
      visibility: 'private',
      blueprint: {
        subjects: [{ subject: 'Physics', count: 2, chapters: [] }],
        difficulty: { easy: 34, medium: 33, hard: 33 },
        types: { mcq: 100, numerical: 0, conceptual: 0 },
        marksPerQuestion: 4,
        negativeMarks: 1,
        durationMin: 30,
      },
      registrationOpensAt: new Date(Date.now() - 60_000).toISOString(),
      registrationClosesAt: new Date(Date.now() + 86_400_000).toISOString(),
      startsAt: new Date(Date.now() + 172_800_000).toISOString(),
      endsAt: new Date(Date.now() + 259_200_000).toISOString(),
    });
    assert.ok([200, 201].includes(created.status), `competition: ${JSON.stringify(created.body).slice(0, 200)}`);
    const competitionId = created.body.id;

    const outcome = await call<{ method: string; accepted: number; rewrittenByModel: number; note: string }>(
      owner.token,
      'POST',
      `/api/communities/${communityId}/competitions/${competitionId}/paper`,
      { mode: 'upload', text: PAPER, subject: 'Physics' },
    );

    assert.equal(outcome.status, 201, JSON.stringify(outcome.body).slice(0, 300));
    assert.equal(
      outcome.body.method,
      'ai',
      `with a working provider the model path must be the one that runs — note: ${JSON.stringify(outcome.body).slice(0, 400)}`,
    );
    assert.equal(outcome.body.accepted, 2);
    assert.equal(outcome.body.rewrittenByModel, 2);
    assert.match(outcome.body.note, /rewritten by the AI/i);

    /* The provider was actually asked, and it was sent the host's own questions. */
    assert.ok(seen.calls > 0, 'the provider was never called');
    const payload = seen.sent.join('\n');
    assert.ok(payload.includes('average speed'), 'the model was not sent the uploaded paper');
    assert.ok(payload.includes('150 m') && payload.includes('24 N'), 'the whole paper must be handed to the model');

    /* What is stored is the model's rewrite, and nothing from the file survives. */
    const rows = await db.all<{ prompt: string; correct_answer: string; review_status: string }>(
      'SELECT prompt, correct_answer, review_status FROM arena_questions WHERE competition_id = ? ORDER BY position',
      [competitionId],
    );
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.match(row.prompt, /^REWRITTEN \d/, 'the stored prompt must be the model rewrite');
      assert.ok(!row.prompt.includes('150 m'), 'the uploaded wording must not survive');
      assert.equal(row.correct_answer, '758 m/s');
      assert.equal(row.review_status, 'approved');
    }

    /* And the browser reply still carries no question text. */
    assert.ok(!outcome.raw.includes('REWRITTEN'), 'the response must not echo the rewritten question');
    assert.ok(!outcome.raw.includes('758 m/s'), 'the response must not echo the answer');
  });
});
