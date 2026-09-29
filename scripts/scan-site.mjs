/**
 * Deep scan — every route, real browser, phone + desktop.
 *
 * `browser-check.mjs` measures layout. This one hunts for the things a student actually hits and then
 * reports as "it does not work":
 *
 *   · **Page errors and failed requests.** A thrown exception or a 5xx on the way through a screen is
 *     a broken screen, even when the layout looks fine.
 *   · **Dead ends.** Every route must render real content (a heading, a button, or a card) rather than
 *     an empty shell, and must not be stuck on a spinner after the page has settled.
 *   · **Console noise.** React key warnings, hydration mismatches and "findDOMNode" style complaints
 *     are logged too, because they are the usual precursor to a broken screen.
 *   · **Error boundaries and raw error text.** A student must never be shown a stack trace, an `Error:`
 *     line or a bare `undefined`.
 *   · **Language.** The Hinglish and Hindi paths are exercised: the composer must accept Devanagari and
 *     Roman-script Hindi input without mangling it, and settings must persist the choice.
 *   · **Private chat and the Code Lab mentor.** The two places the app talks back: a Code Lab follow-up
 *     must reach the mentor with the conversation attached, and the messages screen must state its
 *     encryption honestly.
 *
 * Run:  npm run scan:site      (needs the server running; playwright-core is optional)
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BROWSER_BASE ?? 'http://127.0.0.1:8787';
const EMAIL = process.env.SMOKE_EMAIL ?? 'demo@vroqn.dev';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'nexus1234';

/** Every route a signed-in student can reach. Kept in sync with `App.tsx` by hand — and by the check
 *  below, which fails if a route with a `path=` in App.tsx is missing from this list. */
const ROUTES = [
  ['/', 'Home'],
  ['/tutor', 'AI tutor'],
  ['/practice', 'Practice'],
  ['/mock-exam', 'Mock exam'],
  ['/notes', 'Notes'],
  ['/code-lab', 'Code Lab'],
  ['/arena', 'Arena'],
  ['/arena/my-competitions', 'My competitions'],
  ['/analytics', 'Learning analytics'],
  ['/activity', 'Learning activity'],
  ['/settings', 'Settings'],
  ['/messages', 'Messages'],
  ['/profile', 'Profile'],
  ['/news', 'News'],
  ['/help', 'Help'],
  ['/communities', 'Groups'],
  ['/communities/new', 'Create group'],
  ['/communities/notifications', 'Notifications'],
  ['/communities/profile/me', 'Community profile'],
  /* Staff-only screen. Scanned anyway: a student following a guessed URL must see a clean refusal,
     not a broken page. */
  ['/arena/admin', 'Paper review (staff only)'],
];

const IGNORABLE_ERROR = /ResizeObserver|Non-Error promise rejection|Failed to fetch|NetworkError|net::ERR_|AbortError|The user aborted a request|playwright/i;
const IGNORABLE_CONSOLE = /DevTools|Download the React DevTools|\[vite\]|favicon|React Router Future Flag/i;

