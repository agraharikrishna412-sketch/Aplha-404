/**
 * Member list permissions.
 *
 * The Members tab renders its whole action row — change role, mute, remove, ban — only where the
 * server says an action is allowed, by reading `canChangeRole` and `canRemove` off every member row.
 * The server never sent those two fields. `undefined` is falsy, so the community had a member list
 * with no controls on it at all: a moderator could see who was in the group and could not touch any of
 * them. Nothing failed loudly; the buttons simply were not there.
 *
 * These tests pin the flags to the same rules the write endpoints enforce, so the UI and the server
 * cannot drift apart again:
 *
 *   · the owner may change and remove anyone except the owner's own row being removed (self);
 *   · a moderator may act on members below them and may grant only roles below their own;
 *   · an ordinary member may act on nobody;
 *   · nobody may be granted `owner` through the role control — that is the transfer endpoint's job.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { SessionUser } from '../src/middleware/auth.js';

process.env.DATA_DIR = path.join(os.tmpdir(), `vroqn-members-${Date.now()}`);
process.env.JWT_SECRET = 'members-test-secret-not-used-anywhere-real';
process.env.VROQN_MASTER_KEY = 'f'.repeat(64);
process.env.DEMO_MODE = 'on';

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { migrate } = await import('../src/db/schema.js');
const db = await import('../src/db/index.js');
const { hashPassword } = await import('../src/services/crypto.js');
const { attachUser, signSession } = await import('../src/middleware/auth.js');
const { errorHandler, notFoundHandler } = await import('../src/middleware/errors.js');
const { communitiesRouter } = await import('../src/routes/communities.js');

/* ------------------------------------------------------------------ harness --------------------- */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(attachUser);
app.use('/api/communities', communitiesRouter);
app.use(notFoundHandler);
app.use(errorHandler);

let server: import('node:http').Server;
let base = '';

async function call<T = Record<string, unknown>>(
  token: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
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
    email: `${name.toLowerCase().replace(/[^a-z]/g, '')}-${id.slice(0, 6)}@members.test`,
    name,
    role: 'student',
  };
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, class_level, board, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Class 12', 'CBSE', ?, ?)`,
    [id, user.email, hashPassword('members-test-password'), name, now, now],
  );
  return { id, token: signSession(user) };
}

interface Row {
  userId: string;
  role: string;
  isSelf: boolean;
  canChangeRole: boolean;
  canRemove: boolean;
}

async function rows(viewerToken: string, communityId: string): Promise<Map<string, Row>> {
  const reply = await call<{ members: Row[] }>(viewerToken, 'GET', `/api/communities/${communityId}/members`);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return new Map(reply.body.members.map((row) => [row.userId, row]));
}

interface Member {
  id: string;
  token: string;
}

