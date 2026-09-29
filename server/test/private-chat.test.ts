/**
 * Private messaging + profile HTTP tests.
 *
 * These run against the real `messagesRouter`, `profileRouter` and `newsRouter` on a throwaway SQLite
 * database behind a real HTTP listener, because every guarantee worth checking here lives at the HTTP
 * layer. The claims under test:
 *
 *  - **Ciphertext only.** The server accepts a message body and stores exactly those bytes. It never
 *    sees, logs or returns plaintext, and it refuses a payload that claims an algorithm it does not
 *    implement.
 *  - **No IDOR.** A student outside a conversation gets 404 (not 403) for the thread, for envelopes
 *    and for the detail row, so the endpoint cannot be used to discover conversations.
 *  - **Blocks and policy.** A block refuses messages in *both* directions with the same wording, a
 *    `nobody` policy blocks new conversations but leaves existing ones intact, and history survives.
 *  - **Ownership of content.** Only the author can edit or delete a message; reactions are per user.
 *  - **Key handling.** A device key payload carrying private material (`d`) is refused; an envelope
 *    for a device that is not in the conversation is refused; a student can read only their own
 *    envelopes.
 *  - **Profile editing.** Bio, username, interests, accent, privacy and DM policy round-trip, values
 *    are validated, and a private profile withholds fields from a stranger.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { webcrypto } from 'node:crypto';
import type { SessionUser } from '../src/middleware/auth.js';

process.env.DATA_DIR = path.join(os.tmpdir(), `vroqn-private-chat-${Date.now()}`);
process.env.JWT_SECRET = 'private-chat-test-secret-not-used-anywhere-real';
process.env.VROQN_MASTER_KEY = 'e'.repeat(64);
process.env.DEMO_MODE = 'on';

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { migrate } = await import('../src/db/schema.js');
const db = await import('../src/db/index.js');
const { hashPassword } = await import('../src/services/crypto.js');
const { attachUser, signSession } = await import('../src/middleware/auth.js');
const { errorHandler, notFoundHandler } = await import('../src/middleware/errors.js');
const { messagesRouter } = await import('../src/routes/messages.js');
const { profileRouter } = await import('../src/routes/profile.js');

/* ------------------------------------------------------------------ harness --------------------- */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(attachUser);
app.use('/api/messages', messagesRouter);
app.use('/api/profile', profileRouter);
app.use(notFoundHandler);
app.use(errorHandler);

let server: import('node:http').Server;
let base = '';

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(token: string | null, method: string, url: string, body?: unknown): Promise<Reply<T>> {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed as T };
}

async function createStudent(name: string): Promise<{ id: string; token: string }> {
  const id = db.uuid();
  const now = db.nowIso();
  const user: SessionUser = {
    id,
    email: `${name.toLowerCase().replace(/[^a-z]/g, '')}-${id.slice(0, 6)}@private.test`,
    name,
    role: 'student',
  };
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, class_level, board, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Class 12', 'CBSE', ?, ?)`,
    [id, user.email, hashPassword('private-test-password'), name, now, now],
  );
  return { id, token: signSession(user) };
}

/** A real P-256 public JWK, so the device-key checks exercise the same shape the browser sends. */
async function publicKey(): Promise<JsonWebKey> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  return webcrypto.subtle.exportKey('jwk', pair.publicKey);
}

const fill = (char: string, length = 80) => char.repeat(length);