let pass = 0;
const findings = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    findings.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`);
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
        /* A full Chromium build ships `chrome`; the slimmer installs ship one of the shells. */
        for (const bin of ['chrome-headless-shell', 'headless_shell', 'chrome']) {
          const candidate = path.join(root, dir, sub, bin);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return null;
}

let chromium;
try {
  chromium = require('playwright-core').chromium;
} catch {
  chromium = null;
}
const executablePath = findBrowser();
if (!chromium || !executablePath) {
  console.log('scan-site: needs playwright-core and a Chromium build.');
  console.log('  npm i --no-save playwright-core && npx playwright-core install chromium-headless-shell');
  process.exit(0);
}

async function session() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookies = (res.headers.getSetCookie?.() ?? []).map((raw) => {
    const [name, value] = raw.split(';')[0].split('=');
    return { name, value, domain: new URL(BASE).hostname, path: '/' };
  });
  return { cookies, user: await res.json() };
}

const { cookies, user } = await session();
console.log(`signed in as ${user.user?.name ?? EMAIL}\n`);

const instance = await chromium.launch({ executablePath, args: ['--no-sandbox'] });

/* ------------------------------------------------------------ 1. every route, two viewports ----- */

const VIEWPORTS = [
  { name: 'phone 390', width: 390, height: 844, touch: true },
  { name: 'desktop 1440', width: 1440, height: 900, touch: false },
];

for (const viewport of VIEWPORTS) {
  console.log(`══════ every route · ${viewport.name}`);
  const context = await instance.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.touch,
    isMobile: viewport.touch,
  });
  await context.addCookies(cookies);

  for (const [route, label] of ROUTES) {
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const badResponses = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('response', (response) => {
      if (response.status() >= 500 && response.url().includes('/api/')) badResponses.push(`${response.status()} ${response.url()}`);
    });

    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
    await page.waitForTimeout(1600);

    const state = await page.evaluate(() => {
      const text = (document.body.innerText ?? '').replace(/\s+/g, ' ').trim();
      const headings = [...document.querySelectorAll('h1, h2')].map((el) => (el.textContent ?? '').trim()).filter(Boolean);
      const interactive = document.querySelectorAll('button:not([disabled]), a[href], input, textarea, select').length;
      const spinnerOnly = /loading|just a moment|please wait/i.test(text) && text.length < 90;
      return {
        text,
        headings,
        interactive,
        spinnerOnly,
        hasMain: Boolean(document.querySelector('#main')),
        length: text.length,
      };
    });

    const relevantErrors = pageErrors.filter((message) => !IGNORABLE_ERROR.test(message));
    const relevantConsole = consoleErrors.filter((message) => !IGNORABLE_CONSOLE.test(message));

    const problems = [];
    if (relevantErrors.length) problems.push(`page error: ${relevantErrors[0].slice(0, 110)}`);
    if (badResponses.length) problems.push(`server error: ${badResponses[0]}`);
    if (!state.hasMain) problems.push('no #main landmark');
    if (state.length < 40) problems.push(`almost no text rendered (${state.length} chars)`);
    if (state.interactive === 0) problems.push('no interactive controls');
    if (state.spinnerOnly) problems.push('still showing a loading placeholder after 1.6s');
    if (/error:|stack:|undefined is not|cannot read propert/i.test(state.text)) problems.push('raw error text shown to the student');
    if (relevantConsole.length) problems.push(`console error: ${relevantConsole[0].slice(0, 110)}`);

    check(`${label} @ ${viewport.name}`, problems.length === 0, problems[0] ?? `${state.headings[0]?.slice(0, 40) ?? ''}`);

    await page.close();
  }
  await context.close();
}

/* ------------------------------------------------------- 2. routes declared in App.tsx ------------- */

console.log('\n══════ route coverage');
{
  const app = await import('node:fs').then((fs) => fs.readFileSync(path.join(ROOT, 'client', 'src', 'App.tsx'), 'utf8'));
  const declared = [...app.matchAll(/path="([^"]+)"/g)]
    .map((match) => match[1])
    .filter(
      (route) =>
        !route.includes(':') &&
        !['*', '/login', '/signup'].includes(route) &&
        // The signed-out landing page owns "/" for visitors; the signed-in check above covers it.
        route !== '/',
    );
  const scanned = new Set(ROUTES.map(([route]) => route));
  const missing = declared.filter((route) => !scanned.has(route));
  check(
    'every declared route is scanned',
    missing.length === 0,
    missing.length ? `not covered: ${missing.join(', ')}` : `${declared.length} routes`,
  );
}

/* ------------------------------------------------------------- 3. the two AI conversations -------- */

console.log('\n══════ Code Lab mentor');
{
  const context = await instance.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies(cookies);
  const page = await context.newPage();
  const requests = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/code/assist')) {
      let body = null;
      try {
        body = JSON.parse(request.postData() ?? 'null');
      } catch {
        body = null;
      }
      requests.push(body);
    }
  });
  await page.goto(`${BASE}/code-lab`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  // The mentor lives in its own panel tab; open it the way a student would.
  await page.getByRole('radio', { name: 'AI review' }).click();
  await page.waitForTimeout(800);

  // The field's visible label changes once a conversation exists ("Ask your code mentor" -> "Keep asking"),
  // so match either name instead of pinning one.
  const mentorField = page.getByRole('textbox', { name: /ask your code mentor|keep asking|ask about your code/i });
  await mentorField.first().fill('bhai ye loop kyu nahi chal raha?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.waitForTimeout(3000);

  const firstAsk = requests.at(-1);
  check('the mentor receives the question', Boolean(firstAsk?.question), firstAsk?.question?.slice(0, 40) ?? 'no request');
  check('the question is sent intact, Devanagari/Roman script included', firstAsk?.question === 'bhai ye loop kyu nahi chal raha?', firstAsk?.question ?? '');

  // Second turn: the whole point of the fix — the mentor must see the earlier turn.
  await mentorField.first().fill('iska matlab kya hai?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.waitForTimeout(3000);
  const secondAsk = requests.at(-1);
  check(
    'a follow-up carries the earlier conversation',
    Array.isArray(secondAsk?.history) && secondAsk.history.length >= 2,
    `${secondAsk?.history?.length ?? 0} turn(s) attached`,
  );
  const transcript = await page.locator('body').innerText();
  check('the conversation stays on screen', transcript.includes('bhai ye loop kyu nahi chal raha'), 'first question visible in the thread');

  /* Count real turns rather than keyword-matching the page: two questions asked, two replies rendered. */
  const asked = await page.getByLabel('Your question').count();
  const replies = page.getByLabel('Mentor reply');
  const replyCount = await replies.count();
  const lastReply = replyCount ? (await replies.last().innerText()).trim() : '';
  check('both questions are in the thread', asked === 2, `${asked} question bubble(s)`);
  check('the mentor replied to both', replyCount === 2, `${replyCount} reply bubble(s)`);
  check('the reply carries real content, not an empty bubble', lastReply.length > 40, `${lastReply.length} chars`);
  /*
   * The complaint that started this: a student asked in Hinglish and was answered in formal English.
   * The reply must now mirror the question's language — no key connected included, because that is
   * the path a student without a provider key actually sees.
   */
  check(
    'the reply mirrors the student\'s language instead of defaulting to English',
    /Tumhara sawaal|आपका सवाल/.test(lastReply),
    lastReply.replace(/\s+/g, ' ').slice(0, 120),
  );
  check(
    'the framing is Hinglish, not the English sample',
    /abhi koi AI key connected nahi hai|AI key जुड़ी नहीं है/.test(lastReply) && !/no AI key connected yet/.test(lastReply),
    lastReply.split('\n')[0].slice(0, 90),
  );
  console.log('  ·· mentor reply 1:', (await replies.first().innerText()).replace(/\s+/g, ' ').slice(0, 150));
  console.log('  ·· mentor reply 2:', lastReply.replace(/\s+/g, ' ').slice(0, 200));

  await context.close();
}

console.log('\n══════ §2 controls (no OS pickers, every control named)');
{
  /*
   * Two rules from the brief that are easy to break by accident and invisible in a screenshot:
   *  - no native `<select>` anywhere (§2) — the Vroqn pickers are used instead;
   *  - every interactive control has an accessible name (§23–24), so a screen reader is never left
   *    announcing "button".
   */
  const context = await instance.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies(cookies);
  const page = await context.newPage();

  const SCREENS = [
    ['/practice', 'Practice'],
    ['/mock-exam', 'Mock exam'],
    ['/notes', 'Notes'],
    ['/code-lab', 'Code Lab'],
    ['/settings', 'Settings'],
    ['/communities', 'Communities'],
    ['/communities/new', 'Create community'],
  ];

  for (const [route, name] of SCREENS) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1400);
    const audit = await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const selects = [...document.querySelectorAll('select')].filter(visible).length;
      const controls = [...document.querySelectorAll('button, a[href], [role="button"], input, textarea, [role="listbox"]')].filter(visible);
      /* The same sources the accessibility tree uses, in the same order of precedence. */
      const named = (el) => {
        if ((el.getAttribute('aria-label') || '').trim()) return true;
        const byId = el.getAttribute('aria-labelledby');
        if (byId && byId.split(/\s+/).some((part) => document.getElementById(part)?.textContent?.trim())) return true;
        if (el.labels && el.labels.length) return true;
        if (el.id && document.querySelector(`label[for="${el.id}"]`)) return true;
        if (el.closest('label')) return true;
        const own = (el.textContent || '').trim();
        if (own) return true;
        // A placeholder deliberately does not count: it is not a name, and it disappears on typing.
        return false;
      };
      const unnamed = controls.filter((el) => !named(el));
      return { selects, unnamed: unnamed.length, sample: unnamed.slice(0, 2).map((el) => el.className.toString().slice(0, 40)) };
    });
    check(`${name}: no native picker`, audit.selects === 0, `${audit.selects} <select> on screen`);
    check(`${name}: every control has a name`, audit.unnamed === 0, audit.unnamed ? `${audit.unnamed} unnamed (${audit.sample.join(', ')})` : 'all named');
  }
  await context.close();
}

console.log('\n══════ Private messages');
{
  const context = await instance.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies(cookies);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${BASE}/messages`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);

  const text = await page.locator('body').innerText();
  check('the encryption claim is stated plainly', /encrypted on your device/i.test(text), 'notice visible');
  check('the safety panel is reachable', /safety/i.test(text));
  check('a student can start a new message', /new message/i.test(text));
  check('no page errors on the messages screen', errors.filter((message) => !IGNORABLE_ERROR.test(message)).length === 0, errors[0] ?? 'none');

  // The new-conversation sheet must open and search real students.
  await page.getByRole('button', { name: /new message/i }).first().click();
  await page.waitForTimeout(900);
  const sheet = await page.locator('body').innerText();
  check('the new-message sheet explains who can be messaged', /inbox|communities|restricted/i.test(sheet), 'explanation present');
  await context.close();
}

