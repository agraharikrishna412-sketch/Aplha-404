/**
 * Builds the CSC submission pack: high-resolution screenshots and walkthrough videos.
 *
 *   node scripts/capture-submission.mjs
 *
 * Everything is captured from the running product (no mock-ups): a real sign-in, real data, real
 * navigation. Desktop shots are 1440x900 at 2x device pixel ratio (~2880px wide), mobile shots are
 * 390x844 at 2x — the sizes an evaluator expects to see.
 *
 * Output: ../CSC-Submission/{screenshots/{desktop,mobile},video}
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const BASE = process.env.BROWSER_BASE ?? 'http://127.0.0.1:8787';
const EMAIL = process.env.SMOKE_EMAIL ?? 'demo@vroqn.dev';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'nexus1234';
const OUT = path.resolve(process.cwd(), '..', 'CSC-Submission');
const DESKTOP = path.join(OUT, 'screenshots', 'desktop');
const MOBILE = path.join(OUT, 'screenshots', 'mobile');
const VIDEO = path.join(OUT, 'video');
for (const dir of [DESKTOP, MOBILE, VIDEO]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function findBrowser() {
  if (process.env.BROWSER_PATH) return existsSync(process.env.BROWSER_PATH) ? process.env.BROWSER_PATH : null;
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

const executablePath = findBrowser();
if (!executablePath) {
  console.error('capture-submission: no Chromium found — install playwright-core and a browser first.');
  process.exit(1);
}

const instance = await chromium.launch({ executablePath, args: ['--no-sandbox'] });

async function signIn() {
  return fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }).then((response) => response.headers.getSetCookie());
}

const sessionCookies = (await signIn()).map((value) => {
  const [name, ...rest] = value.split(';')[0].split('=');
  return { name, value: rest.join('='), url: BASE };
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Prepares a page: calm cursor, animations settled, no toast leftovers. */
async function settle(page, ms = 1800) {
  await page.waitForTimeout(ms);
  await page.mouse.move(2, 2).catch(() => undefined);
  await page.waitForTimeout(250);
}

const shots = [];
async function shot(page, dir, name, { full = false } = {}) {
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  shots.push(path.relative(OUT, file));
  console.log('  shot', path.relative(OUT, file));
}

/* ------------------------------------------------------------------ desktop screens ------------- */

const desktop = await instance.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  reducedMotion: 'no-preference',
});

/* 1. The public landing page, signed out — what a visitor sees first. */
const landing = await desktop.newPage();
await landing.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await settle(landing, 2500);
await shot(landing, DESKTOP, '01-landing-signed-out');
await landing.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await settle(landing, 2200);
await shot(landing, DESKTOP, '02-landing-lower', { full: true });
await landing.close();

await desktop.addCookies(sessionCookies);
const page = await desktop.newPage();

const pages = [
  ['03-dashboard', '/dashboard'],
  ['04-ai-tutor', '/tutor'],
  ['05-practice', '/practice'],
  ['06-mock-exam', '/mock-exam'],
  ['07-notes', '/notes'],
  ['08-code-lab', '/code-lab'],
  ['09-arena-catalog', '/arena'],
  ['10-arena-my-competitions', '/arena/my-competitions'],
  ['11-arena-organiser-console', '/arena/admin'],
  ['12-communities', '/communities'],
  ['13-community-competitions', '/communities/class-10-cbse'],
  ['14-messages', '/messages'],
  ['15-analytics', '/analytics'],
  ['16-activity', '/activity'],
  ['17-profile', '/profile'],
  ['18-news', '/news'],
  ['19-settings', '/settings'],
  ['20-help', '/help'],
];

for (const [name, route] of pages) {
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  await settle(page, route === '/dashboard' ? 3000 : 1900);
  if (name === '13-community-competitions') {
    const tab = page.getByRole('tab', { name: /competitions/i }).first();
    if (await tab.count()) {
      await tab.click();
      await settle(page, 1500);
    }
  }
  await shot(page, DESKTOP, name);
}

/* The two "how it works" screens get the long form too — they are the ones a judge will study. */
await page.goto(`${BASE}/arena`, { waitUntil: 'domcontentloaded' });
await settle(page, 2200);
await shot(page, DESKTOP, '21-arena-full', { full: true });

await page.goto(`${BASE}/arena/admin`, { waitUntil: 'domcontentloaded' });
await settle(page, 2200);
await shot(page, DESKTOP, '22-arena-console-full', { full: true });
await page.goto(`${BASE}/arena/admin?create=1`, { waitUntil: 'domcontentloaded' });
await settle(page, 2200);
await shot(page, DESKTOP, '23-create-competition-dialog');
await page.keyboard.press('Escape').catch(() => undefined);

await page.goto(`${BASE}/communities/class-10-cbse`, { waitUntil: 'domcontentloaded' });
await settle(page, 2200);
const competitionsTab = page.getByRole('tab', { name: /competitions/i }).first();
if (await competitionsTab.count()) {
  await competitionsTab.click();
  await settle(page, 1500);
}
await page.getByRole('button', { name: /host a competition/i }).first().click().catch(() => undefined);
await settle(page, 1500);
await shot(page, DESKTOP, '24-community-host-dialog');

