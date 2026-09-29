/**
 * Client-side end-to-end encryption for private messages (§7).
 *
 * What this actually does — stated plainly, because the UI is only allowed to claim what is true:
 *
 *   · Each browser profile generates its own ECDH P-256 device identity. The private half is created
 *     **non-extractable** and never leaves WebCrypto; the server is given the public JWK only
 *     (`x`, `y`, `crv`, `kty` — never `d`).
 *   · Every conversation has its own random AES-256-GCM key. A message is encrypted with that key
 *     before it is sent; the server stores ciphertext, an IV and a key version, and nothing else.
 *   · The conversation key is delivered to each participant's device wrapped with ECDH + HKDF-SHA256
 *     + AES-GCM (`wrapKey`). The wrapped blob carries the ephemeral public key, so the server never
 *     needs to hold — or understand — any key material.
 *
 * What this deliberately does not do: it is not "verified" end-to-end encryption (no safety-number
 * comparison between students yet), and it cannot protect a student whose device is already
 * compromised. Both limitations are stated in the product, not hidden.
 */
import { bytesToBase64, base64ToBytes, utf8Encode, utf8Decode } from './format';

const DB_NAME = 'vroqn-private';
const DB_VERSION = 1;
const IDENTITY_STORE = 'identity';
const KEY_STORE = 'conversation-keys';
const HKDF_INFO = 'vroqn-dm-v1';
/**
 * Usages for the derived key-wrapping key.
 *
 * `encrypt`/`decrypt` are required as well as `wrapKey`/`unwrapKey`: WebCrypto refuses to use a key
 * for an operation it was not created with, and this module encrypts the raw conversation key with
 * AES-GCM rather than calling `wrapKey` (the raw export is what travels in the envelope).
 */
const WRAP_USAGES: KeyUsage[] = ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'];
const ENVELOPE_VERSION = 1;

export interface DeviceIdentity {
  /** Random per-browser id, also used as the HKDF salt so each device gets a distinct wrapping key. */
  deviceId: string;
  keyPair: CryptoKeyPair;
  publicKey: JsonWebKey;
  createdAt: string;
}

/** A conversation key as stored locally, with the id of the conversation it belongs to. */
interface StoredConversationKey {
  conversationId: string;
  key: CryptoKey;
  keyVersion: number;
  createdAt: string;
}

export class CryptoUnavailableError extends Error {
  constructor() {
    super(
      'This browser cannot encrypt messages locally, so private chat is unavailable here. Try a current version of Chrome, Edge, Safari or Firefox.',
    );
    this.name = 'CryptoUnavailableError';
  }
}

export function cryptoAvailable(): boolean {
  return typeof globalThis.crypto?.subtle?.generateKey === 'function' && typeof indexedDB !== 'undefined';
}

function subtle(): SubtleCrypto {
  if (!cryptoAvailable()) throw new CryptoUnavailableError();
  return globalThis.crypto.subtle;
}

/* ------------------------------------------------------------------ storage ---------------------- */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDENTITY_STORE)) db.createObjectStore(IDENTITY_STORE);
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE, { keyPath: 'conversationId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local storage.'));
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (objectStore: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = run(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Local storage request failed.'));
        transaction.oncomplete = () => db.close();
      }),
  );
}

