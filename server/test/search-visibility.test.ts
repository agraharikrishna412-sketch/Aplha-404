/**
 * The two things this turn changed on the server, tested at the HTTP layer because that is where they
 * failed for the student:
 *
 *  1. **Profile visibility is a three-way choice.** The profile screen offered "Public / Communities /
 *     Private"; the API only accepted `public` and `private`. Choosing "Communities" produced a stream
 *     of "Could not save that — Invalid enum value. Expected 'public' | 'private', received 'members'"
 *     toasts on a screen that otherwise looked fine. The tests below fail if that ever happens again,
 *     and they check the *meaning* too: 'members' must actually hide a profile from a stranger and
 *     reveal it to a classmate, or it is just a word in a database column.
 *
 *  2. **One search box for people and groups.** "add the search option, by searching, shows both
 *     communities and users" — so one request returns both, refuses to list the caller as their own
 *     result, refuses to answer a one-character query with the whole directory, and never leaks a
 *     private community into the results.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { SessionUser } from '../src/middleware/auth.js';

process.env.DATA_DIR = path.join(os.tmpdir(), `vroqn-search-visibility-${Date.now()}`);
process.env.JWT_SECRET = 'search-visibility-test-secret-not-used-anywhere-real';
process.env.VROQN_MASTER_KEY = 'c'.repeat(64);
process.env.DEMO_MODE = 'on';

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { migrate } = await import('../src/db/schema.js');
const db = await import('../src/db/index.js');
const { hashPassword } = await import('../src/services/crypto.js');
const { attachUser, signSession } = await import('../src/middleware/auth.js');
const { errorHandler, notFoundHandler } = await import('../src/middleware/errors.js');
const { profileRouter } = await import('../src/routes/profile.js');
const { searchRouter } = await import('../src/routes/search.js');
const { communitiesRouter } = await import('../src/routes/communities.js');

/* ------------------------------------------------------------------ harness --------------------- */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(attachUser);
app.use('/api/profile', profileRouter);
app.use('/api/search', searchRouter);
app.use('/api/communities', communitiesRouter);
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
    email: `${name.toLowerCase().replace(/[^a-z]/g, '')}-${id.slice(0, 6)}@visibility.test`,
    name,
    role: 'student',
  };
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, class_level, board, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Class 10', 'CBSE', ?, ?)`,
    [id, user.email, hashPassword('visibility-test-password'), name, now, now],
  );
  return { id, token: signSession(user) };
}

