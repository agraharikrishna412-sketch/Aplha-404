/**
 * Community ownership transfer — tested at the HTTP layer, because this is the one action in a
 * community that can be taken away from the person who took it.
 *
 * The UI side of this turn was a hollow shell: Manage showed "Transfer ownership", which confirmed,
 * then told the student to find a "Make owner" button that did not exist — the API wrapper had no
 * caller anywhere in the app. The endpoint itself was fine, which is exactly why it needed tests
 * rather than trust.
 *
 * What must hold, and is asserted below:
 *
 *  1. only the owner may hand the community over (`transfer_ownership: ['owner']`), and an ordinary
 *     member cannot reach the endpoint at all;
 *  2. the new owner must already be an active member — you cannot hand a community to a stranger;
 *  3. after the transfer the roles genuinely swap: the new owner holds owner powers (delete, edit) and
 *     the former owner keeps admin powers but can no longer transfer or delete;
 *  4. ownership cannot be seized through the ordinary role endpoint: promoting to `owner` via
 *     `/members/:id/role` must be refused, so the only path to owning a community is a transfer from
 *     its current owner.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { SessionUser } from '../src/middleware/auth.js';

process.env.DATA_DIR = path.join(os.tmpdir(), `vroqn-ownership-${Date.now()}`);
process.env.JWT_SECRET = 'ownership-test-secret-not-used-anywhere-real';
process.env.VROQN_MASTER_KEY = 'e'.repeat(64);
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
    email: `${name.toLowerCase().replace(/[^a-z]/g, '')}-${id.slice(0, 6)}@ownership.test`,
    name,
    role: 'student',
  };
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, class_level, board, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Class 11', 'CBSE', ?, ?)`,
    [id, user.email, hashPassword('ownership-test-password'), name, now, now],
  );
  return { id, token: signSession(user) };
}

interface Detail {
  id: string;
  name: string;
  myRole: string | null;
  capabilities: Record<string, boolean>;
}

/** Reads the caller's own view of a community. */
async function view(communityId: string, token: string): Promise<Detail> {
  const reply = await call<Detail>(token, 'GET', `/api/communities/${communityId}`);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body;
}

/* `POST /api/communities` and `GET /api/communities/:id` both answer with the detail object itself. */
async function makeCommunity(ownerToken: string, name: string): Promise<Detail> {
  const created = await call<Detail>(ownerToken, 'POST', '/api/communities', {
    name,
    description: 'Ownership transfer test community.',
    category: 'physics',
    visibility: 'public',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
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

describe('ownership transfer', () => {
  it('moves ownership to a member, and swaps what each person may do', async () => {
    const owner = await createStudent('Founding Owner');
    const successor = await createStudent('Careful Successor');
    const community = await makeCommunity(owner.token, 'Handover Physics Circle');

    const joined = await call(successor.token, 'POST', `/api/communities/${community.id}/join`, {});
    assert.equal(joined.status, 200, JSON.stringify(joined.body));

    const before = await view(community.id, owner.token);
    assert.equal(before.myRole, 'owner');

    const transferred = await call(owner.token, 'POST', `/api/communities/${community.id}/transfer`, {
      userId: successor.id,
      confirm: true,
    });
    assert.equal(transferred.status, 200, JSON.stringify(transferred.body));

    // The successor owns it now, with the powers that only the owner has.
    const successorView = await view(community.id, successor.token);
    assert.equal(successorView.myRole, 'owner');
    assert.equal(successorView.capabilities.transfer_ownership, true);
    assert.equal(successorView.capabilities.delete_community, true);

    // The former owner is an admin: still useful, no longer able to hand it over or destroy it.
    const formerView = await view(community.id, owner.token);
    assert.equal(formerView.myRole, 'admin');
    assert.equal(formerView.capabilities.edit_community, true, 'an admin still edits settings');
    assert.equal(formerView.capabilities.transfer_ownership, false);
    assert.equal(formerView.capabilities.delete_community, false);

    // And the server enforces it, not just the capability flags in the response.
    const secondTransfer = await call(owner.token, 'POST', `/api/communities/${community.id}/transfer`, {
      userId: successor.id,
      confirm: true,
    });
    assert.equal(secondTransfer.status, 403, 'the former owner must not be able to transfer again');
    const deletion = await call(owner.token, 'DELETE', `/api/communities/${community.id}`);
    assert.equal(deletion.status, 403, 'the former owner must not be able to delete the community');
  });

  it('refuses a transfer to somebody who is not a member', async () => {
    const owner = await createStudent('Guarded Owner');
    const stranger = await createStudent('Passing Stranger');
    const community = await makeCommunity(owner.token, 'Guarded Algebra Circle');

    const reply = await call(owner.token, 'POST', `/api/communities/${community.id}/transfer`, {
      userId: stranger.id,
      confirm: true,
    });
    assert.equal(reply.status, 400);
    const stillOwner = await view(community.id, owner.token);
    assert.equal(stillOwner.myRole, 'owner', 'a failed transfer must change nothing');
  });

  it('refuses a transfer to yourself', async () => {
    const owner = await createStudent('Sole Owner');
    const community = await makeCommunity(owner.token, 'Sole Owner Chemistry Circle');
    const reply = await call(owner.token, 'POST', `/api/communities/${community.id}/transfer`, {
      userId: owner.id,
      confirm: true,
    });
    assert.equal(reply.status, 400);
  });

  it('refuses a transfer attempted by an ordinary member', async () => {
    const owner = await createStudent('Quiet Owner');
    const member = await createStudent('Ordinary Member');
    const other = await createStudent('Other Member');
    const community = await makeCommunity(owner.token, 'Closed Optics Circle');
    await call(member.token, 'POST', `/api/communities/${community.id}/join`, {});
    await call(other.token, 'POST', `/api/communities/${community.id}/join`, {});

    const reply = await call(member.token, 'POST', `/api/communities/${community.id}/transfer`, {
      userId: other.id,
      confirm: true,
    });
    assert.equal(reply.status, 403);
  });

  it('cannot be reached through the ordinary role endpoint', async () => {
    const owner = await createStudent('Different Owner');
    const climber = await createStudent('Ambitious Climber');
    const community = await makeCommunity(owner.token, 'Climb Attempt Mechanics Circle');
    await call(climber.token, 'POST', `/api/communities/${community.id}/join`, {});

    // The climber tries to promote themselves, then the owner tries to promote them to owner directly.
    const selfPromotion = await call(climber.token, 'POST', `/api/communities/${community.id}/members/${climber.id}/role`, {
      role: 'owner',
    });
    assert.ok(selfPromotion.status === 403 || selfPromotion.status === 400, `self-promotion must be refused, got ${selfPromotion.status}`);
    const ownerPromotion = await call(owner.token, 'POST', `/api/communities/${community.id}/members/${climber.id}/role`, {
      role: 'owner',
    });
    assert.notEqual(ownerPromotion.status, 200, 'promoting to owner must go through the transfer endpoint, not the role endpoint');

    const stillOwner = await view(community.id, owner.token);
    assert.equal(stillOwner.myRole, 'owner');
  });
});
