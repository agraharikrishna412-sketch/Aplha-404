/**
 * "Delete my account" has to be true all the way down.
 *
 * These tests do not check a status code and call it a day. They give a student real rows in several
 * subsystems, delete the account through the real HTTP route, then ask the database itself whether a
 * single row still points at the person. Two guards are pinned as well: a wrong password cannot destroy
 * an account, and a community other students belong to cannot be lost because one member left.
 *
 * The final test is the one that keeps this honest as the product grows — it walks the live schema,
 * finds every column that references a user, and fails if the deletion plan does not cover its table.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { SessionUser } from '../src/middleware/auth.js';

process.env.DATA_DIR = path.join(os.tmpdir(), `vroqn-deletion-${Date.now()}`);
process.env.JWT_SECRET = 'deletion-test-secret-not-used-anywhere-real';
process.env.VROQN_MASTER_KEY = 'd'.repeat(64);
process.env.DEMO_MODE = 'on';
process.env.RATE_LIMIT_DISABLED = '1';

const here = path.dirname(fileURLToPath(import.meta.url));
const accountSource = readFileSync(path.join(here, '../src/services/account.ts'), 'utf8');

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { migrate } = await import('../src/db/schema.js');
const db = await import('../src/db/index.js');
const { hashPassword } = await import('../src/services/crypto.js');
const { attachUser, signSession } = await import('../src/middleware/auth.js');
const { errorHandler, notFoundHandler } = await import('../src/middleware/errors.js');
const { authRouter } = await import('../src/routes/auth.js');
const { communitiesRouter } = await import('../src/routes/communities.js');
const { notesRouter } = await import('../src/routes/notes.js');

/* ------------------------------------------------------------------ harness --------------------- */

await migrate();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(attachUser);
app.use('/api/auth', authRouter);
app.use('/api/communities', communitiesRouter);
app.use('/api/notes', notesRouter);
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
  /* The pool is left to the process: tests share one database and node:test exits when done. */
});

const PASSWORD = 'DeleteMe-pass1';

async function call<T = Record<string, unknown>>(
  token: string | null,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

async function createStudent(name: string): Promise<{ id: string; token: string; email: string }> {
  const id = db.uuid();
  const now = db.nowIso();
  const user: SessionUser = {
    id,
    email: `${name.toLowerCase().replace(/[^a-z]/g, '')}-${id.slice(0, 6)}@deletion.test`,
    name,
    role: 'student',
  };
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, class_level, board, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Class 11', 'CBSE', ?, ?)`,
    [id, user.email, hashPassword(PASSWORD), name, now, now],
  );
  return { id, token: signSession(user), email: user.email };
}

/** Every DELETE in the plan, with the verb swapped for a COUNT — read from the source of truth. */
function planStatements(): string[] {
  const block = accountSource.match(/const WIPE:[\s\S]*?\n\];/);
  assert.ok(block, 'the deletion plan could not be read from account.ts');
  return [...block[0].matchAll(/sql: '([^']+)'/g)].map((match) => match[1]);
}

/** How many rows still mention this student — asked of the database, not of the API. */
async function rowsForUser(userId: string): Promise<number> {
  let total = 0;
  for (const statement of planStatements()) {
    const countSql = statement.replace(/^DELETE FROM\s+(\w+)/, 'SELECT COUNT(*) AS n FROM $1');
    const rows = await db.all<{ n: number }>(countSql, [userId]);
    total += rows[0]?.n ?? 0;
  }
  return total;
}

/* --------------------------------------------------------------------- tests -------------------- */

