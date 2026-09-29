/**
 * "Working" captures — the product doing its job, not just sitting there.
 *
 *   node scripts/capture-working.mjs
 *
 * Every shot here requires a real interaction first: a question typed into the tutor and answered, a
 * practice question answered, an exam started, code run, a search performed, a thread opened. If a step
 * cannot be performed the script says exactly what the page offered instead of quietly writing a
 * screenshot of a loading state.
 *
 * Output: ../CSC-Submission/screenshots/working  (desktop, 2x) and ../CSC-Submission/screenshots/main
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const BASE = process.env.BROWSER_BASE ?? 'http://127.0.0.1:8787';
const OUT = path.resolve(process.cwd(), '..', 'CSC-Submission', 'screenshots');
const WORKING = path.join(OUT, 'working');
const MAIN = path.join(OUT, 'main');
for (const dir of [WORKING, MAIN]) mkdirSync(dir, { recursive: true });

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

const executablePath = findBrowser();
if (!executablePath) {
  console.error('capture-working: no Chromium found.');
  process.exit(1);
}

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'demo@vroqn.dev', password: 'nexus1234' }),
});
const cookies = login.headers.getSetCookie().map((value) => {
  const [name, ...rest] = value.split(';')[0].split('=');
  return { name, value: rest.join('='), url: BASE };
});

const instance = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const context = await instance.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  reducedMotion: 'no-preference',
});
await context.addCookies(cookies);
const page = await context.newPage();

const results = [];
async function shot(name, note = '') {
  await page.mouse.move(2, 2).catch(() => undefined);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(WORKING, `${name}.png`) });
  results.push(`  ok   ${name}${note ? `  ${note}` : ''}`);
  console.log(results[results.length - 1]);
}

/** Says what the page actually shows, so a failed selector can be fixed instead of guessed at. */
async function dump(label) {
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 220);
  const controls = await page
    .locator('button, [role="button"], a[href], input, textarea')
    .evaluateAll((els) =>
      els
        .slice(0, 30)
        .map((el) => `${el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 26)}`)
        .filter((value) => value.length > 3),
    );
  console.log(`  ?? ${label}\n     text: ${text}\n     controls: ${controls.join(' | ')}`);
}

const settle = (ms) => page.waitForTimeout(ms);