interface Person {
  userId: string;
  name: string;
  username: string | null;
  canMessage: boolean;
  reason: string | null;
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

/* ------------------------------------------------------------------ visibility ------------------ */

describe('profile visibility: public / members / private', () => {
  it('accepts "members" — the value the profile screen actually sends', async () => {
    const owner = await createStudent('Members Owner');
    for (const value of ['public', 'members', 'private'] as const) {
      const saved = await call<{ visibility: { profile: string } }>(owner.token, 'PATCH', '/api/profile/me', {
        profileVisibility: value,
      });
      assert.equal(saved.status, 200, `${value} must be accepted: ${JSON.stringify(saved.body)}`);
      assert.equal(saved.body.visibility.profile, value, 'the saved value must come back as saved');
    }
    // And the old spelling still works, so nothing that predates this turn breaks.
    const legacy = await call(owner.token, 'PATCH', '/api/profile/me', { profileVisibility: 'public' });
    assert.equal(legacy.status, 200);
  });

  it('rejects a value that is not one of the three', async () => {
    const owner = await createStudent('Bad Value');
    const reply = await call(owner.token, 'PATCH', '/api/profile/me', { profileVisibility: 'friends' });
    assert.equal(reply.status, 400);
  });

  it('hides a "members" profile from a stranger and shows it to a classmate', async () => {
    const owner = await createStudent('Members Middle');
    const stranger = await createStudent('Total Stranger');
    const classmate = await createStudent('Same Classmate');

    await call(owner.token, 'PATCH', '/api/profile/me', {
      profileVisibility: 'members',
      bio: 'I am revising rotational motion this week.',
      interests: ['Physics'],
    });

    // A stranger sees the card but not the details.
    const asStranger = await call<{ bio: string; visibility: { profile: string } }>(
      stranger.token,
      'GET',
      `/api/profile/${owner.id}`,
    );
    assert.equal(asStranger.status, 200, 'the profile must still answer');
    assert.equal(asStranger.body.visibility.profile, 'members');
    assert.equal(asStranger.body.bio, '', 'a stranger must not read a members-only bio');

    // They join the same community; now 'members' means them too.
    const community = await call<{ id: string; slug: string }>(classmate.token, 'POST', '/api/communities', {
      name: `Shared Circle ${db.uuid().slice(0, 6)}`,
      description: 'Shared study group for the visibility test.',
      category: 'physics',
      visibility: 'public',
    });
    assert.equal(community.status, 201, JSON.stringify(community.body));
    const joined = await call(owner.token, 'POST', `/api/communities/${community.body.slug}/join`, {});
    assert.ok([200, 201].includes(joined.status), JSON.stringify(joined.body));

    const asClassmate = await call<{ bio: string }>(classmate.token, 'GET', `/api/profile/${owner.id}`);
    assert.equal(asClassmate.status, 200);
    assert.match(asClassmate.body.bio, /rotational motion/, 'a classmate in the same community must see the bio');

    // The owner always sees their own profile, whatever the setting says.
    const asSelf = await call<{ bio: string }>(owner.token, 'GET', '/api/profile/me');
    assert.match(asSelf.body.bio, /rotational motion/);
  });

  it('keeps a private profile private even from a classmate', async () => {
    const owner = await createStudent('Private Owner');
    const classmate = await createStudent('Private Classmate');
    await call(owner.token, 'PATCH', '/api/profile/me', { profileVisibility: 'private', bio: 'Nobody reads this.' });

    const community = await call<{ slug: string }>(classmate.token, 'POST', '/api/communities', {
      name: `Private Circle ${db.uuid().slice(0, 6)}`,
      description: 'Community for the private-profile test.',
      category: 'physics',
      visibility: 'public',
    });
    await call(owner.token, 'POST', `/api/communities/${community.body.slug}/join`, {});

    const asClassmate = await call<{ bio: string; visibility: { profile: string } }>(
      classmate.token,
      'GET',
      `/api/profile/${owner.id}`,
    );
    assert.equal(asClassmate.body.visibility.profile, 'private');
    assert.equal(asClassmate.body.bio, '', 'a private profile stays hidden even from a community member');
  });
});

/* ------------------------------------------------------------------ search ---------------------- */

describe('one search box returns people and communities', () => {
  it('returns both kinds of result in one payload', async () => {
    const searcher = await createStudent('Searching Student');
    const found = await createStudent('Aisha Findable');
    await call(found.token, 'PATCH', '/api/profile/me', { username: `aisha${db.uuid().slice(0, 4)}` });

    const community = await call<{ slug: string }>(searcher.token, 'POST', '/api/communities', {
      name: `Findable Physics Circle ${db.uuid().slice(0, 5)}`,
      description: 'A public community that must appear in search results.',
      category: 'physics',
      visibility: 'public',
    });
    assert.equal(community.status, 201, JSON.stringify(community.body));

    const reply = await call<{ people: Person[]; communities: { name: string; memberCount: number }[] }>(
      searcher.token,
      'GET',
      '/api/search?q=findable',
    );
    assert.equal(reply.status, 200);
    assert.ok(reply.body.people.some((person) => person.name === 'Aisha Findable'), 'the student must be found');
    assert.ok(
      reply.body.communities.some((entry) => entry.name.includes('Findable Physics Circle')),
      'the community must be found',
    );
    const person = reply.body.people.find((entry) => entry.name === 'Aisha Findable');
    assert.equal(typeof person?.canMessage, 'boolean', 'each person carries the server\'s message decision');
  });

  it('never lists the caller as their own result', async () => {
    const searcher = await createStudent('Self Search');
    const reply = await call<{ people: Person[] }>(searcher.token, 'GET', '/api/search?q=Self%20Search');
    assert.equal(reply.status, 200);
    assert.equal(reply.body.people.length, 0, 'a student must not find themselves');
  });

  it('answers a one-character query with nothing, not the whole directory', async () => {
    const searcher = await createStudent('Short Query');
    for (const term of ['a', '', '  ']) {
      const reply = await call<{ people: Person[]; communities: unknown[] }>(
        searcher.token,
        'GET',
        `/api/search?q=${encodeURIComponent(term)}`,
      );
      assert.equal(reply.status, 200);
      assert.equal(reply.body.people.length, 0);
      assert.equal(reply.body.communities.length, 0);
    }
  });

  it('never leaks a private community', async () => {
    const searcher = await createStudent('Private Seeker');
    const owner = await createStudent('Private Group Owner');
    const secretName = `Hidden Sanctum ${db.uuid().slice(0, 5)}`;
    const created = await call<{ slug: string }>(owner.token, 'POST', '/api/communities', {
      name: secretName,
      description: 'This community is private and must not be discoverable.',
      category: 'physics',
      visibility: 'private',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const reply = await call<{ communities: { name: string }[] }>(searcher.token, 'GET', '/api/search?q=Sanctum');
    assert.equal(reply.status, 200);
    assert.equal(
      reply.body.communities.filter((entry) => entry.name === secretName).length,
      0,
      'a private community must not be searchable',
    );
  });

  it('requires a session', async () => {
    const reply = await call(null, 'GET', '/api/search?q=physics');
    assert.equal(reply.status, 401);
  });
});
