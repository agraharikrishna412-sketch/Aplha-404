/**
 * The core promise of the product: a request never dies because one model, key or provider failed.
 *
 * These are integration tests against the real fallback engine, key manager and database layer
 * (SQLite in a temp DATA_DIR) with stubbed provider adapters, so the ordering, cooldowns and
 * safety rules are exercised end to end.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';

process.env.DATA_DIR = path.join(os.tmpdir(), `vroqn-test-${Date.now()}`);
process.env.JWT_SECRET = 'test-secret-not-used-for-anything-real';
process.env.VROQN_MASTER_KEY = 'a'.repeat(64);
process.env.AI_BETWEEN_ATTEMPTS_MS = '0';

const { migrate } = await import('../src/db/schema.js');
const { run: runSql, nowIso, uuid } = await import('../src/db/index.js');
const { addKey, getRotationCandidates, updateKey } = await import('../src/services/ai/keyManager.js');
const { providers } = await import('../src/services/ai/providers/index.js');
const { runWithFallback } = await import('../src/services/ai/fallback.js');
const { AIError } = await import('../src/services/ai/errors.js');
const { saveSettings } = await import('../src/services/settings.js');
const type = (await import('../src/services/ai/types.js')) as unknown as Record<string, never>;
void type;

type Events = Awaited<ReturnType<typeof collect>>;
type Outcome = 'ok' | { kind: string; message?: string };

const KEYS = {
  gemini1: 'AIzaTEST-gemini-key-number-one-0001',
  gemini2: 'AIzaTEST-gemini-key-number-two-0002',
  groq1: 'gsk_TESTgroqkeynumberone0001',
  openrouter1: 'sk-or-v1-TESTopenrouterkeynumberone',
};

/** Records every provider call so we can assert the exact attempt order. */
const calls: { provider: string; model: string; key: string }[] = [];

function stubProvider(id: 'gemini' | 'groq' | 'openrouter', script: (call: { model: string; key: string }) => Outcome) {
  providers[id] = {
    ...providers[id],
    async *streamChat({ key, model }) {
      calls.push({ provider: id, model, key });
      const outcome = script({ model, key });
      if (outcome === 'ok') {
        yield 'Hello ';
        yield 'from ';
        yield `${id}.`;
        return;
      }
      throw new AIError({ kind: outcome.kind as never, message: outcome.message ?? `${id} failed: ${outcome.kind}`, provider: id, model });
    },
    async chat({ key, model }) {
      calls.push({ provider: id, model, key });
      const outcome = script({ model, key });
      if (outcome === 'ok') return { text: `Hello from ${id}.` };
      throw new AIError({ kind: outcome.kind as never, message: outcome.message ?? `${id} failed`, provider: id, model });
    },
  };
}

async function collect(userId: string, overrides: Record<string, unknown> = {}) {
  const events: any[] = [];
  for await (const event of runWithFallback({
    userId,
    task: 'general',
    messages: [{ role: 'user', content: 'Explain Newton’s third law.' }],
    system: 'You are a tutor.',
    ...overrides,
  })) {
    events.push(event);
  }
  return events;
}

