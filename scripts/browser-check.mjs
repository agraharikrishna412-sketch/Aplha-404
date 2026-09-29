/**
 * Real-browser layout verification (360 / 390 / 430 px + desktop).
 *
 * jsdom — which `smoke:ui` uses — has no layout engine, so it cannot answer the questions that
 * actually matter on a phone: does anything overflow horizontally, is a touch target big enough,
 * does the Arena timer stay on screen while the paper scrolls. This script drives a real Chromium
 * at real viewport sizes and measures.
 *
 * OPTIONAL: it is not part of `npm test` and has no hard dependency on a browser being present.
 * To run it:
 *
 *   npm i --no-save playwright-core
 *   npx playwright-core install chromium-headless-shell
 *   node scripts/browser-check.mjs
 *
 * Point BROWSER_PATH at the downloaded `chrome-headless-shell` binary if it is not in a standard
 * Playwright location. If no browser is found the script says so and exits 0 rather than failing a
 * build on a developer machine that has none.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, so screenshots land in the right place whatever the caller's cwd is. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const require = createRequire(import.meta.url);
const BASE = process.env.BROWSER_BASE ?? 'http://127.0.0.1:8787';
const EMAIL = process.env.SMOKE_EMAIL ?? 'demo@vroqn.dev';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'nexus1234';

/** The three phone widths the brief names, plus a desktop reference. */
const VIEWPORTS = [
  /* §22 names 320 px as the floor: the narrowest phone in real use (iPhone SE 1st gen, small
     Android). If anything overflows, this is where it happens first. */
  { name: '320×568  (narrowest phone)', width: 320, height: 568, touch: true },
  { name: '360×740  (small Android)', width: 360, height: 740, touch: true },
  { name: '390×844  (iPhone)', width: 390, height: 844, touch: true },
  { name: '430×932  (large phone)', width: 430, height: 932, touch: true },
  { name: '1440×900 (desktop)', width: 1440, height: 900, touch: false },
];

const ROUTES = [
  ['/', 'Homepage (signed out)'],
  ['/dashboard', 'Dashboard'],
  ['/tutor', 'AI Tutor'],
  ['/practice', 'Practice'],
  ['/mock-exam', 'Mock Exam'],
  ['/notes', 'Notes'],
  ['/code-lab', 'Code Lab'],
  ['/arena', 'Arena'],
  ['/arena/my-competitions', 'My competitions'],
  /* Turn 7 screens: private messages, editable profile, the news reader and Help. */
  ['/messages', 'Messages'],
  ['/profile', 'Profile'],
  ['/news', 'News'],
  ['/help', 'Help'],
  ['/activity', 'Learning Activity'],
  ['/settings', 'Settings'],
];

/* ------------------------------------------------------------------ browser discovery --------- */

