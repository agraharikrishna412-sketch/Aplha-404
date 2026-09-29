/**
 * Demo data seeder.
 *
 *   npm run seed --workspace server
 *
 * Creates (or refreshes) a demo student so the whole product can be explored immediately:
 * notes, a week of learning activity, topic statistics with clear weak/strong areas.
 * It never touches AI providers — everything here is local data.
 */
import { hashPassword } from '../services/crypto.js';
import { createNote } from '../services/notes.js';
import { recordTopicResult } from '../services/activity.js';
import { getSettings } from '../services/settings.js';
import { migrate } from './schema.js';
import * as db from './index.js';
import { nowIso, uuid } from './index.js';

/**
 * Demo student seeder.
 *
 * The credentials below are development defaults for the sample account — they are never created
 * unless this script is run explicitly, and the script refuses to run against a production database
 * unless SEED_ALLOW_PROD=1 is set (with an explicitly supplied password).
 */
const EMAIL = process.env.SEED_EMAIL ?? 'demo@vroqn.dev';
const PASSWORD = process.env.SEED_PASSWORD ?? 'nexus1234';

/*
 * A ready-made teacher account, so a fresh workspace can host a competition without anyone having to
 * learn the permission model first. Same password rule as every other account; same server-side role
 * check — this is an ordinary account that happens to carry the organiser flag, not a backdoor.
 *
 * `npm run who:admin` lists organisers, `npm run make:student -- <email>` takes it away.
 */
const TEACHER_EMAIL = process.env.SEED_TEACHER_EMAIL ?? 'teacher@vroqn.dev';
const TEACHER_PASSWORD = process.env.SEED_TEACHER_PASSWORD ?? PASSWORD;
const TEACHER_NAME = process.env.SEED_TEACHER_NAME ?? 'Ms Dutta';

if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PROD !== '1') {
  console.error('[seed] Refusing to seed demo data in production. Set SEED_ALLOW_PROD=1 to override.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && !process.env.SEED_PASSWORD) {
  console.error('[seed] SEED_PASSWORD must be supplied explicitly when seeding production.');
  process.exit(1);
}

async function ensureUser(): Promise<string> {
  const existing = await db.one<{ id: string }>('SELECT id FROM users WHERE email = ?', [EMAIL]);
  if (existing) return existing.id;

  const id = uuid();
  const now = nowIso();
  /*
   * The seeded demo account is also an Arena *organiser*.
   *
   * Not a shortcut around the permission — it is the permission, applied to the one account whose job is
   * to demonstrate the product. Without it, the workspace opens with no way to see how a competition is
   * created: the console is staff-only by design, and a fresh signup is (correctly) a student.
   *
   * Undo it any time with `npm run make:student -- <email>`. Real accounts are unaffected: this role is
   * written only for the account this script creates, and students still cannot promote themselves —
   * the server enforces the role, and `/api/arena/admin/*` answers 403 to everyone else.
   */
  await db.run(
    `INSERT INTO users (id, email, name, class_level, board, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, ?)`,
    [id, EMAIL, 'Aarav', 'Class 10', 'CBSE', hashPassword(PASSWORD), now, now],
  );
  return id;
}

/**
 * Creates (or repairs) the teacher account: an ordinary student account carrying the organiser flag.
 *
 * Idempotent on purpose — running the seeder again after someone removed the flag puts the workspace back
 * into a state where the Arena console can be demonstrated, and it never duplicates the account or
 * touches its data.
 */
async function ensureTeacher(): Promise<string> {
  const existing = await db.one<{ id: string; role: string | null }>(
    'SELECT id, role FROM users WHERE email = ?',
    [TEACHER_EMAIL],
  );
  const now = nowIso();
  if (existing) {
    if (existing.role !== 'admin') {
      await db.run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', ['admin', now, existing.id]);
    }
    return existing.id;
  }
  const id = uuid();
  await db.run(
    `INSERT INTO users (id, email, name, class_level, board, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, 'Class 11', 'CBSE', ?, 'admin', ?, ?)`,
    [id, TEACHER_EMAIL, TEACHER_NAME, hashPassword(TEACHER_PASSWORD), now, now],
  );
  return id;
}

async function resetDemoData(userId: string): Promise<void> {
  await db.run('DELETE FROM notes WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM activity_events WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM topic_stats WHERE user_id = ?', [userId]);
}

function daysAgo(days: number, hour = 18): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, 15, 0, 0);
  return date.toISOString();
}

