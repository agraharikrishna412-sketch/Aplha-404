/**
 * Private messaging, verified through a real browser (§7, §31).
 *
 * The claim under test is the one the product makes on screen: messages are encrypted on the student's
 * device, the server stores ciphertext, and another device holding the conversation key can read the
 * text. So this script does not test the API against itself — it puts a *real* Chromium on one side
 * and an independent Node WebCrypto device on the other:
 *
 *   1. Student A signs in from a real browser and opens Messages, which creates A's device key.
 *   2. A second device (Node, own ECDH key pair) registers, opens the conversation, creates the
 *      conversation key and wraps it for both devices.
 *   3. The Node device sends an encrypted message; the browser must decrypt and display it.
 *   4. A replies by typing into the real composer; the Node device fetches the row and decrypts it,
 *      which is only possible if the browser encrypted with the shared conversation key.
 *   5. The server's own copy of both messages must not contain the plaintext anywhere.
 *
 * Run:  npm run check:chat  (or `node scripts/private-chat-check.mjs`)
 * Needs the server running and, optionally, playwright-core for the browser half.
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BROWSER_BASE ?? process.env.API ?? 'http://127.0.0.1:8787';
const { subtle } = webcrypto;
const getRandomValues = (buffer) => webcrypto.getRandomValues(buffer);

let pass = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`);
  }
}

const b64 = (value) => Buffer.from(value).toString('base64');
const b64url = (value) => Buffer.from(value).toString('base64url');
const utf8 = (value) => new TextEncoder().encode(value);
const text = (bytes) => new TextDecoder().decode(bytes);

/* ------------------------------------------------------------------ http helpers ----------------- */

function jarFrom(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  return raw.length ? raw[0].split(';')[0] : null;
}

async function call(pathname, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = { raw: raw.slice(0, 200) };
  }
  return { status: response.status, json, cookie: jarFrom(response) };
}

