/*
 * The smoke, flow and browser checks create communities on the live database. They are soft-deleted
 * when the check finishes, so they never show in the UI, but the rows (and their members/messages)
 * stay behind — 148 of them by the time this was written. This is the janitor for that pile.
 *
 * This removes them through the app's own deleteCommunity service, so every dependent row (members,
 * messages, events, hosted competitions, invites, badges) is cleaned the same way the UI cleans it.
 * Dry run by default:  node scripts/clean-probe-communities.mjs          → list
 *                      node scripts/clean-probe-communities.mjs --apply  → delete
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DATA_DIR ??= path.join(here, '..', 'server', '.data');

const { all, one, getDb } = await import('../server/src/db/index.ts');
await getDb();

const { deleteCommunity } = await import('../server/src/services/communities/communities.ts');

const JUNK = /(Circle$|Handover Circle|^Zylo|^Browser Circle|^Smoke Physics|^Probe|^Prob|^Repr|^Escalation Probe|^Join Probe|^Err Probe|^Tr[a-z0-9]{4,6}\b|^comm-|^Invite Only Waves|^Private Cells|^Quantum Circle)/;
const KEEP = /^(JEE Practice|Mathematics Doubts|NEET Biology|Class 10 CBSE|Code Club)$/;

const apply = process.argv.includes('--apply');
const rows = await all(
  `SELECT c.id, c.name, m.user_id AS owner_id,
     (SELECT COUNT(*) FROM community_members x WHERE x.community_id = c.id) AS members
   FROM communities c
   JOIN community_members m ON m.community_id = c.id AND m.role = 'owner'
   ORDER BY c.created_at`,
);

const targets = rows.filter((row) => !KEEP.test(row.name) && JUNK.test(row.name));
console.log(`${rows.length} communities · ${targets.length} look like check leftovers · ${rows.length - targets.length} kept`);
if (!apply) {
  for (const row of targets.slice(0, 6)) console.log(`  would remove  ${row.name}  (${row.members} members)`);
  console.log(`  … and ${Math.max(0, targets.length - 6)} more. Re-run with --apply to delete.`);
  process.exit(0);
}

let removed = 0;
const failed = [];
for (const row of targets) {
  try {
    await deleteCommunity(row.owner_id, row.id);
    removed += 1;
  } catch (error) {
    failed.push(`${row.name}: ${String(error).slice(0, 90)}`);
  }
}
const left = await one('SELECT COUNT(*) AS n FROM communities');
console.log(`removed ${removed}/${targets.length} · communities left: ${left?.n}`);
if (failed.length) {
  console.log('could not remove:');
  for (const line of failed.slice(0, 10)) console.log(`  · ${line}`);
}
