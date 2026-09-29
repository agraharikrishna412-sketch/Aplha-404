/**
 * Arena data hooks — thin, typed wrappers over the `/api/arena` surface.
 * Same conventions as the rest of the app: `api` verbs, `ApiError`, `{tone,title,detail}` toasts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ApiError } from '../../lib/api';
import type {
  ArenaAdminQuestion,
  ArenaCompetitionDetailPayload,
  ArenaAttemptStatus,
  ArenaCompetitionSummary,
  ArenaHistoryPayload,
  ArenaMyCompetitions,
  ArenaOverview,
  ArenaResultPayload,
} from '../../types';

interface RemoteState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

function useRemote<T>(path: string | null, deps: unknown[] = []): RemoteState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const reloadToken = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const token = ++reloadToken.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.get<T>(path);
      if (mounted.current && token === reloadToken.current) setData(next);
    } catch (err) {
      if (mounted.current && token === reloadToken.current) {
        setError((err as ApiError)?.message ?? 'Could not load this screen.');
      }
    } finally {
      if (mounted.current && token === reloadToken.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);

  return { data, loading, error, refresh: load };
}

export function useArenaOverview() {
  return useRemote<ArenaOverview>('/arena/overview');
}

export function useArenaCatalog() {
  return useRemote<{ competitions: ArenaCompetitionSummary[]; serverNow: string; total: number }>(
    '/arena/competitions',
  );
}

export function useMyCompetitions() {
  return useRemote<ArenaMyCompetitions>('/arena/my-competitions');
}

export function useArenaCompetition(id: string | undefined) {
  return useRemote<ArenaCompetitionDetailPayload>(id ? `/arena/competitions/${id}` : null, [id]);
}

export function useArenaHistory() {
  return useRemote<ArenaHistoryPayload>('/arena/history');
}

export function useArenaResult(attemptId: string | undefined) {
  return useRemote<ArenaResultPayload>(attemptId ? `/arena/results/${attemptId}` : null, [attemptId]);
}

export function useArenaAttemptStatus(competitionId: string | undefined, enabled: boolean, pollMs = 20000) {
  const state = useRemote<ArenaAttemptStatus>(competitionId ? `/arena/competitions/${competitionId}/status` : null, [
    competitionId,
  ]);

  useEffect(() => {
    if (!enabled || !competitionId) return;
    const id = window.setInterval(() => void state.refresh(), pollMs);
    return () => window.clearInterval(id);
  }, [enabled, competitionId, pollMs, state.refresh]);

  return state;
}

/* ------------------------------- admin hooks ------------------------------ */

export function useAdminCompetitions() {
  return useRemote<{ competitions: ArenaCompetitionSummary[]; serverNow: string }>(
    '/arena/competitions?includeDrafts=true',
  );
}

export function useAdminQuestions(competitionId: string | null) {
  return useRemote<{ questions: ArenaAdminQuestion[]; review: ArenaCompetitionSummary['reviewCounts'] }>(
    competitionId ? `/arena/admin/competitions/${competitionId}/questions` : null,
    [competitionId],
  );
}

/* -------------------------------- mutations ------------------------------- */

export function useArenaAction() {
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    try {
      return await fn();
    } finally {
      setBusy(null);
    }
  }, []);

  return { busy, run };
}