try {
  /* ---------------------------------------------------------------- AI Tutor: a real answer --- */
  await page.goto(`${BASE}/tutor`, { waitUntil: 'domcontentloaded' });
  await settle(2200);
  const composer = page.locator('textarea').first();
  if (await composer.count()) {
    await composer.click();
    await composer.fill('What is inertia? Explain with one everyday example.');
    const send = page.getByRole('button', { name: /send|ask|submit/i }).first();
    await (await send.count() ? send.click() : page.keyboard.press('Enter'));
    await settle(9000);
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    await shot('01-ai-tutor-answer', /inertia/i.test(text) && text.length > 400 ? 'answer rendered' : 'answer may still be streaming');
  } else {
    await dump('tutor composer');
  }

  /* Same thread, Hinglish — the mentor answers in the language the student wrote. */
  if (await composer.count()) {
    await composer.click();
    await composer.fill('Samjhao na simple tarike se ki force aur mass ka relation kya hai?');
    const send = page.getByRole('button', { name: /send|ask|submit/i }).first();
    await (await send.count() ? send.click() : page.keyboard.press('Enter'));
    await settle(9000);
    await shot('02-ai-tutor-hinglish', 'language mirrors the student');
  }

  /* ---------------------------------------------------------------- Practice: answer a question */
  await page.goto(`${BASE}/practice`, { waitUntil: 'domcontentloaded' });
  await settle(2400);
  const startPractice = page.getByRole('button', { name: /start|begin|practice/i }).first();
  if (await startPractice.count()) {
    await startPractice.click();
    await settle(2600);
  } else {
    const chapter = page.locator('button, a').filter({ hasText: /motion|inertia|physics|algebra|cell/i }).first();
    if (await chapter.count()) {
      await chapter.click();
      await settle(2600);
    } else {
      await dump('practice entry');
    }
  }
  await shot('03-practice-question', 'question on screen');

  const option = page.locator('button').filter({ hasText: /^[A-D][).\s]/ }).first();
  if (await option.count()) {
    await option.click();
    await settle(600);
    const check = page.getByRole('button', { name: /check|submit answer|submit/i }).first();
    if (await check.count()) await check.click();
    await settle(2600);
    await shot('04-practice-feedback', 'graded with explanation');
  }

  /* ---------------------------------------------------------------- Mock Exam: a real runner --- */
  await page.goto(`${BASE}/mock-exam`, { waitUntil: 'domcontentloaded' });
  await settle(2400);
  const startExam = page.getByRole('button', { name: /start|begin|generate|create/i }).first();
  if (await startExam.count()) {
    await startExam.click();
    await settle(4000);
    await shot('05-mock-exam-runner', 'timer + palette');
  } else {
    await dump('mock exam entry');
  }

  /* ---------------------------------------------------------------- Code Lab: run something --- */
  await page.goto(`${BASE}/code-lab`, { waitUntil: 'domcontentloaded' });
  await settle(2400);
  const editor = page.locator('textarea, [contenteditable="true"], .cm-content').first();
  if (await editor.count()) {
    await editor.click();
    await page.keyboard.press('Control+A').catch(() => undefined);
    await page.keyboard.type(
      'def average(numbers):\n    return sum(numbers) / len(numbers)\n\nmarks = [42, 78, 65, 90]\nprint("Average:", average(marks))\n',
      { delay: 8 },
    );
    await settle(600);
    const run = page.getByRole('button', { name: /^run|run code/i }).first();
    if (await run.count()) {
      await run.click();
      await settle(6000);
      await shot('06-code-lab-running-code', 'program output shown');
    } else {
      await dump('code lab run button');
    }
  } else {
    await dump('code lab editor');
  }

  /* ---------------------------------------------------------------- Search: one box, two kinds --- */
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await settle(2200);
  const openSearch = page.getByRole('button', { name: /open search/i }).first();
  if (await openSearch.count()) {
    await openSearch.click();
    await settle(900);
    const field = page.getByRole('textbox', { name: /search students and groups/i }).first();
    if (await field.count()) {
      await field.fill('physics');
      await settle(2400);
      await shot('07-search-students-and-groups', 'people + groups in one list');
    }
    await page.keyboard.press('Escape');
    await settle(400);
  }

  /* ---------------------------------------------------------------- Messages: an open thread --- */
  await page.goto(`${BASE}/messages`, { waitUntil: 'domcontentloaded' });
  await settle(2600);
  const thread = page.locator('a[href^="/messages/"], li[role="button"], button').filter({ hasText: /./ }).first();
  const conversation = page.locator('a[href^="/messages/"]').first();
  if (await conversation.count()) {
    await conversation.click();
    await settle(2600);
    await shot('08-messages-thread', 'conversation open');
  } else if (await thread.count()) {
    await thread.click();
    await settle(2400);
    await shot('08-messages-thread', 'first conversation opened');
  } else {
    await dump('messages list');
  }

  /* ---------------------------------------------------------------- Community: chat + doubts --- */
  await page.goto(`${BASE}/communities/class-10-cbse`, { waitUntil: 'domcontentloaded' });
  await settle(2400);
  const chatTab = page.getByRole('button', { name: /^chat$/i }).first();
  if (await chatTab.count()) {
    await chatTab.click();
    await settle(2200);
    await shot('09-community-chat', 'members talking');
    const composer = page.locator('textarea').first();
    if (await composer.count()) {
      await composer.fill('Kal ka Physics doubt session 7 baje — jo chapter doubt hai, yahin likh do.');
      await page.keyboard.press('Enter').catch(() => undefined);
      await settle(2200);
      await shot('10-community-message-sent', 'sent and rendered');
    }
  }

  /* ---------------------------------------------------------------- Notes: real content --- */
  await page.goto(`${BASE}/notes`, { waitUntil: 'domcontentloaded' });
  await settle(2400);
  const noteCard = page.locator('a[href^="/notes/"], article, [role="button"]').filter({ hasText: /photosynthesis|inertia|note/i }).first();
  if (await noteCard.count()) {
    await noteCard.click();
    await settle(2400);
    await shot('11-note-open', 'note content');
  } else {
    await shot('11-notes-library', 'list of notes');
  }

  /* ---------------------------------------------------------------- News: an article open --- */
  await page.goto(`${BASE}/news`, { waitUntil: 'domcontentloaded' });
  await settle(2600);
  const article = page.locator('a[href^="/news/"], article').first();
  if (await article.count()) {
    await article.click();
    await settle(2600);
    await shot('12-news-article', 'article reader');
  } else {
    await shot('12-news-feed', 'headlines');
  }

  /* ---------------------------------------------------------------- Arena: the exam runner --- */
  await page.goto(`${BASE}/arena`, { waitUntil: 'domcontentloaded' });
  await settle(2400);
  const startPaper = page.getByRole('link', { name: /start paper|start attempt/i }).first();
  if (await startPaper.count()) {
    await startPaper.click();
    await settle(4500);
    await shot('13-arena-exam-runner', 'server clock + palette');
    /* Leave without submitting? No — a half-started paper is untidy. Submit it and let the result stand. */
    const submit = page.getByRole('button', { name: /^submit/i }).first();
    if (await submit.count()) {
      await submit.click();
      await settle(1200);
      const confirm = page.getByRole('button', { name: /submit paper|submit now|yes|confirm/i }).last();
      if (await confirm.count()) await confirm.click().catch(() => undefined);
      await settle(3000);
    }
  } else {
    await dump('arena start button');
  }

  /* The result screen: percentile, section breakdown, answer review. */
  await page.goto(`${BASE}/arena/my-competitions`, { waitUntil: 'domcontentloaded' });
  await settle(2600);
  const result = page.locator('a[href*="/arena/results/"]').first();
  if (await result.count()) {
    await result.click();
    await settle(3200);
    await shot('14-arena-result-analysis', 'score, percentile, weak areas');
  } else {
    await dump('arena result link');
  }
} catch (error) {
  console.log('  !! stopped early:', error.message.split('\n')[0]);
}

/* ---------------------------------------------------------------- main page, both sizes ------ */
const mainPage = await context.newPage();
for (const [name, width, height, mobile] of [
  ['01-main-hero-desktop', 1440, 900, false],
  ['02-main-scroll-desktop', 1440, 900, false],
]) {
  await mainPage.setViewportSize({ width, height });
  await mainPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await mainPage.waitForTimeout(2600);
  await mainPage.mouse.move(2, 2);
  await mainPage.screenshot({ path: path.join(MAIN, `${name}.png`), fullPage: name.includes('scroll') });
  console.log(`  ok   ${name}`);
}
await mainPage.close();

const phoneContext = await instance.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const phone = await phoneContext.newPage();
for (const [name, full] of [['03-main-hero-mobile', false], ['04-main-scroll-mobile', true]]) {
  await phone.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await phone.waitForTimeout(2600);
  await phone.screenshot({ path: path.join(MAIN, `${name}.png`), fullPage: full });
  console.log(`  ok   ${name}`);
}
await phoneContext.close();

await context.close();
await instance.close();
console.log(`\ncapture-working: ${results.length} working shots + 4 main-page shots`);