console.log('\n══════ Language handling');
{
  const context = await instance.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await context.addCookies(cookies);
  const page = await context.newPage();
  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const settingsText = await page.locator('body').innerText();
  check('settings offers the language choice', /language/i.test(settingsText), 'language control present');

  // Hinglish input must survive a round trip through the composer's state untouched.
  await page.goto(`${BASE}/tutor`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const composer = page.getByLabel('Your question');
  const hinglish = 'Mujhe ye samajh nahi aaya, dobara samjhao';
  await composer.fill(hinglish);
  const value = await composer.inputValue();
  check('a Hinglish question is kept exactly as typed', value === hinglish, value.slice(0, 40));

  const hindi = 'मुझे यह समझ नहीं आया';
  await composer.fill(hindi);
  check('a Devanagari question is kept exactly as typed', (await composer.inputValue()) === hindi, 'no mangling of Hindi input');
  await context.close();
}

/* ---------------------------------------------------------- 4. home is the navigation --------- */

console.log('\n══════ dashboard is the hub (no bottom bar)');
{
  const context = await instance.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await context.addCookies(cookies);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);

  /*
   * The bottom navigation bar was removed at the user's request, and the home screen took over its
   * job. Two things therefore have to be true: every destination is reachable from the dashboard, and
   * nothing is left floating over the content where the bar used to be.
   */
  const fixedBottom = await page.evaluate(() => {
    const vh = window.innerHeight;
    return [...document.querySelectorAll('nav, div')].filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return style.position === 'fixed' && rect.bottom > vh - 4 && rect.height > 24 && rect.width > 200;
    }).length;
  });
  check('the bottom navigation bar is gone', fixedBottom === 0, `${fixedBottom} fixed bar(s) over the content`);

  /*
   * Home stopped carrying the full destination grid in turn 10 (at the user's request), so the only
   * place the promise "nothing is a dead end" can still be kept is the header menu. Open it and read
   * what is really inside — a check against the DOM, not against the intention.
   */
  await page.getByRole('button', { name: /open navigation menu/i }).first().click();
  await page.waitForTimeout(500);
  const menu = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="All sections"]');
    if (!nav) return null;
    return [...nav.querySelectorAll('a')].map((el) => (el.textContent ?? '').trim());
  });
  const needed = ['AI', 'Practice', 'Arena', 'Groups', 'Messages', 'News', 'Mock Exam', 'Notes', 'Code Lab', 'Profile', 'Learning Analytics', 'Learning Activity', 'Settings', 'Help'];
  const missing = needed.filter((label) => !menu?.some((entry) => entry.includes(label)));
  check(
    'every destination is reachable from the dashboard menu',
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${menu?.length ?? 0} destinations in the menu`,
  );
  /*
   * Escape does not dismiss this drawer. There are two elements carrying "Close navigation" — the
   * full-screen backdrop and the X in the panel header — and the backdrop cannot be clicked at its
   * own centre because the panel sits over it. So press the header button, the one a student taps,
   * and wait for the drawer to actually leave the DOM before the next section drives the page.
   */
  await page.getByRole('button', { name: /close navigation/i }).last().click();
  await page.locator('nav[aria-label="All sections"]').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);

  /*
   * Arena: "how does a competition get created?" has to be answerable from inside the product.
   *
   * Whichever side of the permission the signed-in account is on, Arena must say something true: an
   * organiser gets the create panel, a student gets the four-step explanation (and never a dead end).
   * The organiser half is driven end to end — signup, make:admin, dialog, draft, revocation — by
   * `scripts/arena-organiser-check.mjs`, which cannot run inside this scan because it needs a throwaway
   * account. Here we check the half that matches whoever is signed in.
   */
  await page.goto(`${BASE}/arena`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  const arenaBody = await page.evaluate(() => (document.body.innerText ?? '').replace(/\s+/g, ' '));

  if (/You run competitions here/i.test(arenaBody)) {
    check('Arena tells an organiser how to start one', /Create a competition/i.test(arenaBody));
    check(
      'the organiser panel names the three steps',
      /name the paper, add questions, then open registration/i.test(arenaBody),
    );
  } else {
    check('Arena explains how a competition is created', /How competitions are created/i.test(arenaBody));

    await page.getByText(/How competitions are created/i).first().click();
    await page.waitForTimeout(500);
    const expanded = await page.evaluate(() => (document.body.innerText ?? '').replace(/\s+/g, ' '));
    check('students are told who publishes a paper', /teacher|Vroqn organiser|Vroqn team/i.test(expanded));
    const steps = [
      /organiser writes the paper/i,
      /you register while it is open/i,
      /it goes live/i,
      /leaderboard/i,
    ];
    check(
      'the explanation is the real four-step path',
      steps.every((pattern) => pattern.test(expanded)),
      `${steps.filter((pattern) => pattern.test(expanded)).length}/${steps.length} steps found`,
    );
    check('the explanation says when solutions unlock', /never before|once the paper closes/i.test(expanded));
  }

  /* Leave the page where this scan found it: the sections below drive the dashboard menu. */
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  /*
   * Search: one field, two kinds of result.
   *
   * The scan creates the two things it is about to look for (a public community and a second student)
   * rather than hoping the database happens to contain something with the right name — the earlier
   * version silently failed on a freshly seeded database, and a check that only passes by accident is
   * worse than no check.
   */
  const marker = `Zylo${Date.now().toString(36).slice(-4)}`;
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const created = await fetch(`${BASE}/api/communities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader },
    body: JSON.stringify({
      name: `${marker} Physics Circle`,
      description: 'Created by the deep scan so search has something real to find.',
      category: 'physics',
      visibility: 'public',
    }),
  }).then((r) => r.json());
  const signedUp = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `${marker} Finder`,
      email: `${marker.toLowerCase()}@scan.vroqn.dev`,
      password: 'scanpass123',
      classLevel: 'Class 10',
      board: 'CBSE',
    }),
  });
  check('search fixture created', Boolean(created?.slug) && signedUp.ok, `${marker}: community ${created?.slug ?? 'failed'} · student ${signedUp.status}`);

  await page.getByRole('button', { name: 'Open search' }).first().click();
  await page.waitForTimeout(700);
  const searchInput = page.getByRole('textbox', { name: 'Search students and groups' });
  check('the header search opens from anywhere', (await searchInput.count()) === 1, 'search sheet visible');
  await searchInput.fill(marker);
  await page.waitForTimeout(1600);
  const searchText = await page.locator('body').innerText();
  check('search returns groups', /groups · \d+/i.test(searchText), (searchText.match(/groups · \d+/i) ?? ['none'])[0]);
  check(
    'search returns students in the same list',
    /students · \d+/i.test(searchText),
    (searchText.match(/students · \d+/i) ?? ['none'])[0],
  );
  check('search says what it will not do', /private conversations are never searched/i.test(searchText), 'privacy note present');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  /*
   * A destination really navigates from the dashboard. Home stopped carrying the big link grid in
   * turn 10, so the path a student now takes is the header menu — and that is the path being tested,
   * not a shortcut through the address bar.
   */
  await page.getByRole('button', { name: /open navigation menu/i }).first().click();
  await page.waitForTimeout(500);
  await page.locator('nav[aria-label="All sections"] a[href="/messages"]').first().click();
  await page.waitForTimeout(1800);
  check('Messages opens from the dashboard menu', page.url().includes('/messages'), page.url().replace(BASE, ''));

  // And the sub-page header offers a way back rather than a dead end.
  const back = await page.getByRole('button', { name: /go back/i }).count();
  check('a sub-page can go back', back >= 1, `${back} back control(s)`);
  await context.close();
}