before(async () => {
  await migrate();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/* ------------------------------------------------------------------ profile --------------------- */

describe('profile', () => {
  it('saves and returns an editable profile including the bio', async () => {
    const alice = await createStudent('Alice Profile');
    const saved = await call(alice.token, 'PATCH', '/api/profile/me', {
      name: 'Alice P',
      username: 'alice.p',
      bio: 'Class 12 · physics, astronomy and long walks.',
      interests: ['Physics', 'Astronomy'],
      accent: '#00E5FF',
      classLevel: '12',
      board: 'CBSE',
      dmPolicy: 'everyone',
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.bio, 'Class 12 · physics, astronomy and long walks.');
    assert.equal(saved.body.username, 'alice.p');
    assert.deepEqual(saved.body.interests, ['Physics', 'Astronomy']);
    assert.equal((saved.body.visibility as { dmPolicy: string }).dmPolicy, 'everyone');

    const reread = await call(alice.token, 'GET', '/api/profile/me');
    assert.equal(reread.body.bio, saved.body.bio, 'the bio must persist');
  });

  it('refuses an invalid accent and an over-long bio', async () => {
    const student = await createStudent('Validate Me');
    const badAccent = await call(student.token, 'PATCH', '/api/profile/me', { accent: 'pink-ish' });
    assert.equal(badAccent.status, 400, 'non-hex accent must be rejected');
    const longBio = await call(student.token, 'PATCH', '/api/profile/me', { bio: fill('x', 700) });
    assert.equal(longBio.status, 400, 'bio over 600 characters must be rejected');
  });

  it('withholds a private profile from a student with no shared community', async () => {
    const owner = await createStudent('Private One');
    const stranger = await createStudent('Nosy Stranger');
    await call(owner.token, 'PATCH', '/api/profile/me', {
      bio: 'Only my community sees this.',
      profileVisibility: 'private',
      activityVisible: false,
    });
    const seen = await call(stranger.token, 'GET', `/api/profile/${owner.id}`);
    assert.equal(seen.status, 200);
    assert.notEqual(seen.body.bio, 'Only my community sees this.', 'a private bio must not leak');
    assert.equal((seen.body.visibility as { profile: string }).profile, 'private');
    const asSelf = await call(owner.token, 'GET', '/api/profile/me');
    assert.equal(asSelf.body.bio, 'Only my community sees this.', 'the owner still sees their own bio');
  });

  it('finds other students by name and by username, and never returns yourself', async () => {
    const found = await createStudent('Searchable Student');
    const searcher = await createStudent('Searching Student');
    await call(found.token, 'PATCH', '/api/profile/me', { username: `find_${found.id.slice(0, 6)}` });

    const byName = await call<{ people: { userId: string }[] }>(searcher.token, 'GET', '/api/profile/people?q=Searchable');
    assert.ok(byName.body.people.some((person) => person.userId === found.id), 'name search must find the student');

    const byHandle = await call<{ people: { userId: string }[] }>(searcher.token, 'GET', `/api/profile/people?q=find_${found.id.slice(0, 6)}`);
    assert.ok(byHandle.body.people.some((person) => person.userId === found.id), 'username search must find the student');

    const own = await call<{ people: { userId: string }[] }>(found.token, 'GET', '/api/profile/people?q=Searchable');
    assert.ok(!own.body.people.some((person) => person.userId === found.id), 'a student must not appear in their own search results');
  });
});

/* ------------------------------------------------------------------ messaging ------------------- */

describe('private messaging', () => {
  it('stores ciphertext verbatim and returns it unchanged to the other member', async () => {
    const alice = await createStudent('Alice Cipher');
    const bob = await createStudent('Bob Cipher');
    await call(alice.token, 'PATCH', '/api/profile/me', { dmPolicy: 'everyone' });
    await call(bob.token, 'PATCH', '/api/profile/me', { dmPolicy: 'everyone' });

    const opened = await call<{ conversationId: string }>(bob.token, 'POST', '/api/messages/conversations', { userId: alice.id });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const conversationId = opened.body.conversationId;

    const ciphertext = 'mZ0qXv9p+Qm3w1y8t7Yq0A==';
    const sent = await call<{ id: string }>(alice.token, 'POST', `/api/messages/conversations/${conversationId}/messages`, {
      ciphertext,
      iv: '3q2+7w==',
      alg: 'AES-256-GCM',
      keyVersion: 1,
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.ciphertext, ciphertext, 'the server must not transform the ciphertext');

    const thread = await call<{ messages: { id: string; ciphertext: string; iv: string }[] }>(
      bob.token,
      'GET',
      `/api/messages/conversations/${conversationId}/messages`,
    );
    const row = thread.body.messages.find((message) => message.id === sent.body.id);
    assert.ok(row, 'the recipient must see the message');
    assert.equal(row.ciphertext, ciphertext);
    assert.equal(row.iv, '3q2+7w==');
  });

  it('refuses an algorithm it does not implement and a body that is not base64', async () => {
    const alice = await createStudent('Alice Alg');
    const bob = await createStudent('Bob Alg');
    await call(alice.token, 'PATCH', '/api/profile/me', { dmPolicy: 'everyone' });
    await call(bob.token, 'PATCH', '/api/profile/me', { dmPolicy: 'everyone' });
    const opened = await call<{ conversationId: string }>(alice.token, 'POST', '/api/messages/conversations', { userId: bob.id });
    const conversationId = opened.body.conversationId;

    const wrongAlg = await call(alice.token, 'POST', `/api/messages/conversations/${conversationId}/messages`, {
      ciphertext: 'AAAA',
      iv: 'AAAA',
      alg: 'ROT13',
    });
    assert.equal(wrongAlg.status, 400);
    assert.equal((wrongAlg.body as { error: { code: string } }).error.code, 'bad_algorithm');

    const notBase64 = await call(alice.token, 'POST', `/api/messages/conversations/${conversationId}/messages`, {
      ciphertext: 'not base64 !!',
      iv: 'AAAA',
    });
    assert.equal(notBase64.status, 400, 'ciphertext must be base64');
  });

  it('hides the thread, the detail row and envelopes from a non-member with 404', async () => {
    const alice = await createStudent('Alice Hidden');
    const bob = await createStudent('Bob Hidden');
    const outsider = await createStudent('Outsider Hidden');
    await call(alice.token, 'PATCH', '/api/profile/me', { dmPolicy: 'everyone' });
    await call(bob.token, 'PATCH', '/api/profile/me', { dmPolicy: 'everyone' });
    const opened = await call<{ conversationId: string }>(alice.token, 'POST', '/api/messages/conversations', { userId: bob.id });
    const conversationId = opened.body.conversationId;

    for (const path of [
      `/api/messages/conversations/${conversationId}/messages`,
      `/api/messages/conversations/${conversationId}`,
      `/api/messages/conversations/${conversationId}/keys`,
    ]) {
      const reply = await call(outsider.token, 'GET', path);
      assert.equal(reply.status, 404, `${path} must be invisible to a non-member`);
    }
    const notListed = await call<{ conversations: { id: string }[] }>(outsider.token, 'GET', '/api/messages/conversations');
    assert.equal(notListed.body.conversations.length, 0, 'a non-member must not see the conversation in their list');
  });

  it('lets only the author edit or delete a message', async () => {
    const alice = await createStudent('Alice Author');
    const bob = await createStudent('Bob Author');
    await call(alice.token, 'PATCH', '/api/profile/me', { dmPolicy: 'everyone' });
    await call(bob.token, 'PATCH', '/api/profile/me', { dmPolicy: 'everyone' });
    const opened = await call<{ conversationId: string }>(alice.token, 'POST', '/api/messages/conversations', { userId: bob.id });
    const conversationId = opened.body.conversationId;
    const sent = await call<{ id: string }>(alice.token, 'POST', `/api/messages/conversations/${conversationId}/messages`, {
      ciphertext: 'QUJDRA==',
      iv: 'AAAA',
    });

    const intruder = await call(bob.token, 'PATCH', `/api/messages/messages/${sent.body.id}`, { ciphertext: 'QUJDRA==', iv: 'BBBB' });
    assert.ok(intruder.status >= 400, 'a non-author must not edit');
    const intruderDelete = await call(bob.token, 'DELETE', `/api/messages/messages/${sent.body.id}`);
    assert.ok(intruderDelete.status >= 400, 'a non-author must not delete');

    const authorEdit = await call(alice.token, 'PATCH', `/api/messages/messages/${sent.body.id}`, { ciphertext: 'QUJDREU=', iv: 'AAAA' });
    assert.equal(authorEdit.status, 200, JSON.stringify(authorEdit.body));

    const reaction = await call<{ added: boolean; reactions: { userId: string; reaction: string }[] }>(
      bob.token,
      'POST',
      `/api/messages/messages/${sent.body.id}/reactions`,
      { reaction: '👍' },
    );
    assert.equal(reaction.status, 200);
    assert.equal(reaction.body.added, true);
    assert.ok(
      reaction.body.reactions.some((entry) => entry.userId === bob.id),
      'the reaction must be recorded against the reacting student',
    );
    const toggledOff = await call<{ added: boolean }>(bob.token, 'POST', `/api/messages/messages/${sent.body.id}/reactions`, { reaction: '👍' });
    assert.equal(toggledOff.body.added, false, 'reacting twice with the same emoji removes it');
  });

  it('enforces the message policy, and a block in both directions without deleting history', async () => {
    const alice = await createStudent('Alice Policy');
    const bob = await createStudent('Bob Policy');
    await call(alice.token, 'PATCH', '/api/profile/me', { dmPolicy: 'everyone' });
    await call(bob.token, 'PATCH', '/api/profile/me', { dmPolicy: 'everyone' });
    const opened = await call<{ conversationId: string }>(alice.token, 'POST', '/api/messages/conversations', { userId: bob.id });
    const conversationId = opened.body.conversationId;
    await call(alice.token, 'POST', `/api/messages/conversations/${conversationId}/messages`, { ciphertext: 'SEk=', iv: 'AAAA' });

    // A *new* conversation is refused while the policy is "nobody"...
    await call(bob.token, 'PUT', '/api/messages/prefs', { dmPolicy: 'nobody' });
    const outsider = await createStudent('Outsider Policy');
    const refused = await call(outsider.token, 'POST', '/api/messages/conversations', { userId: bob.id });
    assert.equal(refused.status, 403, 'a nobody policy must refuse a new conversation');
    // ...but the thread already in progress keeps working, which is what the screen promises.
    const stillWorks = await call(alice.token, 'POST', `/api/messages/conversations/${conversationId}/messages`, { ciphertext: 'SEs=', iv: 'AAAA' });
    assert.equal(stillWorks.status, 201, 'an existing conversation must survive a policy change');
    const reopened = await call<{ created: boolean }>(alice.token, 'POST', '/api/messages/conversations', { userId: bob.id });
    assert.equal(reopened.status, 200, 're-opening an existing conversation must not be treated as a new one');

    const blocked = await call(alice.token, 'POST', '/api/messages/blocks', { userId: bob.id });
    assert.equal(blocked.status, 200);
    const toBlocked = await call(alice.token, 'POST', `/api/messages/conversations/${conversationId}/messages`, { ciphertext: 'SEs=', iv: 'AAAA' });
    const fromBlocked = await call(bob.token, 'POST', `/api/messages/conversations/${conversationId}/messages`, { ciphertext: 'SEs=', iv: 'AAAA' });
    assert.ok(toBlocked.status >= 400 && fromBlocked.status >= 400, 'a block must stop messages both ways');
    /*
     * Wording matters as much as the refusal: the student who blocked is told about their own action
     * (so they know how to undo it), while the blocked student gets a neutral message and therefore
     * cannot tell whether they were blocked or simply refused.
     */
    const blockerSees = (toBlocked.body as { error: { message: string } }).error.message;
    const blockedSees = (fromBlocked.body as { error: { message: string } }).error.message;
    assert.match(blockerSees, /block/i, 'the blocker should be told about their own block');
    assert.doesNotMatch(blockedSees, /block/i, 'the blocked student must not be told a block exists');

    const history = await call<{ messages: unknown[] }>(bob.token, 'GET', `/api/messages/conversations/${conversationId}/messages`);
    assert.ok(history.body.messages.length >= 1, 'blocking must not delete the conversation history');
  });

  it('validates device keys and refuses to store private material', async () => {
    const student = await createStudent('Key Owner');
    const jwk = await publicKey();
    const good = await call(student.token, 'POST', '/api/messages/devices', {
      deviceId: 'device-abcdef12',
      publicKey: jwk,
      label: 'test device',
    });
    assert.equal(good.status, 200, JSON.stringify(good.body));

    const withPrivate = await call(student.token, 'POST', '/api/messages/devices', {
      deviceId: 'device-abcdef13',
      publicKey: { ...jwk, d: 'PRIVATE-SCALAR-MUST-NEVER-BE-STORED' },
    });
    assert.equal(withPrivate.status, 400, 'a payload carrying `d` must be refused outright');

    const stored = await db.one<{ public_key: string }>(`SELECT public_key FROM dm_device_keys WHERE user_id = ?`, [student.id]);
    assert.ok(stored, 'the public key must be stored');
    assert.ok(!stored.public_key.includes('PRIVATE-SCALAR'), 'no private material may reach the database');
  });

  it('accepts an envelope only for a device in the conversation and returns it only to its owner', async () => {
    const alice = await createStudent('Alice Keys');
    const bob = await createStudent('Bob Keys');
    await call(alice.token, 'PATCH', '/api/profile/me', { dmPolicy: 'everyone' });
    await call(bob.token, 'PATCH', '/api/profile/me', { dmPolicy: 'everyone' });
    await call(alice.token, 'POST', '/api/messages/devices', { deviceId: 'alice-device-1', publicKey: await publicKey() });
    await call(bob.token, 'POST', '/api/messages/devices', { deviceId: 'bob-device-1', publicKey: await publicKey() });
    const opened = await call<{ conversationId: string }>(alice.token, 'POST', '/api/messages/conversations', { userId: bob.id });
    const conversationId = opened.body.conversationId;

    const stored = await call(alice.token, 'POST', `/api/messages/conversations/${conversationId}/keys`, {
      recipientUserId: bob.id,
      deviceId: 'bob-device-1',
      wrappedKey: 'QUJDREVGR0g=',
      iv: 'AAAA',
      keyVersion: 1,
    });
    assert.equal(stored.status, 200, JSON.stringify(stored.body));

    const mine = await call<{ envelopes: { deviceId: string }[] }>(bob.token, 'GET', `/api/messages/conversations/${conversationId}/keys`);
    assert.deepEqual(
      mine.body.envelopes.map((envelope) => envelope.deviceId),
      ['bob-device-1'],
      'a student may only read their own envelopes',
    );

    const outsider = await createStudent('Outsider Keys');
    await call(outsider.token, 'POST', '/api/messages/devices', { deviceId: 'outsider-device-1', publicKey: await publicKey() });
    const foreign = await call(outsider.token, 'POST', `/api/messages/conversations/${conversationId}/keys`, {
      recipientUserId: outsider.id,
      deviceId: 'outsider-device-1',
      wrappedKey: 'QUJDREVGR0g=',
      iv: 'AAAA',
    });
    assert.equal(foreign.status, 404, 'a non-member must not write envelopes');
  });

  it('records a safety report privately and keeps the staff queue closed to students', async () => {
    const alice = await createStudent('Alice Report');
    const bob = await createStudent('Bob Report');
    await call(alice.token, 'PATCH', '/api/profile/me', { dmPolicy: 'everyone' });
    await call(bob.token, 'PATCH', '/api/profile/me', { dmPolicy: 'everyone' });
    const opened = await call<{ conversationId: string }>(alice.token, 'POST', '/api/messages/conversations', { userId: bob.id });

    const filed = await call<{ reportId: string }>(alice.token, 'POST', '/api/messages/reports', {
      conversationId: opened.body.conversationId,
      targetUserId: bob.id,
      reason: 'spam',
      note: 'Sent three identical messages.',
    });
    assert.equal(filed.status, 200, JSON.stringify(filed.body));

    const communityReports = await db.one<{ total: number }>(
      `SELECT COUNT(*) AS total FROM community_reports WHERE reporter_id = ?`,
      [alice.id],
    );
    assert.equal(communityReports?.total ?? 0, 0, 'a private-chat report must never enter a community moderation queue');

    const own = await call<{ reports: { id: string; mine: boolean }[] }>(alice.token, 'GET', '/api/messages/reports');
    assert.ok(own.body.reports.every((report) => report.mine), 'a student sees only the reports they filed');
    const queue = await call(alice.token, 'GET', '/api/messages/reports?scope=all');
    assert.equal(queue.status, 403, 'the staff queue must be closed to students');

    const selfReport = await call(alice.token, 'POST', '/api/messages/reports', {
      conversationId: opened.body.conversationId,
      targetUserId: alice.id,
      reason: 'testing',
    });
    assert.equal(selfReport.status, 400, 'reporting yourself is not a report');
  });

  it('refuses a message from a student who is not in the conversation, and reports an empty inbox honestly', async () => {
    const loner = await createStudent('Loner Student');
    const list = await call<{ conversations: unknown[]; unread: number }>(loner.token, 'GET', '/api/messages/conversations');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.conversations, []);
    assert.equal(list.body.unread, 0);

    const stranger = await createStudent('Stranger Student');
    const opened = await call(stranger.token, 'POST', '/api/messages/conversations', { userId: loner.id });
    assert.ok(opened.status >= 400, 'the default policy refuses a stranger');
  });
});