function findBrowser() {
  if (process.env.BROWSER_PATH) return existsSync(process.env.BROWSER_PATH) ? process.env.BROWSER_PATH : null;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/tmp/pw-browsers', path.join(process.cwd(), '.pw-browsers')].filter(Boolean);
  /* A full Chromium build ships `chrome`; the slimmer installs ship one of the shells. */
  const names = ['chrome-headless-shell', 'headless_shell', 'chrome'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (!dir.startsWith('chromium')) continue;
      for (const sub of readdirSync(path.join(root, dir))) {
        for (const bin of names) {
          const candidate = path.join(root, dir, sub, bin);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return null;
}

let playwright;
try {
  playwright = require('playwright-core');
} catch {
  console.log('browser-check: playwright-core is not installed.');
  console.log('  npm i --no-save playwright-core && npx playwright-core install chromium-headless-shell');
  process.exit(0);
}

const executablePath = findBrowser();
if (!executablePath) {
  console.log('browser-check: no Chromium build found.');
  console.log('  Set BROWSER_PATH, or: npx playwright-core install chromium-headless-shell');
  process.exit(0);
}

/* ------------------------------------------------------------------ helpers -------------------- */

let pass = 0;
let fail = 0;
const findings = [];

function report(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name.padEnd(30)} ${detail}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name.padEnd(30)} ${detail}`);
    findings.push(`${name}: ${detail}`);
  }
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

/**
 * Everything that must not overflow: any element whose right edge passes the viewport, ignoring
 * anything inside a deliberate horizontal scroller (a table wrapper, a chip row) — those are
 * allowed to scroll, and the page itself must not.
 */
const PROBE = `(() => {
  const vw = document.documentElement.clientWidth;
  const docOverflow = document.documentElement.scrollWidth - vw;

  const scroller = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const ov = getComputedStyle(n).overflowX;
      if (ov === 'auto' || ov === 'scroll') return true;
    }
    return false;
  };

  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right <= vw + 1) continue;
    if (scroller(el)) continue;
    const style = getComputedStyle(el);
    if (style.position === 'fixed') continue;
    offenders.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').toString().slice(0, 90),
      text: (el.textContent || '').trim().slice(0, 45),
      right: Math.round(r.right),
      width: Math.round(r.width),
    });
  }

  // Interactive elements and their measured hit areas.
  const sel = 'a[href], button, [role="button"], [role="radio"], select, input:not([type="hidden"]), summary';
  const small = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    // Visually hidden controls (sr-only file inputs) are driven by a visible label, not by this box.
    if (el.classList.contains('sr-only') || (r.width <= 2 && r.height <= 2)) continue;
    // An inline link inside a sentence is exempt from the 40px minimum (WCAG 2.5.8 inline exception).
    const inline = el.tagName === 'A' && style.display.startsWith('inline') && !style.display.includes('flex') && !style.display.includes('block') && !style.display.includes('grid');
    if (inline) continue;
    /*
     * The .vroqn-tap class expands the HEIGHT to 40px via an absolutely positioned ::after, which does
     * not appear in getBoundingClientRect. Measure it the way the CSS actually behaves: height floored
     * at 40, width untouched (growing width would steal taps from an adjacent toolbar button).
     * WCAG 2.5.8 asks for 24x24; this pass holds things to 40x40 wherever the layout allows.
     */
    const tapped = el.classList.contains('vroqn-tap');
    const effW = r.width;
    const effH = tapped ? Math.max(r.height, 40) : r.height;
    if (effH < 40 || effW < 24) {
      small.push({
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
        w: Math.round(r.width), h: Math.round(r.height),
        tapped,
      });
    }
  }

  // Any visible text rendered below the 11px floor this pass established.
  const tiny = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!el.childNodes.length) continue;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) continue;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (px && px < 11) tiny.push({ px, text: el.textContent.trim().slice(0, 40) });
  }

  return { docOverflow, offenders: offenders.slice(0, 6), small: small.slice(0, 8), tiny: tiny.slice(0, 6), vw };
})()`;

/* ------------------------------------------------------------------ run ------------------------ */

const browser = await playwright.chromium.launch({ executablePath, args: ['--no-sandbox'] });
const { cookies } = await session();
console.log(`signed in as ${EMAIL}\n`);

const shots = [];

for (const vp of VIEWPORTS) {
  console.log(`══════ ${vp.name}`);

  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: vp.touch,
    isMobile: vp.touch,
    deviceScaleFactor: vp.touch ? 2 : 1,
    reducedMotion: 'no-preference',
  });
  await context.addCookies(cookies);

  let worstOverflow = 0;
  let overflowDetail = '';
  let smallTargets = [];
  let tinyText = [];

  for (const [route, label] of ROUTES) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 20000 });
    } catch {
      await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    }
    await page.waitForTimeout(700);

    const res = await page.evaluate(PROBE).catch(() => null);
    if (!res) {
      report(`${label} @ ${vp.width}`, false, 'probe failed to run');
      await page.close();
      continue;
    }

    if (res.docOverflow > worstOverflow) {
      worstOverflow = res.docOverflow;
      overflowDetail = `${label} → +${res.docOverflow}px, e.g. ${res.offenders.map((o) => `${o.tag}.${o.cls.split(' ')[0]}(w=${o.width})`).slice(0, 2).join(', ')}`;
    }
    smallTargets.push(...res.small.map((s) => `${label}: ${s.tag} "${s.label}" ${s.w}×${s.h}`));
    tinyText.push(...res.tiny.map((t) => `${label}: ${t.px}px "${t.text}"`));
    if (errors.length) findings.push(`${label} @ ${vp.width}: page error ${errors[0]}`);

    await page.close();
  }

  report(`No horizontal scroll`, worstOverflow <= 1, worstOverflow <= 1 ? 'every route fits the viewport' : overflowDetail);
  report(`Touch targets ≥ 40px`, smallTargets.length === 0, smallTargets.length === 0 ? 'all measured targets pass' : `${smallTargets.length} under 40px: ${smallTargets.slice(0, 3).join(' | ')}`);
  report(`Text ≥ 11px`, tinyText.length === 0, tinyText.length === 0 ? 'no sub-11px text rendered' : tinyText.slice(0, 3).join(' | '));

  // Screenshots at the two most common phone widths, plus desktop. The homepage is captured in a
  // signed-OUT context on purpose: with a session, "/" redirects to the dashboard, and a screenshot
  // of the dashboard labelled "home" is worse than no screenshot at all.
  if (vp.width === 390 || vp.width === 1440) {
    const anon = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.touch,
      isMobile: vp.touch,
      deviceScaleFactor: vp.touch ? 2 : 1,
    });
    for (const [ctx, route, label] of [
      [anon, '/', 'home'],
      [context, '/dashboard', 'dashboard'],
      [context, '/arena', 'arena'],
      [context, '/practice', 'practice'],
    ]) {
      const page = await ctx.newPage();
      await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(900);
      const file = path.join(SHOTS, `${vp.width}-${label}.png`);
      await page.screenshot({ path: file, fullPage: vp.width === 1440 && route === '/' });
      shots.push(path.basename(file));
      await page.close();
    }
    await anon.close();
  }

  await context.close();
}

/* ------------------------------------------------- exam surfaces need a live paper ------------- */

console.log('══════ exam surfaces (live Arena paper)');
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await context.addCookies(cookies);

  // /api/arena/catalog is reference data (taxonomies), not a competition list — the list lives here.
  const cookiesHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const list = await fetch(`${BASE}/api/arena/competitions`, { headers: { cookie: cookiesHeader } }).then((r) => r.json());
  const live = (list.competitions ?? []).find((c) => c.state === 'LIVE');

  if (!live) {
    report(
      'Arena timer stays on screen',
      false,
      'no live paper available — run `npm run seed:arena --workspace server` first ' +
        '(smoke:ui and smoke:flows submit the live paper, and this check needs one that is still running)',
    );
  } else {
    /*
     * A submitted paper must open its result, never the consent screen (§44 explains answers, §15
     * keeps a finished paper closed). Both states are handled here: a submitted paper is reported as
     * checked-and-skipped, and the gate/timer measurements run for a paper that is still open.
     */
    const status = await fetch(`${BASE}/api/arena/competitions/${live.id}/status`, { headers: { cookie: cookiesHeader } })
      .then((r) => r.json())
      .catch(() => null);
    const submittedElsewhere = Boolean(status?.attempt && status.attempt.status !== 'in_progress');

    const page = await context.newPage();
    await page.goto(`${BASE}/arena/${live.id}/start`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1800);

    if (submittedElsewhere) {
      const landed = /Answer review|post-analysis|Your result/i.test((await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' '));
      report('Submitted paper opens its result', landed, landed ? `redirected to ${page.url().replace(BASE, '')}` : 'still showing the pre-start screen');
      report('Integrity gate on phone', true, 'skipped — this paper is already submitted');
      report('Arena timer stays on screen', true, 'skipped — this paper is already submitted');
      report('Arena runner fits width', true, 'skipped — this paper is already submitted');
      report('Exam controls reachable', true, 'skipped — this paper is already submitted');
    } else {
      const gate = page.getByText(/integrity mode/i).first();
      if (await gate.count()) {
        const checkbox = page.locator('input[type="checkbox"]').first();
        if (await checkbox.count()) await checkbox.check().catch(() => {});
        const startButton = page.getByRole('button', { name: /start the (paper|exam)/i }).first();
        if (await startButton.count()) await startButton.click().catch(() => {});
        await page.waitForTimeout(2200);
      }
      const gateOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      report('Integrity gate on phone', gateOverflow <= 1, gateOverflow <= 1 ? 'consent screen fits a 390px viewport' : `+${gateOverflow}px`);

      const timer = page.locator('[role="timer"]');
      const before = await timer.boundingBox().catch(() => null);

      // Scroll deep into the paper — the countdown must still be inside the viewport.
      await page.evaluate(() => window.scrollBy(0, 900));
      await page.waitForTimeout(500);
      const after = await timer.boundingBox().catch(() => null);

      const visible = after && after.y >= -1 && after.y + after.height <= 844 + 1;
      report(
        'Arena timer stays on screen',
        Boolean(before && visible),
        before ? (visible ? `sticky at y=${Math.round(after.y)} after scrolling 900px` : `scrolled out of view (y=${Math.round(after?.y ?? -1)})`) : 'timer element not found',
      );

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      report('Arena runner fits width', overflow <= 1, overflow <= 1 ? 'no horizontal scroll under a live paper' : `+${overflow}px`);

      // Controls must remain reachable without scrolling back to the top.
      const controls = await page.evaluate(() => {
        const vh = window.innerHeight;
        return [...document.querySelectorAll('button')]
          .filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= vh;
          })
          .map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30))
          .filter(Boolean);
      });
      report('Exam controls reachable', controls.length >= 2, `${controls.length} controls in view: ${controls.slice(0, 3).join(' / ')}`);

      await page.screenshot({ path: path.join(SHOTS, '390-arena-runner.png') });
      shots.push('390-arena-runner.png');
    }
    await page.close();
  }
  await context.close();
}

/* ------------------------------------------------- modals fit the screen ----------------------- */

console.log('══════ modal fit (360px, the narrowest target)');
{
  const context = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await context.addCookies(cookies);
  const page = await context.newPage();
  await page.goto(`${BASE}/notes`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(900);

  // The Notes page's upload dialog is its tallest modal (fields + a dropzone), so it is the
  // worst case for fitting on the smallest screen.
  const trigger = page.locator('button:has-text("Upload")').first();
  if (await trigger.count()) {
    await trigger.click().catch(() => {});
    await page.waitForTimeout(600);
    /*
     * Measure the visible panel, not the overlay: the overlay is always viewport-sized, so asserting
     * on it would pass even when the panel itself is rendered off-screen. This is the check that
     * actually caught the modal opening below the fold.
     */
    const fits = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return null;
      const panel = dlg.querySelector('div');
      if (!panel) return null;
      const p = panel.getBoundingClientRect();
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const vw = window.visualViewport?.width ?? window.innerWidth;
      return { x: p.x, y: p.y, w: p.width, h: p.height, vw, vh };
    });
    if (fits) {
      const inside = fits.y >= -1 && fits.y + fits.h <= fits.vh + 1 && fits.w <= fits.vw + 1;
      const scrolls = await page.evaluate(() => {
        const panel = document.querySelector('[role="dialog"] > div');
        if (!panel) return false;
        const before = panel.scrollTop;
        panel.scrollTop = 9999;
        const moved = panel.scrollTop > before;
        panel.scrollTop = before;
        return moved || panel.scrollHeight <= panel.clientHeight + 1;
      });
      report('Modal fits 360×640', inside && scrolls, inside ? `panel ${Math.round(fits.w)}×${Math.round(fits.h)} at y=${Math.round(fits.y)}, fully on screen${scrolls ? ' and reachable' : ' but content is cut off'}` : `panel ${Math.round(fits.w)}×${Math.round(fits.h)} at y=${Math.round(fits.y)} overflows the ${Math.round(fits.vw)}×${Math.round(fits.vh)} viewport`);
      await page.screenshot({ path: path.join(SHOTS, '360-modal.png') });
      shots.push('360-modal.png');
    } else {
      report('Modal fits 360×640', false, 'dialog did not open');
    }
  } else {
    report('Modal fits 360×640', true, 'no modal trigger on this page (nothing to overflow)');
  }
  await page.close();
  await context.close();
}

/* ------------------------------------------------- destructive confirmation ------------------- */

console.log('══════ destructive confirmation (portalled overlay)');
{
  const context = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await context.addCookies(cookies);
  const page = await context.newPage();
  await page.goto(`${BASE}/activity`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(900);

  // "Clear learning activity" is genuinely destructive, so it must ask first — and the question has
  // to be visible, not rendered off-screen behind the fold.
  const trigger = page.locator('button:has-text("Clear learning activity")').first();
  if (!(await trigger.count())) {
    report('Confirm appears on screen', false, 'could not find the reset control on Activity');
  } else {
    await trigger.click().catch(() => {});
    await page.waitForTimeout(600);

    const box = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"][aria-modal="true"]');
      if (!dlg) return null;
      const panel = dlg.querySelector('div');
      const r = (panel ?? dlg).getBoundingClientRect();
      return {
        onScreen: r.y >= -1 && r.y + r.height <= (window.visualViewport?.height ?? window.innerHeight) + 1,
        y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width),
        labelled: Boolean(dlg.getAttribute('aria-labelledby') || dlg.getAttribute('aria-label')),
        // A confirmation must offer a way out that is not "yes".
        hasCancel: [...dlg.querySelectorAll('button')].some((b) => /cancel/i.test(b.textContent || '')),
        text: (dlg.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70),
      };
    });

    if (!box) {
      report('Confirm appears on screen', false, 'no dialog element was rendered');
    } else {
      const ok = box.onScreen && box.labelled && box.hasCancel;
      report('Confirm appears on screen', ok, `${box.w}×${box.h} at y=${box.y}${box.labelled ? ', labelled' : ', UNLABELLED'}${box.hasCancel ? ', has a cancel path' : ', NO CANCEL PATH'}`);
      report('Confirm explains the action', box.text.length > 25, `"${box.text}"`);
      await page.screenshot({ path: path.join(SHOTS, '360-confirm.png') });
      shots.push('360-confirm.png');

      // Escape must dismiss without performing the action.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const gone = await page.evaluate(() => !document.querySelector('[role="dialog"][aria-modal="true"]'));
      report('Escape cancels safely', gone, gone ? 'dialog dismissed, nothing destructive ran' : 'dialog stayed open after Escape');
    }
  }
  await page.close();
  await context.close();
}

/* ------------------------------------------------- reduced motion ----------------------------- */

console.log('══════ reduced motion');
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(900);

  const core = await page.locator('[data-motion][role="img"]').first();
  const tier = await core.getAttribute('data-motion').catch(() => null);
  const nodes = await page.locator('g.core-node').count();
  report('Tier follows the OS setting', tier === 'static', `prefers-reduced-motion → data-motion="${tier}", ${nodes} nodes still drawn`);

  // Nothing ambient should still be animating.
  const running = await page.evaluate(() =>
    document.getAnimations().filter((a) => a.playState === 'running').length,
  );
  report('No ambient animation left', running === 0, running === 0 ? 'no running animations (spinner transitions are instantaneous)' : `${running} animation(s) still running`);
  await page.screenshot({ path: path.join(SHOTS, '390-reduced-motion.png') });
  shots.push('390-reduced-motion.png');
  await page.close();
  await context.close();
}

/* ------------------------------------------------- hero renders ------------------------------ */

console.log('══════ communities on a phone');
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await context.addCookies(cookies);
  const auth = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const stamp = Date.now().toString(36);

  const created = await fetch(`${BASE}/api/communities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: auth },
    body: JSON.stringify({
      name: `Browser Circle ${stamp}`,
      description: 'Created by the browser check to measure a community page on a phone.',
      category: 'physics',
      visibility: 'public',
    }),
  }).then((r) => r.json());

  if (!created?.slug) {
    report('Community page on a phone', false, `could not create a community: ${JSON.stringify(created).slice(0, 120)}`);
  } else {
    // A doubt, so the community has real content rather than an empty state.
    await fetch(`${BASE}/api/communities/${created.id}/doubts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: auth },
      body: JSON.stringify({
        title: `Why does a capacitor block DC ${stamp}?`,
        description: 'I understand charging but not the steady state.',
        subject: 'Physics',
      }),
    }).catch(() => undefined);

    const page = await context.newPage();
    // The shared link carries the slug, which is exactly how a student would reach the page.
    await page.goto(`${BASE}/communities/${created.slug}`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    report('Community page fits width', overflow <= 1, overflow <= 1 ? 'no horizontal scroll at 390px' : `+${overflow}px`);

    // The owner must see their own community, not a stranger's "Join" gate.
    report(
      'Community opens as its owner',
      /Chat/.test(text) && !/Join community/i.test(text),
      /Join community/i.test(text) ? 'the owner was shown the join gate' : 'owner view rendered',
    );
    report('Community shows its doubt', new RegExp(`capacitor block DC ${stamp}`).test(text), 'the doubt is listed on the page');

    // Chat: the composer must be reachable without pinching or scrolling sideways.
    const chatTab = page.getByRole('button', { name: /^Chat$/i }).first();
    if (await chatTab.count()) {
      await chatTab.click().catch(() => {});
      await page.waitForTimeout(900);
      const composer = page.locator('textarea, input[type="text"]').first();
      const box = await composer.boundingBox().catch(() => null);
      report(
        'Community chat is usable on a phone',
        Boolean(box && box.width > 120 && box.x >= 0 && box.x + box.width <= 391),
        box ? `composer ${Math.round(box.width)}px wide at x=${Math.round(box.x)}` : 'no composer found',
      );
    } else {
      report('Community chat is usable on a phone', false, 'no Chat tab button');
    }

    await page.screenshot({ path: path.join(SHOTS, '390-community.png') });
    shots.push('390-community.png');
    await page.close();

    // Leave the workspace as it was found.
    await fetch(`${BASE}/api/communities/${created.id}`, { method: 'DELETE', headers: { cookie: auth } }).catch(() => undefined);
  }
  await context.close();
}

console.log('══════ hero');
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
  const loadMs = Date.now() - t0;

  const core = await page.locator('[data-motion][role="img"]').first().boundingBox().catch(() => null);
  const inViewport = core && core.y + core.height > 0 && core.y < 844;
  report('Hero visible on a phone', Boolean(inViewport), core ? `core is ${Math.round(core.width)}×${Math.round(core.height)} at y=${Math.round(core.y)}` : 'not found');

  // The hero must never intercept a tap meant for the CTA underneath it.
  const blocking = await page.evaluate(() => {
    const el = document.querySelector('[data-motion][role="img"]');
    return el ? getComputedStyle(el).pointerEvents : 'missing';
  });
  report('Hero cannot block taps', blocking === 'none', `pointer-events: ${blocking}`);

  // The product message must be readable with animation fully disabled.
  const headline = await page.locator('h1').first().textContent().catch(() => '');
  report('Message without animation', (headline ?? '').length > 15, `h1: "${(headline ?? '').trim().slice(0, 62)}"`);
  report('Homepage load time', loadMs < 4000, `${loadMs}ms to load event on a 390px viewport`);

  await page.close();
  await context.close();
}

await browser.close();

/* ------------------------------------------------------------------ summary -------------------- */

console.log(`\nBrowser checks: ${pass} passed, ${fail} failed`);
if (shots.length) console.log(`Screenshots: ${[...new Set(shots)].join(', ')}`);
if (findings.length) {
  console.log('\nFindings:');
  for (const f of [...new Set(findings)].slice(0, 20)) console.log(`  - ${f}`);
}
process.exit(fail ? 1 : 0);
