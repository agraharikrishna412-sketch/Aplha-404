/**
 * "Competition banti kaise hai?" — answered by driving the whole path in a real browser.
 *
 * The question this replaces is a legitimate one, because creating a competition is a *staff* action
 * while everything else in Arena is a student action. This check walks the exact route a human takes:
 *
 *   1. a brand-new account signs up and is, correctly, only a student (no console, no organiser panel)
 *   2. `npm run make:admin -- <email>` — the documented command — grants the flag
 *   3. Arena now says "You run competitions here", with a button that opens the real create dialog
 *   4. the dialog schedules a competition, and the console lists it as a draft
 *   5. a *student* still cannot see or register for that draft — publishing is a separate decision
 *   6. `npm run make:student -- <email>` takes the console away again
 *
 * OPTIONAL, like the other browser scripts: it needs playwright-core and a Chromium build, is not part
 * of `npm test`, and exits 0 with a note when no browser is installed.
 *
 *   npm i --no-save playwright-core
 *   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers node scripts/arena-organiser-check.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BROWSER_BASE ?? 'http://127.0.0.1:8787';
/* A note on accounts: this check never touches the seeded demo account. It creates its own organiser and
   its own student, and deletes both, so it can be re-run against a live workspace without side effects. */

let pass = 0;
const findings = [];
function check(name, ok, detail = '') {
  const line = `${name}${detail ? `  ${detail}` : ''}`;
  if (ok) {
    pass += 1;
    console.log(`  ok   ${line}`);
  } else {
    findings.push(line);
    console.log(`  FAIL ${line}`);
  }
}

function findBrowser() {
  if (process.env.BROWSER_PATH) return existsSync(process.env.BROWSER_PATH) ? process.env.BROWSER_PATH : null;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/tmp/pw-browsers', path.join(process.cwd(), '.pw-browsers')].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (!dir.startsWith('chromium')) continue;
      for (const sub of readdirSync(path.join(root, dir))) {
        for (const bin of ['chrome-headless-shell', 'headless_shell', 'chrome']) {
          const candidate = path.join(root, dir, sub, bin);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return null;
}

const executablePath = findBrowser();
if (!executablePath) {
  console.log('arena-organiser-check: no Chromium found — skipping (install playwright-core + a browser to run it).');
  process.exit(0);
}
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.log('arena-organiser-check: playwright-core is not installed — skipping.');
  process.exit(0);
}

/** The documented commands, run exactly as an operator would run them. */
function runScript(script, email) {
  return execFileSync(process.execPath, [path.join(ROOT, 'scripts', script), email], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: process.env.DATA_DIR ?? path.join(ROOT, 'server', '.data') },
  });
}

