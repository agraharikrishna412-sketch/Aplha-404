/**
 * Demo communities for the sample account.
 *
 *   node scripts/seed-demo-communities.mjs
 *
 * Why this exists: `npm run seed --workspace server` fills the demo student's notes, activity and
 * weak areas, and `seed:arena` fills Arena — but nothing ever created communities, so the dashboard's
 * "top communities" strip showed whatever test fixtures happened to be lying around. This script
 * creates the same kind of starter clubs a real student would join, using the ordinary HTTP API (so
 * every rule — ownership, membership, badges — is applied by the product itself, not written straight
 * into the database), and it is idempotent: run it twice and it updates rather than duplicates.
 *
 * It also removes the debris left by interrupted test runs (`Zylo*`, `Probe*`, `Smoke*`, `Trdn*`,
 * `Invite Only Waves *`, `Private Cells *`, `Quantum Circle *` and friends), because those were never
 * demo content and they drown the strip they appear in.
 */
const BASE = process.env.BASE ?? 'http://localhost:8787';
const OWNER = { email: process.env.SMOKE_EMAIL ?? 'demo@vroqn.dev', password: process.env.SMOKE_PASSWORD ?? 'nexus1234' };

/** Fixture name patterns used by the verification suites. Never demo content. */
const FIXTURE = /^(Zylo|Probe|Smoke|Trdn|Repro|Esc|Comm-|Invite Only Waves|Private Cells|Quantum Circle)/i;

/** The starter clubs, and the classmates who join them. */
const CIRCLES = [
  {
    name: 'JEE Practice',
    category: 'jee',
    visibility: 'public',
    description: 'Daily JEE problems, previous-year papers and doubt threads. Post what you are stuck on; someone here has solved it.',
    tags: ['jee', 'physics', 'mathematics'],
    members: ['aarav@vroqn.dev', 'ishita@vroqn.dev', 'rohit@vroqn.dev'],
  },
  {
    name: 'Class 10 CBSE',
    category: 'class-10',
    visibility: 'public',
    description: 'Everything for Class 10 — board patterns, chapter-wise revision and shared notes.',
    tags: ['cbse', 'class 10', 'boards'],
    members: ['aarav@vroqn.dev', 'meera@vroqn.dev'],
  },
  {
    name: 'Mathematics Doubts',
    category: 'mathematics',
    visibility: 'public',
    description: 'Stuck on a sum? Ask here with your working and get a step-by-step explanation.',
    tags: ['mathematics', 'doubts'],
    members: ['ishita@vroqn.dev', 'rohit@vroqn.dev'],
  },
  {
    name: 'Code Club',
    category: 'coding',
    visibility: 'public',
    description: 'Weekly coding challenges, run through Code Lab. Beginners welcome — that is the whole point.',
    tags: ['code', 'programming'],
    members: ['rohit@vroqn.dev', 'meera@vroqn.dev'],
  },
  {
    name: 'NEET Biology',
    category: 'biology',
    visibility: 'public',
    description: 'NCERT line-by-line revision, diagram practice and daily MCQs for NEET aspirants.',
    tags: ['neet', 'biology'],
    members: ['meera@vroqn.dev', 'aarav@vroqn.dev'],
  },
];

/** The classmates. Passwords match the other demo accounts so the login form is easy to try. */
const STUDENTS = [
  { email: 'aarav@vroqn.dev', name: 'Aarav Sharma' },
  { email: 'ishita@vroqn.dev', name: 'Ishita Verma' },
  { email: 'rohit@vroqn.dev', name: 'Rohit Kulkarni' },
  { email: 'meera@vroqn.dev', name: 'Meera Nair' },
];
const STUDENT_PASSWORD = 'nexus1234';

async function signIn(email, password) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (response.ok) {
    return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  }
  /* Not registered yet: create the account, then sign in. */
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name: email.split('@')[0] }),
  });
  if (!signup.ok && signup.status !== 409) {
    throw new Error(`could not create ${email}: HTTP ${signup.status} ${await signup.text()}`);
  }
  const retry = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!retry.ok) throw new Error(`could not sign in ${email}: HTTP ${retry.status}`);
  return retry.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
}

const api = async (cookie, path, init = {}) => {
  const response = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
};

const ownerCookie = await signIn(OWNER.email, OWNER.password);

/* ------------------------------------------------------------------ cleanup */
{
  const mine = await api(ownerCookie, '/communities/discover?mine=1&limit=200');
  const owned = mine.body.communities ?? mine.body.items ?? [];
  const debris = owned.filter((entry) => FIXTURE.test(entry.name));
  for (const entry of debris) await api(ownerCookie, `/communities/${entry.id}`, { method: 'DELETE' });
  console.log(`cleanup: removed ${debris.length} leftover test community/ies`);
}

/* ------------------------------------------------------------- real content */
const cookies = new Map([[OWNER.email, ownerCookie]]);
for (const student of STUDENTS) cookies.set(student.email, await signIn(student.email, STUDENT_PASSWORD));

/* Give the classmates their display names (signup may have used the email prefix). */
for (const student of STUDENTS) {
  await api(cookies.get(student.email), '/profile', {
    method: 'PATCH',
    body: JSON.stringify({ name: student.name, bio: `${student.name.split(' ')[0]} is studying for the next exam.`, visibility: 'community' }),
  }).catch(() => undefined);
}

const existing = await api(ownerCookie, '/communities/discover?mine=1&limit=200');
const byName = new Map((existing.body.communities ?? existing.body.items ?? []).map((entry) => [entry.name, entry]));

for (const circle of CIRCLES) {
  let community = byName.get(circle.name);
  if (!community) {
    const created = await api(ownerCookie, '/communities', {
      method: 'POST',
      body: JSON.stringify({
        name: circle.name,
        description: circle.description,
        category: circle.category,
        visibility: circle.visibility,
        tags: circle.tags,
      }),
    });
    if (created.status !== 201 && created.status !== 200) {
      console.log(`  !! ${circle.name}: HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 120)}`);
      continue;
    }
    community = created.body;
    console.log(`  +  ${circle.name}`);
  } else {
    console.log(`  =  ${circle.name} (already there)`);
  }

  let joined = 0;
  for (const email of circle.members) {
    const cookie = cookies.get(email);
    if (!cookie) continue;
    const result = await api(cookie, `/communities/${community.id}/join`, { method: 'POST', body: '{}' });
    if (result.status < 300) joined += 1;
  }
  console.log(`     ${joined} classmate(s) joined`);
}

const final = await api(ownerCookie, '/communities/discover?limit=6');
console.log('\ntop communities now:');
for (const entry of final.body.communities ?? final.body.items ?? []) {
  console.log(`  ${String(entry.memberCount).padStart(3)} members · ${entry.name}`);
}