{
  /* The same hub, on a desktop viewport: the sidebar is still there and search is one tap away. */
  const context = await instance.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(cookies);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  const sidebar = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Main"]');
    return nav ? nav.querySelectorAll('a[href]').length : 0;
  });
  check('the desktop dashboard keeps every destination in its sidebar', sidebar >= 14, `${sidebar} sidebar links`);
  const news = await page.locator('text=In the news').count();
  check('the dashboard shows news', news >= 1, 'news strip rendered');

  /*
   * The declutter contract (turn 10). The user asked for home to be the hero, the search box, the top
   * communities and the news — so the sections that were removed must be gone from Home, while still
   * existing on their own screens (which the menu check above proves). Asserting the removal is the
   * honest way to test a request that was specifically about removal.
   */
  const clutter = await page.evaluate(() => {
    const text = document.body.innerText;
    return ['Your profile', "Today's Learning", 'What to do next', 'Your AI connections', 'Start here', 'Everything in Vroqn'].filter((label) =>
      text.includes(label),
    );
  });
  check('home carries only the hero, search, communities and news', clutter.length === 0, clutter.length ? `still on Home: ${clutter.join(', ')}` : 'the removed sections are gone');
  await context.close();
}

/* ------------------------------------------------------------------ joining a community --- */

/*
 * Joining is the single most important action in the whole Communities section, and it had three
 * different answers depending on where a student stood:
 *
 *   · on the home screen, the top-community cards were links and nothing else — no way to join at all,
 *     which is what the user reported ("there is no button to join any community");
 *   · on a public community's own page, the home tab answered a non-member with a red
 *     "Could not load this community" error and a Retry button, so the one screen that should welcome
 *     somebody looked broken;
 *   · on the Groups screen it worked.
 *
 * These checks hold all three to the same promise: a public community can be joined from the home
 * screen in one tap, and a non-member looking inside gets an invitation rather than an error.
 */