/** Removes the throwaway competition afterwards: a check must not leave litter in the demo console. */
function removeCompetition(id) {
  /* Child-side, child-by-child: `arena_performance_reports` hangs off the attempt, not the
     competition, and a table that does not exist yet must not abort the cleanup of the ones that do. */
  const childSql = `
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1]);
    const statements = [
      "DELETE FROM arena_answers WHERE attempt_id IN (SELECT id FROM arena_attempts WHERE competition_id = ?)",
      "DELETE FROM arena_performance_reports WHERE attempt_id IN (SELECT id FROM arena_attempts WHERE competition_id = ?)",
      "DELETE FROM arena_results WHERE competition_id = ?",
      "DELETE FROM arena_attempts WHERE competition_id = ?",
      "DELETE FROM arena_registrations WHERE competition_id = ?",
      "DELETE FROM arena_questions WHERE competition_id = ?",
      "DELETE FROM arena_competitions WHERE id = ?",
    ];
    for (const sql of statements) {
      try { db.prepare(sql).run(process.argv[3]); } catch (error) { console.error('skip:', error.message.split('\\n')[0]); }
    }
  `;
  try {
    execFileSync(process.execPath, [
      '-e',
      childSql,
      path.join(process.env.DATA_DIR ?? path.join(ROOT, 'server', '.data'), 'vroqn-nexus.db'),
      id,
    ], { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch (error) {
    console.log(`  note: could not remove the throwaway competition (${error.message.split('\n')[0]})`);
    return false;
  }
}

async function api(method, url, body, cookie) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, setCookie: response.headers.getSetCookie?.() ?? [] };
}

/** Session cookies → the shape `context.addCookies` wants. */
function cookieJar(setCookie) {
  return setCookie.map((value) => {
    const [name, ...rest] = value.split(';')[0].split('=');
    return { name, value: rest.join('='), url: BASE };
  });
}

const stamp = Date.now();
const organiser = {
  name: 'Organiser Check',
  email: `organiser-check-${stamp}@vroqn.dev`,
  password: 'organiser1234',
};
let createdId = null;

const instance = await chromium.launch({ executablePath, args: ['--no-sandbox'] });

try {
  console.log('\nArena organiser path\n');

  /* 1 — a new account is a student, and the student view explains itself instead of dead-ending. */
  const signup = await api('POST', '/api/auth/signup', {
    name: organiser.name,
    email: organiser.email,
    password: organiser.password,
    classLevel: 'Class 11',
    board: 'CBSE',
  });
  check('a new account can sign up', [200, 201].includes(signup.status), `HTTP ${signup.status}`);

  const organiserCookie = signup.setCookie.map((value) => value.split(';')[0]).join('; ');
  const denied = await api('GET', '/api/arena/admin/competitions', undefined, organiserCookie);
  check('a fresh account is refused by the console API', denied.status === 403, `HTTP ${denied.status}`);

  /*
   * The student walk-through gets its own account rather than borrowing the demo one. The seeded demo
   * account is an organiser (seed.ts writes the flag so a fresh workspace can demonstrate hosting at
   * all), so it is exactly the wrong witness for "what does a student who cannot organise see?".
   */
  const student = { name: 'Student Check', email: `student-check-${stamp}@vroqn.dev`, password: 'student1234' };
  const studentSignup = await api('POST', '/api/auth/signup', {
    name: student.name,
    email: student.email,
    password: student.password,
    classLevel: 'Class 10',
    board: 'CBSE',
  });
  check('a second account signs up as a plain student', [200, 201].includes(studentSignup.status), `HTTP ${studentSignup.status}`);
  const studentCookie = studentSignup.setCookie.map((value) => value.split(';')[0]).join('; ');

  const studentContext = await instance.newContext({ viewport: { width: 1280, height: 900 } });
  await studentContext.addCookies(cookieJar(studentSignup.setCookie));
  const studentPage = await studentContext.newPage();
  await studentPage.goto(`${BASE}/arena`, { waitUntil: 'domcontentloaded' });
  await studentPage.waitForTimeout(1800);
  const studentText = (await studentPage.locator('body').innerText()).replace(/\s+/g, ' ');
  check('Arena explains how competitions are created', /How competitions are created/i.test(studentText));
  await studentPage.getByText(/How competitions are created/i).first().click();
  await studentPage.waitForTimeout(400);
  const expanded = (await studentPage.locator('body').innerText()).replace(/\s+/g, ' ');
  check('the explanation names the organiser step', /organiser writes the paper/i.test(expanded));
  check('the explanation names registration', /you register while it is open/i.test(expanded));
  check('the explanation names results', /leaderboard|results/i.test(expanded));
  await studentContext.close();

  /* 2 — the documented command. */
  const output = runScript('make-admin.mjs', organiser.email);
  check('npm run make:admin grants the flag', /can now schedule competitions/.test(output));
  const promoted = await api('GET', '/api/arena/admin/competitions', undefined, organiserCookie);
  check('the promoted account reaches the console API', promoted.status === 200, `HTTP ${promoted.status}`);

  /* 3 — the organiser's own Arena shows the panel, and the button opens the real dialog. */
  const organiserContext = await instance.newContext({ viewport: { width: 1280, height: 900 } });
  await organiserContext.addCookies(cookieJar(signup.setCookie));
  const page = await organiserContext.newPage();
  await page.goto(`${BASE}/arena`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const organiserText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  check('Arena greets an organiser with the create panel', /You run competitions here/i.test(organiserText));
  check('the panel promises the three-step flow', /name the paper, add questions, then open registration/i.test(organiserText));

  await page.getByRole('link', { name: /Create a competition/i }).first().click();
  await page.waitForURL(/\/arena\/admin/, { timeout: 10000 }).catch(() => undefined);
  check('the button lands on the Arena console', page.url().includes('/arena/admin'), page.url().replace(BASE, ''));
  await page.waitForTimeout(1200);
  const dialog = page.getByRole('dialog');
  const dialogShown = await dialog.isVisible().catch(() => false);
  check('?create=1 opens the create dialog directly', dialogShown);
  const consoleText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  check('the console spells out the order of work', /Creating a competition, in order/i.test(consoleText));
  check('the console names the review step', /Generate, then review/i.test(consoleText));

  /* 4 — actually schedule one, through the dialog. */
  if (dialogShown) {
    await dialog.getByLabel(/Title/i).first().fill('Organiser Check Paper');
    await dialog.getByLabel(/Description/i).first().fill('Scheduled by the organiser check to prove the path works end to end.');
    await dialog.getByRole('button', { name: /^(Schedule|Create|Save)/i }).first().click();
    await page.waitForTimeout(2500);
    const after = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    check('the new competition appears in the console', /Organiser Check Paper/.test(after));

    const list = await api('GET', '/api/arena/admin/competitions', undefined, organiserCookie);
    const match = (list.body?.competitions ?? []).find((entry) => entry.title === 'Organiser Check Paper');
    createdId = match?.id ?? null;
    check('the server stored it as a draft', Boolean(match), match ? `status ${match.status}, state ${match.state}` : 'not found');
  }

  /* 5 — a draft is invisible to students: scheduling and publishing are different decisions. */
  const catalog = await api('GET', '/api/arena/competitions', undefined, studentCookie);
  const leaked = (catalog.body?.competitions ?? []).some((entry) => entry.id === createdId);
  check('a draft never reaches the student catalog', createdId !== null && !leaked, `catalog has ${catalog.body?.competitions?.length ?? 0} competitions`);

  /* 6 — and the flag comes off again. */
  runScript('make-student.mjs', organiser.email);
  const revoked = await api('GET', '/api/arena/admin/competitions', undefined, organiserCookie);
  check('npm run make:student revokes it', revoked.status === 403, `HTTP ${revoked.status}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.goto(`${BASE}/arena`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  const studentAgain = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  check('the create panel is gone once the flag is off', !/You run competitions here/i.test(studentAgain));
  await organiserContext.close();

  /* 7 — put the workspace back exactly as it was found. The throwaway account deletes itself through
     the real route, which also removes its solo draft paper; the extra cleanup below is a fallback
     for the case where that fails. */
  const before = await api('GET', '/api/auth/deletion-preview', undefined, organiserCookie);
  const preview = before.body ?? {};
  check(
    'the throwaway account is deletable',
    before.status === 200 && Array.isArray(preview.blocking) && preview.blocking.length === 0,
    JSON.stringify(preview).slice(0, 140),
  );
  check('its solo draft paper is listed as deletable with it', Array.isArray(preview.arenaSolo));
  const wiped = await api('POST', '/api/auth/delete-account', { password: organiser.password, confirm: 'DELETE' }, organiserCookie);
  check('the organiser account removes itself', [200, 201].includes(wiped.status), `HTTP ${wiped.status}`);
  if ([200, 201].includes(wiped.status)) createdId = null;

  const studentBefore = await api('GET', '/api/auth/deletion-preview', undefined, studentCookie);
  const studentPreview = studentBefore.body ?? {};
  check(
    'the student account is deletable too',
    studentBefore.status === 200 && Array.isArray(studentPreview.blocking) && studentPreview.blocking.length === 0,
    JSON.stringify(studentPreview).slice(0, 120),
  );
  const studentWiped = await api(
    'POST',
    '/api/auth/delete-account',
    { password: student.password, confirm: 'DELETE' },
    studentCookie,
  );
  check('the student account removes itself', [200, 201].includes(studentWiped.status), `HTTP ${studentWiped.status}`);
} catch (error) {
  findings.push(`unexpected failure — ${error.message}`);
  console.log(`  FAIL unexpected failure — ${error.message}`);
} finally {
  await instance.close();
  if (createdId) {
    const removed = removeCompetition(createdId);
    if (removed) console.log('  note: throwaway competition removed from the demo database');
  }
}

console.log(`\narena-organiser-check: ${pass} passed, ${findings.length} failed`);
if (findings.length) {
  console.log(findings.map((line) => `  - ${line}`).join('\n'));
  process.exit(1);
}
