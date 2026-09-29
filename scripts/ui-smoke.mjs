/**
 * UI smoke harness — boots the real built client in a DOM and walks every screen.
 *
 * Why this exists: typechecking proves the code compiles and API tests prove the server answers,
 * but neither proves the app renders. This script loads the production bundle, signs in against a
 * live API, visits each route, and fails loudly on a blank screen, a wrong screen or any uncaught
 * runtime error.
 *
 * Usage (API must be running and seeded so the demo account exists):
 *   npm run seed --workspace server
 *   npm run build:smoke --workspace client
 *   npm run smoke:ui --workspace client
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, CookieJar } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'client', 'dist-smoke');
const BASE = process.argv[2] ?? 'http://localhost:8787';
const EMAIL = process.env.SMOKE_EMAIL ?? 'demo@vroqn.dev';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'nexus1234';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`[ui-smoke] ${DIST}/index.html missing — run: npm run build:smoke --workspace client`);
  process.exit(1);
}

/**
 * Every screen: the route, the `<h1>` it must render (the page header — deliberately not
 * matching the sidebar labels, which would make the test pass on a blank page) and one more
 * string unique to that screen's content.
 */
const SCREENS = [
  { name: 'Dashboard', path: '/', h1: /^Namaste, \w+/, needle: 'Ready to learn something new?' },
  { name: 'AI Tutor', path: '/tutor', h1: /.+/, needle: 'what should we understand today' },
  { name: 'Practice', path: '/practice', h1: /^Practice/, needle: 'Subject' },
  { name: 'Mock Exam', path: '/mock-exam', h1: /^Mock Exam/, needle: 'Subject' },
  { name: 'Notes', path: '/notes', h1: /^Notes/, needle: 'note' },
  { name: 'Code Lab', path: '/code-lab', h1: /^Code Lab/, needle: 'Run' },
  { name: 'Arena', path: '/arena', h1: /^Arena/, needle: 'Competitions' },
  { name: 'My competitions', path: '/arena/my-competitions', h1: /^My competitions/, needle: 'Attempt history' },
  { name: 'Learning Activity', path: '/activity', h1: /^Learning Activity/, needle: 'day' },
  { name: 'AI Settings', path: '/settings', h1: /^AI Settings/, needle: 'Gemini' },
];

const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8').replace(/\s+crossorigin/g, '');
const appJs = fs.readFileSync(path.join(DIST, 'app.js'), 'utf8');
const appCss = fs.existsSync(path.join(DIST, 'app.css')) ? fs.readFileSync(path.join(DIST, 'app.css'), 'utf8') : '';

async function session() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookies = res.headers.getSetCookie?.() ?? [];
  return cookies.map((raw) => raw.split(';')[0]);
}

const cookieHeader = (await session()).join('; ');
const errors = [];
const consoleErrors = [];