/* The student side of a paper: the live runner, if a paper is running. */
await page.goto(`${BASE}/arena`, { waitUntil: 'domcontentloaded' });
await settle(page, 2000);
const startLink = page.getByRole('link', { name: /start attempt|enter|start/i }).first();
if (await startLink.count()) {
  await startLink.click().catch(() => undefined);
  await settle(page, 3000);
  if (page.url().includes('/arena/')) await shot(page, DESKTOP, '25-arena-exam-runner');
}
await desktop.close();

/* ------------------------------------------------------------------ mobile screens -------------- */

const mobile = await instance.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
await mobile.addCookies(sessionCookies);
const phone = await mobile.newPage();
for (const [name, route] of [
  ['01-dashboard-planet', '/dashboard'],
  ['02-ai-tutor', '/tutor'],
  ['03-practice', '/practice'],
  ['04-arena', '/arena'],
  ['05-communities', '/communities'],
  ['06-messages', '/messages'],
  ['07-analytics', '/analytics'],
  ['08-profile', '/profile'],
]) {
  await phone.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  await settle(phone, route === '/dashboard' ? 3200 : 1900);
  await shot(phone, MOBILE, name);
}
await mobile.close();

/* ------------------------------------------------------------------ videos ---------------------- */

/* Desktop walkthrough: the tour a judge would take if they had five minutes with the product. */
const tour = await instance.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: VIDEO, size: { width: 1280, height: 800 } },
});
await tour.addCookies(sessionCookies);
const video = await tour.newPage();

async function beat(ms, label) {
  if (label) console.log('  video beat:', label);
  await video.waitForTimeout(ms);
}

await video.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await beat(3500, 'landing');
await video.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
await beat(3000);
/* Hover the planet: it holds still the moment you reach for it, which is the nicest thing to show. */
const chips = video.locator('a.vroqn-core__badge');
const chipCount = await chips.count();
for (let i = 0; i < Math.min(chipCount, 6); i += 1) {
  const box = await chips.nth(i).boundingBox();
  if (box) await video.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
  await beat(500);
}
await beat(1200, 'planet + hover pause');
await video.goto(`${BASE}/tutor`, { waitUntil: 'domcontentloaded' });
await beat(2600, 'AI tutor');
await video.goto(`${BASE}/practice`, { waitUntil: 'domcontentloaded' });
await beat(2600, 'practice');
await video.goto(`${BASE}/mock-exam`, { waitUntil: 'domcontentloaded' });
await beat(2600, 'mock exam');
await video.goto(`${BASE}/notes`, { waitUntil: 'domcontentloaded' });
await beat(2200, 'notes');
await video.goto(`${BASE}/code-lab`, { waitUntil: 'domcontentloaded' });
await beat(2600, 'code lab');
await video.goto(`${BASE}/arena`, { waitUntil: 'domcontentloaded' });
await beat(3200, 'arena catalog + organiser panel');
await video.goto(`${BASE}/arena/admin`, { waitUntil: 'domcontentloaded' });
await beat(2600, 'organiser console');
await video.goto(`${BASE}/arena/admin?create=1`, { waitUntil: 'domcontentloaded' });
await beat(4000, 'create competition dialog');
await video.keyboard.press('Escape').catch(() => undefined);
await video.goto(`${BASE}/communities/class-10-cbse`, { waitUntil: 'domcontentloaded' });
await beat(2200);
const tourTab = video.getByRole('tab', { name: /competitions/i }).first();
if (await tourTab.count()) {
  await tourTab.click();
  await beat(2200, 'community competitions');
}
await video.goto(`${BASE}/messages`, { waitUntil: 'domcontentloaded' });
await beat(2400, 'messages');
await video.goto(`${BASE}/analytics`, { waitUntil: 'domcontentloaded' });
await beat(2600, 'analytics');
await video.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
await beat(2000, 'profile');
await video.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
await beat(2200, 'settings');
await video.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
await beat(3000, 'back to the planet');
await tour.close();

/* Mobile video: the same product on a phone, which is where students actually are. */
const phoneTour = await instance.newContext({
  viewport: { width: 390, height: 844 },
  recordVideo: { dir: VIDEO, size: { width: 390, height: 844 } },
  isMobile: true,
  hasTouch: true,
});
await phoneTour.addCookies(sessionCookies);
const phonePage = await phoneTour.newPage();
for (const [route, ms, label] of [
  ['/dashboard', 4000, 'phone dashboard'],
  ['/practice', 2200, 'phone practice'],
  ['/arena', 2600, 'phone arena'],
  ['/messages', 2200, 'phone messages'],
  ['/communities', 2200, 'phone communities'],
  ['/dashboard', 3200, 'phone planet again'],
]) {
  await phonePage.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  await beat(ms, label);
}
await phoneTour.close();

await instance.close();

/* Playwright names the files itself; give them names a human can use. */
const videos = readdirSync(VIDEO).filter((name) => name.endsWith('.webm'));
videos.sort((a, b) => (a < b ? -1 : 1));
const names = ['walkthrough-desktop.webm', 'walkthrough-mobile.webm'];
videos.forEach((file, index) => {
  const { renameSync } = require('node:fs');
  renameSync(path.join(VIDEO, file), path.join(VIDEO, names[index] ?? `clip-${index}.webm`));
});

console.log(`\ncapture-submission: ${shots.length} screenshots, ${videos.length} videos → ${OUT}`);
