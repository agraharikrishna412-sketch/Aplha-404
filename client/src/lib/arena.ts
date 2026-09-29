/**
 * Arena presentation helpers — state labels/tones, clocks and countdown logic.
 *
 * The server clock is the single source of truth. `useServerClock` keeps a local offset so a countdown
 * stays correct even when the device clock is wrong, and never lets a client-side timer decide
 * anything: it only tells the UI what the *server* currently thinks the time is.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CompetitionState } from '../types';

export const ARENA_STATE_META: Record<
  CompetitionState,
  { label: string; tone: 'primary' | 'success' | 'warning' | 'error' | 'muted'; short: string }
> = {
  UPCOMING: { label: 'Upcoming', tone: 'muted', short: 'Starts later' },
  REGISTRATION_OPEN: { label: 'Registration open', tone: 'primary', short: 'Register now' },
  LIVE: { label: 'Live now', tone: 'success', short: 'Exam running' },
  SUBMISSION_CLOSED: { label: 'Submission closed', tone: 'warning', short: 'Answer sheets locked' },
  PROCESSING_RESULTS: { label: 'Processing results', tone: 'warning', short: 'Preparing analysis' },
  RESULTS_PUBLISHED: { label: 'Results published', tone: 'primary', short: 'Analysis ready' },
  ARCHIVED: { label: 'Archived', tone: 'muted', short: 'Past competition' },
};

export function stateMeta(state: CompetitionState) {
  return ARENA_STATE_META[state] ?? ARENA_STATE_META.UPCOMING;
}

/** Arena percentiles arrive on a 0–100 scale (unlike activity ratios), so they format differently. */
export function formatPercentile(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Number(value.toFixed(1));
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateTimeLong(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function compactMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/**
 * Tracks the offset between this device and the server, then ticks once per second.
 * Returns the *server* time as a Date plus the offset in milliseconds.
 */
export function useServerClock(serverNow?: string | null) {
  const [offsetMs, setOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!serverNow) return;
    const parsed = new Date(serverNow).getTime();
    if (!Number.isNaN(parsed)) setOffsetMs(parsed - Date.now());
  }, [serverNow]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const serverNowMs = nowMs + offsetMs;
  return useMemo(
    () => ({
      offsetMs,
      serverNowMs,
      serverNow: new Date(serverNowMs),
      remainingSeconds: (deadlineIso: string | null | undefined) => {
        if (!deadlineIso) return 0;
        return Math.max(0, Math.round((new Date(deadlineIso).getTime() - serverNowMs) / 1000));
      },
    }),
    [offsetMs, serverNowMs],
  );
}

/** Re-renders on an interval — used for "time left" badges on list screens. */
export function useTicker(intervalMs = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
}

/**
 * Exam navigation state machine. Kept as a hook so both the runner and the routes can reason about
 * the same transitions, including the "server says the clock ran out" path.
 */
export interface ExamTimerState {
  remainingSeconds: number;
  low: boolean;
  critical: boolean;
  expired: boolean;
}

export function useExamTimer(deadlineIso: string | null | undefined, serverNowMs: number): ExamTimerState {
  const remainingSeconds = deadlineIso
    ? Math.max(0, Math.round((new Date(deadlineIso).getTime() - serverNowMs) / 1000))
    : 0;
  return useMemo(
    () => ({
      remainingSeconds,
      low: remainingSeconds <= 300,
      critical: remainingSeconds <= 60,
      expired: remainingSeconds <= 0,
    }),
    [remainingSeconds],
  );
}

/** Unsaved-answer guard for in-page navigation (browser back / tab close). */
export function useUnsavedGuard(active: boolean, message: string) {
  const handler = useCallback(
    (event: BeforeUnloadEvent) => {
      if (!active) return;
      event.preventDefault();
      event.returnValue = message;
      return message;
    },
    [active, message],
  );

  useEffect(() => {
    if (!active) return;
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active, handler]);
}
