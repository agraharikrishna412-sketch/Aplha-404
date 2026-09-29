/**
 * Key Manager — CRUD + rotation state for the student's own provider keys (spec §10–§12, §16).
 *
 * Guarantees:
 *  - Secrets are encrypted at rest (AES-256-GCM) and never returned to the client.
 *  - Keys are ordered for rotation: default first, then least-recently-used.
 *  - Cooled-down keys are skipped when fresh alternatives exist, but are still used as a
 *    last resort so a request never fails merely because every key is cooling down.
 *  - Failures classify the key (invalid vs temporary) and never delete student data.
 */
import { nowIso, uuid } from '../../db/index.js';
import * as db from '../../db/index.js';
import { PROVIDER_IDS, type ProviderId } from '../../config/models.js';
import { decryptSecret, describeSecret, encryptSecret } from '../crypto.js';
import { AIError, FAILURE_POLICY, type FailureKind } from './errors.js';
import { getProvider } from './providers/index.js';
import type { ApiKeyPublic, KeyStatus } from '../../types/domain.js';

interface ApiKeyRow {
  id: string;
  user_id: string;
  provider: string;
  label: string;
  secret_enc: string;
  masked: string;
  fingerprint: string;
  is_default: number;
  enabled: number;
  status: string;
  last_checked_at: string | null;
  last_used_at: string | null;
  last_error_type: string | null;
  last_error_message: string | null;
  fail_count: number;
  success_count: number;
  cooldown_until: string | null;
  created_at: string;
}

export interface ResolvedKey extends ApiKeyPublic {
  /** Decrypted secret — only ever held in memory for the duration of a request. */
  secret: string;
  coolingDown: boolean;
}

function toPublic(row: ApiKeyRow): ApiKeyPublic {
  return {
    id: row.id,
    provider: row.provider as ProviderId,
    label: row.label,
    masked: row.masked,
    isDefault: row.is_default === 1,
    enabled: row.enabled === 1,
    status: row.status as KeyStatus,
    lastCheckedAt: row.last_checked_at,
    lastUsedAt: row.last_used_at,
    lastErrorType: row.last_error_type,
    lastErrorMessage: row.last_error_message,
    failCount: row.fail_count,
    successCount: row.success_count,
    cooldownUntil: row.cooldown_until,
    createdAt: row.created_at,
  };
}

async function rawKeys(userId: string, provider?: ProviderId): Promise<ApiKeyRow[]> {
  const sql = provider
    ? 'SELECT * FROM api_keys WHERE user_id = ? AND provider = ? ORDER BY is_default DESC, created_at ASC'
    : 'SELECT * FROM api_keys WHERE user_id = ? ORDER BY provider ASC, is_default DESC, created_at ASC';
  return db.all<ApiKeyRow>(sql, provider ? [userId, provider] : [userId]);
}

export async function listKeys(userId: string): Promise<ApiKeyPublic[]> {
  const rows = await rawKeys(userId);
  return rows.map(toPublic);
}

/** Never-throw key status summary used by the AI Settings page and the dashboard. */
export async function keyOverview(userId: string): Promise<
  Record<ProviderId, { total: number; enabled: number; connected: number; needsAttention: number; keys: ApiKeyPublic[] }>
> {
  const rows = (await rawKeys(userId)).map(toPublic);
  const out = {} as Record<ProviderId, { total: number; enabled: number; connected: number; needsAttention: number; keys: ApiKeyPublic[] }>;
  for (const provider of PROVIDER_IDS) {
    const keys = rows.filter((k) => k.provider === provider);
    out[provider] = {
      total: keys.length,
      enabled: keys.filter((k) => k.enabled).length,
      connected: keys.filter((k) => k.enabled && k.status === 'connected').length,
      needsAttention: keys.filter((k) => k.status === 'invalid' || k.status === 'error').length,
      keys,
    };
  }
  return out;
}

export async function countEnabledKeys(userId: string): Promise<number> {
  const rows = await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ? AND enabled = 1', [
    userId,
  ]);
  return Number(rows[0]?.c ?? 0);
}