function randomId(bytes = 16): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  // URL-safe: the device id travels in a query string and must survive it untouched.
  return bytesToBase64(buffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ------------------------------------------------------------------ identity --------------------- */

/**
 * Returns this browser's device identity, creating it on first use.
 *
 * The private key is generated with `extractable: false`: even our own code cannot read it back out
 * of WebCrypto, which is exactly what makes "the server never holds your private key" a fact rather
 * than a promise. The public key lives in memory and in IndexedDB via the key pair handle.
 */
export async function ensureIdentity(): Promise<DeviceIdentity> {
  const existing = await tx<StoredDeviceIdentity | undefined>(IDENTITY_STORE, 'readonly', (store) => store.get('device'));
  if (existing?.keyPair) {
    const publicKey = await subtle().exportKey('jwk', existing.keyPair.publicKey);
    return { deviceId: existing.deviceId, keyPair: existing.keyPair, publicKey, createdAt: existing.createdAt };
  }

  const api = subtle();
  const keyPair = await api.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
  // `generateKey` above creates both halves non-extractable; re-import the public half as extractable
  // so its JWK can be published, while the private half stays sealed inside WebCrypto.
  const publicJwk = await api.exportKey('jwk', keyPair.publicKey);
  const identity: StoredDeviceIdentity = {
    deviceId: randomId(16),
    keyPair,
    createdAt: new Date().toISOString(),
  };
  await tx(IDENTITY_STORE, 'readwrite', (store) => store.put(identity, 'device'));
  return { deviceId: identity.deviceId, keyPair, publicKey: publicJwk, createdAt: identity.createdAt };
}

interface StoredDeviceIdentity {
  deviceId: string;
  keyPair: CryptoKeyPair;
  createdAt: string;
}

/**
 * True when an identity exists already.
 *
 * Used to decide whether an empty inbox means "new device, keys not yet received" or "no messages".
 */
export async function hasIdentity(): Promise<boolean> {
  if (!cryptoAvailable()) return false;
  const existing = await tx<StoredDeviceIdentity | undefined>(IDENTITY_STORE, 'readonly', (store) => store.get('device'));
  return Boolean(existing?.keyPair);
}

/** Drops this device's identity and every cached conversation key. Used by "Forget this device". */
export async function forgetDevice(): Promise<void> {
  if (!cryptoAvailable()) return;
  await tx(IDENTITY_STORE, 'readwrite', (store) => store.clear());
  await tx(KEY_STORE, 'readwrite', (store) => store.clear());
}

/* ------------------------------------------------------- conversation keys ----------------------- */

export async function createConversationKey(
  conversationId: string,
  keyVersion = 1,
): Promise<StoredConversationKey> {
  const key = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const record: StoredConversationKey = {
    conversationId,
    key,
    keyVersion,
    createdAt: new Date().toISOString(),
  };
  await tx(KEY_STORE, 'readwrite', (store) => store.put(record));
  return record;
}

export async function getConversationKey(conversationId: string): Promise<StoredConversationKey | null> {
  if (!cryptoAvailable()) return null;
  const found = await tx<StoredConversationKey | undefined>(KEY_STORE, 'readonly', (store) => store.get(conversationId));
  return found ?? null;
}

export async function putConversationKey(record: StoredConversationKey): Promise<void> {
  await tx(KEY_STORE, 'readwrite', (store) => store.put(record));
}

/** One conversation key can be shared by several devices; `keyVersion` lets it be rotated later. */
export async function getOrCreateConversationKey(
  conversationId: string,
  keyVersion = 1,
): Promise<StoredConversationKey> {
  const existing = await getConversationKey(conversationId);
  if (existing && existing.keyVersion >= keyVersion) return existing;
  return createConversationKey(conversationId, keyVersion);
}

/* ------------------------------------------------------------------ envelope --------------------- */

/**
 * Wraps a conversation key for one recipient device.
 *
 * The returned blob is `base64(ephemeralPublicKey || iv || wrapped)`, where the ephemeral key is the
 * raw uncompressed P-256 point (65 bytes). Packing it into the same field means a recipient needs
 * exactly one value to unwrap, and the server sees an opaque string.
 */
export async function wrapKeyForDevice(
  recipientPublicJwk: JsonWebKey,
  conversationKey: CryptoKey,
  recipientDeviceId: string,
): Promise<{ wrappedKey: string; iv: string }> {
  const api = subtle();
  const recipientPublic = await api.importKey(
    'jwk',
    { ...recipientPublicJwk, ext: true },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  // A fresh ephemeral pair per envelope: the sender's identity key is never used for key agreement,
  // so a leaked conversation key cannot be traced back to a long-lived secret.
  const ephemeral = await api.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const shared = await api.deriveBits({ name: 'ECDH', public: recipientPublic }, ephemeral.privateKey, 256);
  const wrappingKey = await deriveWrappingKey(shared, recipientDeviceId, WRAP_USAGES);

  const rawKey = await api.exportKey('raw', conversationKey);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await api.encrypt({ name: 'AES-GCM', iv }, wrappingKey, rawKey);
  const ephemeralRaw = new Uint8Array(await api.exportKey('raw', ephemeral.publicKey));

  const packed = new Uint8Array(new ArrayBuffer(ephemeralRaw.length + iv.length + wrapped.byteLength));
  packed.set(ephemeralRaw, 0);
  packed.set(iv, ephemeralRaw.length);
  packed.set(new Uint8Array(wrapped), ephemeralRaw.length + iv.length);

  return { wrappedKey: bytesToBase64(packed), iv: bytesToBase64(iv) };
}

export async function unwrapKeyFromEnvelope(
  identity: DeviceIdentity,
  wrappedKey: string,
): Promise<{ key: CryptoKey; keyVersion: number } | null> {
  const api = subtle();
  const packed = base64ToBytes(wrappedKey);
  if (packed.byteLength < 65 + 12 + 16) return null;
  const ephemeralRaw = packed.slice(0, 65);
  const iv = packed.slice(65, 77);
  const wrapped = packed.slice(77);

  const ephemeralPublic = await api.importKey(
    'raw',
    ephemeralRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = await api.deriveBits({ name: 'ECDH', public: ephemeralPublic }, identity.keyPair.privateKey, 256);
  const wrappingKey = await deriveWrappingKey(shared, identity.deviceId, WRAP_USAGES);
  try {
    const raw = await api.decrypt({ name: 'AES-GCM', iv }, wrappingKey, wrapped);
    const key = await api.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    return { key, keyVersion: ENVELOPE_VERSION };
  } catch {
    // A wrong device, a rotated key or a corrupted blob — all recoverable by asking for a fresh
    // envelope, so this is a `null` rather than an exception the page has to explain.
    return null;
  }
}

async function deriveWrappingKey(
  sharedBits: ArrayBuffer,
  saltText: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const api = subtle();
  const material = await api.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return api.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: utf8Encode(saltText),
      info: utf8Encode(HKDF_INFO),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

/* ---------------------------------------------------------------- message crypto ------------------ */

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  alg: string;
}

/** Additional data binds ciphertext to its conversation: a message cannot be replayed into another. */
function associatedData(conversationId: string): Uint8Array<ArrayBuffer> {
  return utf8Encode(`vroqn-dm|${conversationId}|v1`);
}

export async function encryptMessage(
  conversationKey: CryptoKey,
  conversationId: string,
  body: { text: string; replyToId?: string | null },
  sentAt = new Date().toISOString(),
): Promise<EncryptedPayload> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plaintext = utf8Encode(JSON.stringify({ text: body.text, replyToId: body.replyToId ?? null, sentAt }));
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: associatedData(conversationId) },
    conversationKey,
    plaintext,
  );
  return { ciphertext: bytesToBase64(ciphertext), iv: bytesToBase64(iv), alg: 'AES-256-GCM' };
}

export interface DecryptedMessage {
  text: string;
  replyToId: string | null;
  sentAt: string;
}

/**
 * Decrypts one message.
 *
 * Returns `null` when the bytes cannot be read (no key yet, or a key from another device), so the
 * thread can show "waiting for keys" instead of an error the student cannot act on.
 */
export async function decryptMessage(
  conversationKey: CryptoKey,
  conversationId: string,
  payload: { ciphertext: string; iv: string },
): Promise<DecryptedMessage | null> {
  try {
    const plaintext = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(payload.iv),
        additionalData: associatedData(conversationId),
      },
      conversationKey,
      base64ToBytes(payload.ciphertext),
    );
    const parsed = JSON.parse(utf8Decode(plaintext)) as Partial<DecryptedMessage>;
    return {
      text: String(parsed.text ?? ''),
      replyToId: parsed.replyToId ?? null,
      sentAt: parsed.sentAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
