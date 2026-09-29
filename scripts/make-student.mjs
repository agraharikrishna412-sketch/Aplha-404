/**
 * Takes the Arena organiser flag back off an account.
 *
 *   npm run make:student -- you@example.com
 *
 * The mirror of `make:admin`, and it exists for the same reason: a permission you can grant but not
 * revoke is a permission you cannot try out safely.
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
  console.error('[make:student] better-sqlite3 was not found — run `npm install` at the repo root first.');
  process.exit(1);
}
const Database = loadDatabase();

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!email) {
  console.error('usage: npm run make:student -- <email>');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'server/.data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'vroqn-nexus.db');
if (!fs.existsSync(dbPath)) {
  console.error(`[make:student] no database at ${dbPath}.`);
  process.exit(1);
}

const db = new Database(dbPath);
const row = db.prepare('SELECT id, email, role FROM users WHERE lower(email) = ?').get(email);
if (!row) {
  console.error(`[make:student] no account with the email ${email}.`);
  process.exit(1);
}
db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run('student', new Date().toISOString(), row.id);
console.log(`[make:student] ${row.email} is a student account again.`);
db.close();
