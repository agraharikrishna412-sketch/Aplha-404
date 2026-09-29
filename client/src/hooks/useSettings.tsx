/**
 * Settings + AI connection context.
 *
 * This is the single source of truth the whole app reads for:
 *  - provider/model catalogue (so no screen hardcodes a model id)
 *  - the student's key inventory and routing preferences
 *  - whether any real AI is configured (the UI must never pretend otherwise)
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import type { ProviderId, ProviderCatalogueEntry, KeyOverviewEntry, TaskKind, UserSettings } from '../types';

interface RuntimeInfo {
  maxAttempts: number;
  attemptTimeoutMs: number;
  demoModeAllowed: boolean;
  codeRunEnabled: boolean;
  providers: { id: ProviderId; label: string; capabilities?: ProviderCatalogueEntry['capabilities'] }[];
}

/** Patches are shallow-merged per section, so a single routed task can be updated alone. */
export type SettingsPatch = Omit<Partial<UserSettings>, 'routing' | 'modelPrefs' | 'subjectDefaults'> & {
  routing?: Partial<Record<TaskKind, ProviderId>>;
  modelPrefs?: Partial<Record<ProviderId, string>>;
  subjectDefaults?: Partial<UserSettings['subjectDefaults']>;
};

interface SettingsContextValue {
  settings: UserSettings | null;
  providers: ProviderCatalogueEntry[];
  keys: Record<ProviderId, KeyOverviewEntry> | null;
  runtime: RuntimeInfo | null;
  loading: boolean;
  error: string | null;
  hasAnyKey: boolean;
  hasConnectedKey: boolean;
  reload: () => Promise<void>;
  save: (patch: SettingsPatch) => Promise<void>;
  addKey: (input: { provider: ProviderId; key: string; label?: string; makeDefault?: boolean }) => Promise<void>;
  updateKey: (id: string, patch: { label?: string; enabled?: boolean; isDefault?: boolean }) => Promise<void>;
  removeKey: (id: string) => Promise<void>;
  testKey: (id: string) => Promise<{ ok: boolean; message: string; status: string }>;
  checkAll: () => Promise<{ tested: number; healthy: number; results: { label: string; provider: string; ok: boolean; message: string }[] }>;
  refreshModels: (provider: ProviderId) => Promise<{ ok: boolean; count: number; message: string }>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

const EMPTY: Record<ProviderId, KeyOverviewEntry> = {
  gemini: { total: 0, enabled: 0, connected: 0, needsAttention: 0, keys: [] },
  groq: { total: 0, enabled: 0, connected: 0, needsAttention: 0, keys: [] },
  openrouter: { total: 0, enabled: 0, connected: 0, needsAttention: 0, keys: [] },
};

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [providers, setProviders] = useState<ProviderCatalogueEntry[]>([]);
  const [keys, setKeys] = useState<Record<ProviderId, KeyOverviewEntry> | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    const overview = await api.get<{ providers: ProviderCatalogueEntry[]; keys: Record<ProviderId, KeyOverviewEntry> }>(
      '/keys/overview',
    );
    setProviders(overview.providers);
    setKeys(overview.keys);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsResult] = await Promise.all([
        api.get<{ settings: UserSettings; runtime: RuntimeInfo }>('/settings'),
        loadKeys(),
      ]);
      setSettings(settingsResult.settings);
      setRuntime(settingsResult.runtime);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your AI settings.');
      setKeys((current) => current ?? EMPTY);
    } finally {
      setLoading(false);
    }
  }, [loadKeys]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback<SettingsContextValue['save']>(async (patch) => {
    const result = await api.put<{ settings: UserSettings }>('/settings', patch);
    setSettings(result.settings);
  }, []);

  const addKey = useCallback<SettingsContextValue['addKey']>(
    async (input) => {
      await api.post('/keys', input);
      await loadKeys();
    },
    [loadKeys],
  );

  const updateKey = useCallback<SettingsContextValue['updateKey']>(
    async (id, patch) => {
      await api.patch(`/keys/${id}`, patch);
      await loadKeys();
    },
    [loadKeys],
  );

  const removeKey = useCallback<SettingsContextValue['removeKey']>(
    async (id) => {
      await api.del(`/keys/${id}`);
      await loadKeys();
    },
    [loadKeys],
  );

  const testKey = useCallback<SettingsContextValue['testKey']>(
    async (id) => {
      const result = await api.post<{ ok: boolean; message: string; status: string }>(`/keys/${id}/test`, {});
      await loadKeys();
      return result;
    },
    [loadKeys],
  );

  const checkAll = useCallback<SettingsContextValue['checkAll']>(async () => {
    const result = await api.post<{ tested: number; healthy: number; results: { label: string; provider: string; ok: boolean; message: string }[] }>(
      '/keys/check-connections',
      {},
    );
    await loadKeys();
    return result;
  }, [loadKeys]);

  const refreshModels = useCallback<SettingsContextValue['refreshModels']>(
    async (provider) => {
      const result = await api.post<{ ok: boolean; count: number; message: string }>(`/keys/${provider}/refresh-models`, {});
      await loadKeys();
      return result;
    },
    [loadKeys],
  );

  const value = useMemo<SettingsContextValue>(() => {
    const allKeys = keys ? Object.values(keys).flatMap((entry) => entry.keys) : [];
    return {
      settings,
      providers,
      keys,
      runtime,
      loading,
      error,
      hasAnyKey: allKeys.some((key) => key.enabled),
      hasConnectedKey: allKeys.some((key) => key.enabled && key.status === 'connected'),
      reload,
      save,
      addKey,
      updateKey,
      removeKey,
      testKey,
      checkAll,
      refreshModels,
    };
  }, [settings, providers, keys, runtime, loading, error, reload, save, addKey, updateKey, removeKey, testKey, checkAll, refreshModels]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) throw new Error('useSettings must be used inside SettingsProvider');
  return context;
}