async function insertEvent(args: {
  userId: string;
  kind: string;
  label: string;
  subject?: string;
  topic?: string;
  durationMs?: number;
  correct?: number;
  total?: number;
  createdAt: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await db.run(
    `INSERT INTO activity_events (id, user_id, kind, subject, topic, duration_ms, correct, total, label, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid(),
      args.userId,
      args.kind,
      args.subject ?? null,
      args.topic ?? null,
      args.durationMs ?? 0,
      args.correct ?? null,
      args.total ?? null,
      args.label,
      args.meta ? JSON.stringify(args.meta) : null,
      args.createdAt,
    ],
  );
}

const NOTES = [
  {
    title: 'Newton’s Laws of Motion',
    subject: 'Physics',
    chapter: 'Laws of Motion',
    tags: ['formulas', 'class 10'],
    content: `# Newton’s Laws of Motion

## Summary
Three laws that connect force and motion. They explain why a bus jerks forward when it brakes and
why rockets move in space where there is nothing to push against.

## Key concepts
- **First law (inertia)** — an object keeps doing what it was doing unless a net external force acts.
- **Second law** — net force equals mass times acceleration: \`F = ma\`.
- **Third law** — every action has an equal and opposite reaction, acting on *different* bodies.

## Formulas
- Net force: \`F = ma\`
- Momentum: \`p = mv\`
- Impulse: \`F·t = Δp\`

## Common mistakes
- Adding action–reaction pairs as if they cancel — they act on different objects.
- Forgetting that the second law uses the **net** force, not a single force.

## Quick revision
1. Why do we fall forward when a moving bus stops suddenly?
2. A 2 kg ball accelerates at 3 m/s². Find the net force.`,
  },
  {
    title: 'Polynomials — factorisation habits',
    subject: 'Mathematics',
    chapter: 'Polynomials',
    tags: ['algebra'],
    content: `# Polynomials

## Summarised from class notes
A polynomial is an expression of the form \`a₀ + a₁x + … + aₙxⁿ\` with whole-number powers.

## Key concepts
- **Degree** decides how many roots are possible.
- **Factor theorem:** \`(x − a)\` is a factor exactly when \`p(a) = 0\`.
- **Remainder theorem:** \`p(a)\` is the remainder when dividing by \`(x − a)\`.

## Worked example
Factorise \`x² − 5x + 6\`.
Find two numbers that multiply to 6 and add to −5: −2 and −3, so \`x² − 5x + 6 = (x − 2)(x − 3)\`.

## Practice questions
1. Factorise \`x² + 7x + 12\`.
2. If \`p(x) = 2x³ − 3x + 1\`, find \`p(2)\` and state the remainder for \`(x − 2)\`.`,
  },
  {
    title: 'Photosynthesis — handwritten page 3',
    subject: 'Biology',
    chapter: 'Life Processes',
    tags: ['diagram', 'uploaded'],
    content: `# Photosynthesis (structured from your photo)

## Summary
Green plants convert light energy into chemical energy stored in glucose, releasing oxygen.

## Equation
\`6CO₂ + 6H₂O --light/chlorophyll--> C₆H₁₂O₆ + 6O₂\`

## Key concepts
- Chlorophyll absorbs mainly blue and red light; green light is reflected (why leaves look green).
- Stomata allow gas exchange and control water loss.
- Rate depends on light intensity, CO₂ concentration and temperature.

## Exam-style question
Why does the rate of photosynthesis stop increasing beyond a certain light intensity?`,
  },
];

async function seedNotes(userId: string): Promise<void> {
  for (const note of NOTES) {
    await createNote(userId, { ...note, source: note.tags.includes('uploaded') ? 'upload' : 'manual' });
  }
}

/** A believable week of study so Activity and the dashboard are not empty. */
async function seedActivity(userId: string): Promise<void> {
  const plan: Array<Parameters<typeof insertEvent>[0] extends never ? never : { d: number; kind: string; label: string; subject?: string; topic?: string; minutes?: number; correct?: number; total?: number }> = [
    { d: 6, kind: 'practice', label: 'Practised 8 questions on Laws of Motion', subject: 'Physics', topic: 'Laws of Motion', minutes: 22, correct: 6, total: 8 },
    { d: 5, kind: 'notes', label: 'Organised handwritten notes: Life Processes', subject: 'Biology', minutes: 14 },
    { d: 4, kind: 'tutor', label: 'Asked about photovoltaic cells and band gaps', subject: 'Physics', minutes: 11 },
    { d: 3, kind: 'exam', label: 'Completed Physics Mock Exam (10 questions)', subject: 'Physics', minutes: 30, correct: 7, total: 10 },
    { d: 3, kind: 'code', label: 'Ran a Python program: prime sieve', minutes: 18 },
    { d: 2, kind: 'practice', label: 'Practised 10 questions on Polynomials', subject: 'Mathematics', topic: 'Polynomials', minutes: 26, correct: 4, total: 10 },
    { d: 1, kind: 'tutor', label: 'Tutor session: revising photosynthesis', subject: 'Biology', minutes: 9 },
    { d: 0, kind: 'practice', label: 'Practised 6 questions on Trigonometry', subject: 'Mathematics', topic: 'Trigonometry', minutes: 17, correct: 3, total: 6 },
  ];

  for (const item of plan) {
    await insertEvent({
      userId,
      kind: item.kind,
      label: item.label,
      subject: item.subject,
      topic: item.topic,
      durationMs: (item.minutes ?? 10) * 60_000,
      correct: item.correct,
      total: item.total,
      createdAt: daysAgo(item.d),
    });
  }

  // Topic statistics — weights chosen so both weak and strong areas show up.
  const topics: Array<[string, string, number, number]> = [
    ['Physics', 'Laws of Motion', 8, 6],
    ['Physics', 'Work, Energy and Power', 6, 3],
    ['Physics', 'Units and Measurements', 5, 5],
    ['Mathematics', 'Polynomials', 10, 4],
    ['Mathematics', 'Trigonometry', 6, 3],
    ['Mathematics', 'Real Numbers', 5, 4],
    ['Biology', 'Life Processes', 7, 6],
    ['Biology', 'Control and Coordination', 6, 3],
    ['Chemistry', 'Chemical Reactions', 5, 4],
  ];

  for (const [subject, topic, attempted, correct] of topics) {
    for (let i = 0; i < attempted; i += 1) {
      await recordTopicResult({ userId, subject, topic, isCorrect: i < correct });
    }
  }
}

async function main(): Promise<void> {
  await migrate();
  const userId = await ensureUser();
  await ensureTeacher();
  await getSettings(userId);
  await resetDemoData(userId);
  await seedNotes(userId);
  await seedActivity(userId);
  const counts = await db.one<{ notes: number; events: number }>(
    `SELECT (SELECT COUNT(*) FROM notes WHERE user_id = ?) AS notes,
            (SELECT COUNT(*) FROM activity_events WHERE user_id = ?) AS events`,
    [userId, userId],
  );
  console.log(`[seed] demo student ready — ${EMAIL} / ${PASSWORD}`);
  console.log(`[seed] ${counts?.notes ?? 0} notes, ${counts?.events ?? 0} activity events, ${NOTES.length} structured note topics`);
  console.log(`[seed] teacher (Arena organiser) ready — ${TEACHER_EMAIL} / ${TEACHER_PASSWORD}`);
  console.log('[seed] sign in as the teacher to create a competition: Arena → "You run competitions here" → Create a competition');
}

await main();
process.exit(0);