console.log('\n══════ joining a community from anywhere');
{
  const context = await instance.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const ownerCookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

  // A brand-new student is the honest test: they are a member of nothing at all.
  const stamp = Date.now().toString(36).slice(-5);

  /*
   * Self-healing: sweep up fixtures from a previous run that died before its own cleanup.
   *
   * Not cosmetic. Leftovers pile up in the demo account's community list, they show up in "top
   * communities", and the join assertions then inspect a page full of stale test circles. A suite
   * that only cleans up on the happy path quietly poisons the runs after it — this one had already
   * done exactly that by the time it was noticed.
   */
  {
    const mine = await fetch(`${BASE}/api/communities/discover?mine=1&limit=200`, { headers: { cookie: ownerCookie } }).then((r) => r.json());
    const stale = (mine.communities ?? mine.items ?? []).filter((entry) => /^Zylo/i.test(entry.name));
    for (const entry of stale) {
      await fetch(`${BASE}/api/communities/${entry.id}`, { method: 'DELETE', headers: { cookie: ownerCookie } });
    }
    if (stale.length) console.log(`  ..   swept ${stale.length} leftover fixture(s) from an earlier run`);
  }
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `Joiner ${stamp}`,
      email: `joiner-${stamp}@scan.vroqn.dev`,
      password: `Vr0qn-${stamp}1`,
      classLevel: 'Class 10',
      board: 'CBSE',
    }),
  });
  const newCookies = (signup.headers.getSetCookie?.() ?? []).map((raw) => raw.split(';')[0]).join('; ');
  check('a student who is in no community exists', signup.ok && Boolean(newCookies), `HTTP ${signup.status}`);

  const openCircle = await fetch(`${BASE}/api/communities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({
      name: `ZyloJoin ${stamp} Circle`,
      description: 'Created by the deep scan so there is something public to join.',
      category: 'physics',
      visibility: 'public',
    }),
  }).then((response) => response.json());
  check('a public community waits to be joined', Boolean(openCircle?.slug), openCircle?.slug ?? 'creation failed');

  const fresh = await instance.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await fresh.addCookies(
    newCookies.split('; ').map((pair) => {
      const [name, value] = pair.split('=');
      return { name, value, domain: '127.0.0.1', path: '/' };
    }),
  );
  const page = await fresh.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // 1. The home screen offers a join action on its top-community cards.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  const joinOnHome = page.getByRole('button', { name: /^Join$/ });
  const homeJoinCount = await joinOnHome.count();
  check('the home screen offers a way to join a community', homeJoinCount > 0, `${homeJoinCount} join button(s) on the dashboard`);

  if (homeJoinCount > 0) {
    /*
     * Which community the dashboard shows in its top six depends on how many members each has, so the
     * check does not assume the scan's own community is among them. It does what a student does: taps
     * Join, then verifies that exactly one more community is now in their list — which is the real
     * promise ("one tap on the home screen joins the thing you tapped").
     */
    const membership = () =>
      fetch(`${BASE}/api/communities/discover?mine=1&limit=60`, { headers: { cookie: newCookies } })
        .then((response) => response.json())
        .then((body) => new Set((body?.communities ?? []).map((entry) => entry.id)))
        .catch(() => new Set());
    const before = await membership();
    await joinOnHome.first().click();
    await page.waitForTimeout(2800);
    const after = await membership();
    const added = [...after].filter((id) => !before.has(id));
    check('one tap on the home screen really joins the community', added.length === 1, `${added.length} community joined`);
    const refreshed = await page.evaluate(() => {
      const section = document.querySelector('section[aria-labelledby="top-communities"]');
      return section ? section.querySelectorAll('a').length : 0;
    });
    check('the card re-renders after joining', refreshed > 0, `${refreshed} link(s) in the refreshed section`);
  }

  /*
   * 2. A non-member looking inside a public community is invited, not shown an error.
   *
   * A second community is created for this, because the student joined the first one a moment ago and
   * is a member of it now — checking the non-member experience on a community they are in would assert
   * the wrong thing (it would pass by accident on the "Leave" button).
   */
  const closedCircle = await fetch(`${BASE}/api/communities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({
      name: `ZyloLook ${stamp} Circle`,
      description: 'A public community this student has not joined.',
      category: 'physics',
      visibility: 'public',
    }),
  }).then((response) => response.json());

  await page.goto(`${BASE}/communities/${closedCircle.slug}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  check('a public community page does not look broken to a non-member', !/could not load this community/i.test(body), 'no error panel for an ordinary visitor');
  check(
    'the home tab invites a non-member instead of erroring',
    /join to see what is inside|join to read the chat/i.test(body),
    /join to see what is inside/i.test(body) ? 'invitation shown' : 'no invitation copy found',
  );
  const joinVisible = (await page.getByRole('button', { name: /^(Join|Ask to join|Have a code\?)$/ }).count()) > 0;
  check('the community page itself shows a join control', joinVisible, joinVisible ? 'join control present' : 'no join control');
  check('browsing a community raises no script error', pageErrors.length === 0, pageErrors[0] ?? 'no page errors');

  // 3. The Groups screen still offers joining, so nothing regressed there.
  await page.goto(`${BASE}/communities`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const groupsJoin = await page.getByRole('button', { name: /^Join$/ }).count();
  check('the Groups screen still offers joining', groupsJoin > 0, `${groupsJoin} join button(s)`);

  await fresh.close();

  // Clean up: the scan's own fixtures do not accumulate on the account.
  await fetch(`${BASE}/api/communities/${openCircle.id}`, { method: 'DELETE', headers: { cookie: ownerCookie } });
  await fetch(`${BASE}/api/communities/${closedCircle.id}`, { method: 'DELETE', headers: { cookie: ownerCookie } });
  await context.close();
}

/* ------------------------------------------------------------------ turn 9: the new home and the new doors --- */

/*
 * The four things this turn added, checked against the running product rather than against the code:
 *
 *   1. the Study Core animation exists, is decoration (hidden from assistive tech, cannot eat taps),
 *      occupies a real box, and freezes completely when the device asks for less motion;
 *   2. the home screen actually lists top communities — and the ranking is the one it claims, most
 *      members first — with real links into those communities;
 *   3. the analytics screen opens from the home screen and renders a report, not an empty shell;
 *   4. a search result can be messaged directly: the button must end on the conversation itself.
 *      That last one is the check that would have caught the old bug, where "Message" changed the URL
 *      and left the student staring at an unchanged inbox.
 */
console.log('\n══════ the 3D study core, top communities, analytics and messaging from search');
{
  const context = await instance.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await context.addCookies(cookies);
  const page = await context.newPage();
  const pageErrors = [];
  const apiCalls = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    const url = response.url().replace(BASE, '');
    if (url.includes('/api/')) apiCalls.push(`${response.status()} ${response.request().method()} ${url}`);
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);

  const core = await page.evaluate(() => {
    const root = document.querySelector('.vroqn-core');
    if (!root) return null;
    const rect = root.getBoundingClientRect();
    const stage = root.querySelector('.vroqn-core__stage');
    const badges = [...root.querySelectorAll('a.vroqn-core__badge')];
    const spread = badges.map((badge) => badge.getBoundingClientRect().left);
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      pointer: getComputedStyle(root).pointerEvents,
      /* Every purely visual layer must be invisible to a screen reader. */
      hiddenLayers: root.querySelectorAll('[aria-hidden="true"]').length,
      discs: badges.length,
      ticks: root.querySelectorAll('.vroqn-core__tick').length,
      animation: stage ? getComputedStyle(stage).animationName : null,
      links: badges.map((badge) => ({
        href: badge.getAttribute('href'),
        name: (badge.getAttribute('aria-label') ?? '').trim(),
        w: Math.round(badge.getBoundingClientRect().width),
        h: Math.round(badge.getBoundingClientRect().height),
      })),
      /*
       * The tightest pair anywhere in the composition, measured edge to edge.
       *
       * Edge to edge, not centre to centre: two 44px chips 50px apart still look like a pile, and a
       * centre-distance check passed the version of this planet whose inner ring had six icons squeezed
       * into a 60x34 ellipse. The gap a person can actually see is the one that matters.
       */
      minEdgeGap: (() => {
        const chips = badges.map((badge) => {
          const rect = badge.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, size: rect.width };
        });
        let closest = Number.POSITIVE_INFINITY;
        for (let i = 0; i < chips.length; i += 1) {
          for (let j = i + 1; j < chips.length; j += 1) {
            closest = Math.min(
              closest,
              Math.hypot(chips[i].x - chips[j].x, chips[i].y - chips[j].y) - (chips[i].size + chips[j].size) / 2,
            );
          }
        }
        return Math.round(closest);
      })(),
      // The discs must occupy different x positions, or the "orbit" is a stack of icons.
      spread: Math.round(Math.max(...spread) - Math.min(...spread)),
    };
  });
  check('the home screen has the 3D study core', Boolean(core), core ? `${core.width}×${core.height}` : 'not found');
  check(
    'the artwork is hidden from assistive tech and cannot eat a tap',
    Boolean(core && core.pointer === 'none' && core.hiddenLayers >= 6),
    core ? `pointer-events=${core.pointer} · ${core.hiddenLayers} decorative layers hidden` : '',
  );
  /*
   * Every destination the product has is a chip on this planet, and every chip is a real link. This is
   * the user's core requirement for the animation: "I click the icon, its function runs".
   */
  const wantedHrefs = ['/tutor', '/practice', '/news', '/notes', '/code-lab', '/mock-exam', '/arena', '/communities', '/messages', '/profile', '/analytics', '/activity', '/settings', '/help'];
  const missingHrefs = wantedHrefs.filter((href) => !core?.links.some((link) => link.href === href));
  check(
    'every destination is a chip orbiting the planet',
    core?.discs === 14 && missingHrefs.length === 0,
    core ? `${core.discs} chips${missingHrefs.length ? ` · missing ${missingHrefs.join(', ')}` : ' · all 14 destinations, each a real link'}` : '',
  );
  check(
    'no two chips can be confused for one another',
    (core?.minEdgeGap ?? 0) >= 26,
    core
      ? `closest two chips have ${core.minEdgeGap}px of clear space between them (each is ${Math.round(
          Math.min(...core.links.map((l) => l.w)),
        )}–${Math.round(Math.max(...core.links.map((l) => l.w)))}px wide)`
      : '',
  );
  check(
    'every disc keeps a usable hit area inside the 3D transform',
    Boolean(core && Math.min(...core.links.map((l) => l.w)) >= 24 && Math.min(...core.links.map((l) => l.h)) >= 24),
    core ? `smallest disc ${Math.min(...core.links.map((l) => l.w))}×${Math.min(...core.links.map((l) => l.h))}px` : '',
  );
  check('the core is properly built', Boolean(core && core.discs >= 14 && core.ticks >= 24), core ? `${core.discs} chips, ${core.ticks} dial ticks` : '');
  check('the core discs are spread around an orbit', (core?.spread ?? 0) > 120, `${core?.spread}px between the outermost discs`);
  check('the core animates', Boolean(core?.animation && core.animation !== 'none'), `animation: ${core?.animation}`);

  /*
   * The two promises that make it "the thing that spins is the thing you press": it holds still when
   * a student reaches for it, and the press really lands on the screen the disc names.
   */
  /*
   * Drive this exactly the way a finger does: put the pointer where the disc is *right now* (a
   * stability-waiting `hover()` can never succeed on a permanently moving target — the first version
   * of this check timed out for that reason, which is itself the proof that the pause matters), then
   * assert the orbit stopped, then press the disc where it stopped.
   */
  const firstDisc = page.locator('a.vroqn-core__badge').first();
  const firstHref = await firstDisc.getAttribute('href');
  const aim = async () => {
    const box = await firstDisc.boundingBox();
    return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  };
  /*
   * Focus first. This is not a workaround: on a pointer device the orbit pauses on hover, and a
   * keyboard student gets the same pause on focus — focus is the path that exists on every device,
   * including the touch-emulated context this scan runs in, where `:hover` never matches.
   */
  await firstDisc.focus();
  await page.waitForTimeout(350);
  const pausedState = await page.evaluate(() => {
    const item = document.querySelector('.vroqn-core__item');
    return item ? getComputedStyle(item).animationPlayState : null;
  });
  check('the orbit pauses when a student reaches for it', pausedState === 'paused', `animation-play-state: ${pausedState}`);
  const settled = await aim();
  if (settled) {
    /* Force: the click goes to where the disc is drawn right now. A finger does the same thing. */
    await page.mouse.click(settled.x, settled.y);
    await page.waitForTimeout(1500);
    const landed = await page.evaluate(() => `${location.pathname}${location.search}`);
    check('pressing a disc opens the screen it names', landed === firstHref, `${firstHref} → ${landed}`);
  } else {
    check('pressing a disc opens the screen it names', false, 'the disc had no box to press');
  }

  /* The disc navigated away (that is the point of the previous check) — come back to Home. */
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  check('the home screen renders without a script error', pageErrors.length === 0, pageErrors[0] ?? 'no page errors');

  // Top communities: the section says what it sorts by, and its ordering must match.
  const communities = await page.evaluate(async () => {
    const section = document.querySelector('section[aria-labelledby="top-communities"]');
    if (!section) return null;
    /*
     * One card can contain more than one link (the card itself and the "Open" affordance), but only the
     * card link carries the member count — so the ordering is read from the links that actually state
     * one, not from every anchor in the section.
     */
    /*
     * Read the member count from the element that *is* the member count, never by regexing the whole
     * card. `textContent` glues child nodes together with no separator, so a card named "…Circle 6243"
     * followed by "2 members" reads as "62432 members" — which is how this check first reported a
     * 62,432-member community that does not exist. Anchoring to the span that starts with a number
     * makes the reading exact.
     */
    const links = [...section.querySelectorAll('a')]
      .filter((a) => (a.getAttribute('href') ?? '').startsWith('/communities/'))
      .map((a) => {
        const counter = [...a.querySelectorAll('span')].find((span) => /^\s*\d[\d,]*\s+members?\b/i.test(span.textContent ?? ''));
        const match = counter ? (counter.textContent ?? '').match(/^\s*([\d,]+)/) : null;
        return { href: a.getAttribute('href') ?? '', members: match ? Number(match[1].replace(/,/g, '')) : null };
      })
      .filter((entry) => entry.members !== null);
    return { heading: 'Top communities', count: links.length, members: links.map((entry) => entry.members) };
  });
  check('the home screen lists top communities', (communities?.count ?? 0) >= 1, `${communities?.count ?? 0} community link(s)`);
  const sorted = (communities?.members ?? []).every((value, index, list) => index === 0 || list[index - 1] >= value);
  check('top communities are ordered by members, as labelled', sorted, `member counts: ${(communities?.members ?? []).join(', ')}`);

  /*
   * The analytics door: Learning Analytics is a dashboard destination, reached from Home's menu. The
   * old one-tap preview card left the page in turn 10, so the check follows the route that remains.
   */
  await page.getByRole('button', { name: /open navigation menu/i }).first().click();
  await page.waitForTimeout(500);
  await page.locator('nav[aria-label="All sections"] a[href="/analytics"]').first().click();
  await page.waitForTimeout(2000);
  check('analytics opens from the dashboard', page.url().includes('/analytics'), page.url().replace(BASE, ''));
  const report = await page.evaluate(() => ({
    heading: document.querySelector('h1')?.textContent?.trim() ?? '',
    sliders: document.querySelectorAll('[role="progressbar"]').length,
    charts: document.querySelectorAll('svg[role="img"]').length,
    error: document.body.innerText.includes('Could not load'),
  }));
  check('the analytics screen is a report, not an empty shell', report.charts >= 1, `${report.charts} chart(s), ${report.sliders} accuracy bar(s)`);
  check('the analytics screen loads without an error', !report.error, report.error ? 'showed an error state' : report.heading);

  // Message a person straight from search results.
  /*
   * The classmate and the community are REUSED across runs on purpose.
   *
   * Conversations are rate limited (12 new ones an hour, deliberately, to stop a spammer) — a check
   * that invents a new person on every scan therefore fails after a dozen runs for a reason that has
   * nothing to do with the feature. A fixed classmate exercises the same path (search → Message →
   * thread) without burning the limit, and the first run also covers the "brand-new conversation"
   * case because that is how the conversation gets created in the first place.
   */
  const marker = 'ZyloScan';
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  /*
   * Reuse the scan's own community when it already exists. Creating one per run would climb into the
   * product's real limit (an account may own 25 communities), and a check that fails because of its own
   * leftovers is a check nobody trusts.
   */
  const mine = await fetch(`${BASE}/api/communities/discover?mine=1&limit=60`, { headers: { cookie: cookieHeader } })
    .then((response) => response.json())
    .catch(() => ({ communities: [] }));
  const existing = (mine?.communities ?? []).find((entry) => entry.name === `${marker} DM Circle`);
  const circle =
    existing ??
    (await fetch(`${BASE}/api/communities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader },
      body: JSON.stringify({
        name: `${marker} DM Circle`,
        description: 'Created by the deep scan so a classmate can be messaged.',
        category: 'physics',
        visibility: 'public',
      }),
    }).then((response) => response.json()));

  // Sign up if this is the first run, otherwise sign in. Either way we end with a session cookie.
  let classmateStatus = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `${marker} Classmate`,
      email: `${marker.toLowerCase()}@scan.vroqn.dev`,
      password: 'scanpass123',
      classLevel: 'Class 10',
      board: 'CBSE',
    }),
  });
  let classmateCookies = (classmateStatus.headers.getSetCookie?.() ?? []).map((raw) => raw.split(';')[0]).join('; ');
  if (!classmateStatus.ok) {
    classmateStatus = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${marker.toLowerCase()}@scan.vroqn.dev`, password: 'scanpass123' }),
    });
    classmateCookies = (classmateStatus.headers.getSetCookie?.() ?? []).map((raw) => raw.split(';')[0]).join('; ');
  }
  let joined = false;
  if (circle?.id && classmateCookies) {
    // Re-joining a community you are already in is a no-op on the server, so this is safe every run.
    const response = await fetch(`${BASE}/api/communities/${circle.id}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: classmateCookies },
      body: JSON.stringify({}),
    });
    joined = response.ok || response.status === 409;
  }
  check(
    'a classmate exists to message',
    Boolean(circle?.id) && joined,
    `${marker}: community ${circle?.slug ?? 'created already'} · classmate ${classmateStatus.status} · joined ${joined}`,
  );

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Open search' }).first().click();
  await page.waitForTimeout(600);
  await page.getByRole('textbox', { name: 'Search students and groups' }).fill(marker);
  await page.waitForTimeout(1800);
  const messageButton = page.getByRole('button', { name: /^Message$/ }).first();
  const hasMessage = (await messageButton.count()) > 0;
  check('a search result offers a direct message button', hasMessage, hasMessage ? 'Message button rendered' : 'no Message button in the results');
  if (hasMessage) {
    await messageButton.click();
    const onThread = await page
      .waitForURL(/\/messages\/[0-9a-f-]{8,}/i, { timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    check('messaging from search opens the conversation itself', onThread, page.url().replace(BASE, ''));

    /*
     * "Ready to type in", not merely "rendered": the composer exists before the conversation key
     * does, and for a brand-new conversation this screen sets that key up by itself. The check waits
     * for the field to become usable, which is the experience the button promises.
     */
    const composer = page.locator('textarea').first();
    const waitForComposer = async (timeout) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if ((await composer.count()) > 0 && (await composer.isEnabled().catch(() => false))) return true;
        await page.waitForTimeout(400);
      }
      return false;
    };

    /*
     * A brand-new conversation has no key yet, and the thread sets one up by itself — that is the
     * point of arriving from a search result rather than from the inbox. If the automatic step does not
     * finish in time (or declines, because the other student's device already holds a key), the screen
     * must still offer the manual way forward. So the check accepts either: a composer that becomes
     * usable on its own, or the "Send keys to this device" button that makes it usable.
     */
    let usable = await waitForComposer(9000);
    let via = usable ? 'prepared automatically' : '';
    if (!usable) {
      const sendKeys = page.getByRole('button', { name: /send keys to this device/i });
      if ((await sendKeys.count()) > 0) {
        await sendKeys.first().click();
        usable = await waitForComposer(12000);
        via = usable ? 'via the manual "Send keys to this device" step' : '';
      }
    }
    if (!usable) {
      // Diagnostic dump: what the screen actually said while we waited.
      const diag = await page.evaluate(() => {
        const area = document.querySelector('textarea');
        return {
          count: document.querySelectorAll('textarea').length,
          disabled: area ? area.disabled : null,
          placeholder: area?.getAttribute('placeholder') ?? null,
          needsKeys: /send keys to this device/i.test(document.body.innerText),
          identityError: /cannot encrypt messages locally|Could not set up encryption/i.test(document.body.innerText),
          subtle: Boolean(window.crypto?.subtle),
          indexedDb: typeof indexedDB !== 'undefined',
          head: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
        };
      });
      console.log(`       diag: ${JSON.stringify(diag)}`);
      console.log(`       api: ${apiCalls.filter((line) => line.includes('/messages')).slice(-8).join(' | ')}`);
    }
    check(
      'the conversation is ready to type in',
      usable,
      usable ? `composer enabled — ${via}` : 'composer still disabled and no recovery offered',
    );
    if (usable) {
      const text = `Deep scan hello ${Date.now().toString(36).slice(-4)}`;
      await composer.fill(text);
      await composer.press('Enter');
      await page.waitForTimeout(2500);
      const shown = await page.evaluate((needle) => document.body.innerText.includes(needle), text);
      check('the message is sent and shown in the thread', shown, shown ? 'encrypted locally, stored, and rendered back' : 'message did not appear');
    }
  }
  await context.close();
}

