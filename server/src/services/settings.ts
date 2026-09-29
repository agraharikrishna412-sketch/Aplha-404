/**
 * Per-student settings (task routing, learning profile, activity controls).
 * Stored as a single JSON document per user so new preference fields need no migration.
 */
import * as db from '../db/index.js';
import { nowIso } from '../db/index.js';
import { DEFAULT_SETTINGS, type UserSettings } from '../types/domain.js';

/**
 * Keys that belonged to the removed voice feature.
 *
 * Settings are one JSON document per student, so retired fields would otherwise sit in the database
 * for ever and reappear in API responses. They are dropped on read: no migration, no rewrite, and a
 * stale row cannot resurrect a feature that no longer exists.
 */
const RETIRED_SETTING_KEYS = ['voiceMode', 'ttsEngine', 'sttEngine', 'ttsVoice', 'ttsRate'];

function withoutRetiredKeys(value: Partial<UserSettings>): Partial<UserSettings> {
  const copy: Record<string, unknown> = { ...value };
  for (const key of RETIRED_SETTING_KEYS) delete copy[key];
  if (copy.routing && typeof copy.routing === 'object') {
    const routing = { ...(copy.routing as Record<string, unknown>) };
    delete routing.voice;
    copy.routing = routing;
  }
  return copy as Partial<UserSettings>;
}

export async function getSettings(userId: string): Promise<UserSettings> {
  const row = await db.one<{ data: string }>('SELECT data FROM user_settings WHERE user_id = ?', [userId]);
  if (!row) return { ...DEFAULT_SETTINGS };
  const stored = withoutRetiredKeys(db.json<Partial<UserSettings>>(row.data, {}));
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    routing: { ...DEFAULT_SETTINGS.routing, ...(stored.routing ?? {}) },
    subjectDefaults: { ...DEFAULT_SETTINGS.subjectDefaults, ...(stored.subjectDefaults ?? {}) },
    modelPrefs: { ...(stored.modelPrefs ?? {}) },
  };
}

export async function saveSettings(userId: string, patch: Partial<UserSettings>): Promise<UserSettings> {
  const current = await getSettings(userId);
  const next: UserSettings = {
    ...current,
    ...patch,
    routing: { ...current.routing, ...(patch.routing ?? {}) },
    subjectDefaults: { ...current.subjectDefaults, ...(patch.subjectDefaults ?? {}) },
    modelPrefs: { ...current.modelPrefs, ...(patch.modelPrefs ?? {}) },
  };
  await db.run(
    `INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [userId, JSON.stringify(next), nowIso()],
  );
  return next;
}
