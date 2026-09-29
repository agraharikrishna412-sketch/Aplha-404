/**
 * Who can host a competition right now?
 *
 *   npm run who:admin
 *
 * Two kinds of account can, and this lists both:
 *   1. accounts flagged in the database (what `npm run make:admin` writes), and
 *   2. addresses listed in ARENA_ADMIN_EMAILS, which the running server also honours.
 *
 * The second list can only be read from the environment this command runs in — if you set the allowlist
 * on your server and run this elsewhere, it will not see it. The server always has the last word.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

function loadDatabase() {
  for (const from of [import.meta.url, path.join(process.cwd(), 'server', 'package.json')]) {
    try {
      return createRequire(from)('better-sqlite3');
    } catch {
      /* try the next one */
    }
  }
  console.error('[who:admin] better-sqlite3 was not found — run `npm install` at the repo root first.');
  process.exit(1);
}
const Database = loadDatabase();

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'server/.data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'vroqn-nexus.db');
if (!fs.existsSync(dbPath)) {
  console.error(`[who:admin] no database at ${dbPath} — start the server once first.`);
  process.exit(1);
}

const allowlist = (process.env.ARENA_ADMIN_EMAILS ?? '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

const db = new Database(dbPath, { readonly: true });
const flagged = db.prepare("SELECT email, name FROM users WHERE role = 'admin' ORDER BY email").all();

console.log(`[who:admin] database: ${dbPath}`);
if (flagged.length) {
  console.log('[who:admin] organisers flagged in the database (npm run make:admin):');
  for (const row of flagged) console.log(`  · ${row.name} <${row.email}>`);
} else {
  console.log('[who:admin] no account is flagged in the database.');
}
if (allowlist.length) {
  console.log('[who:admin] ARENA_ADMIN_EMAILS in this shell:');
  for (const email of allowlist) console.log(`  · ${email}`);
} else {
  console.log('[who:admin] ARENA_ADMIN_EMAILS is not set in this shell.');
  console.log('[who:admin] (if your server was started with it, those addresses are organisers too —');
  console.log('[who:admin]  check the environment that server runs in.)');
}
if (!flagged.length && !allowlist.length) {
  console.log('[who:admin] nobody can host a competition yet. For example:');
  console.log('[who:admin]   npm run make:admin -- you@example.com');
}
db.close();