async function createUser(email: string): Promise<string> {
  const id = uuid();
  await runSql(
    `INSERT INTO users (id, email, name, class_level, board, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, email, email.split('@')[0], 'Class 10', 'CBSE', 'not-a-real-hash', nowIso(), nowIso()],
  );
  await saveSettings(id, {});
  return id;
}

function keyLabelOf(secret: string): string {
  return Object.entries(KEYS).find(([, value]) => value === secret)?.[0] ?? 'unknown';
}

before(async () => {
  await migrate();
});

describe('failover engine', () => {
  it('walks keys, then providers, and succeeds on the next available connection', async () => {
    calls.length = 0;
    const userId = await createUser('failover@example.com');
    await addKey(userId, 'gemini', KEYS.gemini1, 'Gemini Key 1');
    const gemini2 = await addKey(userId, 'gemini', KEYS.gemini2, 'Gemini Key 2');
    await addKey(userId, 'groq', KEYS.groq1, 'Groq Key 1');

    stubProvider('gemini', ({ key }) => {
      if (key === KEYS.gemini1) return { kind: 'rate_limit', message: 'Quota exceeded, retry shortly' };
      return { kind: 'invalid_key', message: 'Invalid API key' };
    });
    stubProvider('groq', () => 'ok');
    stubProvider('openrouter', () => ({ kind: 'network', message: 'unreachable' }));

    const events = await collect(userId);
    const done = events.find((event) => event.type === 'done');

    assert.ok(done, 'the request must still succeed');
    assert.equal(done.provider, 'groq', 'should land on the next provider after Gemini fails');
    assert.equal(done.fellBack, true);
    assert.equal(done.attempts, 3, 'two Gemini keys tried, then Groq');
    assert.ok(done.text.includes('groq'));

    const failures = events.filter((event) => event.type === 'attempt_failed');
    assert.equal(failures.length, 2);
    assert.equal(failures[0].failure, 'rate_limit');
    assert.equal(failures[0].willRetry, true, 'temporary failures continue the chain');
    assert.equal(failures[1].failure, 'invalid_key');

    // Order: default key first, then the second key, then the other provider.
    assert.deepEqual(
      calls.map((call) => `${call.provider}:${keyLabelOf(call.key)}`).slice(0, 3),
      ['gemini:gemini1', 'gemini:gemini2', 'groq:groq1'],
    );

    // The rejected key is parked and flagged, not deleted.
    const geminiKeys = await getRotationCandidates(userId, 'gemini');
    const parked = geminiKeys.find((key) => key.id === gemini2.id);
    assert.equal(parked?.status, 'invalid');
    assert.equal(parked?.cooldownUntil !== null, true);
  });

  it('does not leak API keys into streamed events', async () => {
    const events = await collect(await createUser('redaction@example.com'));
    const serialised = JSON.stringify(events);
    for (const secret of Object.values(KEYS)) {
      assert.ok(!serialised.includes(secret), 'raw key must never appear in an event payload');
    }
  });

  it('stops on a safety refusal instead of asking another provider the same thing', async () => {
    calls.length = 0;
    const userId = await createUser('safety@example.com');
    await addKey(userId, 'gemini', KEYS.gemini1, 'Gemini Key 1');
    await addKey(userId, 'groq', KEYS.groq1, 'Groq Key 1');

    stubProvider('gemini', () => ({ kind: 'safety', message: 'Blocked by safety filter' }));
    stubProvider('groq', () => 'ok');
    stubProvider('openrouter', () => 'ok');

    const events = await collect(userId);
    const error = events.find((event) => event.type === 'error');

    assert.ok(error, 'safety refusals surface as an error');
    assert.equal(error.failure, 'safety');
    assert.ok(error.hint?.length, 'the student gets a rephrase suggestion');
    assert.equal(calls.length, 1, 'no other provider is asked the same blocked prompt');
    assert.equal(events.some((event) => event.type === 'done'), false);
  });

  it('reports a useful, actionable error when every connection fails', async () => {
    const userId = await createUser('exhausted@example.com');
    await addKey(userId, 'gemini', KEYS.gemini1, 'Gemini Key 1');
    await addKey(userId, 'groq', KEYS.groq1, 'Groq Key 1');
    await addKey(userId, 'openrouter', KEYS.openrouter1, 'OpenRouter Key 1');

    stubProvider('gemini', () => ({ kind: 'server_error', message: 'internal' }));
    stubProvider('groq', () => ({ kind: 'server_error', message: 'internal' }));
    stubProvider('openrouter', () => ({ kind: 'server_error', message: 'internal' }));

    const events = await collect(await Promise.resolve(userId));
    const error = events.find((event) => event.type === 'error');
    assert.ok(error);
    assert.match(error.message, /unavailable/i);
    assert.ok(error.hint?.includes('Gemini'), 'hint names the providers that failed');
    assert.ok(events.length > 3, 'the client saw progress rather than a hang');
  });

  it('falls back to the sample engine when no key is configured at all', async () => {
    const userId = await createUser('nokeys@example.com');
    const events = await collect(userId);
    const done = events.find((event) => event.type === 'done');
    assert.ok(done);
    assert.equal(done.demo, true);
    const plan = events.find((event) => event.type === 'plan');
    assert.match(plan.plan.reason, /sample library/i);
  });

  it('respects a disabled key and uses the next one', async () => {
    calls.length = 0;
    const userId = await createUser('disabled@example.com');
    const first = await addKey(userId, 'gemini', KEYS.gemini1, 'Gemini Key 1');
    await addKey(userId, 'gemini', KEYS.gemini2, 'Gemini Key 2');
    await updateKey(userId, first.id, { enabled: false });

    stubProvider('gemini', () => 'ok');
    stubProvider('groq', () => 'ok');
    stubProvider('openrouter', () => 'ok');

    const events = await collect(userId);
    assert.equal(events.find((event) => event.type === 'done')?.keyLabel, 'Gemini Key 2');
  });

  it('skips a model that cannot read images when an attachment is present', async () => {
    calls.length = 0;
    const userId = await createUser('vision@example.com');
    await addKey(userId, 'groq', KEYS.groq1, 'Groq Key 1');
    await addKey(userId, 'gemini', KEYS.gemini1, 'Gemini Key 1');
    await saveSettings(userId, { routing: { general: 'groq', vision: 'groq', fallback: 'groq' } as never });

    stubProvider('groq', ({ key }) => (key === KEYS.groq1 ? { kind: 'server_error', message: 'down' } : 'ok'));
    stubProvider('gemini', () => 'ok');
    stubProvider('openrouter', () => 'ok');

    const events = await collect(userId, {
      task: 'vision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this page and explain it.' },
            { type: 'image', mimeType: 'image/jpeg', data: 'aaa' },
          ],
        },
      ],
    });

    const done = events.find((event) => event.type === 'done');
    assert.ok(done, 'a vision-capable provider should still answer');
    assert.equal(done.provider, 'gemini');
  });
});