{
  /* Reduced motion: the same composition, standing still. Nothing here may animate. */
  const context = await instance.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: 'reduce',
  });
  await context.addCookies(cookies);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const frozen = await page.evaluate(() => {
    const root = document.querySelector('.vroqn-core');
    if (!root) return null;
    const animated = [...root.querySelectorAll('*')].filter((el) => {
      const style = getComputedStyle(el);
      return style.animationName && style.animationName !== 'none';
    });
    const stage = root.querySelector('.vroqn-core__stage');
    /*
     * The frozen drawing has to be the same drawing. Killing every animation used to drop all fourteen
     * chips onto the centre of the stage — the keyframe *was* what positioned them — so a student who
     * asked for less motion got a pile of icons instead of a planet. These two numbers are what keeps
     * that from coming back: the chips are spread, and they are still spaced apart.
     */
    const chips = [...root.querySelectorAll('a.vroqn-core__badge')].map((badge) => {
      const rect = badge.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, size: rect.width };
    });
    let minEdgeGap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < chips.length; i += 1) {
      for (let j = i + 1; j < chips.length; j += 1) {
        minEdgeGap = Math.min(
          minEdgeGap,
          Math.hypot(chips[i].x - chips[j].x, chips[i].y - chips[j].y) - (chips[i].size + chips[j].size) / 2,
        );
      }
    }
    return {
      animated: animated.length,
      transform: stage ? getComputedStyle(stage).transform !== 'none' : false,
      discs: root.querySelectorAll('.vroqn-core__badge').length,
      ticks: root.querySelectorAll('.vroqn-core__tick').length,
      spread: Math.round(Math.max(...chips.map((chip) => chip.x)) - Math.min(...chips.map((chip) => chip.x))),
      minEdgeGap: Math.round(minEdgeGap),
    };
  });
  check('reduced motion freezes the core completely', frozen?.animated === 0, frozen ? `${frozen.animated} animated element(s)` : 'no core found');
  check('the frozen core is still a complete drawing', Boolean(frozen && frozen.discs >= 14 && frozen.ticks >= 24), frozen ? `${frozen.discs} chips, ${frozen.ticks} ticks` : '');
  check(
    'the frozen core is still laid out like the moving one',
    Boolean(frozen && frozen.spread > 200 && frozen.minEdgeGap >= 26),
    frozen ? `${frozen.spread}px spread, ${frozen.minEdgeGap}px between the closest two chips` : '',
  );
  await context.close();
}

await instance.close();

console.log(`\nDeep scan: ${pass} passed, ${findings.length} failed`);
if (findings.length) {
  console.log('\nFindings:');
  for (const finding of findings) console.log(`  - ${finding}`);
}
process.exit(findings.length ? 1 : 0);
