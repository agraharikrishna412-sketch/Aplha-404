/** Key handling: encryption at rest, masking, password hashing and log redaction. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decryptSecret,
  describeSecret,
  encryptSecret,
  fingerprintOf,
  hashPassword,
  maskSecret,
  redactSecrets,
  verifyPassword,
} from '../src/services/crypto.js';

describe('secret encryption', () => {
  it('round-trips a key without changing it', () => {
    const key = 'AIzaSyD-EXAMPLE-KEY-1234567890';
    const encrypted = encryptSecret(key);
    assert.notEqual(encrypted, key);
    assert.equal(decryptSecret(encrypted), key);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptSecret('gsk_example_key_value_1234567890');
    const b = encryptSecret('gsk_example_key_value_1234567890');
    assert.notEqual(a, b);
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = encryptSecret('sk-or-v1-example-example-example');
    const [version, iv, tag, data] = encrypted.split('.');
    const tampered = [version, iv, tag, `${data.slice(0, -4)}AAAA`].join('.');
    assert.throws(() => decryptSecret(tampered));
  });
});

describe('masking', () => {
  it('never reveals the middle of a key', () => {
    const key = 'AIzaSyD-EXAMPLE-MIDDLE-1234abcd';
    const masked = maskSecret(key);
    assert.ok(masked.includes('•'));
    assert.ok(!masked.includes('MIDDLE'));
    assert.ok(masked.length <= key.length);
  });

  it('keeps short keys unreadable', () => {
    assert.equal(maskSecret('short'), '•••••');
  });

  it('reports only safe metadata', () => {
    const info = describeSecret('gsk_abcdefghijklmnopqrstuvwxyz012345');
    assert.equal(info.length, 36);
    assert.ok(!info.masked.includes('mnop'));
    assert.equal(info.fingerprint.length, 24);
    assert.equal(fingerprintOf('gsk_abcdefghijklmnopqrstuvwxyz012345'), info.fingerprint);
  });
});

describe('log redaction', () => {
  it('scrubs every supported key shape', () => {
    const line = [
      'google AIzaSyD-EXAMPLE-KEY-1234567890',
      'groq gsk_abcdefghijklmnopqrstuvwxyz012345',
      'openrouter sk-or-v1-abcdefghijklmnopqrstuvwx',
      'header Bearer abcdefghijklmnopqrstuvwx',
    ].join(' | ');
    const redacted = redactSecrets(line);
    assert.ok(!redacted.includes('AIzaSyD-EXAMPLE'));
    assert.ok(!redacted.includes('gsk_abcdefghij'));
    assert.ok(!redacted.includes('sk-or-v1-abcdefghij'));
    assert.ok(!redacted.includes('Bearer abcdefghij'));
  });
});

describe('passwords', () => {
  it('hashes with a per-user salt and verifies correctly', () => {
    const hash = hashPassword('learn1234');
    assert.notEqual(hash, hashPassword('learn1234'));
    assert.ok(verifyPassword('learn1234', hash));
    assert.ok(!verifyPassword('learn1235', hash));
  });

  it('rejects malformed stored values instead of throwing', () => {
    assert.equal(verifyPassword('anything', 'not-a-hash'), false);
  });
});