/** A community with an owner, an admin, a moderator and two ordinary members, all joined. */
async function fixture(label: string) {
  const owner = await createStudent(`${label} Owner`);
  const created = await call<{ id: string }>(owner.token, 'POST', '/api/communities', {
    name: `${label} Permissions Circle`,
    description: 'Member permission flags test.',
    category: 'physics',
    visibility: 'public',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const communityId = created.body.id;

  const admin = await createStudent(`${label} Admin`);
  const moderator = await createStudent(`${label} Moderator`);
  const memberOne = await createStudent(`${label} Memberone`);
  const memberTwo = await createStudent(`${label} Membertwo`);

  for (const person of [admin, moderator, memberOne, memberTwo]) {
    const joined = await call(person.token, 'POST', `/api/communities/${communityId}/join`, {});
    assert.equal(joined.status, 200, `${person.id}: ${JSON.stringify(joined.body)}`);
  }
  for (const [person, role] of [
    [admin, 'admin'],
    [moderator, 'moderator'],
  ] as [Member, string][]) {
    const changed = await call(owner.token, 'POST', `/api/communities/${communityId}/members/${person.id}/role`, { role });
    assert.equal(changed.status, 200, `${role}: ${JSON.stringify(changed.body)}`);
  }

  return { owner, admin, moderator, memberOne, memberTwo, communityId };
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

describe('the member list tells the screen what it may do', () => {
  it('sends the flags at all — they were missing entirely', async () => {
    const { owner, memberOne, communityId } = await fixture('Flags');
    const list = await rows(owner.token, communityId);
    const target = list.get(memberOne.id);
    assert.ok(target, 'the member must appear in the list');
    assert.equal(typeof target.canChangeRole, 'boolean', 'canChangeRole must be a boolean, not undefined');
    assert.equal(typeof target.canRemove, 'boolean', 'canRemove must be a boolean, not undefined');
  });

  it('lets the owner act on members and admin on nobody above them', async () => {
    const { owner, admin, moderator, memberOne, communityId } = await fixture('Ownerview');
    const list = await rows(owner.token, communityId);

    assert.equal(list.get(memberOne.id)?.canChangeRole, true, 'the owner may change a member role');
    assert.equal(list.get(memberOne.id)?.canRemove, true, 'the owner may remove a member');
    assert.equal(list.get(moderator.id)?.canRemove, true, 'the owner may remove a moderator');
    assert.equal(list.get(owner.id)?.canRemove, false, 'nobody removes themselves from this list');
    assert.equal(list.get(admin.id)?.canChangeRole, true, 'the owner may change an admin role');

    // An admin outranks members and moderators but not the owner.
    const adminList = await rows(admin.token, communityId);
    assert.equal(adminList.get(memberOne.id)?.canRemove, true);
    assert.equal(adminList.get(moderator.id)?.canRemove, true);
    assert.equal(adminList.get(owner.id)?.canRemove, false, 'an admin must not be able to remove the owner');
    assert.equal(adminList.get(owner.id)?.canChangeRole, false, 'an admin must not be able to re-role the owner');
    assert.equal(adminList.get(admin.id)?.canRemove, false, 'an admin must not be able to remove themselves');
  });

  it('gives a moderator power over ordinary members only', async () => {
    const { moderator, memberOne, memberTwo, admin, owner, communityId } = await fixture('Modview');
    const list = await rows(moderator.token, communityId);
    assert.equal(list.get(memberOne.id)?.canChangeRole, true, 'a moderator may re-role a member');
    assert.equal(list.get(memberOne.id)?.canRemove, true, 'a moderator may remove a member');
    assert.equal(list.get(memberTwo.id)?.canRemove, true);
    assert.equal(list.get(admin.id)?.canRemove, false, 'a moderator must not touch an admin');
    assert.equal(list.get(owner.id)?.canRemove, false, 'a moderator must not touch the owner');
  });

  it('gives an ordinary member no power at all', async () => {
    const { memberOne, memberTwo, moderator, communityId } = await fixture('Memberview');
    const list = await rows(memberOne.token, communityId);
    for (const other of [memberTwo.id, moderator.id]) {
      assert.equal(list.get(other)?.canChangeRole, false, 'a member cannot re-role anyone');
      assert.equal(list.get(other)?.canRemove, false, 'a member cannot remove anyone');
    }
    assert.equal(list.get(memberOne.id)?.canChangeRole, false, 'a member cannot re-role themselves');
  });

  it('never offers ownership through the role control', async () => {
    const { owner, memberOne, communityId } = await fixture('Noowner');
    const list = await rows(owner.token, communityId);
    assert.equal(list.get(memberOne.id)?.canChangeRole, true, 'the owner may re-role the member');

    // And the endpoint itself refuses it, which is what the flag is derived from.
    const attempt = await call(owner.token, 'POST', `/api/communities/${communityId}/members/${memberOne.id}/role`, {
      role: 'owner',
    });
    assert.notEqual(attempt.status, 200, 'the role endpoint must not mint a second owner');

    const after = await rows(owner.token, communityId);
    assert.equal(after.get(owner.id)?.role, 'owner', 'the community still has exactly one owner');
    assert.equal(after.get(memberOne.id)?.role, 'member');
  });

  it('keeps the flags consistent with what the endpoints actually allow', async () => {
    const { owner, moderator, memberOne, communityId } = await fixture('Consistent');
    const list = await rows(owner.token, communityId);

    // canRemove true ⇒ removing really works.
    assert.equal(list.get(memberOne.id)?.canRemove, true);
    const removed = await call(owner.token, 'DELETE', `/api/communities/${communityId}/members/${memberOne.id}`);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const afterRemoval = await rows(owner.token, communityId);
    assert.equal(afterRemoval.has(memberOne.id), false, 'a removed member is no longer listed');

    // canChangeRole true ⇒ changing really works.
    const changed = await call(owner.token, 'POST', `/api/communities/${communityId}/members/${moderator.id}/role`, {
      role: 'mentor',
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const afterChange = await rows(owner.token, communityId);
    assert.equal(afterChange.get(moderator.id)?.role, 'mentor');
  });
});
