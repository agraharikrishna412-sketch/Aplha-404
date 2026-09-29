/**
 * Community ownership transfer — end to end, through the real screens.
 *
 * Why this script exists: the transfer endpoint worked and was tested on the server, but the app could
 * not reach it. Manage showed a "Transfer ownership" button that confirmed and then told the student to
 * use a "Make owner" control on the Members tab that did not exist — the API wrapper had no caller
 * anywhere. A server test cannot catch that; only driving the screens can.
 *
 * What it proves, in order:
 *
 *   1. the owner opens Manage and the Ownership section offers a working transfer gesture;
 *   2. that gesture lands on the Members tab, where a member row carries "Make owner";
 *   3. pressing it, confirming, swaps the roles — verified by re-reading both students from the API;
 *   4. the new owner really holds owner powers (transfer to the old owner is now theirs to do), and the
 *      old owner has lost them (a second transfer is refused).
 *
 * Run:  npm run smoke:ownership      (needs the server running, playwright-core + a chromium shell)
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const BASE = process.env.BROWSER_BASE ?? 'http://127.0.0.1:8787';
const OWNER_EMAIL = process.env.SMOKE_EMAIL ?? 'demo@vroqn.dev';
const OWNER_PASSWORD = process.env.SMOKE_PASSWORD ?? 'nexus1234';

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
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/tmp/pw-browsers', path.join(process.cwd(), '.pw-browsers')].filter(Boolean)) {
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
  console.error('No chromium build found. Set PLAYWRIGHT_BROWSERS_PATH or install playwright-core browsers.');
  process.exit(1);
}

const { chromium } = require('playwright-core');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });

/* ------------------------------------------------------------------ fixtures -------------------- */

const login = await context.request.post(`${BASE}/api/auth/login`, {
  data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
});
check('the owner account can sign in', login.ok(), `HTTP ${login.status()}`);
const ownerUserId = (await login.json().catch(() => null))?.user?.id ?? null;
await context.addCookies(await context.cookies());

const marker = `Tr${Date.now().toString(36).slice(-5)}`;
const circleResponse = await context.request.post(`${BASE}/api/communities`, {
  data: {
    name: `${marker} Handover Circle`,
    description: 'Created by the ownership transfer check.',
    category: 'physics',
    visibility: 'public',
  },
});
const circle = await circleResponse.json();
if (circleResponse.status() === 429) {
  /*
   * Real product rule, not a bug: an account may own at most 25 communities, and this check creates
   * one every run. When the cap is reached the check says so plainly and stops, rather than crashing
   * and leaving an unreadable stack trace behind (which is what it did the first time it met the cap).
   */
  console.log(`  ...  community creation refused: ${circle?.error?.message ?? 'rate limited'}`);
  console.log('       Delete a few communities owned by this account and run again.');
  await browser.close();
  process.exit(1);
}
check('a community exists to hand over', circleResponse.ok() && Boolean(circle?.id), circle?.slug ?? `HTTP ${circleResponse.status()}`);
if (!circle?.id) {
  await browser.close();
  process.exit(1);
}

/*
 * A second student joins, so there is somebody to hand the community to.
 *
 * Their account is created with plain `fetch` rather than through the browser context's request
 * handler: that handler shares the context's cookie jar, so signing the successor up through it would
 * quietly replace the owner's session with the successor's — which is exactly what happened the first
 * time this script ran, and it made the owner look like a member of their own community.
 */
const successorEmail = `${marker.toLowerCase()}.owner@ownership-check.vroqn.dev`;
const successorPassword = 'ownership-check-pass1';

async function plain(pathname, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const cookies = (response.headers.getSetCookie?.() ?? []).map((raw) => raw.split(';')[0]).join('; ');
  return { status: response.status, body: text ? JSON.parse(text) : null, cookies };
}

let successorStatus = await plain('/api/auth/signup', {
  method: 'POST',
  body: {
    name: `${marker} Successor`,
    email: successorEmail,
    password: successorPassword,
    classLevel: 'Class 11',
    board: 'CBSE',
  },
});
if (successorStatus.status === 409) {
  successorStatus = await plain('/api/auth/login', {
    method: 'POST',
    body: { email: successorEmail, password: successorPassword },
  });
}
const successorCookie = successorStatus.cookies;
const successorId = successorStatus.body?.user?.id ?? null;
check('a successor account exists', Boolean(successorId), successorId ? `user ${successorId.slice(0, 8)}…` : `HTTP ${successorStatus.status}`);

const join = await plain(`/api/communities/${circle.id}/join`, { method: 'POST', body: {}, cookie: successorCookie });
check('the successor is a member before the handover', join.status === 200 || join.status === 409, `HTTP ${join.status}`);

/** The successor's own view of the community, used to verify the roles actually swapped. */
const successorView = () =>
  plain(`/api/communities/${circle.id}`, { cookie: successorCookie }).then((reply) => reply.body);

/* ------------------------------------------------------------------ the screens ----------------- */

const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

