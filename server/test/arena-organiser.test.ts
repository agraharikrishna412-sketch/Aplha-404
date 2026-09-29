/**
 * "How does a competition get created?" — the question has a mechanical answer, and this test pins it.
 *
 * Two ways to become an Arena organiser are promised in the README: `npm run make:admin -- <email>`
 * (flags the account in the database) and `ARENA_ADMIN_EMAILS` (a bootstrap allowlist for hosted
 * deploys). Both are exercised here through the real HTTP surface, because a documented command that
 * does not actually grant anything is worse than no documentation at all.
 *
 * The test runs the *shipped script* rather than repeating its SQL, so the file on disk is what is
 * being verified. Also pinned: an ordinary student is refused (403), a signed-out visitor is refused
 * (401), and the flag is visible in `/api/auth/me` — that last one is what makes the client show the
 * "You run competitions here" panel instead of leaving the organiser to guess.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { SessionUser } from '../src/middleware/auth.js';

const DATA_DIR = path.join(os.tmpdir(), `vroqn-organiser-${Date.now()}`);
process.env.DATA_DIR = DATA_DIR;
process.env.JWT_SECRET = 'organiser-test-secret-not-used-anywhere-real';
process.env.VROQN_MASTER_KEY = 'o'.repeat(64);
process.env.DEMO_MODE = 'on';
process.env.RATE_LIMIT_DISABLED = '1';
delete process.env.ARENA_ADMIN_EMAILS;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { migrate } = await import('../src/db/schema.js');
const db = await import('../src/db/index.js');
const { hashPassword } = await import('../src/services/crypto.js');
const { attachUser, signSession } = await import('../src/middleware/auth.js');
const { errorHandler, notFoundHandler } = await import('../src/middleware/errors.js');
const { authRouter } = await import('../src/routes/auth.js');
const { arenaRouter } = await import('../src/routes/arena.js');

await migrate();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(attachUser);
app.use('/api/auth', authRouter);
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

const PASSWORD = 'Organiser-pass1';

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

async function createStudent(name: string, email?: string): Promise<{ id: string; token: string; email: string }> {
  const id = db.uuid();
  const now = db.nowIso();
  const user: SessionUser = {
    id,
    email: email ?? `${name.toLowerCase().replace(/[^a-z]/g, '')}-${id.slice(0, 6)}@organiser.test`,
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

/** Exactly the command the README tells an operator to run. */
function runScript(script: 'make-admin.mjs' | 'make-student.mjs', email: string): string {
  return execFileSync(process.execPath, [path.join(repoRoot, 'scripts', script), email], {
    env: { ...process.env, DATA_DIR },
    encoding: 'utf8',
  });
}

const tomorrow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

function paper(title: string) {
  return {
    title,
    description: 'Scheduled by an organiser from the Arena console.',
    category: 'foundation',
    durationMinutes: 60,
    questionsToServe: 10,
    marksPerQuestion: 4,
    registrationOpensAt: tomorrow(-2),
    registrationClosesAt: tomorrow(-1),
    startsAt: tomorrow(1),
    endsAt: tomorrow(2),
  };
}