/** A DOM environment with Node's fetch wired to the same origin, cookie included. */
function makeDom(url, signedIn, cookies = cookieHeader, options = {}) {
  const { reducedMotion = false, lowEnd = false } = options;
  const jar = new CookieJar();
  if (signedIn) {
    for (const pair of cookies.split('; ')) {
      const [name, value] = pair.split('=');
      jar.setCookieSync(`${name}=${value}`, BASE, { http: true });
    }
  }

  const dom = new JSDOM(html, {
    url: new URL(url, BASE).toString(),
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    cookieJar: jar,
    virtualConsole: undefined,
  });
  const { window } = dom;

  window.addEventListener('error', (event) => errors.push(`uncaught: ${event.message ?? String(event)}`));
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    errors.push(`unhandled rejection: ${reason?.message ?? String(reason)}`);
  });

  const base = new URL(BASE);
  // Relative URLs resolve against the API origin; the httpOnly session cookie is attached by hand,
  // exactly as a browser would send it.
  window.fetch = (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const target = new URL(raw, BASE);
    const headers = new Headers(init.headers ?? {});
    if (target.origin === base.origin && signedIn) headers.set('cookie', cookies);
    return fetch(target, { ...init, headers, duplex: 'half' });
  };

  const w = window;
  // jsdom implements neither smooth scrolling nor layout observers; browsers do. Stub them so the
  // harness measures app logic rather than DOM-library gaps.
  w.HTMLElement.prototype.scrollIntoView ??= () => {};
  w.HTMLElement.prototype.scrollTo ??= () => {};
  /*
   * matchMedia is stubbed rather than absent so the harness can drive the two branches that matter
   * for the hero animation: a normal device and one where the student asked for reduced motion.
   */
  w.matchMedia = (query) => ({
    matches: reducedMotion && /prefers-reduced-motion/.test(query),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  });
  if (lowEnd === 'weak') {
    // Dual-core but adequately provisioned: orbits are fine, the seven particle streams are not.
    Object.defineProperty(w.navigator, 'hardwareConcurrency', { value: 2, configurable: true });
    Object.defineProperty(w.navigator, 'deviceMemory', { value: 4, configurable: true });
  } else if (lowEnd === 'minimal') {
    // A 1GB device: no ambient animation at all.
    Object.defineProperty(w.navigator, 'hardwareConcurrency', { value: 8, configurable: true });
    Object.defineProperty(w.navigator, 'deviceMemory', { value: 1, configurable: true });
  }
  w.scrollTo ??= () => {};
  w.confirm ??= () => true;
  w.alert ??= () => {};
  if (!w.ResizeObserver) {
    w.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!w.IntersectionObserver) {
    w.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
  }
  if (!('speechSynthesis' in w)) {
    w.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [], addEventListener() {}, removeEventListener() {} };
  }

  const script = window.document.createElement('script');
  script.textContent = appJs;
  const style = window.document.createElement('style');
  style.textContent = appCss;
  window.document.head.append(style, script);
  return dom;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
let fail = 0;