await page.goto(`${BASE}/communities/${circle.slug}`, { waitUntil: 'domcontentloaded' });
// Wait for the community itself to render before looking for its controls.
const heading = await page
  .getByRole('heading', { level: 1, name: new RegExp(circle.name.slice(0, 12)) })
  .waitFor({ state: 'visible', timeout: 15000 })
  .then(() => true)
  .catch(() => false);
check('the community page renders', heading, heading ? 'heading visible' : 'heading never appeared');

// 1. The owner sees the Manage tab and the Ownership section.
const manageTab = page.getByRole('button', { name: /^Manage$/ });
if ((await manageTab.count()) === 0) {
  const view = await context.request.get(`${BASE}/api/communities/${circle.id}`);
  const body = await view.json().catch(() => null);
  console.log(`       api view: role=${body?.myRole} edit=${body?.capabilities?.edit_community} members=${body?.memberCount}`);
  console.log(`       page text: ${(await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))).slice(0, 300)}`);
  console.log(`       buttons: ${await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter(Boolean).slice(0, 14).join(' | '))}`);
}
check('the owner is offered the Manage tab', (await manageTab.count()) > 0, `${await manageTab.count()} control(s)`);
if ((await manageTab.count()) > 0) {
  await manageTab.first().click();
  await page.waitForTimeout(900);
  const transferButton = page.getByRole('button', { name: /transfer ownership/i }).first();
  const hasTransfer = (await transferButton.count()) > 0;
  check('Manage offers a transfer gesture', hasTransfer, hasTransfer ? 'button rendered' : 'no transfer control in Manage');

  if (hasTransfer) {
    await transferButton.click();
    await page.waitForTimeout(900);
    // The gesture must move the owner to where the choice is made — not just talk about it.
    const membersVisible = (await page.getByRole('button', { name: /^Make owner$/i }).count()) > 0;
    if (!membersVisible) {
      console.log(`       url: ${page.url().replace(BASE, '')}`);
      console.log(`       buttons: ${await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter(Boolean).slice(0, 18).join(' | '))}`);
      console.log(`       members api: ${JSON.stringify(await context.request.get(`${BASE}/api/communities/${circle.id}/members`).then((r) => r.json()).then((b) => (b.members ?? []).map((m) => ({ name: m.name, role: m.role, status: m.status, canChangeRole: m.canChangeRole, isSelf: m.isSelf }))))}`);
    }
    check('the transfer gesture takes the owner to a real "Make owner" action', membersVisible, membersVisible ? 'Members tab opened with the action' : 'no Make owner action anywhere');

    if (membersVisible) {
      await page.getByRole('button', { name: /^Make owner$/i }).first().click();
      await page.waitForTimeout(700);
      const confirm = page.getByRole('button', { name: /^Transfer ownership$/ }).last();
      check('the handover asks for confirmation first', (await confirm.count()) > 0, 'confirmation dialog shown');
      if ((await confirm.count()) > 0) {
        await confirm.click();
        await page.waitForTimeout(2200);

        // 2. The API now says the roles actually swapped.
        const ownerBody = await context.request.get(`${BASE}/api/communities/${circle.id}`).then((reply) => reply.json());
        const successorBody = await successorView();
        check('the chosen member is the owner now', successorBody?.myRole === 'owner', `successor role: ${successorBody?.myRole ?? 'unknown'}`);
        check(
          'the former owner is an admin, not the owner',
          ownerBody?.myRole === 'admin',
          `former owner role: ${ownerBody?.myRole ?? 'unknown'}`,
        );

        // 3. The powers moved with it, not just the label.
        const secondAttempt = await context.request.post(`${BASE}/api/communities/${circle.id}/transfer`, {
          data: { userId: successorId, confirm: true },
        });
        check('the former owner can no longer hand it over', !secondAttempt.ok(), `HTTP ${secondAttempt.status()}`);
        // Handing it back to the original owner proves the new owner really holds the capability.
        const successorCan = await plain(`/api/communities/${circle.id}/transfer`, {
          method: 'POST',
          body: { userId: ownerUserId, confirm: true },
          cookie: successorCookie,
        });
        check('the new owner can hand it back', successorCan.status === 200, `HTTP ${successorCan.status}`);
        const backAgain = await plain(`/api/communities/${circle.id}`, { cookie: successorCookie });
        check(
          'the roles swapped back cleanly',
          backAgain.body?.myRole === 'admin',
          `original owner's role now: ${backAgain.body?.myRole ?? 'unknown'}`,
        );
      }
    }
  }
}

check('the transfer flow raises no script error', pageErrors.length === 0, pageErrors[0] ?? 'no page errors');

/*
 * Tidy up: the community created for this check is deleted again, so running the check a hundred times
 * leaves the account exactly as it found it. Discover runs first (delete everything the check may have
 * registered), then the community itself, with the account that owns it.
 */
const cleanup = await context.request.delete(`${BASE}/api/communities/${circle.id}`);
console.log(`  ...  cleanup: community deleted (HTTP ${cleanup.status()})`);

await context.close();
await browser.close();

console.log(`\nOwnership check: ${pass} passed, ${findings.length} failed`);
if (findings.length) {
  console.log('\nFindings:');
  for (const finding of findings) console.log(`  - ${finding}`);
}
process.exit(findings.length ? 1 : 0);