describe('Arena organisers', () => {
  it('refuses a signed-out visitor and an ordinary student', async () => {
    const anon = await call(null, 'GET', '/api/arena/admin/competitions');
    assert.equal(anon.status, 401, 'no session must not read the console');

    const student = await createStudent('Nisha');
    const list = await call(student.token, 'GET', '/api/arena/admin/competitions');
    assert.equal(list.status, 403);

    const create = await call(student.token, 'POST', '/api/arena/admin/competitions', paper('Should not exist'));
    assert.equal(create.status, 403, 'a student must not be able to schedule a competition');
  });

  it('make:admin grants exactly that power, make:student takes it back', async () => {
    const student = await createStudent('Ravi');

    const before = await call(student.token, 'GET', '/api/arena/admin/competitions');
    assert.equal(before.status, 403, 'starts as a student');

    // The script the operator runs. Note the session token is unchanged: the role is read from the
    // database on every request, so an organiser does not have to sign out and back in.
    const output = runScript('make-admin.mjs', student.email);
    assert.match(output, /can now schedule competitions/);

    const me = await call<{ user: { role: string } }>(student.token, 'GET', '/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.role, 'admin', 'the client decides whether to show the console from this');

    const list = await call(student.token, 'GET', '/api/arena/admin/competitions');
    assert.equal(list.status, 200);

    const created = await call<{ competition: { id: string; title: string } }>(
      student.token,
      'POST',
      '/api/arena/admin/competitions',
      paper('Bihar Mock Sprint'),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.ok(created.body.competition.id, 'a scheduled competition comes back with an id');

    const row = await db.one<{ title: string; status: string; created_by: string }>(
      'SELECT title, status, created_by FROM arena_competitions WHERE id = ?',
      [created.body.competition.id],
    );
    assert.equal(row?.title, 'Bihar Mock Sprint');
    assert.equal(row?.created_by, student.id, 'authorship is recorded against the organiser');
    assert.equal(row?.status, 'draft', 'a new competition is a draft — nothing is live on creation');

    // Draft means invisible: a student who guesses the id is refused, not given an empty exam.
    const guesser = await createStudent('Sneha');
    const hidden = await call(guesser.token, 'GET', '/api/arena/competitions');
    assert.equal(hidden.status, 200);
    assert.ok(
      !(hidden.body as { competitions: { id: string }[] }).competitions.some((entry) => entry.id === created.body.competition.id),
      'an unpublished paper must not appear in the student catalog',
    );

    runScript('make-student.mjs', student.email);
    const after = await call(student.token, 'GET', '/api/arena/admin/competitions');
    assert.equal(after.status, 403, 'the flag is revocable, which is why it is safe to hand out');
  });

  it('ARENA_ADMIN_EMAILS also works, for the very first organiser', async () => {
    const student = await createStudent('Ipsita', `bootstrap-admin-${Date.now()}@organiser.test`);
    process.env.ARENA_ADMIN_EMAILS = student.email.toUpperCase();

    const list = await call(student.token, 'GET', '/api/arena/admin/competitions');
    assert.equal(list.status, 200, 'an allowlisted email is an organiser without touching the database');

    const me = await call<{ user: { role: string } }>(student.token, 'GET', '/api/auth/me');
    assert.equal(me.body.user.role, 'admin');

    delete process.env.ARENA_ADMIN_EMAILS;
    const after = await call(student.token, 'GET', '/api/arena/admin/competitions');
    assert.equal(after.status, 403, 'the allowlist is read per request, not cached into the session');
  });

  it('the seeder leaves a ready organiser behind, so a fresh workspace can host at all', async () => {
    /*
     * The complaint this answers, verbatim: "I don't understand how a competition gets hosted in Arena,
     * or who can do it." Part of the fix is that a seeded workspace ships with an account that already
     * has the permission — otherwise the honest answer to a new user is "run a script first".
     *
     * The seeder also repairs the flag if someone removed it, so this test runs it twice on the same
     * database and expects the same result both times.
     */
    const seeded = path.join(os.tmpdir(), `vroqn-seed-${Date.now()}`);
    const run = () =>
      execFileSync(process.execPath, ['--import', 'tsx', 'src/db/seed.ts'], {
        cwd: path.resolve(here, '..'),
        env: { ...process.env, DATA_DIR: seeded },
        encoding: 'utf8',
        stdio: 'pipe',
      });

    const first = run();
    assert.match(first, /teacher \(Arena organiser\) ready/);
    assert.match(first, /\S+@\S+ \/ \S+/, 'the seeder prints the credentials it just created');

    const { default: Database } = await import('better-sqlite3');
    const check = new Database(path.join(seeded, 'vroqn-nexus.db'), { readonly: true });
    const teacher = check.prepare("SELECT email, name, role FROM users WHERE email = 'teacher@vroqn.dev'").get();
    assert.ok(teacher, 'the seeder creates the teacher account');
    assert.equal(teacher.role, 'admin', 'and the teacher carries the organiser flag');

    /* Removing the flag must not be permanent: seeding again puts the workspace back in a demoable state. */
    check.close();
    const writable = new Database(path.join(seeded, 'vroqn-nexus.db'));
    writable.prepare("UPDATE users SET role = 'student' WHERE email = 'teacher@vroqn.dev'").run();
    writable.close();

    run();
    const repaired = new Database(path.join(seeded, 'vroqn-nexus.db'), { readonly: true });
    assert.equal(
      repaired.prepare("SELECT role FROM users WHERE email = 'teacher@vroqn.dev'").get().role,
      'admin',
      're-running the seeder repairs the permission instead of duplicating the account',
    );
    assert.equal(
      repaired.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'teacher@vroqn.dev'").get().n,
      1,
      'one teacher account, not one per run',
    );
    repaired.close();
  });

  it('a competition created by an organiser is what a student then registers for', async () => {
    const organiser = await createStudent('Ms Dutta');
    runScript('make-admin.mjs', organiser.email);

    const now = Date.now();
    const created = await call<{ competition: { id: string } }>(
      organiser.token,
      'POST',
      '/api/arena/admin/competitions',
      {
        ...paper('Open Now Paper'),
        registrationOpensAt: new Date(now - 3_600_000).toISOString(),
        registrationClosesAt: new Date(now + 3_600_000).toISOString(),
        startsAt: new Date(now + 2 * 3_600_000).toISOString(),
        endsAt: new Date(now + 3 * 3_600_000).toISOString(),
      },
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const joiner = await createStudent('Kavya');
    const beforePublish = await call(joiner.token, 'POST', `/api/arena/competitions/${created.body.competition.id}/register`, {});
    assert.equal(beforePublish.status, 404, 'registration is impossible before the organiser publishes');

    // Publishing before the paper exists is refused — and the refusal names the missing step. This is
    // the sentence the console relays to the organiser, so it has to be useful, not just correct.
    const tooEarly = await call<{ error: { code: string; message: string } }>(
      organiser.token,
      'POST',
      `/api/arena/admin/competitions/${created.body.competition.id}/action`,
      { action: 'publish' },
    );
    assert.equal(tooEarly.status, 409, JSON.stringify(tooEarly.body));
    assert.equal(tooEarly.body.error.code, 'paper_not_ready');
    assert.match(tooEarly.body.error.message, /questions approved/i);

    // Step 2 of the console: generate the paper from the curated bank (no AI keys needed), then approve.
    const generated = await call<{ created: number; usedBank: boolean }>(
      organiser.token,
      'POST',
      `/api/arena/admin/competitions/${created.body.competition.id}/generate`,
      { bankOnly: true, replace: true },
    );
    assert.ok([200, 201].includes(generated.status), JSON.stringify(generated.body).slice(0, 300));
    assert.ok(generated.body.created > 0, 'a bank-only paper still has to produce questions');
    assert.equal(generated.body.usedBank, true, 'bank-only generation must not reach for a provider');

    const queue = await call<{ questions: { id: string }[]; readiness: { required: number } }>(
      organiser.token,
      'GET',
      `/api/arena/admin/competitions/${created.body.competition.id}/questions`,
    );
    assert.equal(queue.status, 200);
    for (const question of queue.body.questions) {
      const approved = await call(
        organiser.token,
        'PATCH',
        `/api/arena/admin/questions/${question.id}?competitionId=${created.body.competition.id}`,
        { reviewStatus: 'approved' },
      );
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
    }

    const published = await call(organiser.token, 'POST', `/api/arena/admin/competitions/${created.body.competition.id}/action`, {
      action: 'publish',
    });
    assert.ok([200, 201].includes(published.status), JSON.stringify(published.body));
    const opened = await call(organiser.token, 'POST', `/api/arena/admin/competitions/${created.body.competition.id}/action`, {
      action: 'open_registration',
    });
    assert.ok([200, 201].includes(opened.status), JSON.stringify(opened.body));

    const registered = await call(joiner.token, 'POST', `/api/arena/competitions/${created.body.competition.id}/register`, {});
    assert.ok([200, 201].includes(registered.status), JSON.stringify(registered.body));

    const catalog = await call<{ competitions: { id: string; title: string }[] }>(joiner.token, 'GET', '/api/arena/competitions');
    assert.ok(
      catalog.body.competitions.some((entry) => entry.id === created.body.competition.id),
      'the paper an organiser scheduled is the paper a student sees',
    );

    // Step 3 of the console: run the lifecycle. The paper is approved now, so it starts.
    const started = await call<{ competition: { state: string } }>(
      organiser.token,
      'POST',
      `/api/arena/admin/competitions/${created.body.competition.id}/action`,
      { action: 'start_now' },
    );
    assert.ok([200, 201].includes(started.status), JSON.stringify(started.body).slice(0, 200));
    assert.equal(started.body.competition.state, 'LIVE', 'start_now takes the paper live');

    // The student view agrees, from the other side of the same row.
    const catalogAfter = await call<{ competitions: { id: string; state: string }[] }>(
      joiner.token,
      'GET',
      '/api/arena/competitions',
    );
    const listed = catalogAfter.body.competitions.find((entry) => entry.id === created.body.competition.id);
    assert.equal(listed?.state, 'LIVE', 'what the organiser started is what the student sees as live');
  });
});
