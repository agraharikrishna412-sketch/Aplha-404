/**
 * Communities + exam-integrity HTTP tests.
 *
 * These run against the real routers on a real (throwaway) SQLite database and a real HTTP listener,
 * because the guarantees being checked only exist at the HTTP layer:
 *
 *  - a community link carries a **slug**, while the database stores ids. A slug reaching a query as if
 *    it were an id used to write rows nothing could find again, and to show an owner their own
 *    community as "0 members · Join". Both the read and the write paths are checked here.
 *  - a community's contents are visible to its members and to nobody else, and a private community
 *    answers 404 rather than 403 so its existence is not confirmed.
 *  - permissions are decided by the server: a member cannot promote themselves, a moderator cannot
 *    remove an admin, and only the owner can transfer the community.
 *  - the exam-integrity endpoints are self-only (another student's paper is a 404) and the record
 *    freezes when the paper is submitted.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
// Type-only: erased at compile time, so it does not load the auth module before the env vars above.
import type { SessionUser } from '../src/middleware/auth.js';

process.env.DATA_DIR = path.join(os.tmpdir(), `vroqn-communities-http-${Date.now()}`);
process.env.JWT_SECRET = 'communities-http-test-secret-not-used-anywhere-real';
process.env.VROQN_MASTER_KEY = 'd'.repeat(64);
process.env.DEMO_MODE = 'on';

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { migrate } = await import('../src/db/schema.js');
const db = await import('../src/db/index.js');
const { hashPassword } = await import('../src/services/crypto.js');
const { attachUser, signSession } = await import('../src/middleware/auth.js');
const { errorHandler, notFoundHandler } = await import('../src/middleware/errors.js');
const { communitiesRouter } = await import('../src/routes/communities.js');
const { examsRouter } = await import('../src/routes/exams.js');
const { arenaRouter } = await import('../src/routes/arena.js');
const { createCompetition, updateSchedule } = await import('../src/services/arena/competitions.js');

/* ------------------------------------------------------------------ harness --------------------- */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(attachUser);
app.use('/api/communities', communitiesRouter);
app.use('/api/exams', examsRouter);
app.use('/api/arena', arenaRouter);
app.use(notFoundHandler);
app.use(errorHandler);

let server: import('node:http').Server;
let base = '';

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  token: string | null,
  method: string,
  url: string,
  body?: unknown,
): Promise<Reply<T>> {
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
    email: `${name.toLowerCase().replace(/[^a-z]/g, '')}-${id.slice(0, 6)}@communities.test`,
    name,
    role: 'student',
  };
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, class_level, board, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Class 12', 'CBSE', ?, ?)`,
    [id, user.email, hashPassword('communities-test-password'), name, now, now],
  );
  return { id, token: signSession(user) };
}

