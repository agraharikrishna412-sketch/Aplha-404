/**
 * Makes an account an Arena organiser (staff), so it can schedule competitions.
 *
 *   npm run make:admin -- you@example.com
 *
 * Why this exists: creating a competition lives on `/arena/admin`, which the server only serves to
 * accounts flagged as staff. Without a way to flag one, a fresh deployment has no path from "I want to
 * run a competition" to actually running one — which is exactly the confusion this script removes.
 *
 * Two ways to become an organiser, both supported:
 *   1. this script (writes the flag to the database, survives restarts), or
 *   2. ARENA_ADMIN_EMAILS=you@example.com in the environment (a bootstrap path for hosted deploys
 *      where you would rather not touch the database).
 *
 * The flag is intentionally *not* grantable from inside the app: nothing a student can reach may hand
 * itself the power to publish exams.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

/*
 * `better-sqlite3` belongs to the server workspace, so depending on how npm hoisted the tree a root-level
 * script may or may not resolve it. Try the repo root, then the server package, and only then give up —
 * with a message that says what to do.
 */
function loadDatabase() {
  const tries = [import.meta.url, path.join(process.cwd(), 'server', 'package.json')];
  for (const from of tries) {
    try {
      return createRequire(from)('better-sqlite3');
    } catch {
      /* try the next one */
    }
  }
  console.error('[make:admin] better-sqlite3 was not found — run `npm install` at the repo root first.');
  process.exit(1);
}
const Database = loadDatabase();

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!email) {
  console.error('usage: npm run make:admin -- <email>');
  console.error('example: npm run make:admin -- demo@vroqn.dev');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'server/.data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'vroqn-nexus.db');
if (!fs.existsSync(dbPath)) {
  console.error(`[make:admin] no database at ${dbPath} — start the server once (or run the seeder) first.`);
  process.exit(1);
}

const db = new Database(dbPath);
const row = db.prepare('SELECT id, email, name, role FROM users WHERE lower(email) = ?').get(email);
if (!row) {
  const known = db.prepare('SELECT email FROM users ORDER BY created_at LIMIT 12').all().map((entry) => entry.email);
  console.error(`[make:admin] no account with the email ${email}.`);
  if (known.length) console.error(`            known accounts: ${known.join(', ')}`);
  process.exit(1);
}

if (row.role === 'admin') {
  console.log(`[make:admin] ${row.email} is already an organiser — nothing to do.`);
  process.exit(0);
}

db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run('admin', new Date().toISOString(), row.id);
console.log(`[make:admin] ${row.name} <${row.email}> can now schedule competitions.`);
console.log('[make:admin] sign out and back in (the role is read from the session), then open Arena →');
console.log('[make:admin] "Schedule an Arena competition" appears at the top of the page, or use the');
console.log('[make:admin] "Paper review" entry in the menu.');
console.log('[make:admin] to undo: npm run make:student -- ' + row.email);
db.close();