export async function addKey(
  userId: string,
  provider: ProviderId,
  secret: string,
  label?: string,
): Promise<ApiKeyPublic> {
  const trimmed = secret.trim();
  const fingerprint = describeSecret(trimmed).fingerprint;

  const existing = await db.one<ApiKeyRow>(
    'SELECT * FROM api_keys WHERE user_id = ? AND provider = ? AND fingerprint = ?',
    [userId, provider, fingerprint],
  );
  if (existing) {
    throw new AIError({
      kind: 'bad_request',
      message: 'That key is already saved for this provider.',
      provider,
    });
  }

  const forProvider = await rawKeys(userId, provider);
  const id = uuid();
  const created = nowIso();
  await db.run(
    `INSERT INTO api_keys
       (id, user_id, provider, label, secret_enc, masked, fingerprint, is_default, enabled, status,
        fail_count, success_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'untested', 0, 0, ?)`,
    [
      id,
      userId,
      provider,
      label?.trim() || `${getProvider(provider).label} Key ${forProvider.length + 1}`,
      encryptSecret(trimmed),
      describeSecret(trimmed).masked,
      fingerprint,
      forProvider.length === 0 ? 1 : 0,
      created,
    ],
  );

  const row = await db.one<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?', [id]);
  return toPublic(row!);
}

export async function updateKey(
  userId: string,
  keyId: string,
  patch: { label?: string; enabled?: boolean; isDefault?: boolean },
): Promise<ApiKeyPublic | null> {
  const row = await db.one<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ? AND user_id = ?', [keyId, userId]);
  if (!row) return null;

  if (patch.isDefault) {
    await db.run('UPDATE api_keys SET is_default = 0 WHERE user_id = ? AND provider = ?', [userId, row.provider]);
    await db.run('UPDATE api_keys SET is_default = 1, enabled = 1 WHERE id = ?', [keyId]);
  }
  if (patch.label !== undefined) await db.run('UPDATE api_keys SET label = ? WHERE id = ?', [patch.label.slice(0, 60), keyId]);
  if (patch.enabled !== undefined) {
    if (!patch.enabled && row.is_default === 1) {
      // Keep a default pointer alive: promote the next available key.
      const others = (await rawKeys(userId, row.provider as ProviderId)).filter((k) => k.id !== keyId && k.enabled === 1);
      await db.run('UPDATE api_keys SET enabled = 0, is_default = 0 WHERE id = ?', [keyId]);
      if (others[0]) await db.run('UPDATE api_keys SET is_default = 1 WHERE id = ?', [others[0].id]);
    } else {
      await db.run('UPDATE api_keys SET enabled = ? WHERE id = ?', [patch.enabled ? 1 : 0, keyId]);
    }
    if (patch.enabled === true) {
      await db.run("UPDATE api_keys SET status = CASE WHEN status = 'disabled' THEN 'untested' ELSE status END WHERE id = ?", [keyId]);
    } else {
      await db.run("UPDATE api_keys SET status = 'disabled' WHERE id = ?", [keyId]);
    }
  }

  const updated = await db.one<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?', [keyId]);
  return updated ? toPublic(updated) : null;
}

export async function removeKey(userId: string, keyId: string): Promise<boolean> {
  const row = await db.one<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ? AND user_id = ?', [keyId, userId]);
  if (!row) return false;
  await db.run('DELETE FROM api_keys WHERE id = ?', [keyId]);
  if (row.is_default === 1) {
    const next = (await rawKeys(userId, row.provider as ProviderId)).find((k) => k.enabled === 1);
    if (next) await db.run('UPDATE api_keys SET is_default = 1 WHERE id = ?', [next.id]);
  }
  return true;
}

/* ------------------------------- rotation ------------------------------- */

interface RotationCandidate extends ResolvedKey {
  orderIndex: number;
}

/**
 * Keys eligible for a request, best-first: default → recently-successful → rest.
 * Cooled-down keys are returned at the end so the engine can still use them as a last resort.
 */
export async function getRotationCandidates(userId: string, provider: ProviderId): Promise<ResolvedKey[]> {
  const rows = (await rawKeys(userId, provider)).filter((r) => r.enabled === 1);
  const now = Date.now();
  const resolved: RotationCandidate[] = rows.map((row, index) => {
    let secret = '';
    try {
      secret = decryptSecret(row.secret_enc);
    } catch {
      secret = '';
    }
    const coolingDown = Boolean(row.cooldown_until && new Date(row.cooldown_until).getTime() > now);
    return { ...toPublic(row), secret, coolingDown, orderIndex: index };
  });

  const usable = resolved.filter((k) => k.secret && !k.coolingDown);
  const cooling = resolved
    .filter((k) => k.secret && k.coolingDown)
    .sort((a, b) => String(a.cooldownUntil).localeCompare(String(b.cooldownUntil)));

  const score = (k: RotationCandidate) => {
    let s = k.orderIndex;
    if (k.isDefault) s -= 100;
    if (k.status === 'connected') s -= 20;
    if (k.status === 'invalid') s += 15;
    return s;
  };

  return [...usable.sort((a, b) => score(a) - score(b)), ...cooling].map(({ orderIndex, ...rest }) => rest);
}

export async function markKeyUsed(userId: string, keyId: string): Promise<void> {
  await db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ? AND user_id = ?', [nowIso(), keyId, userId]);
}

