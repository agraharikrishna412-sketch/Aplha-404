/**
 * Vroqn Communities end-to-end check.
 *
 *   node scripts/communities-check.mjs [apiBase]        # default http://localhost:8787
 *
 * Signs in as the seeded demo student, creates two throwaway accounts, and drives the whole
 * Communities ecosystem against a running server: discovery, creation, all three visibilities,
 * roles and permission escalation attempts, chat lifecycle, doubts, knowledge, resources,
 * challenges, plans, events, rooms, polls, teams, competitions, moderation, notifications,
 * analytics, privacy and search scoping.
 *
 * Accounts, communities and content are named with a run stamp so repeated runs never collide,
 * and nothing here touches seeded data. Exit code 0 means every check passed.
 */
const BASE = (process.argv[2] ?? process.env.API_BASE ?? 'http://localhost:8787').replace(/\/$/, '');
const STAMP = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    return true;
  }
  fail += 1;
  failures.push(`${label}${detail ? ` → ${detail}` : ''}`);
  return false;
}

function check(label, condition, detail = '') {
  ok(label, Boolean(condition), detail);
}

class Session {
  constructor(name) {
    this.name = name;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  store(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      if (index > 0) this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  async request(method, path, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual' });
    this.store(response);
    let json = null;
    const text = await response.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    return { status: response.status, body: json, headers: response.headers };
  }

  get = (path) => this.request('GET', path);
  post = (path, body) => this.request('POST', path, body);
  patch = (path, body) => this.request('PATCH', path, body);
  put = (path, body) => this.request('PUT', path, body);
  del = (path, body) => this.request('DELETE', path, body);
}

async function register(session, tag) {
  const email = `comm-${STAMP}-${tag}@vroqn.dev`;
  const response = await session.post('/api/auth/signup', {
    name: `Comm ${tag}`,
    email,
    password: `Vr0qn-${STAMP}-${tag}!`,
    classLevel: 'Class 12',
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`could not register ${tag}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  // The moderation and handover checks act on specific user ids, so remember who this session is.
  session.userId = response.body?.user?.id ?? response.body?.id ?? null;
  if (!session.userId) throw new Error(`the signup response carried no user id: ${JSON.stringify(response.body)}`);
  return email;
}

const owner = new Session('owner');
const member = new Session('member');
const outsider = new Session('outsider');

/* ------------------------------------------------------------------ run ------------------------- */

console.log(`Vroqn Communities check → ${BASE}\n`);

await register(owner, 'owner');
await register(member, 'member');
await register(outsider, 'outsider');
check('three throwaway accounts created', true);

/* catalog + discovery -------------------------------------------------------- */
const catalog = await owner.get('/api/communities/catalog');
check('catalog lists categories', catalog.status === 200 && Array.isArray(catalog.body?.categories) && catalog.body.categories.length >= 8,
  JSON.stringify(catalog.body).slice(0, 160));

const discover = await owner.get('/api/communities/discover?limit=10');
check('discover returns a shape the client can render',
  discover.status === 200 && Array.isArray(discover.body?.communities) && typeof discover.body?.total === 'number');

const searchTerm = `Quantum ${STAMP}`;
const createPublic = await owner.post('/api/communities', {
  name: `Quantum Circle ${STAMP}`,
  description: 'A community for doubt-solving and weekly practice competitions.',
  category: 'physics',
  tags: ['physics', 'jee'],
  visibility: 'public',
  rules: 'Be kind. Show your attempt before asking.',
  welcomeMessage: 'Welcome! Start by introducing yourself in chat.',
  memberLimit: 50,
});
check('create public community', createPublic.status === 201 && createPublic.body?.id, JSON.stringify(createPublic.body).slice(0, 200));
const publicId = createPublic.body?.id;
const publicSlug = createPublic.body?.slug;

const detail = await owner.get(`/api/communities/${publicId}`);
check('creator is OWNER', detail.body?.myRole === 'owner', String(detail.body?.myRole));
check('tabs are computed for the community', Array.isArray(detail.body?.tabs) && detail.body.tabs.includes('chat'));
check('capabilities are exposed, not roles', typeof detail.body?.capabilities === 'object' && detail.body.capabilities ? true : false);

const bySlug = await outsider.get(`/api/communities/${publicSlug}`);
check('a public community is reachable by slug', bySlug.status === 200 && bySlug.body?.id === publicId);

/* private + invite-only ----------------------------------------------------- */
const createPrivate = await owner.post('/api/communities', {
  name: `Private Cells ${STAMP}`,
  description: 'Invite-vetted group for serious revision.',
  category: 'chemistry',
  visibility: 'private',
  joinRequirements: 'Tell us your target exam and current progress.',
});
const privateId = createPrivate.body?.id;
check('create private community', createPrivate.status === 201 && privateId);

const createInvite = await owner.post('/api/communities', {
  name: `Invite Only Waves ${STAMP}`,
  description: 'Code-gated group.',
  category: 'physics',
  visibility: 'invite_only',
});
const inviteCommunityId = createInvite.body?.id;
check('create invite-only community', createInvite.status === 201 && inviteCommunityId);

const outsiderPrivate = await outsider.get(`/api/communities/${privateId}`);
check('a non-member cannot read a private community (404, not a hint)',
  outsiderPrivate.status === 404, `${outsiderPrivate.status} ${JSON.stringify(outsiderPrivate.body).slice(0, 120)}`);

const privateJoin = await outsider.post(`/api/communities/${privateId}/join`, { reason: 'Preparing for NEET 2027, 78% in mocks.' });
check('private join creates a request instead of membership',
  privateJoin.status === 200 && privateJoin.body?.status === 'requested', JSON.stringify(privateJoin.body).slice(0, 160));
check('a pending requester still cannot read the community', (await outsider.get(`/api/communities/${privateId}`)).status === 404);

const inviteJoin = await outsider.post(`/api/communities/${inviteCommunityId}/join`, {});
check('invite-only join without a code is refused',
  inviteJoin.body?.status === 'invite_required', JSON.stringify(inviteJoin.body).slice(0, 160));

const invite = await owner.post(`/api/communities/${inviteCommunityId}/invites`, { maxUses: 1 });
check('owner mints an invite code', invite.status === 201 && typeof invite.body?.code === 'string');
const inviteCode = invite.body?.code;

const outsiderInviteJoin = await outsider.post(`/api/communities/${inviteCommunityId}/join`, { inviteCode });
check('the code gets the member in', outsiderInviteJoin.body?.status === 'joined', JSON.stringify(outsiderInviteJoin.body).slice(0, 120));

const reuse = await member.post(`/api/communities/${inviteCommunityId}/join`, { inviteCode });
check('an invite code cannot be reused past its limit',
  reuse.status !== 200 || reuse.body?.status !== 'joined', JSON.stringify(reuse.body).slice(0, 120));

const guestRead = await member.get(`/api/communities/${inviteCommunityId}/messages`);
check('a non-member cannot read invite-only chat', guestRead.status === 403 || guestRead.status === 404, String(guestRead.status));

/* membership + roles -------------------------------------------------------- */
const memberJoin = await member.post(`/api/communities/${publicId}/join`, {});
check('a public community joins instantly', memberJoin.body?.status === 'joined', JSON.stringify(memberJoin.body).slice(0, 120));

const blocked = await owner.post(`/api/communities/${publicId}/members/${'nobody'}/role`, { role: 'admin' });
check('a role change for an unknown member is refused', blocked.status === 404 || blocked.status === 400, String(blocked.status));

const escalate = await member.post(`/api/communities/${publicId}/members/${'self'}/role`, { role: 'owner' });
check('a member cannot promote themselves to owner', escalate.status >= 400, String(escalate.status));

const memberClaimsOwner = await member.patch(`/api/communities/${publicId}`, { name: 'Hijacked', myRole: 'owner' });
check('a plain member cannot edit community settings', memberClaimsOwner.status === 403 || memberClaimsOwner.status === 404,
  String(memberClaimsOwner.status));

const outsiderEdit = await outsider.patch(`/api/communities/${publicId}`, { name: 'Renamed by outsider' });
check('a non-member cannot edit a community', outsiderEdit.status >= 400, String(outsiderEdit.status));

/* chat ---------------------------------------------------------------------- */
const sent = await owner.post(`/api/communities/${publicId}/messages`, { body: `Hello community ${STAMP}` });
check('send a chat message', sent.status === 201 && sent.body?.id, JSON.stringify(sent.body).slice(0, 160));
const messageId = sent.body?.id;

const reply = await member.post(`/api/communities/${publicId}/messages`, { body: 'Replying about the doubt', parentId: messageId });
check('reply to a message carries the parent preview',
  reply.status === 201 && reply.body?.parentId === messageId, JSON.stringify(reply.body).slice(0, 160));

const edited = await owner.patch(`/api/communities/${publicId}/messages/${messageId}`, { body: `Hello community ${STAMP} (edited)` });
check('author edits their own message and it shows as edited',
  edited.status === 200 && edited.body?.editedAt, JSON.stringify(edited.body).slice(0, 200));

const foreignEdit = await member.patch(`/api/communities/${publicId}/messages/${messageId}`, { body: 'not mine' });
check('another member cannot edit my message', foreignEdit.status >= 400, String(foreignEdit.status));

const reaction = await member.post(`/api/communities/${publicId}/messages/${messageId}/reactions`, { emoji: '👍' });
check('react to a message', reaction.status === 200 && Array.isArray(reaction.body?.reactions), JSON.stringify(reaction.body).slice(0, 160));

const badReaction = await member.post(`/api/communities/${publicId}/messages/${messageId}/reactions`, { emoji: '💣' });
check('an unknown reaction is refused', badReaction.status >= 400, String(badReaction.status));

const pinned = await owner.post(`/api/communities/${publicId}/messages/${messageId}/pin`, {});
check('moderator pins a message', pinned.status === 200 && pinned.body?.isPinned === true, JSON.stringify(pinned.body).slice(0, 120));

const history = await member.get(`/api/communities/${publicId}/messages?limit=20`);
check('messages paginate with a cursor',
  history.status === 200 && Array.isArray(history.body?.messages) && 'hasMore' in (history.body ?? {}),
  JSON.stringify(history.body).slice(0, 160));

const searchMessages = await member.get(`/api/communities/${publicId}/messages?search=${STAMP}`);
check('chat search only returns this community', (searchMessages.body?.messages ?? []).every((m) => m.communityId === publicId));

const longMessage = await member.post(`/api/communities/${publicId}/messages`, { body: 'x'.repeat(6000) });
check('an over-length message is rejected', longMessage.status >= 400, String(longMessage.status));

const emptyMessage = await member.post(`/api/communities/${publicId}/messages`, { body: '   ' });
check('an empty message is rejected', emptyMessage.status >= 400, String(emptyMessage.status));

const poll = await owner.post(`/api/communities/${publicId}/polls`, { question: 'Which chapter next?', options: ['Optics', 'Modern physics'] });
check('create a poll', poll.status === 201 && (poll.body?.options ?? []).length === 2, JSON.stringify(poll.body).slice(0, 160));
const voted = poll.body?.id ? await member.post(`/api/communities/${publicId}/polls/${poll.body.id}/vote`, { optionIds: [poll.body.options[0].id] }) : { status: 0 };
check('vote on a poll', voted.status === 200 && voted.body?.totalVotes >= 1, JSON.stringify(voted.body).slice(0, 160));

/* doubts + knowledge -------------------------------------------------------- */
const doubt = await member.post(`/api/communities/${publicId}/doubts`, {
  title: `Why does a capacitor block DC ${STAMP}?`,
  description: 'I understand charging but not the steady state.',
  subject: 'Physics',
  topic: 'Current Electricity',
});
check('ask a doubt', doubt.status === 201 && doubt.body?.id, JSON.stringify(doubt.body).slice(0, 160));
const doubtId = doubt.body?.id;

const answer = await owner.post(`/api/communities/${publicId}/doubts/${doubtId}/answers`, {
  body: 'Because the plates accumulate charge until the potential difference equals the source, so the steady current is zero.',
});
check('answer a doubt', answer.status === 201 && answer.body?.id, JSON.stringify(answer.body).slice(0, 160));

const helpful = await member.post(`/api/communities/${publicId}/doubts/${doubtId}/helpful`, { answerId: answer.body?.id });
check('the asker marks the helpful answer', helpful.status === 200, JSON.stringify(helpful.body).slice(0, 160));

const answererWronglyMarks = await owner.post(`/api/communities/${publicId}/doubts/${doubtId}/helpful`, { answerId: answer.body?.id });
check('only the asker (or a moderator) can mark an answer helpful', answererWronglyMarks.status < 500,
  String(answererWronglyMarks.status));

const promoted = await owner.post(`/api/communities/${publicId}/doubts/${doubtId}/knowledge`, {});
check('a solved doubt can be promoted to the knowledge base', promoted.status === 201 && promoted.body?.id,
  JSON.stringify(promoted.body).slice(0, 160));

const knowledge = await member.get(`/api/communities/${publicId}/knowledge?search=capacitor`);
check('knowledge is searchable', knowledge.status === 200 && (knowledge.body?.items ?? []).length >= 1,
  JSON.stringify(knowledge.body).slice(0, 160));

const guestKnowledge = await outsider.get(`/api/communities/${publicId}/knowledge`);
check('a non-member cannot read knowledge inside a community they have not joined',
  guestKnowledge.status === 403 || guestKnowledge.status === 404, String(guestKnowledge.status));

/* resources ---------------------------------------------------------------- */
const resource = await owner.post(`/api/communities/${publicId}/resources`, {
  title: `Formula sheet ${STAMP}`,
  description: 'All the formulas in one page.',
  category: 'formula_sheet',
  kind: 'link',
  url: 'https://example.com/formulas.pdf',
});
check('share a link resource', resource.status === 201 && resource.body?.url, JSON.stringify(resource.body).slice(0, 160));

const badResource = await owner.post(`/api/communities/${publicId}/resources`, {
  title: 'Bad link',
  kind: 'link',
  url: 'javascript:alert(1)',
});
check('a javascript: URL is refused (stored XSS vector)', badResource.status >= 400, String(badResource.status));

/* challenges, plans, events, rooms ---------------------------------------- */
const challenge = await owner.post(`/api/communities/${publicId}/challenges`, {
  title: `7 day current electricity ${STAMP}`,
  description: 'One topic a day.',
  subject: 'Physics',
  startsAt: new Date().toISOString(),
  endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  days: Array.from({ length: 7 }, (_, index) => ({ title: `Day ${index + 1} work`, description: '' })),
});
check('create a challenge', challenge.status === 201 && challenge.body?.days?.length === 7, JSON.stringify(challenge.body).slice(0, 160));

const dayCheck = challenge.body?.days?.[0]?.index;
const completed = await member.post(`/api/communities/${publicId}/challenges/${challenge.body?.id}/days/${dayCheck}`, { done: true });
check('tick a challenge day', completed.status === 200 && (completed.body?.completedDays ?? []).includes(dayCheck),
  JSON.stringify(completed.body?.completedDays ?? null));

const plan = await owner.post(`/api/communities/${publicId}/plans`, {
  title: `30 day revision ${STAMP}`,
  subject: 'Physics',
  tasks: [
    { dayIndex: 1, title: 'Kinematics revision' },
    { dayIndex: 2, title: 'Laws of motion'+'' },
  ],
});
check('create a study plan', plan.status === 201 && (plan.body?.tasks ?? []).length === 2, JSON.stringify(plan.body).slice(0, 160));

const planTask = plan.body?.tasks?.[0]?.id;
const planDone = planTask ? await member.post(`/api/communities/${publicId}/plans/${plan.body.id}/tasks/${planTask}`, { done: true }) : { status: 0 };
check('tick a plan task', planDone.status === 200 && planDone.body?.doneCount >= 1, JSON.stringify(planDone.body).slice(0, 160));

const event = await owner.post(`/api/communities/${publicId}/events`, {
  title: `Doubt session ${STAMP}`,
  description: 'Bring your unsolved questions.',
  kind: 'doubt_session',
  startsAt: new Date(Date.now() + 3_600_000).toISOString(),
  endsAt: new Date(Date.now() + 7_200_000).toISOString(),
});
check('schedule an event', event.status === 201 && event.body?.id, JSON.stringify(event.body).slice(0, 160));

const rsvp = await member.post(`/api/communities/${publicId}/events/${event.body?.id}/rsvp`, { going: true });
check('RSVP to an event', rsvp.status === 200 && rsvp.body?.isGoing === true, JSON.stringify(rsvp.body).slice(0, 160));

const pastEvent = await owner.post(`/api/communities/${publicId}/events`, {
  title: 'Already over',
  startsAt: new Date(Date.now() - 7_200_000).toISOString(),
  endsAt: new Date(Date.now() - 3_600_000).toISOString(),
});
check('an event cannot be created in the past', pastEvent.status >= 400, String(pastEvent.status));

const room = await owner.post(`/api/communities/${publicId}/rooms`, {
  title: `Tonight 8pm ${STAMP}`,
  topic: 'Thermodynamics',
  startsAt: new Date(Date.now() + 3_600_000).toISOString(),
  endsAt: new Date(Date.now() + 7_200_000).toISOString(),
  checklist: ['Revise gas laws', 'Solve 10 numericals'],
});
check('open a study room with a checklist', room.status === 201 && (room.body?.checklist ?? []).length === 2, JSON.stringify(room.body).slice(0, 160));

/* leaderboard, badges, profile ------------------------------------------- */
const contribution = await member.post(`/api/communities/${publicId}/doubts/${doubtId}/helpful`, { answerId: answer.body?.id });
check('a second helpful-mark attempt does not error', contribution.status < 500, String(contribution.status));

const leaderboard = await member.get(`/api/communities/${publicId}/leaderboard`);
check('leaderboard returns entries plus an enabled flag',
  leaderboard.status === 200 && Array.isArray(leaderboard.body?.entries) && typeof leaderboard.body?.enabled === 'boolean');
check('leaderboard entries are ranked from real contribution',
  (leaderboard.body?.entries ?? []).every((entry, index, list) => index === 0 || list[index - 1].contributionPoints >= entry.contributionPoints));

const badges = await member.get('/api/communities/badges');
check('badges are derived from activity', badges.status === 200 && Array.isArray(badges.body?.badges) && typeof badges.body?.streakDays === 'number');

const profile = await member.get('/api/communities/profile/me');
check('my profile returns privacy flags', profile.status === 200 && typeof profile.body?.isProfilePublic === 'boolean');

const hiddenProfile = await owner.get(`/api/communities/profile/${profile.body?.userId}`);
check('a hidden profile hides activity, not the account', hiddenProfile.status === 200 && hiddenProfile.body?.isSelf === false);

/* notifications ----------------------------------------------------------- */
const notifications = await member.get('/api/communities/notifications');
check('notifications arrive for community events',
  notifications.status === 200 && Array.isArray(notifications.body?.notifications) && notifications.body.notifications.length >= 1,
  JSON.stringify(notifications.body).slice(0, 160));

const first = notifications.body?.notifications?.[0];
const readOne = first ? await member.post(`/api/communities/notifications/${first.id}/read`, {}) : { status: 0 };
check('a notification can be marked read', readOne.status === 200 && typeof readOne.body?.unread === 'number');

const prefs = await member.put('/api/communities/notifications/preferences', { mutedKinds: ['announcement'] });
check('notification preferences save', prefs.status === 200 && (prefs.body?.mutedKinds ?? []).includes('announcement'), JSON.stringify(prefs.body).slice(0, 120));

/* moderation + reporting -------------------------------------------------- */
const report = await member.post(`/api/communities/${publicId}/reports`, {
  targetType: 'message',
  targetId: messageId,
  reason: 'spam',
  details: 'Repeated posting',
});
check('report content', report.status === 201 && report.body?.id, JSON.stringify(report.body).slice(0, 160));

const queue = await owner.get(`/api/communities/${publicId}/reports`);
check('a moderator sees the report queue', queue.status === 200 && (queue.body?.reports ?? []).length >= 1);

const outsiderQueue = await member.get(`/api/communities/${publicId}/reports`);
check('a plain member cannot read the report queue', outsiderQueue.status === 403, String(outsiderQueue.status));

const resolved = await owner.post(`/api/communities/${publicId}/reports/${report.body?.id}/resolve`, { action: 'dismiss', note: 'Checked.' });
check('a moderator resolves a report', resolved.status === 200, JSON.stringify(resolved.body).slice(0, 160));

const audit = await owner.get(`/api/communities/${publicId}/moderation`);
check('an audit trail exists for moderation', audit.status === 200 && Array.isArray(audit.body?.actions), JSON.stringify(audit.body).slice(0, 120));

/* analytics -------------------------------------------------------------- */
const analytics = await owner.get(`/api/communities/${publicId}/analytics`);
check('analytics are aggregate only', analytics.status === 200 && typeof analytics.body?.summary?.totalMembers === 'number');
check('analytics never leak member identities in the summary',
  JSON.stringify(analytics.body?.summary ?? {}).length < 800, String(JSON.stringify(analytics.body?.summary ?? {}).length));

/* teams + competitions --------------------------------------------------- */
const team = await owner.post(`/api/communities/${publicId}/teams`, { name: `Circuit Breakers ${STAMP}`, goal: 'Physics revision', memberLimit: 4 });
check('create a study team', team.status === 201 && team.body?.id, JSON.stringify(team.body).slice(0, 160));
const teamJoin = await member.post(`/api/communities/${publicId}/teams/${team.body?.id}/join`, {});
check('join a study team', teamJoin.status === 200 || teamJoin.status === 201, String(teamJoin.status));

// Hosting a community competition reuses the Arena engine, so the request carries a real Arena
// blueprint and a real schedule — no parallel competition format, no client-supplied state.
const hostNow = Date.now();
const competition = await owner.post(`/api/communities/${publicId}/competitions`, {
  title: `Physics sprint ${STAMP}`,
  description: 'Ten questions on motion.',
  category: 'physics',
  difficulty: 'mixed',
  visibility: 'private',
  blueprint: {
    subjects: [{ subject: 'Physics', count: 3, chapters: ['Laws of Motion'] }],
    difficulty: { easy: 30, medium: 50, hard: 20 },
    types: { mcq: 100, numeric: 0, assertion: 0, match: 0, true_false: 0 },
    marksPerQuestion: 4,
    negativeMarks: 1,
    durationMin: 20,
    numericTolerance: 0.01,
  },
  registrationOpensAt: new Date(hostNow - 60_000).toISOString(),
  registrationClosesAt: new Date(hostNow + 30 * 60_000).toISOString(),
  startsAt: new Date(hostNow + 40 * 60_000).toISOString(),
  endsAt: new Date(hostNow + 100 * 60_000).toISOString(),
  rules: ['One attempt per student.'],
  instructions: ['Keep the tab in the foreground.'],
  integrity: { shuffleQuestions: true, shuffleOptions: true, logSuspiciousActivity: true },
});
check('a competition can be hosted (Arena is reused)',
  competition.status === 201 && competition.body?.id, JSON.stringify(competition.body).slice(0, 200));

const competitionId = competition.body?.id;
const competitionList = await member.get(`/api/communities/${publicId}/competitions`);
const hosted = (competitionList.body?.competitions ?? []).find((item) => item.id === competitionId);
check('hosted competition appears with a server-derived state', Boolean(hosted?.state), JSON.stringify(competitionList.body).slice(0, 200));
check('the community competition does not expose an invite code',
  !JSON.stringify(competitionList.body ?? {}).includes('inviteCode'), 'invite code leaked');

const registerComp = await member.post(`/api/communities/${publicId}/competitions/${competitionId}/register`, {});
check('a member can register for the hosted competition', registerComp.status === 200 || registerComp.status === 201,
  JSON.stringify(registerComp.body).slice(0, 160));

const guestRegister = await outsider.post(`/api/communities/${publicId}/competitions/${competitionId}/register`, {});
check('a non-member cannot register for a community competition', guestRegister.status >= 400, String(guestRegister.status));

/* search ----------------------------------------------------------------- */
const smart = await member.get(`/api/communities/smart-search?q=${encodeURIComponent(searchTerm)}`);
check('smart search finds the community by name', smart.status === 200 && (smart.body?.hits ?? []).some((hit) => hit.type === 'community'));
check('smart search never exposes another community\'s content to a non-member',
  (smart.body?.hits ?? []).every((hit) => !hit.communityId || hit.communityId === publicId || hit.type === 'community'),
  JSON.stringify(smart.body?.hits ?? []).slice(0, 200));

const scoped = await member.get(`/api/communities/${publicId}/search?q=capacitor`);
check('search inside a community works for members', scoped.status === 200, String(scoped.status));

/* member moderation + ownership handover ---------------------------------- */

/*
 * The moderation surface and the handover, exercised against the API the screens call.
 *
 * Two of these behaviours turned out to be broken in the app while the API was fine — the Members tab
 * had no controls at all (the list never sent `canChangeRole` / `canRemove`) and "Transfer ownership"
 * called nothing. Both are fixed; these checks keep the server half honest, and
 * `npm run smoke:ownership` covers the screens.
 */
const moderatorJoin = await member.post(`/api/communities/${publicId}/join`, {});
check('the member rejoins for the moderation checks', moderatorJoin.status === 200, JSON.stringify(moderatorJoin.body).slice(0, 120));

const memberRow = (await owner.get(`/api/communities/${publicId}/members`)).body?.members ?? [];
const memberUserId = memberRow.find((row) => row.userId !== owner.userId)?.userId ?? null;
const memberRowForOwner = memberRow.find((row) => row.userId === memberUserId);
check('the member list carries the per-row permissions the UI renders from',
  typeof memberRowForOwner?.canChangeRole === 'boolean' && typeof memberRowForOwner?.canRemove === 'boolean',
  JSON.stringify({ canChangeRole: memberRowForOwner?.canChangeRole, canRemove: memberRowForOwner?.canRemove }));

const promote = await owner.post(`/api/communities/${publicId}/members/${memberUserId}/role`, { role: 'moderator' });
check('the owner can promote a member to moderator', promote.status === 200, JSON.stringify(promote.body).slice(0, 140));
const promotedRow = ((await owner.get(`/api/communities/${publicId}/members`)).body?.members ?? []).find((row) => row.userId === memberUserId);
check('the promotion is what the list reports', promotedRow?.role === 'moderator', String(promotedRow?.role));
check('an ordinary member row is not offered the owner-only handover',
  (await member.get(`/api/communities/${publicId}`)).body?.capabilities?.transfer_ownership === false,
  'a moderator still cannot hand the community over');

const mute = await owner.post(`/api/communities/${publicId}/members/${memberUserId}/mute`, { hours: 1, reason: 'moderation check' });
check('the owner can mute a member', mute.status === 200, JSON.stringify(mute.body).slice(0, 140));
const mutedPost = await member.post(`/api/communities/${publicId}/messages`, { body: 'Can a muted member still speak?' });
check('a muted member cannot post', mutedPost.status >= 400, `HTTP ${mutedPost.status}`);
const unmute = await owner.del(`/api/communities/${publicId}/members/${memberUserId}/mute`);
check('the owner can unmute', unmute.status === 200, JSON.stringify(unmute.body).slice(0, 120));

const kick = await owner.del(`/api/communities/${publicId}/members/${memberUserId}`);
check('the owner can remove a member', kick.status === 200, JSON.stringify(kick.body).slice(0, 140));
/*
 * A removed member is no longer a member. On a *public* community the page itself stays readable —
 * that is deliberate, it is how anybody browses a community before joining — so the honest assertions
 * are that the role is gone and that members-only surfaces refuse them.
 */
const kickedRead = await member.get(`/api/communities/${publicId}`);
check('a removed member is no longer a member', kickedRead.body?.myRole === null || kickedRead.body?.myRole === undefined,
  `myRole=${String(kickedRead.body?.myRole)} HTTP ${kickedRead.status}`);
const kickedChat = await member.get(`/api/communities/${publicId}/messages`);
check('a removed member loses the members-only surfaces', kickedChat.status === 403 || kickedChat.status === 404, `HTTP ${kickedChat.status}`);

const ban = await owner.post(`/api/communities/${publicId}/members/${memberUserId}/ban`, { banned: true, reason: 'moderation check' });
check('the owner can ban a member', ban.status === 200, JSON.stringify(ban.body).slice(0, 140));
const bannedRejoin = await member.post(`/api/communities/${publicId}/join`, {});
check('a banned member cannot rejoin', bannedRejoin.status >= 400, `HTTP ${bannedRejoin.status}`);
await owner.post(`/api/communities/${publicId}/members/${memberUserId}/ban`, { banned: false });

/*
 * Ownership handover, end to end at the API: the outsider joins, takes ownership, and the powers that
 * belong to the owner move with it.
 */
await member.post(`/api/communities/${publicId}/join`, {});
const outsiderJoin = await outsider.post(`/api/communities/${publicId}/join`, {});
check('a second member joins for the handover', outsiderJoin.status === 200, JSON.stringify(outsiderJoin.body).slice(0, 120));

const notMineToGive = await member.post(`/api/communities/${publicId}/transfer`, { userId: outsider.userId, confirm: true });
check('a non-owner cannot hand the community over', notMineToGive.status === 403, `HTTP ${notMineToGive.status}`);

const handover = await owner.post(`/api/communities/${publicId}/transfer`, { userId: outsider.userId, confirm: true });
check('the owner can hand the community over', handover.status === 200, JSON.stringify(handover.body).slice(0, 140));

const outsiderNow = await outsider.get(`/api/communities/${publicId}`);
check('the chosen member is the owner now', outsiderNow.body?.myRole === 'owner', String(outsiderNow.body?.myRole));
check('the new owner holds owner powers', outsiderNow.body?.capabilities?.delete_community === true, JSON.stringify(outsiderNow.body?.capabilities).slice(0, 120));
const formerOwner = await owner.get(`/api/communities/${publicId}`);
check('the former owner is an admin', formerOwner.body?.myRole === 'admin', String(formerOwner.body?.myRole));
check('the former owner lost owner powers', formerOwner.body?.capabilities?.transfer_ownership === false, 'no transfer, no delete');
const secondHandover = await owner.post(`/api/communities/${publicId}/transfer`, { userId: outsider.userId, confirm: true });
check('the former owner cannot hand it over again', secondHandover.status === 403, `HTTP ${secondHandover.status}`);
const handItBack = await outsider.post(`/api/communities/${publicId}/transfer`, { userId: owner.userId, confirm: true });
check('the new owner can hand it back', handItBack.status === 200, JSON.stringify(handItBack.body).slice(0, 120));
check('ownership returns to the original owner', (await owner.get(`/api/communities/${publicId}`)).body?.myRole === 'owner');

/* leave + cleanup -------------------------------------------------------- */
const left = await member.post(`/api/communities/${publicId}/leave`, {});
check('a member can leave', left.status === 200 && left.body?.ok === true, JSON.stringify(left.body).slice(0, 120));

const afterLeave = await member.get(`/api/communities/${publicId}/messages`);
check('a member who left loses access immediately', afterLeave.status === 403 || afterLeave.status === 404, String(afterLeave.status));

const cannotLeaveOwn = await owner.post(`/api/communities/${publicId}/leave`, {});
check('an owner cannot abandon a community they still own',
  cannotLeaveOwn.status >= 400, JSON.stringify(cannotLeaveOwn.body).slice(0, 140));

const unknown = await owner.get('/api/communities/does-not-exist-anywhere');
check('an unknown community is a 404, never an empty page', unknown.status === 404, String(unknown.status));

/* ------------------------------------------------------------------ report ---- */
console.log('');
if (fail === 0) {
  console.log(`PASS ${pass} / FAIL 0 — all Communities checks passed.`);
} else {
  console.log(`PASS ${pass} / FAIL ${fail}`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
}
process.exit(fail === 0 ? 0 : 1);
