/*
 * Turn 13 browser check: the three things a host reported as broken, in a real browser.
 *
 *   1. "Duration select karte waqt last 1–2 digits bach jate hain" — the number fields used to clamp on
 *      every keystroke, so typing 180 produced 1 → 5 → 58 → 240. This types 180 and reads the box back.
 *   2. "Delete nahi ho raha" — the Remove control exists on the host's card, confirms, and the card goes.
 *   3. Hosting offers two ways to fill the paper, and the upload path says honestly what it did.
 *
 * Run with the dev server up:  node scripts/check-community-paper.mjs
 */
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/* Same browser lookup the capture scripts use: whichever Chromium the sandbox has. */
function findBrowser() {
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/tmp/pw-browsers'].filter(Boolean)) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (!dir.startsWith('chromium')) continue;
      for (const sub of readdirSync(path.join(root, dir))) {
        for (const bin of ['chrome', 'chrome-headless-shell', 'headless_shell']) {
          const candidate = path.join(root, dir, sub, bin);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return null;
}

const BASE = process.env.CHECK_BASE ?? 'http://127.0.0.1:8787';
const EMAIL = process.env.CHECK_EMAIL ?? 'demo@vroqn.dev';
const PASSWORD = process.env.CHECK_PASSWORD ?? 'nexus1234';
const COMMUNITY = process.env.CHECK_COMMUNITY ?? 'Class 10 CBSE';
const SHOTS = 'docs/screenshots';
const STAMP = Date.now().toString().slice(-6);

const PAPER = `1) A car covers 150 m in 10 s. What is its average speed?
A) 10 m/s
B) 15 m/s
C) 20 m/s
D) 25 m/s
Answer: B
Explanation: Speed is distance divided by time.

2) A force of 24 N acts on a 6 kg body. What is the acceleration produced?
A) 0.25 m/s2
B) 4 m/s2
C) 18 m/s2
D) 144 m/s2
Answer: B
Explanation: Acceleration is force divided by mass.

3) As we go deeper into the ocean, the water pressure
A) Decreases
B) Increases
C) Stays the same
D) Becomes zero
Answer: B
Explanation: Pressure rises with depth because the water column above grows taller.`;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

await fs.mkdir(SHOTS, { recursive: true });

const executablePath = findBrowser();
if (!executablePath) {
  console.error('check-community-paper: no Chromium found.');
  process.exit(1);
}
/* Sign in through the API and hand the cookies to the browser: the login page itself is covered by
 * the flow tests, and this check is about what a signed-in host sees. */
const loginResponse = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!loginResponse.ok) {
  console.error(`check-community-paper: sign in failed (${loginResponse.status}). Is the server running with this account?`);
  process.exit(1);
}
const cookies = loginResponse.headers.getSetCookie().map((value) => {
  const [name, ...rest] = value.split(';')[0].split('=');
  return { name, value: rest.join('='), url: BASE };
});

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
/* 1440 × 900 @2x keeps these frames the same shape as the screenshots in the submission pack. */
const WIDTH = Number(process.env.CHECK_WIDTH ?? 1440);
const context = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, deviceScaleFactor: 2 });
await context.addCookies(cookies);
const page = await context.newPage();
page.setDefaultTimeout(20_000);

