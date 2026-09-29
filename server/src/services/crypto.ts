/**
 * Cryptography helpers: password hashing, secret encryption at rest, masking.
 *
 * Rules enforced here (see docs/SECURITY.md):
 *  - API keys are encrypted with AES-256-GCM before touching the database.
 *  - API keys are never returned to the client in plaintext, never logged.
 *  - Passwords use scrypt with a per-user salt and constant-time comparison.
 */
import crypto from 'node:crypto';
import { MASTER_KEY } from '../config/env.js';

/* ---------------------------- passwords ---------------------------- */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/* ------------------------- secret encryption ----------------------- */

/** Returns `v1.<iv>.<tag>.<ciphertext>` (all base64url). */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split('.');
  if (version !== 'v1') throw new Error('Unsupported secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

/** Non-reversible fingerprint, used to detect duplicate keys without storing them in clear. */
export function fingerprintOf(secret: string): string {
  return crypto.createHmac('sha256', MASTER_KEY).update(secret.trim()).digest('hex').slice(0, 24);
}

/* ------------------------------ masking ---------------------------- */

/** `sk-abc...` -> `sk-a••••••••wxyz`. Never reveals the middle of the key. */
export function maskSecret(secret: string): string {
  const s = secret.trim();
  if (s.length <= 8) return `${'•'.repeat(Math.max(4, s.length))}`;
  const head = s.slice(0, Math.min(4, Math.ceil(s.length * 0.12)));
  const tail = s.slice(-4);
  return `${head}${'•'.repeat(10)}${tail}`;
}

/** Only useful metadata about a key, safe for logs and UI. */
export function describeSecret(secret: string): { masked: string; length: number; fingerprint: string } {
  return { masked: maskSecret(secret), length: secret.trim().length, fingerprint: fingerprintOf(secret) };
}

/** Redacts anything that looks like an API key from an arbitrary string (used before logging). */
export function redactSecrets(input: string): string {
  return input
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '«redacted-google-key»')
    .replace(/gsk_[0-9A-Za-z]{20,}/g, '«redacted-groq-key»')
    .replace(/sk-or-v1-[0-9A-Za-z]{20,}/g, '«redacted-openrouter-key»')
    .replace(/sk-[0-9A-Za-z\-_]{20,}/g, '«redacted-key»')
    .replace(/(Bearer\s+)[0-9A-Za-z\-_.]{16,}/gi, '$1«redacted»');
}