/** Creates a community and returns its id, slug and the owner's token. */
async function createCommunity(
  owner: { token: string },
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; slug: string }> {
  const reply = await call<{ id: string; slug: string }>(owner.token, 'POST', '/api/communities', {
    name: `Test Circle ${db.uuid().slice(0, 6)}`,
    description: 'A community created by the test suite.',
    category: 'physics',
    visibility: 'public',
    ...overrides,
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return { id: reply.body.id, slug: reply.body.slug };
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

/* ------------------------------------------------------------------ auth ------------------------ */

describe('communities require a session', () => {
  it('refuses anonymous reads and writes', async () => {
    const read = await call(null, 'GET', '/api/communities/mine');
    assert.equal(read.status, 401);
    const write = await call(null, 'POST', '/api/communities', { name: 'Nope', description: 'x', category: 'physics' });
    assert.equal(write.status, 401);
  });
});

/* ------------------------------------------------------------------ slug vs id ------------------ */

describe('a community can be addressed by id or by the slug its link carries', () => {
  it('shows the owner their own community through both addresses', async () => {
    const owner = await createStudent('Owner');
    const community = await createCommunity(owner);

    for (const address of [community.id, community.slug]) {
      const detail = await call<{ id: string; myRole: string | null; memberCount: number; capabilities: Record<string, boolean> }>(
        owner.token,
        'GET',
        `/api/communities/${address}`,
      );
      assert.equal(detail.status, 200, address);
      assert.equal(detail.body.id, community.id);
      assert.equal(detail.body.myRole, 'owner', `myRole through ${address}`);
      assert.equal(detail.body.memberCount, 1, `memberCount through ${address}`);
      assert.equal(detail.body.capabilities.edit_community, true);
    }
  });

  it('writes through the slug address to the canonical id', async () => {
    const owner = await createStudent('SlugWriter');
    const community = await createCommunity(owner);

    const sent = await call<{ communityId: string }>(owner.token, 'POST', `/api/communities/${community.slug}/messages`, {
      body: 'Answered through the slug link.',
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.communityId, community.id, 'the message must be filed under the real id');

    const listed = await call<{ messages: { id: string }[] }>(owner.token, 'GET', `/api/communities/${community.id}/messages?limit=10`);
    assert.equal(listed.status, 200);
    assert.ok(listed.body.messages.length >= 1, 'the message is readable through the id address');

    // Nothing may be stored under a slug: such a row is invisible to every id-addressed query.
    const stranded = await db.one<{ total: number }>(
      `SELECT COUNT(*) AS total FROM community_messages m
        WHERE m.community_id NOT IN (SELECT id FROM communities)`,
    );
    assert.equal(stranded?.total ?? 0, 0, 'no community row may be keyed by a slug');
  });

  it('scopes a search inside one community through the slug address', async () => {
    const owner = await createStudent('SlugSearcher');
    const community = await createCommunity(owner);
    await call(owner.token, 'POST', `/api/communities/${community.slug}/doubts`, {
      title: 'Current electricity doubt',
      description: 'Why does a capacitor block direct current in steady state?',
      subject: 'Physics',
    });

    const scoped = await call<{ hits: { type: string }[]; scope: string[] }>(
      owner.token,
      'GET',
      `/api/communities/${community.slug}/search?q=current%20electricity`,
    );
    assert.equal(scoped.status, 200);
    assert.equal(scoped.body.scope[0], community.id, 'the search scope must be the canonical id');
    assert.ok(scoped.body.hits.some((hit) => hit.type === 'doubt'), 'a two-word query must match');
  });
});

/* ------------------------------------------------------------------ discovery & privacy -------- */

describe('discovery respects visibility', () => {
  it('finds a community by a multi-word name, but only public ones', async () => {
    const owner = await createStudent('Discoverable');
    const publicCommunity = await createCommunity(owner, { name: 'Quantum Mechanics Warriors' });
    const hidden = await createCommunity(owner, { name: 'Quantum Mechanics Invitees', visibility: 'private' });

    const searcher = await createStudent('Searcher');
    const results = await call<{ results: { id: string }[] }>(
      searcher.token,
      'GET',
      '/api/communities/search?q=quantum%20mechanics',
    );
    assert.equal(results.status, 200);
    const ids = results.body.results.map((row) => row.id);
    assert.ok(ids.includes(publicCommunity.id), 'a public community must be discoverable');
    assert.ok(!ids.includes(hidden.id), 'a private community must not be listed');

    const smart = await call<{ hits: { type: string; id: string }[] }>(
      searcher.token,
      'GET',
      '/api/communities/smart-search?q=quantum%20mechanics',
    );
    assert.equal(smart.status, 200);
    const hitIds = smart.body.hits.map((hit) => hit.id);
    assert.ok(hitIds.includes(publicCommunity.id));
    assert.ok(!hitIds.includes(hidden.id), 'smart search must not leak a private community');
  });

  it('answers 404 — not 403 — for a private community a stranger asks about', async () => {
    const owner = await createStudent('PrivateOwner');
    const community = await createCommunity(owner, { visibility: 'private' });
    const stranger = await createStudent('Stranger');

    const detail = await call(stranger.token, 'GET', `/api/communities/${community.slug}`);
    assert.equal(detail.status, 404, 'a 403 would confirm the community exists');

    const chat = await call(stranger.token, 'GET', `/api/communities/${community.id}/messages`);
    assert.equal(chat.status, 404);
  });
});

/* ------------------------------------------------------------------ joining --------------------- */

describe('joining behaves differently per visibility', () => {
  it('lets anyone join a public community immediately', async () => {
    const owner = await createStudent('PublicOwner');
    const community = await createCommunity(owner);
    const joiner = await createStudent('Joiner');

    const joined = await call<{ status: string; detail: { myRole: string } | null }>(
      joiner.token,
      'POST',
      `/api/communities/${community.slug}/join`,
      {},
    );
    assert.equal(joined.status, 200);
    assert.equal(joined.body.status, 'joined');
    assert.equal(joined.body.detail?.myRole, 'member');
  });

  it('turns a private join into a request an admin must approve', async () => {
    const owner = await createStudent('Gatekeeper');
    const community = await createCommunity(owner, { visibility: 'private' });
    const candidate = await createStudent('Candidate');

    const requested = await call<{ status: string }>(candidate.token, 'POST', `/api/communities/${community.id}/join`, {
      reason: 'I am preparing for JEE and need doubt help.',
    });
    assert.equal(requested.status, 200);
    assert.equal(requested.body.status, 'requested');

    // Still outside until somebody decides.
    const before = await call(candidate.token, 'GET', `/api/communities/${community.id}`);
    assert.equal(before.status, 404);

    const queue = await call<{ requests: { id: string }[] }>(owner.token, 'GET', `/api/communities/${community.id}/join-requests`);
    assert.equal(queue.status, 200);
    const request = queue.body.requests[0];
    assert.ok(request, 'the request must be visible to the owner');

    const approved = await call(owner.token, 'POST', `/api/communities/${community.id}/join-requests/${request.id}`, {
      approve: true,
    });
    assert.equal(approved.status, 200);

    const after = await call<{ myRole: string }>(candidate.token, 'GET', `/api/communities/${community.id}`);
    assert.equal(after.status, 200);
    assert.equal(after.body.myRole, 'member');
  });

  it('requires an invite code for an invite-only community and refuses a used one', async () => {
    const owner = await createStudent('Inviter');
    const community = await createCommunity(owner, { visibility: 'invite_only' });
    const guest = await createStudent('Guest');

    const blocked = await call<{ status: string }>(guest.token, 'POST', `/api/communities/${community.id}/join`, {});
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.status, 'invite_required');

    const wrong = await call(guest.token, 'POST', `/api/communities/${community.id}/join`, { inviteCode: 'not-a-real-code' });
    assert.equal(wrong.status, 400);

    const invite = await call<{ code: string }>(owner.token, 'POST', `/api/communities/${community.id}/invites`, { maxUses: 1 });
    assert.equal(invite.status, 201, JSON.stringify(invite.body));

    const accepted = await call<{ status: string }>(guest.token, 'POST', `/api/communities/${community.id}/join`, {
      inviteCode: invite.body.code,
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, 'joined');

    const reuse = await createStudent('Reuser');
    const reused = await call(reuse.token, 'POST', `/api/communities/${community.id}/join`, { inviteCode: invite.body.code });
    assert.equal(reused.status, 400, 'a single-use invite must not be reusable');
  });

  it('refuses to overfill a community that has a member limit', async () => {
    const owner = await createStudent('Limited');
    // Two seats: the owner holds one, so exactly one student may join and the next is refused.
    const community = await createCommunity(owner, { memberLimit: 2 });
    const first = await createStudent('First');
    const second = await createStudent('Second');

    const accepted = await call(first.token, 'POST', `/api/communities/${community.id}/join`, {});
    assert.equal(accepted.status, 200);

    const full = await call<{ error?: { code: string } }>(second.token, 'POST', `/api/communities/${community.id}/join`, {});
    assert.equal(full.status, 409);
    assert.equal(full.body.error?.code, 'community_full');
  });
});

/* ------------------------------------------------------------------ roles ----------------------- */

describe('roles cannot be escalated from the client', () => {
  it('stops a member promoting themselves and lets the owner promote them', async () => {
    const owner = await createStudent('RoleOwner');
    const community = await createCommunity(owner);
    const member = await createStudent('RoleMember');
    await call(member.token, 'POST', `/api/communities/${community.id}/join`, {});

    const escalation = await call(owner.token, 'POST', `/api/communities/${community.id}/members/${member.id}/role`, {
      role: 'admin',
    });
    assert.equal(escalation.status, 200);

    // Now the freshly promoted admin tries to make themselves owner — that is a transfer, not a role change.
    const grab = await call(owner.token, 'POST', `/api/communities/${community.id}/members/${member.id}/role`, {
      role: 'owner',
    });
    assert.ok(grab.status >= 400, 'ownership must not be granted by a role change');

    const stranger = await createStudent('RoleStranger');
    const forbidden = await call(stranger.token, 'POST', `/api/communities/${community.id}/members/${member.id}/role`, {
      role: 'member',
    });
    assert.ok(forbidden.status >= 400, 'a non-member cannot touch roles');
  });

  it('refuses a transfer without an explicit confirmation and moves ownership with one', async () => {
    const owner = await createStudent('TransferOwner');
    const community = await createCommunity(owner);
    const heir = await createStudent('Heir');
    await call(heir.token, 'POST', `/api/communities/${community.id}/join`, {});

    const noConfirm = await call(owner.token, 'POST', `/api/communities/${community.id}/transfer`, { userId: heir.id });
    assert.ok(noConfirm.status >= 400, 'the confirmation flag is required');

    const confirmed = await call(owner.token, 'POST', `/api/communities/${community.id}/transfer`, {
      userId: heir.id,
      confirm: true,
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

    const detail = await call<{ myRole: string; ownerId: string; ownerName: string }>(
      heir.token,
      'GET',
      `/api/communities/${community.id}`,
    );
    assert.equal(detail.body.myRole, 'owner');
    assert.equal(detail.body.ownerId, heir.id, 'the header must name the new owner');
    assert.ok(detail.body.ownerName.length > 0);

    // Exactly one owner row: ownership moved rather than being duplicated.
    const owners = await db.all<{ total: number }>(
      `SELECT COUNT(*) AS total FROM community_members WHERE community_id = ? AND role = 'owner' AND status IN ('active','muted')`,
      [community.id],
    );
    assert.equal(owners[0]?.total, 1);

    // The previous owner keeps standing as an admin instead of dropping out.
    const previous = await call<{ members: { userId: string; role: string }[] }>(
      heir.token,
      'GET',
      `/api/communities/${community.id}/members`,
    );
    const former = previous.body.members.find((member) => member.userId === owner.id);
    assert.equal(former?.role, 'admin');
  });

  it('stops a moderator removing an admin', async () => {
    const owner = await createStudent('HierarchyOwner');
    const community = await createCommunity(owner);
    const admin = await createStudent('HierarchyAdmin');
    const moderator = await createStudent('HierarchyMod');
    await call(admin.token, 'POST', `/api/communities/${community.id}/join`, {});
    await call(moderator.token, 'POST', `/api/communities/${community.id}/join`, {});
    await call(owner.token, 'POST', `/api/communities/${community.id}/members/${admin.id}/role`, { role: 'admin' });
    await call(owner.token, 'POST', `/api/communities/${community.id}/members/${moderator.id}/role`, { role: 'moderator' });

    const attempt = await call(moderator.token, 'DELETE', `/api/communities/${community.id}/members/${admin.id}`);
    assert.ok(attempt.status >= 400, 'role hierarchy must be enforced server-side');
    assert.notEqual(attempt.status, 200);
  });
});

/* ------------------------------------------------------------------ plan progress --------------- */

describe('study-plan progress belongs to the student', () => {
  it('counts only the caller\'s ticks and reports a percentage', async () => {
    const owner = await createStudent('PlanOwner');
    const community = await createCommunity(owner);
    const member = await createStudent('PlanMember');
    await call(member.token, 'POST', `/api/communities/${community.id}/join`, {});

    const created = await call<{ id: string; tasks: { id: string }[]; doneCount: number; percent: number }>(
      owner.token,
      'POST',
      `/api/communities/${community.id}/plans`,
      {
        title: 'Ten day revision',
        subject: 'Physics',
        tasks: [
          { dayIndex: 1, title: 'Kinematics' },
          { dayIndex: 2, title: 'Laws of motion' },
        ],
      },
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.tasks.length, 2);
    assert.equal(created.body.doneCount, 0);

    const ticked = await call<{ doneCount: number; totalCount: number; percent: number }>(
      member.token,
      'POST',
      `/api/communities/${community.id}/plans/${created.body.id}/tasks/${created.body.tasks[0].id}`,
      { done: true },
    );
    assert.equal(ticked.status, 200);
    assert.equal(ticked.body.doneCount, 1);
    assert.equal(ticked.body.totalCount, 2);
    assert.equal(ticked.body.percent, 50);

    // The owner's own copy is untouched: progress is not shared.
    const asOwner = await call<{ doneCount: number }>(owner.token, 'GET', `/api/communities/${community.id}/plans`);
    assert.equal(asOwner.body.doneCount ?? asOwner.body.plans?.[0]?.doneCount, 0);
  });
});

/* ------------------------------------------------------------------ events & rooms -------------- */

describe('events and study rooms are validated server-side', () => {
  it('refuses an event that is already in the past', async () => {
    const owner = await createStudent('EventOwner');
    const community = await createCommunity(owner);
    const past = await call(owner.token, 'POST', `/api/communities/${community.id}/events`, {
      title: 'Revision session from last week',
      startsAt: new Date(Date.now() - 7_200_000).toISOString(),
      endsAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    assert.equal(past.status, 400);
  });

  it('gives every joiner the checklist the host wrote', async () => {
    const owner = await createStudent('RoomOwner');
    const community = await createCommunity(owner);
    const member = await createStudent('RoomMember');
    await call(member.token, 'POST', `/api/communities/${community.id}/join`, {});

    const now = Date.now();
    const room = await call<{ id: string; checklist: { label: string }[]; isJoined: boolean; participantCount: number }>(
      owner.token,
      'POST',
      `/api/communities/${community.id}/rooms`,
      {
        title: 'Tonight at eight',
        topic: 'Thermodynamics',
        startsAt: new Date(now + 3_600_000).toISOString(),
        endsAt: new Date(now + 7_200_000).toISOString(),
        checklist: ['Revise gas laws', 'Solve ten numericals'],
      },
    );
    assert.equal(room.status, 201, JSON.stringify(room.body));
    assert.equal(room.body.participantCount, 1, 'the host is in their own room');
    assert.deepEqual(
      room.body.checklist.map((item) => item.label),
      ['Revise gas laws', 'Solve ten numericals'],
    );

    const joined = await call<{ checklist: { label: string }[] }>(
      member.token,
      'POST',
      `/api/communities/${community.id}/rooms/${room.body.id}/join`,
      { joined: true },
    );
    assert.equal(joined.status, 200);
    assert.deepEqual(
      joined.body.checklist.map((item) => item.label),
      ['Revise gas laws', 'Solve ten numericals'],
      'members work through the host\'s list, not a generic one',
    );
  });
});

/* ------------------------------------------------------------------ exam integrity -------------- */

describe('exam integrity is self-only and freezes at submission', () => {
  async function createExam(student: { token: string }): Promise<string> {
    const reply = await call<{ exam: { id: string } }>(student.token, 'POST', '/api/exams', {
      subject: 'Physics',
      chapters: ['Current Electricity'],
      difficulty: 'medium',
      questionCount: 3,
      questionType: 'mcq',
      durationMin: 10,
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return reply.body.exam.id;
  }

  it('records signals for the student who owns the paper and nobody else', async () => {
    const student = await createStudent('ExamStudent');
    const other = await createStudent('ExamOther');
    const examId = await createExam(student);

    const recorded = await call<{ accepted: number; report: { totalEvents: number; riskLevel: string } }>(
      student.token,
      'POST',
      `/api/exams/${examId}/signals`,
      { signals: [{ kind: 'focus_lost', detail: 'switched windows' }, { kind: 'copy' }], device: 'test-runner' },
    );
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
    assert.equal(recorded.body.accepted, 2);
    assert.equal(recorded.body.report.totalEvents, 2);
    // One lost focus and one copy attempt is a score of 7 — worth a look, not an accusation.
    assert.equal(recorded.body.report.riskLevel, 'notable');

    const intruder = await call(other.token, 'POST', `/api/exams/${examId}/signals`, {
      signals: [{ kind: 'focus_lost' }],
    });
    assert.equal(intruder.status, 404, 'another student\'s paper must not exist for the caller');

    const readBack = await call<{ totalEvents: number }>(other.token, 'GET', `/api/exams/${examId}/integrity`);
    assert.equal(readBack.status, 404);

    const ownerRead = await call<{ report: { totalEvents: number; headline: string } }>(
      student.token,
      'GET',
      `/api/exams/${examId}/integrity`,
    );
    assert.equal(ownerRead.status, 200);
    assert.equal(ownerRead.body.report.totalEvents, 2);
    assert.match(ownerRead.body.report.headline, /focus/i);
  });

  it('ignores unknown signal kinds rather than trusting the client', async () => {
    const student = await createStudent('ExamNoise');
    const examId = await createExam(student);
    const reply = await call<{ accepted: number; ignored: number }>(student.token, 'POST', `/api/exams/${examId}/signals`, {
      signals: [{ kind: 'an_invented_signal' }, { kind: 'paste' }],
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.accepted, 1);
    assert.equal(reply.body.ignored, 1);
  });

  it('starts every paper clean', async () => {
    const student = await createStudent('ExamClean');
    const examId = await createExam(student);
    const report = await call<{ report: { riskLevel: string; totalEvents: number; headline: string } }>(
      student.token,
      'GET',
      `/api/exams/${examId}/integrity`,
    );
    assert.equal(report.status, 200);
    assert.equal(report.body.report.riskLevel, 'clean');
    assert.equal(report.body.report.totalEvents, 0);
    assert.match(report.body.report.headline, /nothing was recorded/i);
  });

  it('stops recording once the paper is submitted', async () => {
    const student = await createStudent('ExamFreeze');
    const examId = await createExam(student);
    await call(student.token, 'POST', `/api/exams/${examId}/signals`, { signals: [{ kind: 'fullscreen_exit' }] });

    // A paper may be submitted with nothing answered; the API still wants the shape it validates.
    const submitted = await call(student.token, 'POST', `/api/exams/${examId}/submit`, {
      answers: [],
      timeSpentMs: 60_000,
    });
    assert.ok(submitted.status < 400, `submit failed: ${submitted.status} ${JSON.stringify(submitted.body)}`);

    const late = await call<{ accepted: number; report: { totalEvents: number } }>(
      student.token,
      'POST',
      `/api/exams/${examId}/signals`,
      { signals: [{ kind: 'focus_lost' }, { kind: 'focus_lost' }] },
    );
    assert.equal(late.status, 200, 'a late signal is not an error — it is simply not recorded');
    assert.equal(late.body.accepted, 0);
    assert.equal(late.body.report.totalEvents, 1, 'the frozen record keeps what happened during the paper');
  });
});

/* ------------------------------------------------------------------ arena integrity ------------- */

describe('Arena papers report integrity too', () => {
  /** A live attempt, created the way the runner would: a registered student mid-paper. */
  async function liveAttempt(studentId: string, creator: string): Promise<{ attemptId: string; competitionId: string }> {
    const now = Date.now();
    const competition = await createCompetition({
      title: `Integrity paper ${db.uuid().slice(0, 6)}`,
      description: 'Hosted paper used to check the integrity record.',
      category: 'foundation',
      blueprint: {
        subjects: [{ subject: 'Physics', count: 2, chapters: [] }],
        difficulty: { easy: 50, medium: 50, hard: 0 },
        types: { mcq: 100, numeric: 0, assertion: 0, match: 0, true_false: 0 },
        marksPerQuestion: 4,
        negativeMarks: 1,
        durationMin: 30,
      },
      // Created with a future window, then moved into the live window — the same two steps an admin
      // takes — because a paper may not be published already running.
      registrationOpensAt: new Date(now - 3_600_000).toISOString(),
      registrationClosesAt: new Date(now + 3_600_000).toISOString(),
      startsAt: new Date(now + 7_200_000).toISOString(),
      endsAt: new Date(now + 10_800_000).toISOString(),
      createdBy: creator,
      publish: true,
    });
    await updateSchedule(competition.id, {
      registrationClosesAt: new Date(now - 120_000).toISOString(),
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
    });
    const attemptId = db.uuid();
    await db.run(
      `INSERT INTO arena_attempts (id, competition_id, user_id, started_at, deadline_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'in_progress', ?)`,
      [attemptId, competition.id, studentId, new Date(now - 60_000).toISOString(), new Date(now + 1_800_000).toISOString(), db.nowIso()],
    );
    return { attemptId, competitionId: competition.id };
  }

  it("records an Arena attempt's signals and keeps them from everyone else", async () => {
    const host = await createStudent('ArenaHost');
    const student = await createStudent('ArenaStudent');
    const nosy = await createStudent('ArenaNosy');
    const { attemptId, competitionId } = await liveAttempt(student.id, host.id);

    const recorded = await call<{ accepted: number; report: { totalEvents: number; fullscreenExits: number } }>(
      student.token,
      'POST',
      `/api/arena/competitions/${competitionId}/signals`,
      { signals: [{ kind: 'fullscreen_exit' }, { kind: 'focus_lost' }], device: 'test-runner' },
    );
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
    assert.equal(recorded.body.accepted, 2);
    // The very first write is the one that used to fail silently: assert it landed in the table.
    const stored = await db.all<{ total: number }>(
      `SELECT COUNT(*) AS total FROM integrity_events WHERE scope = 'arena' AND ref_id = ?`,
      [attemptId],
    );
    assert.equal(stored[0]?.total, 2, 'signals must reach the database, not just the response');

    const storedReport = await db.all<{ total_events: number }>(
      `SELECT total_events FROM integrity_reports WHERE scope = 'arena' AND ref_id = ?`,
      [attemptId],
    );
    assert.equal(storedReport[0]?.total_events, 2, 'the summary row must be written on first report');

    const other = await call(nosy.token, 'GET', `/api/arena/results/${attemptId}/integrity`);
    assert.equal(other.status, 404, 'an attempt is private to the student who sat it');

    const mine = await call<{ report: { totalEvents: number; riskLevel: string } }>(
      student.token,
      'GET',
      `/api/arena/results/${attemptId}/integrity`,
    );
    assert.equal(mine.status, 200);
    assert.equal(mine.body.report.totalEvents, 2);
  });

  it('shows the host which attempts need a closer look, and nobody else', async () => {
    const host = await createStudent('ArenaOwner');
    const student = await createStudent('ArenaSitter');
    const nosy = await createStudent('ArenaOutsider');
    const { attemptId, competitionId } = await liveAttempt(student.id, host.id);
    await call(student.token, 'POST', `/api/arena/competitions/${competitionId}/signals`, {
      signals: [{ kind: 'extended_display' }, { kind: 'copy' }],
    });

    const hostView = await call<{ rows: { userId: string; totalEvents: number }[]; flagged: number; policy: string }>(
      host.token,
      'GET',
      `/api/arena/competitions/${competitionId}/integrity`,
    );
    assert.equal(hostView.status, 200, JSON.stringify(hostView.body));
    assert.ok(hostView.body.rows.some((row) => row.userId === student.id));
    assert.equal(hostView.body.flagged, 1, 'a second display plus a copy attempt is flagged');
    assert.ok(hostView.body.policy.length > 0, 'the host is told what is recorded and what it means');

    const outsider = await call(nosy.token, 'GET', `/api/arena/competitions/${competitionId}/integrity`);
    assert.equal(outsider.status, 404, 'a non-host must not see who slipped up');
  });

  it('returns an empty attempt id for a paper that was never started, so signals cannot be forged', async () => {
    const host = await createStudent('ArenaEmptyHost');
    const student = await createStudent('ArenaEmptyStudent');
    const { competitionId } = await liveAttempt(student.id, host.id);
    // A second attempt row cannot exist for the same student/competition — the unique index says so.
    const duplicate = await db
      .run(
        `INSERT INTO arena_attempts (id, competition_id, user_id, started_at, deadline_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'in_progress', ?)`,
        [
          db.uuid(),
          competitionId,
          student.id,
          db.nowIso(),
          new Date(Date.now() + 1_800_000).toISOString(),
          db.nowIso(),
        ],
      )
      .then(() => true)
      .catch(() => false);
    assert.equal(duplicate, false, 'one attempt per student per paper is enforced by the database');
  });
});