describe('account deletion', () => {
  it('refuses without the correct password', async () => {
    const student = await createStudent('Wrong Pass');
    const attempt = await call(student.token, 'POST', '/api/auth/delete-account', {
      password: 'not-the-password',
      confirm: 'DELETE',
    });
    assert.equal(attempt.status, 401);
    assert.equal(await rowsForUser(student.id), 1, 'the account row must still be there');
  });

  it('refuses without the typed confirmation', async () => {
    const student = await createStudent('No Confirm');
    const attempt = await call(student.token, 'POST', '/api/auth/delete-account', {
      password: PASSWORD,
      confirm: 'delete',
    });
    assert.equal(attempt.status, 400);
    assert.equal(await rowsForUser(student.id), 1);
  });

  it('will not take a community away from its other members', async () => {
    const owner = await createStudent('Owner');
    const member = await createStudent('Member');

    const community = await call<{ id: string }>(owner.token, 'POST', '/api/communities', {
      name: `Shared Circle ${db.uuid().slice(0, 4)}`,
      description: 'Two people are in here.',
      category: 'jee',
      visibility: 'public',
    });
    assert.equal(community.status, 201, JSON.stringify(community.body));
    const joined = await call(member.token, 'POST', `/api/communities/${community.body.id}/join`, {});
    assert.ok(joined.status < 300, `the second member could not join: ${joined.status}`);

    const preview = await call<{ blocking: { otherMembers: number }[] }>(owner.token, 'GET', '/api/auth/deletion-preview');
    assert.equal(preview.status, 200);
    assert.equal(preview.body.blocking.length, 1, 'the shared community must be reported as blocking');
    assert.equal(preview.body.blocking[0].otherMembers, 1);

    const attempt = await call<{ error: { code: string } }>(owner.token, 'POST', '/api/auth/delete-account', {
      password: PASSWORD,
      confirm: 'DELETE',
    });
    assert.equal(attempt.status, 409);
    assert.equal(attempt.body.error.code, 'owns_shared_communities');

    /* Both members keep their community. */
    const stillThere = await call(member.token, 'GET', `/api/communities/${community.body.id}`);
    assert.equal(stillThere.status, 200);
    assert.ok((await rowsForUser(owner.id)) > 1, 'nothing of the owner should have been removed');
  });

  it('deletes the account and every row that mentioned it', async () => {
    const student = await createStudent('Full Wipe');

    const note = await call<{ id: string }>(student.token, 'POST', '/api/notes', {
      title: 'A note that must not outlive the account',
      content: 'Written only to be deleted.',
      subject: 'Physics',
    });
    assert.ok(note.status < 300, `note creation failed: ${note.status} ${JSON.stringify(note.body)}`);
    const notesBefore = await call<{ notes: { id: string }[] }>(student.token, 'GET', '/api/notes');
    assert.ok(
      (notesBefore.body.notes ?? []).some((entry) => entry.title === 'A note that must not outlive the account'),
      'the note should exist before the deletion',
    );

    const solo = await call<{ id: string }>(student.token, 'POST', '/api/communities', {
      name: `Solo Circle ${db.uuid().slice(0, 4)}`,
      description: 'Nobody else is here.',
      category: 'physics',
      visibility: 'public',
    });
    assert.equal(solo.status, 201, JSON.stringify(solo.body));

    const before = await rowsForUser(student.id);
    /*
     * The account, its community membership and its note — at least three rows in three different
     * tables. Asserted loosely on purpose: the exact number is the product's business, and rows like
     * `user_settings` are only created when a student changes a setting. What this test insists on is
     * that real data existed and that the deletion removed all of it.
     */
    assert.ok(before >= 3, `expected the student to own rows in several tables, found ${before}`);

    const preview = await call<{ blocking: unknown[]; solo: unknown[] }>(student.token, 'GET', '/api/auth/deletion-preview');
    assert.equal(preview.body.blocking.length, 0);
    assert.equal(preview.body.solo.length, 1, 'the solo community should be reported as going with the account');

    const deleted = await call<{ ok: boolean; deletedCommunities: string[] }>(student.token, 'POST', '/api/auth/delete-account', {
      password: PASSWORD,
      confirm: 'DELETE',
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.ok, true);
    assert.equal(deleted.body.deletedCommunities.length, 1);

    assert.equal(await rowsForUser(student.id), 0, 'not one row may still point at the deleted account');

    /* The note is gone too, as seen through the API the student used to create it. */
    const notesAfter = await call<{ notes: unknown[] }>(student.token, 'GET', '/api/notes');
    assert.equal((notesAfter.body.notes ?? []).length, 0, 'the note outlived its author');

    /* The solo community went with them, the session is over, and the account cannot sign back in. */
    const gone = await call(memberTokenOr(student.token), 'GET', `/api/communities/${solo.body.id}`);
    assert.ok(gone.status >= 400, `the solo community should be gone, got ${gone.status}`);
    const me = await call<{ user: unknown }>(student.token, 'GET', '/api/auth/me');
    assert.equal(me.body.user, null);
    const login = await call(null, 'POST', '/api/auth/login', { email: student.email, password: PASSWORD });
    assert.equal(login.status, 401, 'the deleted account must not be able to sign in again');
  });

  it('covers every column in the schema that points at a user', async () => {
    const tables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    const userColumns: string[] = [];
    for (const table of tables) {
      const columns = await db.all<{ name: string }>(`PRAGMA table_info(${JSON.stringify(table.name)})`);
      for (const column of columns) {
        if (/(^|_)(user|sender|reporter|target|actor|owner|author|created_by|recipient|invited)/.test(column.name)) {
          userColumns.push(`${table.name}.${column.name}`);
        }
      }
    }
    const tablesInPlan = new Set([...accountSource.matchAll(/DELETE FROM (\w+)/g)].map((match) => match[1]));
    const uncovered = userColumns.filter((entry) => {
      const table = entry.split('.')[0];
      return table !== 'users' && !tablesInPlan.has(table);
    });
    assert.deepEqual(uncovered, [], `user-referencing tables absent from the deletion plan: ${uncovered.join(', ')}`);
  });
});

/** Small helper: the token is only used to prove the session no longer reaches anything. */
function memberTokenOr(token: string): string {
  return token;
}
