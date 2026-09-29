/**
 * Data hooks for Vroqn Communities.
 *
 * Same conventions as the rest of the app: a tiny `useRemote` for reads (loading / error / refresh)
 * and `useAction` for writes (busy flag + a toast that always says what actually happened). Nothing
 * here decides permissions — the server does. When a write is refused, the server's message is shown
 * verbatim instead of an invented one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';

export interface RemoteState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  errorCode: string | null;
  refresh: () => Promise<void>;
  set: (next: T | ((previous: T | null) => T)) => void;
}

export function errorMessage(err: unknown, fallback = 'Could not load this screen.'): string {
  const apiError = err as ApiError;
  return apiError?.message || fallback;
}

export function errorCode(err: unknown): string | null {
  const apiError = err as ApiError;
  return apiError?.code ?? null;
}

export function isNotFound(err: unknown): boolean {
  return (err as ApiError)?.status === 404;
}

export function isForbidden(err: unknown): boolean {
  const status = (err as ApiError)?.status;
  return status === 403 || status === 404;
}

/**
 * Reads a path. Pass `null` to skip the request entirely (used while a required id is still unknown).
 */
export function useRemote<T>(path: string | null, deps: unknown[] = []): RemoteState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<string | null>(null);
  const [errorCodeState, setErrorCodeState] = useState<string | null>(null);
  const mounted = useRef(true);
  const token = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const mine = ++token.current;
    setLoading(true);
    setError(null);
    setErrorCodeState(null);
    try {
      const next = await api.get<T>(path);
      if (mounted.current && mine === token.current) setData(next);
    } catch (err) {
      if (mounted.current && mine === token.current) {
        setError(errorMessage(err));
        setErrorCodeState(errorCode(err));
      }
    } finally {
      if (mounted.current && mine === token.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);

  const set = useCallback((next: T | ((previous: T | null) => T)) => {
    setData((previous) => (typeof next === 'function' ? (next as (value: T | null) => T)(previous) : next));
  }, []);

  return { data, loading, error, errorCode: errorCodeState, refresh: load, set };
}

export interface ActionState {
  busy: boolean;
  run: <T>(
    fn: () => Promise<T>,
    messages: { success?: string; failure?: string; onSuccess?: (result: T) => void | Promise<void> },
  ) => Promise<T | null>;
}

/**
 * Wraps a write. On success it optionally toasts and hands the result to `onSuccess`; on failure it
 * shows the server's own message, which is always written for a student to read.
 */
export function useAction(): ActionState {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async <T>(
      fn: () => Promise<T>,
      messages: { success?: string; failure?: string; onSuccess?: (result: T) => void | Promise<void> },
    ): Promise<T | null> => {
      setBusy(true);
      try {
        const result = await fn();
        if (messages.onSuccess) await messages.onSuccess(result);
        if (messages.success) toast.push({ tone: 'success', title: messages.success });
        return result;
      } catch (err) {
        toast.push({
          tone: 'error',
          title: messages.failure ?? 'That did not go through',
          detail: errorMessage(err, 'Please try again in a moment.'),
        });
        return null;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [toast],
  );

  return { busy, run };
}

/** Debounces a value — used by the community search boxes so typing does not fire a request a key. */
export function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useRelativeTime() {
  return useCallback((iso: string): string => {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const seconds = Math.round((Date.now() - then) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }, []);
}

export function useCountdown(target: string | null): string {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!target) {
      setLabel('');
      return;
    }
    const tick = () => {
      const diff = new Date(target).getTime() - Date.now();
      if (diff <= 0) {
        setLabel('starting now');
        return;
      }
      const days = Math.floor(diff / 86_400_000);
      const hours = Math.floor((diff % 86_400_000) / 3_600_000);
      const minutes = Math.floor((diff % 3_600_000) / 60_000);
      setLabel(days > 0 ? `in ${days}d ${hours}h` : hours > 0 ? `in ${hours}h ${minutes}m` : `in ${minutes}m`);
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [target]);
  return label;
}