function report(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name.padEnd(18)} ${detail}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name.padEnd(18)} ${detail}`);
  }
}

// Single-screen dump for debugging:  DUMP_ROUTE=/arena/<id>/start node ../scripts/ui-smoke.mjs
if (process.env.DUMP_ROUTE) {
  const dumpDom = makeDom(process.env.DUMP_ROUTE, true);
  await wait(Number(process.env.DUMP_WAIT ?? 3500));
  const dumpText = (dumpDom.window.document.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  console.log(`===== ${process.env.DUMP_ROUTE} (${dumpText.length} chars) =====`);
  console.log(process.env.DUMP_FULL === '1' ? dumpText : dumpText.slice(0, 3000));
  if (errors.length) console.log('\nruntime errors:', errors.slice(0, 5));
  dumpDom.window.close();
  process.exit(0);
}

console.log('— signed-out visitors');
{
  // "/" is the public product page for anyone without a session. It must explain the learning loop,
  // name every feature, carry the Arena disclaimer and offer both a sign-in and a sign-up route —
  // and it must NOT be a login wall.
  const dom = makeDom('/', false);
  await wait(1500);
  const doc = dom.window.document;
  const text = (doc.body.textContent ?? '').replace(/\s+/g, ' ');
  const problems = [];
  if (!/learn/i.test(text) || !/practi[cs]e/i.test(text)) problems.push('learning loop missing');
  for (const feature of ['AI Tutor', 'Practice', 'Mock Exam', 'Notes', 'Code Lab', 'Arena']) {
    if (!text.includes(feature)) problems.push(`no ${feature} mention`);
  }
  if (!/mock/i.test(text)) problems.push('mock-exam wording missing');
  const hrefs = [...doc.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
  if (!hrefs.includes('/login')) problems.push('no /login link');
  if (!hrefs.includes('/signup')) problems.push('no /signup link');
  if (!doc.querySelector('footer')) problems.push('no footer');
  if (!doc.querySelector('h1')) problems.push('no h1');
  // An independent competition must never be presented as an official board or entrance exam.
  if (!/independent|not affiliated|unofficial/i.test(text)) problems.push('Arena disclaimer missing');

  // A brand-new student must be able to answer "where do I start?" without documentation.
  for (const question of ['What is Vroqn?', 'What can I do here?', 'Where do I start?', 'How do I practise?']) {
    if (!text.includes(question)) problems.push(`"${question}" not answered on the page`);
  }

  // Every in-page anchor must land somewhere. A dangling #anchor is invisible in a smoke test but
  // very visible to a visitor who taps it.
  const dangling = [...doc.querySelectorAll('a[href^="#"]')]
    .map((a) => a.getAttribute('href').slice(1))
    .filter((id) => id && !doc.getElementById(id));
  if (dangling.length) problems.push(`dangling anchors: ${[...new Set(dangling)].join(', ')}`);

  report('Landing page', problems.length === 0, problems.length ? problems.join(', ') : `${text.length} chars, CTA + footer + disclaimer`);

  // The hero animation: present, labelled, and its decorative internals hidden from assistive tech.
  const core = doc.querySelector('div[data-motion][role="img"]');
  const coreProblems = [];
  if (!core) coreProblems.push('knowledge core missing');
  else {
    if (!(core.getAttribute('aria-label') ?? '').length) coreProblems.push('core has no aria-label');
    if (core.querySelector('svg')?.getAttribute('aria-hidden') !== 'true') coreProblems.push('core SVG is exposed to screen readers');
    if (!core.querySelector('circle[stroke-dasharray]')) coreProblems.push('progress arc missing');
    if (core.querySelectorAll('g.core-node').length !== 7) coreProblems.push('expected 7 learning nodes');
    if (core.querySelectorAll('g[class^="core-orbit"]').length !== 3) coreProblems.push('expected 3 orbit rings');
    if (!['full', 'reduced', 'static'].includes(core.getAttribute('data-motion') ?? '')) {
      coreProblems.push(`unknown motion tier "${core.getAttribute('data-motion')}"`);
    }
  }
  report('Hero animation', coreProblems.length === 0, coreProblems.length ? coreProblems.join(', ') : `Knowledge core rendered, tier=${core.getAttribute('data-motion')}`);
  dom.window.close();
}

{
  // Same page, but the student has asked the OS for reduced motion: the core must switch to the
  // static tier and stop animating, while still rendering the whole diagram.
  const dom = makeDom('/', false, cookieHeader, { reducedMotion: true });
  await wait(1500);
  const core = dom.window.document.querySelector('div[data-motion][role="img"]');
  const ok = core?.getAttribute('data-motion') === 'static' && core.querySelectorAll('g.core-node').length === 7;
  report('Hero reduced motion', ok, ok ? 'tier=static, diagram still complete' : `tier=${core?.getAttribute('data-motion')}`);
  dom.window.close();
}

{
  // A modest dual-core handset: the orbit and pulse stay, the seven particle streams are dropped.
  const dom = makeDom('/', false, cookieHeader, { lowEnd: 'weak' });
  await wait(1500);
  const core = dom.window.document.querySelector('div[data-motion][role="img"]');
  const tier = core?.getAttribute('data-motion');
  const particles = core?.querySelectorAll('path.core-flow').length ?? -1;
  const ok = tier === 'reduced' && particles === 0;
  report(
    'Hero on weak hardware',
    ok,
    ok ? 'tier=reduced, particles dropped, diagram intact' : `tier=${tier}, particles=${particles}`,
  );
  dom.window.close();
}

{
  // A 1GB device: fully static, and still a complete diagram.
  const dom = makeDom('/', false, cookieHeader, { lowEnd: 'minimal' });
  await wait(1500);
  const core = dom.window.document.querySelector('div[data-motion][role="img"]');
  const tier = core?.getAttribute('data-motion');
  const ok = tier === 'static' && core?.querySelectorAll('g.core-node').length === 7;
  report('Hero on minimal hardware', ok, ok ? 'tier=static, diagram intact' : `tier=${tier}`);
  dom.window.close();
}
{
  const dom = makeDom('/login', false);
  await wait(1200);
  const text = (dom.window.document.body.textContent ?? '').replace(/\s+/g, ' ');
  report('Login screen', /sign in|log in|email/i.test(text), text.slice(0, 80));
  dom.window.close();
}

console.log('— signed-in screens');
for (const screen of SCREENS) {
  const dom = makeDom(screen.path, true);
  await wait(1500);
  const doc = dom.window.document;
  const h1 = doc.querySelector('h1')?.textContent?.trim() ?? '';
  const text = (doc.body.textContent ?? '').replace(/\s+/g, ' ');
  const problems = [];
  if (!screen.h1.test(h1)) problems.push(`h1="${h1.slice(0, 40)}"`);
  if (!text.toLowerCase().includes(screen.needle.toLowerCase())) problems.push(`missing "${screen.needle}"`);
  if (text.length < 400) problems.push('page looks empty');
  report(screen.name, problems.length === 0, problems.length ? problems.join(', ') : `${h1} — ${text.length} chars`);
  dom.window.close();
}


/* ------------------------------- interactions ------------------------------- */

const findButton = (doc, pattern) =>
  [...doc.querySelectorAll('button')].find((b) => pattern.test(b.textContent ?? ''));
const waitFor = async (doc, pattern, timeout = 12000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (pattern.test((doc.body.textContent ?? '').replace(/\s+/g, ' '))) return true;
    await wait(250);
  }
  return false;
};
const type = (el, value) => {
  const win = el.ownerDocument.defaultView;
  const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
};
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));

/**
 * Passes the integrity gate that now stands in front of every timed paper (§44).
 *
 * The runner will not start, and nothing is recorded, until the student has read what is monitored and
 * accepted it. A smoke test therefore has to accept it exactly as a student would — which is also the
 * assertion that the gate is really there.
 */
async function acceptIntegrityGate(doc, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const text = (doc.body.textContent ?? '').replace(/\s+/g, ' ');
    if (/integrity mode/i.test(text)) {
      const checkbox = doc.querySelector('input[type="checkbox"]');
      if (checkbox) {
        click(checkbox);
        await wait(140);
      }
      const start = [...doc.querySelectorAll('button')].find((b) => /start the (paper|exam)/i.test(b.textContent ?? ''));
      if (start) click(start);
      /*
       * The text the gate itself showed is returned, because accepting it replaces the gate with the
       * runner: reading the DOM afterwards measures the wrong screen.
       */
      return { seen: true, text };
    }
    if (/Question palette/.test(text)) return { seen: false, text }; // already inside the paper
    await wait(200);
  }
  return { seen: false, text: '' };
}


console.log('— brand-new account (true first-run experience)');
{
  const email = `smoke-${Date.now()}@vroqn.dev`;
  const res = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Test Student', email, password: 'testing1234', classLevel: 'Class 9', board: 'CBSE' }),
  });
  if (!res.ok) {
    report('Signup', false, `${res.status} ${await res.text()}`);
  } else {
    const freshCookies = (res.headers.getSetCookie?.() ?? []).map((raw) => raw.split(';')[0]).join('; ');
    report('Signup', true, email);
    for (const [name, route, h1, needle] of [
      ['Empty dashboard', '/', /^Namaste, Test/, 'start'],
      ['Empty activity', '/activity', /^Learning Activity/, 'no'],
      ['Empty notes', '/notes', /^Notes/, 'note'],
    ]) {
      const dom = makeDom(route, true, freshCookies);
      await wait(1800);
      const doc = dom.window.document;
      const heading = doc.querySelector('h1')?.textContent?.trim() ?? '';
      const text = (doc.body.textContent ?? '').replace(/\s+/g, ' ');
      const ok = h1.test(heading) && text.length > 400;
      report(name, ok, ok ? `${heading} — ${text.length} chars (no crash on empty data)` : `h1="${heading.slice(0, 40)}" len=${text.length}`);
      dom.window.close();
    }
  }
}

console.log('— interactions');
{
  // 1. Sidebar navigation from the dashboard into the Code Lab (client-side routing).
  const dom = makeDom('/', true);
  await wait(1500);
  const doc = dom.window.document;
  const codeLink = [...doc.querySelectorAll('a')].find((a) => /code lab/i.test(a.textContent ?? ''));
  if (codeLink) click(codeLink);
  await wait(1200);
  const onCodeLab = /^Code Lab/.test(doc.querySelector('h1')?.textContent ?? '');
  report('Nav → Code Lab', onCodeLab, `h1="${doc.querySelector('h1')?.textContent?.trim()}"`);

  // 2. Code Lab: type a program, press Run, expect stdout in the output pane.
  const editor = doc.querySelector('textarea');
  if (!editor) {
    report('Code run', false, 'no editor textarea found');
  } else {
    type(editor, 'console.log("nexus smoke " + (6 * 7));');
    const run = findButton(doc, /^\s*Run/);
    if (!run) {
      report('Code run', false, 'no Run button found');
    } else {
      click(run);
      const ok = await waitFor(doc, /nexus smoke 42/);
      report('Code run', ok, ok ? 'stdout rendered: nexus smoke 42' : 'no stdout after 12s');
    }
  }
  if (dom.window.document.body.textContent?.includes('Sample')) {
    // sample-mode notice is expected without keys — nothing to assert
  }
  dom.window.close();
}
{
  // 3. AI Tutor: ask a question, expect a structured answer streamed back.
  const dom = makeDom('/tutor', true);
  await wait(1600);
  const doc = dom.window.document;
  const composer = [...doc.querySelectorAll('textarea, input')].find((el) => el.tagName === 'TEXTAREA');
  if (!composer) {
    report('Tutor answer', false, 'no composer found');
  } else {
    type(composer, 'What is inertia? Explain simply.');
    const send = doc.querySelector('button[aria-label="Send question"]') ?? findButton(doc, /send|ask/i);
    if (!send) {
      report('Tutor answer', false, 'no send button found');
    } else {
      click(send);
      const structured = await waitFor(doc, /Concept[\s\S]*Explanation/, 20000);
      report('Tutor answer', structured, structured ? 'structured answer streamed in' : 'no answer after 20s');
    }
  }
  dom.window.close();
}
{
  // 4. Practice: build a set and confirm questions appear with a working answer flow.
  const dom = makeDom('/practice', true);
  await wait(1600);
  const doc = dom.window.document;
  const generate = findButton(doc, /generate|build|start|practise|practice set/i);
  if (!generate) {
    report('Practice set', false, 'no generate button found');
  } else {
    click(generate);
    const hasQuestions = await waitFor(doc, /question\s*1/i, 20000);
    const hasOption = /[A-D]\)|option/i.test(doc.body.textContent ?? '');
    report('Practice set', hasQuestions, hasQuestions ? `questions rendered${hasOption ? ' with options' : ''}` : 'no questions after 20s');
  }
  dom.window.close();
}


console.log('— exam runner and result analysis');
{
  const auth = { 'content-type': 'application/json', cookie: cookieHeader };
  const created = await fetch(`${BASE}/api/exams`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      subject: 'Physics',
      chapters: ['Laws of Motion'],
      difficulty: 'medium',
      questionCount: 4,
      questionType: 'mcq',
      durationMin: 10,
      title: 'Smoke Harness Mock',
    }),
  });
  /* ------------------------------- communities ------------------------------- */

  console.log('— communities (created through the real API, then rendered)');
  {
    const stamp = Date.now().toString(36);
    const madeCommunity = await fetch(`${BASE}/api/communities`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: `Smoke Physics ${stamp}`,
        description: 'A community created by the UI smoke harness to render the real screens.',
        category: 'physics',
        tags: ['physics'],
        visibility: 'public',
        rules: 'Be kind. Show your attempt before asking.',
        welcomeMessage: 'Welcome! Start by introducing yourself in chat.',
      }),
    });
    const community = await madeCommunity.json();
    if (!community?.slug) {
      report('Community create', false, `could not create a community: ${madeCommunity.status}`);
    } else {
      report('Community create', true, `${community.name} (${community.slug})`);

      for (const [label, url, needle] of [
        ['Community home tab', `/communities/${community.slug}`, /Members/],
        ['Community chat tab', `/communities/${community.slug}?tab=chat`, /chat/i],
        ['Community doubts tab', `/communities/${community.slug}?tab=doubts`, /doubt/i],
      ]) {
        const dom = makeDom(url, true);
        await wait(2200);
        const text = (dom.window.document.body.textContent ?? '').replace(/\s+/g, ' ');
        report(label, needle.test(text), `${text.length} chars`);
        dom.window.close();
      }

      // Content the student must not lose: a doubt asked here should be searchable in the tab.
      const asked = await fetch(`${BASE}/api/communities/${community.id}/doubts`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ title: `Smoke doubt ${stamp}?`, description: 'Rendering check.', subject: 'Physics' }),
      });
      report('Community doubt create', asked.status === 201, String(asked.status));
      const doubtsDom = makeDom(`/communities/${community.slug}?tab=doubts`, true);
      await wait(2300);
      report(
        'Community doubt renders',
        new RegExp(`Smoke doubt ${stamp}`).test((doubtsDom.window.document.body.textContent ?? '').replace(/\s+/g, ' ')),
        'the doubt list shows what was just posted',
      );
      doubtsDom.window.close();
    }
  }

  const exam = (await created.json()).exam;
  if (!exam?.id) {
    report('Exam create', false, `could not create exam: ${created.status}`);
  } else {
    report('Exam create', true, `${exam.title} (${exam.questions.length} questions)`);

    const runner = makeDom(`/mock-exam/${exam.id}`, true);
    await wait(1800);
    await acceptIntegrityGate(runner.window.document);
    /*
     * Wait for the palette, which only the runner has. `/question/i` matched the gate's own copy
     * ("one question at a time"), so this used to resolve while the gate was still on screen and then
     * measure an empty page.
     */
    await waitFor(runner.window.document, /Question palette/, 9000);
    const runnerH1 = runner.window.document.querySelector('h1')?.textContent?.trim() ?? '';
    const runnerText = (runner.window.document.body.textContent ?? '').replace(/\s+/g, ' ');
    report('Exam runner', runnerH1.includes('Smoke Harness'), `h1="${runnerH1}" timer=${/\d{1,2}:\d{2}/.test(runnerText)}`);
    runner.window.close();

    // Answer every question, submit, then load the analysis screen.
    const answers = exam.questions.map((q) => ({ questionId: q.id, answer: 'A', timeMs: 5000 }));
    const submitted = await fetch(`${BASE}/api/exams/${exam.id}/submit`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ answers, timeSpentMs: 60_000 }),
    });
    const result = (await submitted.json()).result;
    if (!result?.id) {
      report('Exam result', false, `submit failed: ${submitted.status}`);
    } else {
      const dom = makeDom(`/mock-exam/results/${result.id}`, true);
      await wait(1900);
      const doc = dom.window.document;
      const heading = doc.querySelector('h1')?.textContent?.trim() ?? '';
      const text = (doc.body.textContent ?? '').replace(/\s+/g, ' ');
      const ok = text.length > 600 && /accuracy|score|weak|strong|revis/i.test(text);
      report('Exam result', ok, ok ? `${heading} — analysis rendered (${text.length} chars)` : `${heading} — analysis missing`);
      dom.window.close();
    }
    await fetch(`${BASE}/api/exams/${exam.id}`, { method: 'DELETE', headers: auth });
  }
}


console.log('— arena (competitive exam surface)');
{
  const headers = { cookie: cookieHeader, 'content-type': 'application/json' };
  const catalog = await fetch(`${BASE}/api/arena/competitions`, { headers }).then((r) => r.json());
  const rows = catalog.competitions ?? [];
  const live = rows.find((row) => row.state === 'LIVE');
  const published = rows.find((row) => row.state === 'RESULTS_PUBLISHED');

  if (!live || !published) {
    report('Arena data', false, 'seeded demo competitions not found — run npm run seed:arena --workspace server');
  } else {
    // Competition detail: instructions first, no answer key anywhere in the payload.
    const detail = makeDom(`/arena/${published.id}`, true);
    await wait(1700);
    const detailText = (detail.window.document.body.textContent ?? '').replace(/\s+/g, ' ');
    report(
      'Competition detail',
      /How this paper is structured/.test(detailText) && /Instructions/.test(detailText) && /Server time now/.test(detailText),
      `${detailText.length} chars`,
    );
    report('Detail marks it as demo', /demo competition/i.test(detailText), 'seeded paper flagged');
    detail.window.close();

    // Results + post-analysis for the attempt the seeder graded.
    const history = await fetch(`${BASE}/api/arena/history`, { headers }).then((r) => r.json());
    const graded = (history.history ?? []).find((attempt) => attempt.resultsPublished);
    if (!graded) {
      report('Arena result', false, 'no published result in the demo history');
    } else {
      const resultDom = makeDom(`/arena/results/${graded.attemptId}`, true);
      await wait(2000);
      const resultText = (resultDom.window.document.body.textContent ?? '').replace(/\s+/g, ' ');
      const resultOk =
        /AI post-analysis/.test(resultText) &&
        /Where the marks went/.test(resultText) &&
        /How you used the time/.test(resultText) &&
        /Fix it now/.test(resultText);
      report('Result analysis', resultOk, resultOk ? `${resultText.length} chars` : resultText.slice(0, 160));
      report(
        'Benchmark + review',
        /Percentile/.test(resultText) && /Answer review/.test(resultText) && /Correct answer/.test(resultText),
        'percentile, answer key and explanations rendered',
      );
      const reviewButtons = [...resultDom.window.document.querySelectorAll('button')].map((b) => b.textContent ?? '');
      report('Review filters', reviewButtons.some((label) => /Wrong \(/.test(label)), 'wrong/skipped/correct filters present');
      resultDom.window.close();
    }

    // The runner: full-screen exam mode, server clock, autosave.
    const status = await fetch(`${BASE}/api/arena/competitions/${live.id}/status`, { headers }).then((r) => r.json());
    const alreadySubmitted = status.attempt && status.attempt.status !== 'in_progress';
    const runnerDom = makeDom(`/arena/${live.id}/start`, true);
    await wait(2500);
    const readRunner = () => (runnerDom.window.document.body.textContent ?? '').replace(/\s+/g, ' ');
    if (alreadySubmitted) {
      // The paper was submitted elsewhere (e.g. the API smoke ran first): the runner sends the
      // student straight to the result screen instead of reopening a closed paper.
      const landed = await waitFor(runnerDom.window.document, /post-analysis|Answer review/, 9000);
      report('Runner redirect', landed, landed ? 'submitted paper goes to its result' : readRunner().slice(0, 160));
    } else {
      const gate = await acceptIntegrityGate(runnerDom.window.document);
      if (gate.seen) {
        report(
          'Integrity gate',
          /not an official|independent/i.test(gate.text) && /full-screen|full screen/i.test(gate.text),
          'the student is told what is monitored before anything is recorded',
        );
      } else {
        report('Integrity gate', false, 'no consent screen appeared before the paper');
      }
      await waitFor(runnerDom.window.document, /Question palette/, 9000);
      const runnerText = readRunner();
      report(
        'Exam runner',
        /Question palette/.test(runnerText) && /Autosave on|Answers saved/.test(runnerText) && /Submit paper/.test(runnerText),
        `${runnerText.length} chars`,
      );
      report('Runner hides chrome', !/Learning Activity/.test(runnerText), 'no sidebar or bottom nav during an exam');
      const clock = /\d{2}:\d{2}/.test(readRunner());
      report('Runner clock', clock, 'countdown rendered');
      // Option buttons are the only pressed-state buttons in the runner that are not the flag toggle.
      const optionButtons = [...runnerDom.window.document.querySelectorAll('button[aria-pressed]')].filter(
        (b) => !/^flag/i.test((b.textContent ?? '').trim()),
      );
      if (optionButtons.length) {
        click(optionButtons[0]);
        await wait(2200);
        const afterClick = (runnerDom.window.document.body.textContent ?? '').replace(/\s+/g, ' ');
        report('Answer autosaves', /Answers saved|Saving/.test(afterClick), 'answer synced to the server');
        const saved = await fetch(`${BASE}/api/arena/competitions/${live.id}/status`, { headers }).then((r) => r.json());
        report('Attempt persisted', Boolean(saved.attempt?.id), `attempt ${saved.attempt?.id ?? 'missing'} on the server`);
      } else {
        report('Answer controls', false, 'no option buttons rendered');
      }
    }
    runnerDom.window.close();
  }
}

if (consoleErrors.length) {
  console.log('\nConsole errors:');
  for (const line of [...new Set(consoleErrors)].slice(0, 10)) console.log(`  - ${line}`);
}
if (errors.length) {
  console.log('\nRuntime errors:');
  for (const line of [...new Set(errors)].slice(0, 10)) console.log(`  - ${line}`);
}

console.log(`\nUI screens rendered: ${pass}   failed: ${fail}   runtime errors: ${errors.length}`);
process.exit(fail || errors.length ? 1 : 0);