export async function markKeySuccess(userId: string, keyId: string, _provider: ProviderId): Promise<void> {
  await db.run(
    `UPDATE api_keys
        SET success_count = success_count + 1,
            status = ?,
            cooldown_until = NULL,
            last_error_type = NULL,
            last_error_message = NULL,
            last_checked_at = ?
      WHERE id = ? AND user_id = ?`,
    ['connected', nowIso(), keyId, userId],
  );
}

export async function markKeyFailure(
  userId: string,
  keyId: string,
  _provider: ProviderId,
  failure: FailureKind,
  message: string,
): Promise<void> {
  const policy = FAILURE_POLICY[failure] ?? FAILURE_POLICY.unknown;
  const cooldownMs =
    failure === 'rate_limit'
      ? Number(process.env.AI_COOLDOWN_RATE_LIMIT_MS ?? 60_000)
      : failure === 'quota_exhausted'
        ? 30 * 60_000
        : failure === 'network' || failure === 'provider_unavailable'
          ? 0
          : policy.markKeyInvalid
            ? Number(process.env.AI_COOLDOWN_AUTH_MS ?? 6 * 60 * 60_000)
            : Number(process.env.AI_COOLDOWN_SERVER_ERROR_MS ?? 20_000);

  const status: KeyStatus = policy.markKeyInvalid
    ? 'invalid'
    : failure === 'rate_limit' || failure === 'quota_exhausted'
      ? 'rate_limited'
      : failure === 'unknown' || failure === 'server_error' || failure === 'timeout' || failure === 'provider_unavailable'
        ? 'error'
        : 'untested';

  await db.run(
    `UPDATE api_keys
        SET fail_count = fail_count + 1,
            status = ?,
            last_error_type = ?,
            last_error_message = ?,
            last_checked_at = ?,
            cooldown_until = ?
      WHERE id = ? AND user_id = ?`,
    [
      status,
      failure,
      message.slice(0, 240),
      nowIso(),
      cooldownMs > 0 ? new Date(Date.now() + cooldownMs).toISOString() : null,
      keyId,
      userId,
    ],
  );
}

/** Explicit "Test" button: performs a real provider call with that key. */
export async function testKey(
  userId: string,
  keyId: string,
): Promise<{ ok: boolean; status: KeyStatus; message: string; models?: string[] }> {
  const row = await db.one<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ? AND user_id = ?', [keyId, userId]);
  if (!row) throw new AIError({ kind: 'bad_request', message: 'Key not found.' });
  const provider = row.provider as ProviderId;
  const adapter = getProvider(provider);

  let secret = '';
  try {
    secret = decryptSecret(row.secret_enc);
  } catch {
    await markKeyFailure(userId, keyId, provider, 'invalid_key', 'Stored key could not be decrypted.');
    return { ok: false, status: 'invalid', message: 'Stored key could not be decrypted — please add it again.' };
  }

  const result = await adapter.validateKey(secret);
  await db.run('UPDATE api_keys SET last_checked_at = ? WHERE id = ?', [nowIso(), keyId]);

  if (result.ok) {
    await markKeySuccess(userId, keyId, provider);
    if (result.models?.length) {
      const { setRuntimeModels } = await import('../../config/models.js');
      const known = new Set((await import('../../config/models.js')).modelsFor(provider).map((m) => m.id));
      const discovered = result.models.filter((m) => !known.has(m)).slice(0, 40);
      if (discovered.length) {
        const { modelsFor } = await import('../../config/models.js');
        setRuntimeModels(provider, [
          ...modelsFor(provider),
          ...discovered.map((id) => ({
            id,
            label: id,
            speed: 'balanced' as const,
            vision: true,
            code: /code|coder|deepseek|qwen|llama|gemini/i.test(id),
            contextK: 128,
            note: 'Discovered from your provider account.',
          })),
        ]);
      }
    }
    return { ok: true, status: 'connected', message: result.message, models: result.models };
  }

  const failure = result.failure ?? 'unknown';
  await markKeyFailure(userId, keyId, provider, failure, result.message);
  const status: KeyStatus = FAILURE_POLICY[failure].markKeyInvalid
    ? 'invalid'
    : failure === 'rate_limit' || failure === 'quota_exhausted'
      ? 'rate_limited'
      : 'error';
  return { ok: false, status, message: result.message };
}

export async function getKeySecret(userId: string, keyId: string): Promise<{ provider: ProviderId; secret: string } | null> {
  const row = await db.one<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ? AND user_id = ?', [keyId, userId]);
  if (!row) return null;
  try {
    return { provider: row.provider as ProviderId, secret: decryptSecret(row.secret_enc) };
  } catch {
    return null;
  }
}