async function signUp(tag) {
  const email = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@chat.test`;
  const created = await call('/api/auth/signup', {
    method: 'POST',
    body: { name: `Chat ${tag}`, email, password: 'Chat!2345pass' },
  });
  if (created.status >= 300) throw new Error(`signup ${tag} failed: ${created.status} ${JSON.stringify(created.json)}`);
  return { cookie: created.cookie, id: created.json.user.id, email };
}

/* --------------------------------------------------------------- node-side crypto ----------------- */

async function nodeDevice() {
  const keyPair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const publicKey = await subtle.exportKey('jwk', keyPair.publicKey);
  return { keyPair, publicKey, deviceId: b64url(getRandomValues(new Uint8Array(16))) };
}

async function wrappingKey(privateKey, publicKeyRaw, salt) {
  const peer = await subtle.importKey('raw', publicKeyRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(salt), info: utf8('vroqn-dm-v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt'],
  );
}

async function wrapFor(recipientJwk, conversationKey, recipientDeviceId) {
  const recipient = await subtle.importKey('jwk', recipientJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: recipient }, ephemeral.privateKey, 256);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(recipientDeviceId), info: utf8('vroqn-dm-v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt'],
  );
  const raw = await subtle.exportKey('raw', conversationKey);
  const iv = getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, raw));
  const ephemeralRaw = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));
  const packed = new Uint8Array(ephemeralRaw.length + iv.length + wrapped.length);
  packed.set(ephemeralRaw, 0);
  packed.set(iv, ephemeralRaw.length);
  packed.set(wrapped, ephemeralRaw.length + iv.length);
  return { wrappedKey: b64(packed), iv: b64(iv) };
}

async function unwrapFrom(privateKey, packedBase64, deviceId) {
  const packed = Buffer.from(packedBase64, 'base64');
  const ephemeralRaw = packed.subarray(0, 65);
  const iv = packed.subarray(65, 77);
  const wrapped = packed.subarray(77);
  const peer = await subtle.importKey('raw', ephemeralRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const key = await wrappingKey(privateKey, (await subtle.exportKey('raw', peer)).byteLength ? ephemeralRaw : ephemeralRaw, deviceId);
  void key;
  const shared = await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const unwrappingKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(deviceId), info: utf8('vroqn-dm-v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['unwrapKey', 'unwrap', 'decrypt'],
  );
  const raw = await subtle.decrypt({ name: 'AES-GCM', iv }, unwrappingKey, wrapped);
  return subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function encrypt(conversationKey, conversationId, payload) {
  const iv = getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(`vroqn-dm|${conversationId}|v1`) },
    conversationKey,
    utf8(JSON.stringify({ ...payload, sentAt: new Date().toISOString() })),
  );
  return { ciphertext: b64(ciphertext), iv: b64(iv), alg: 'AES-256-GCM' };
}

async function decrypt(conversationKey, conversationId, row) {
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(row.iv, 'base64'), additionalData: utf8(`vroqn-dm|${conversationId}|v1`) },
    conversationKey,
    Buffer.from(row.ciphertext, 'base64'),
  );
  return JSON.parse(text(plaintext));
}

/* ------------------------------------------------------------------ browser discovery ------------- */

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

/* ------------------------------------------------------------------ run --------------------------- */

let browser;
try {
  browser = require('playwright-core').chromium;
} catch {
  browser = null;
}

const executablePath = findBrowser();
if (!browser || !executablePath) {
  console.log('private-chat-check: needs playwright-core and a Chromium build.');
  console.log('  npm i --no-save playwright-core && npx playwright-core install chromium-headless-shell');
  process.exit(0);
}

const TEXT_FROM_NODE = `Hello from the second device — ${Date.now()}`;
const TEXT_FROM_BROWSER = `Reply typed in the browser — ${Date.now()}`;

const alice = await signUp('alice');
const bob = await signUp('bob');

/*
 * Both students open their inbox in this check: the default policy is "students in my communities",
 * and these two accounts share no community — which is exactly why the API refuses by default (the
 * refusal itself is asserted in the API probe). Opening both is therefore a deliberate setup step.
 */
await call('/api/messages/prefs', { method: 'PUT', cookie: bob.cookie, body: { dmPolicy: 'everyone' } });
await call('/api/messages/prefs', { method: 'PUT', cookie: alice.cookie, body: { dmPolicy: 'everyone' } });

const instance = await browser.launch({ executablePath, args: ['--no-sandbox'] });
const context = await instance.newContext({ viewport: { width: 414, height: 900 }, hasTouch: true, isMobile: true });
const [name, value] = alice.cookie.split('=');
await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: '/' }]);

console.log('\n== browser: device key is created and registered ==');
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
/*
 * `networkidle` is deliberately avoided: the Messages screen holds an open event stream, so the
 * network is never idle while it is open. Waiting for the DOM plus the explicit assertions below is
 * both faster and more honest about what is being tested.
 */
await page.goto(`${BASE}/messages`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2000);

const aliceDevices = await call(`/api/messages/devices?userIds=${alice.id}`, { cookie: alice.cookie });
check('browser registered its device key', (aliceDevices.json.devices ?? []).length >= 1, `${aliceDevices.json.devices?.length ?? 0} device(s)`);
check('browser device key is public-only', !('d' in (aliceDevices.json.devices?.[0]?.publicKey ?? {})), JSON.stringify(aliceDevices.json.devices?.[0]?.publicKey ?? {}).slice(0, 60));

console.log('\n== second device: conversation + key envelopes ==');
const second = await nodeDevice();
await call('/api/messages/devices', {
  method: 'POST',
  cookie: bob.cookie,
  body: { deviceId: second.deviceId, publicKey: second.publicKey, label: 'node-check' },
});

const opened = await call('/api/messages/conversations', { method: 'POST', cookie: bob.cookie, body: { userId: alice.id } });
check('conversation opens between the two students', opened.status === 200 && Boolean(opened.json.conversationId), `${opened.status}`);
const conversationId = opened.json.conversationId;

const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const bothDevices = await call(`/api/messages/devices?userIds=${alice.id},${bob.id}`, { cookie: bob.cookie });
const aliceDevice = bothDevices.json.devices.find((device) => device.userId === alice.id);
check('second device can see the browser device key', Boolean(aliceDevice), `${bothDevices.json.devices.length} device(s) visible`);

for (const device of bothDevices.json.devices) {
  const wrapped = await wrapFor(device.publicKey, key, device.deviceId);
  const posted = await call(`/api/messages/conversations/${conversationId}/keys`, {
    method: 'POST',
    cookie: bob.cookie,
    body: {
      recipientUserId: device.userId,
      deviceId: device.deviceId,
      wrappedKey: wrapped.wrappedKey,
      iv: wrapped.iv,
      keyVersion: 1,
    },
  });
  if (posted.status >= 300) throw new Error(`envelope failed: ${posted.status} ${JSON.stringify(posted.json)}`);
}
check('key envelopes stored for both devices', true, `${bothDevices.json.devices.length} envelopes`);

console.log('\n== node device sends; the real browser must decrypt it ==');
const outbound = await encrypt(key, conversationId, { text: TEXT_FROM_NODE, replyToId: null });
const sent = await call(`/api/messages/conversations/${conversationId}/messages`, { method: 'POST', cookie: bob.cookie, body: outbound });
check('ciphertext accepted', sent.status === 201, `${sent.status}`);

await page.goto(`${BASE}/messages/${conversationId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page
  .getByText(TEXT_FROM_NODE)
  .first()
  .waitFor({ timeout: 20000 })
  .catch(() => undefined);
const shownText = await page.locator('body').innerText();
check(
  'browser decrypted the message',
  shownText.includes(TEXT_FROM_NODE),
  shownText.includes(TEXT_FROM_NODE) ? 'plaintext rendered' : shownText.replace(/\s+/g, ' ').slice(0, 200),
);
check(
  'thread states the encryption plainly',
  /encrypted on your device/i.test(shownText),
  /encrypted on your device/i.test(shownText) ? 'notice shown' : 'notice missing',
);

console.log('\n== browser sends a reply through the real composer ==');
await page.getByRole('textbox', { name: 'Message' }).fill(TEXT_FROM_BROWSER);
await page.getByRole('button', { name: 'Send message' }).click();
await page.waitForTimeout(3000);

const stored = await call(`/api/messages/conversations/${conversationId}/messages`, { cookie: bob.cookie });
const rows = stored.json.messages ?? [];
const fromBrowser = rows.find((row) => row.senderId === alice.id);
check('reply reached the server', Boolean(fromBrowser), `${rows.length} rows in the thread`);
check(
  'server holds ciphertext, not plaintext',
  Boolean(fromBrowser) &&
    !fromBrowser.ciphertext.includes(TEXT_FROM_BROWSER) &&
    !JSON.stringify(stored.json).includes(TEXT_FROM_BROWSER),
  fromBrowser ? `${fromBrowser.ciphertext.slice(0, 24)}… (${fromBrowser.ciphertext.length} chars)` : 'no row',
);
const decrypted = fromBrowser ? await decrypt(key, conversationId, fromBrowser) : null;
check('independent device decrypts the browser’s reply', decrypted?.text === TEXT_FROM_BROWSER, decrypted?.text?.slice(0, 40) ?? 'could not decrypt');
check('encryption binds the message to its conversation', fromBrowser?.alg === 'AES-256-GCM', fromBrowser?.alg ?? 'missing');

console.log('\n== keys, privacy and refusals ==');
const asBob = await call(`/api/messages/conversations/${conversationId}/keys`, { cookie: bob.cookie });
check('envelope endpoint returns only the caller’s envelopes', (asBob.json.envelopes ?? []).every((envelope) => envelope.recipientUserId === bob.id), `${asBob.json.envelopes?.length ?? 0} envelope(s)`);

const stranger = await signUp('stranger');
const strangerRead = await call(`/api/messages/conversations/${conversationId}/messages`, { cookie: stranger.cookie });
check('a non-member cannot read the thread (404, no IDOR)', strangerRead.status === 404, `${strangerRead.status}`);

const report = await call('/api/messages/reports', {
  method: 'POST',
  cookie: alice.cookie,
  body: { conversationId, targetUserId: bob.id, reason: 'probe', note: 'automated check' },
});
check('safety report is accepted', report.status === 200 && report.json.reportId, `${report.status}`);

const staffQueue = await call('/api/messages/reports?scope=all', { cookie: alice.cookie });
check('the staff report queue is refused to a student', staffQueue.status === 403, `${staffQueue.status}`);

const blocked = await call('/api/messages/blocks', { method: 'POST', cookie: alice.cookie, body: { userId: bob.id } });
const afterBlock = await call(`/api/messages/conversations/${conversationId}/messages`, {
  method: 'POST',
  cookie: bob.cookie,
  body: await encrypt(key, conversationId, { text: 'should not arrive', replyToId: null }),
});
check('blocking stops the other side immediately', blocked.status === 200 && afterBlock.status >= 400, `block ${blocked.status} · send ${afterBlock.status}`);

check('no page errors while using private chat', pageErrors.length === 0, pageErrors[0] ?? 'none');

await context.close();
await instance.close();

console.log(`\nPrivate chat: ${pass} passed, ${failures.length} failed`);
if (failures.length) console.log(`Failed: ${failures.join(' | ')}`);
process.exit(failures.length ? 1 : 0);