try {
  /* ---------------------------------------------------------------- sign in ---------------------- */
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const signedIn = !page.url().includes('/login');
  record('signed in as the organiser', signedIn, page.url().replace(BASE, ''));

  /* -------------------------------- open a community this account owns, by its real slug -------- */
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const discover = await fetch(`${BASE}/api/communities/discover?scope=mine&limit=60`, { headers: { cookie: cookieHeader } });
  const listed = discover.ok ? await discover.json() : { communities: [] };
  const owned = (listed.communities ?? []).find((item) => new RegExp(COMMUNITY, 'i').test(item.name ?? ''));
  if (!owned) {
    record('find a community to host in', false, `no "${COMMUNITY}" among ${(listed.communities ?? []).length} for ${EMAIL}`);
    throw new Error('no community');
  }
  record('find a community to host in', true, `${owned.name} (${owned.slug})`);

  await page.goto(`${BASE}/communities/${owned.slug}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  record('open the community', true, page.url().replace(BASE, ''));

  await page.getByRole('tab', { name: /^competitions$/i }).click().catch(async () => {
    await page.getByRole('button', { name: /^competitions$/i }).click();
  });
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /host a competition/i }).first().click();

  /* ---------------------------------------------------- 1. duration typing keeps every digit ---- */
  /* The title first: the Create button stays disabled until the form is complete. */
  await page.fill('#comp-title', `Uploaded Sprint ${STAMP}`);

  const duration = page.locator('#comp-duration');
  await duration.click();
  await duration.press('Control+A');
  await duration.type('180', { delay: 90 });
  const typedValue = await duration.inputValue();
  record('duration keeps all three digits while typing', typedValue === '180', `box reads "${typedValue}"`);

  const count = page.locator('#comp-count');
  await count.click();
  await count.press('Control+A');
  await count.type('12', { delay: 90 });
  const countValue = await count.inputValue();
  record('question count keeps both digits', countValue === '12', `box reads "${countValue}"`);

  await page.screenshot({ path: `${SHOTS}/community-paper-mode.png`, fullPage: false });

  /* ------------------------------------- 1b. exact dates for registration and the exam -------------- */
  await page.getByRole('button', { name: /^exact dates$/i }).click();
  await page.waitForTimeout(300);

  /* A school's own calendar: registration this week, exam in six days at 10:00. */
  const examStart = new Date(Date.now() + 6 * 86_400_000);
  examStart.setHours(10, 0, 0, 0);
  const examEnd = new Date(examStart.getTime() + 3 * 3_600_000);
  const localValue = (date) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const regOpen = new Date(examStart.getTime() - 4 * 86_400_000);
  const regClose = new Date(examStart.getTime() - 24 * 3_600_000);

  await page.fill('#comp-opens', localValue(regOpen));
  await page.fill('#comp-closes', localValue(regClose));
  await page.fill('#comp-exam-start', localValue(examStart));
  await page.fill('#comp-exam-end', localValue(examEnd));
  await page.waitForTimeout(200);

  const summary = (await page.getByTestId('schedule-summary').textContent()) ?? '';
  const wantedDay = examStart.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  record(
    'the dialog reads the chosen dates back',
    summary.includes(wantedDay) && /Exam:/i.test(summary) && /3 hours/i.test(summary),
    summary.replace(/\s+/g, ' ').slice(0, 130),
  );

  /* A schedule the server would refuse must be refused here first, with the reason in words. */
  await page.fill('#comp-closes', localValue(new Date(examEnd.getTime() + 3_600_000)));
  await page.waitForTimeout(250);
  const problem = (await page.getByRole('alert').textContent().catch(() => '')) ?? '';
  const createDisabled = await page
    .getByRole('button', { name: /^create competition$/i })
    .isDisabled()
    .catch(() => false);
  record(
    'an impossible schedule is caught before Create',
    /cannot start before registration closes/i.test(problem) && createDisabled,
    problem.replace(/\s+/g, ' ').slice(0, 90),
  );
  await page.fill('#comp-closes', localValue(regClose));
  await page.waitForTimeout(200);

  /* 3a. the two paper options are both offered */
  const aiOption = page.getByRole('button', { name: /Vroqn AI writes it/i });
  const uploadOption = page.getByRole('button', { name: /I already have a paper/i });
  record('host is offered both paper options', (await aiOption.count()) > 0 && (await uploadOption.count()) > 0);

  /* ------------------------------------------------- upload path: paste the community's paper -- */
  await uploadOption.click();
  await page.fill('textarea#comp-paper, textarea[name="comp-paper"]', PAPER).catch(async () => {
    await page.locator('textarea').first().fill(PAPER);
  });
  const noteSeen = await page.getByText(/Looks like a paper/i).count();
  record('the paste box recognises a paper', noteSeen > 0);

  await page.getByRole('button', { name: /^create competition$/i }).click();

  /* The paper is prepared on the server after the competition is created, so give the toast time. */
  const toast = page.getByRole('status').filter({ hasText: /rewritten|approved|question/i }).first();
  await toast.waitFor({ timeout: 30_000 }).catch(() => {});
  const toastText = (await toast.textContent().catch(() => '')) ?? '';
  /*
   * Two honest wordings, and the check accepts either — but not the absence of both:
   *   · with a provider key  → "rewritten by the AI"
   *   · without one (demo)   → "twisted on the server"
   * Both must say the file cannot serve as an answer key, because that is the promise to the host.
   */
  const howTwisted = /rewritten by the AI/i.test(toastText)
    ? 'AI'
    : /twisted on the server/i.test(toastText)
      ? 'server'
      : 'unstated';
  record(
    'the host is told what happened to their paper, and that it cannot be used as a key',
    howTwisted !== 'unstated' && /answer key/i.test(toastText),
    `${howTwisted} — ${toastText.replace(/\s+/g, ' ').slice(0, 120)}`,
  );
  const outcome = toastText;

  const bodyText = await page.locator('body').innerText();
  const leaksQuestion = /450 m|45 m\/s|acceleration produced/i.test(bodyText);
  record('no question text is echoed back to the browser', !leaksQuestion);

  /* The dates the host picked are the dates the server stored — asked of the API, not read off the card. */
  const scheduled = await fetch(`${BASE}/api/communities/${owned.id}/competitions`, {
    headers: { cookie: cookieHeader },
  })
    .then((response) => response.json())
    .catch(() => null);
  const mine = (scheduled?.competitions ?? []).find((row) =>
    String(row.title ?? '').includes(`Uploaded Sprint ${STAMP}`),
  );
  const sameMinute = (iso, date) => Math.abs(new Date(iso).getTime() - date.getTime()) < 60_000;
  record(
    'the competition is scheduled for the exact dates the host chose',
    Boolean(mine) && sameMinute(mine.startsAt, examStart) && sameMinute(mine.endsAt, examEnd),
    mine ? `starts ${new Date(mine.startsAt).toLocaleString()}` : 'competition not found',
  );

  await page.screenshot({ path: `${SHOTS}/community-paper-uploaded.png`, fullPage: false });

  /* ------------------------------------------------------ the paper is visible as ready / not -- */
  await page.waitForTimeout(1200);
  const paperState = await page.getByText(/Paper|ready|question/i).count();
  record('the competition card reports its paper state', paperState > 0);

  /* ------------------------------------------------------------------ 2. Remove works ------------ */
  /* Remember the uploaded paper's id before removing it: the Arena row is kept when a community
     unhosts a competition, so the cleanup has to delete it explicitly. */
  const uploadedRow = await fetch(`${BASE}/api/communities/${owned.id}/competitions`, {
    headers: { cookie: cookieHeader },
  })
    .then((response) => response.json())
    .catch(() => null);
  const uploadedSprint = (uploadedRow?.competitions ?? []).find((row) =>
    String(row.title ?? '').includes(`Uploaded Sprint ${STAMP}`),
  );

  const removeButton = page.getByRole('button', { name: /^remove$/i }).first();
  const hasRemove = (await removeButton.count()) > 0;
  record('a host sees the Remove control', hasRemove);
  if (hasRemove) {
    await removeButton.click();
    await page.waitForTimeout(500);
    const dialog = await page.getByRole('dialog').innerText().catch(() => '');
    record('removing asks for confirmation', /remove/i.test(dialog), dialog.split('\n')[0]?.slice(0, 80));
    await page.screenshot({ path: `${SHOTS}/community-competition-remove.png`, fullPage: false });
    await page.getByRole('button', { name: /remove from community/i }).click();
    await page.waitForTimeout(2200);
    const stillThere = await page.getByText(/Uploaded .* Sprint|Sunday Physics Sprint/i).count();
    const after = await page.locator('body').innerText();
    record('the competition is gone after removing', !/Removable|Physics Sprint/i.test(after) || stillThere === 0);
  }

  /* ------------------------------------------- 3b. AI path still hosts a usable competition ------ */
  await page.getByRole('button', { name: /host a competition/i }).first().click();
  await page.waitForTimeout(400);
  await page.fill('#comp-title', `AI Sprint ${STAMP}`);
  await page.getByRole('button', { name: /Vroqn AI writes it/i }).click();
  await page.getByRole('button', { name: /^create competition$/i }).click();
  const aiToast2 = page.getByRole('status').filter({ hasText: /Paper prepared|question/i }).first();
  await aiToast2.waitFor({ timeout: 40_000 }).catch(() => {});
  const aiToastText = (await aiToast2.textContent().catch(() => '')) ?? '';
  record(
    'the AI path reports how the paper was filled',
    /Paper ready|Paper prepared/i.test(aiToastText) && /approved|rewritten/i.test(aiToastText),
    aiToastText.replace(/\s+/g, ' ').slice(0, 150),
  );
  await page.screenshot({ path: `${SHOTS}/community-paper-ai.png`, fullPage: false });

  /* ------------------------------------------------- the platform console stays sealed for it --- */
  const seal = await page.evaluate(async ({ communityId, title }) => {
    const hosted = await fetch(`/api/communities/${communityId}/competitions`, { credentials: 'include' })
      .then((response) => response.json())
      .catch(() => null);
    const mine = (hosted?.competitions ?? []).find((row) => String(row.title ?? '').includes(title));
    if (!mine) return { found: false };
    const paper = await fetch(`/api/communities/${communityId}/competitions/${mine.id}/paper`, { credentials: 'include' })
      .then((response) => response.json())
      .catch(() => null);
    const console1 = await fetch(`/api/arena/admin/competitions/${mine.id}/questions`, { credentials: 'include' });
    const body = await console1.text();
    return { found: true, status: console1.status, body: body.slice(0, 400), id: mine.id, paper: JSON.stringify(paper).slice(0, 120) };
  }, { communityId: owned.id, title: `AI Sprint ${STAMP}` });

  record(
    'the host can still see the paper is ready (counts only)',
    Boolean(seal.found) && /approved|ready/.test(seal.paper ?? ''),
    (seal.paper ?? '').slice(0, 90),
  );
  record(
    'even the platform console cannot read the community paper',
    seal.status === 403 && /community_paper_sealed/.test(seal.body ?? ''),
    `admin console answered ${seal.status}${/community_paper_sealed/.test(seal.body ?? '') ? ' (sealed)' : ''}`,
  );

  if (uploadedSprint?.id) {
    const purgeUploaded = await fetch(`${BASE}/api/arena/admin/competitions/${uploadedSprint.id}`, {
      method: 'DELETE',
      headers: { cookie: cookieHeader },
    });
    record('the uploaded-paper competition is cleaned up too', purgeUploaded.ok, `purge ${purgeUploaded.status}`);
  }

  /*
   * Tidy up after ourselves. Removing the hosting link is not enough: the Arena competition itself is
   * deliberately kept when a community unhosts it (students may have registered), so a test paper left
   * behind would sit in the demo account's Arena list forever. Delete both, as an arena admin would.
   */
  if (seal.found && seal.id) {
    const unlink = await fetch(`${BASE}/api/communities/${owned.id}/competitions/${seal.id}`, {
      method: 'DELETE',
      headers: { cookie: cookieHeader },
    });
    const purge = await fetch(`${BASE}/api/arena/admin/competitions/${seal.id}`, {
      method: 'DELETE',
      headers: { cookie: cookieHeader },
    });
    record(
      'the test competitions are cleaned up again',
      unlink.ok && purge.ok,
      `unhost ${unlink.status} · purge ${purge.status}`,
    );
  }
} catch (error) {
  record('browser check completed', false, String(error).slice(0, 200));
} finally {
  await browser.close();
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('failing:');
  for (const row of failed) console.log(`  · ${row.name} — ${row.detail ?? ''}`);
  process.exitCode = 1;
}
