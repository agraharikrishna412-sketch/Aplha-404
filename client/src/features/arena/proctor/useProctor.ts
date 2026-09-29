/**
 * Exam integrity signals for Arena papers and mock exams (§44).
 *
 * Honest about its own limits, because a student who believes software is watching them will behave
 * differently for the wrong reasons:
 *
 *  - The **timer, the paper and the marking are decided by the server**. This hook cannot extend time,
 *    cannot fetch questions early and cannot change a score. It observes and reports.
 *  - It cannot see another device, a printed sheet, or a friend in the room. Physical cheating is not
 *    detectable from a browser and this hook does not pretend to detect it — it removes the *easy*
 *    digital routes (a solver in another tab, a search engine, copy-pasting the paper out) and leaves
 *    a record a host can read.
 *  - Nothing here blocks answering. If a signal fails to send, the paper keeps working; a lost batch
 *    is not a lost attempt.
 *
 * Everything it observes is also shown to the student in their own result, so the record is not a
 * one-way mirror.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../lib/api';

export type SignalKind =
  | 'focus_lost'
  | 'focus_regained'
  | 'fullscreen_exit'
  | 'fullscreen_enter'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'context_menu'
  | 'key_blocked'
  | 'resize'
  | 'print'
  | 'devtools_suspect'
  | 'nav_attempt'
  | 'extended_display'
  | 'offline'
  | 'online'
  | 'resume'
  | 'session_start';

interface PendingSignal {
  kind: SignalKind;
  detail?: string;
  at: string;
}

export interface ProctorState {
  /** True while the student is away from the paper (another tab, another app, or a restored window). */
  away: boolean;
  /** Full-screen was left and the paper still requires it. */
  fullscreenLost: boolean;
  /** Short, plain-language note about the last thing that was recorded — never accusatory. */
  lastNotice: string | null;
  /** How many warnings the student has been shown, so the UI can stay calm but honest. */
  warnings: number;
  /** Signals waiting to be sent. */
  pending: number;
  /** The paper is offline: the network dropped, so signals queue locally. */
  offline: boolean;
  flush: () => Promise<void>;
  /** Asks the browser for full-screen. Refusal is handled by the caller, never thrown at the student. */
  requestFullscreen: () => Promise<{ ok: boolean; reason?: string }>;
}

interface Options {
  /**
   * `arena` posts to the competition endpoint (the server resolves the caller's own attempt) and
   * `exam` posts to the mock-exam endpoint. Both land in the same evidence tables.
   */
  scope: 'arena' | 'exam';
  refId: string;
  /** Nothing is recorded until the student is actually inside the paper. */
  active: boolean;
  requireFullscreen: boolean;
  /** Called when the platform refuses full-screen, so the runner can degrade instead of blocking. */
  onFullscreenUnavailable?: (reason: string) => void;
}

const FLUSH_INTERVAL_MS = 8_000;
const MAX_QUEUE = 120;

/**
 * A device summary, not a fingerprint: it is stored with the report only so a host can tell a phone
 * from a laptop when reading the log. It contains nothing identifying and is never used to track
 * anyone across sessions.
 */
function deviceSummary(): string {
  if (typeof navigator === 'undefined') return '';
  const nav = navigator as Navigator & { deviceMemory?: number };
  const screenInfo = typeof window !== 'undefined' ? `${window.screen.width}x${window.screen.height}` : '';
  const memory = nav.deviceMemory ? `${nav.deviceMemory}GB` : '';
  return [nav.platform || 'unknown platform', screenInfo, memory].filter(Boolean).join(' · ').slice(0, 200);
}

export function useProctor({ scope, refId, active, requireFullscreen, onFullscreenUnavailable }: Options): ProctorState {
  const queue = useRef<PendingSignal[]>([]);
  const [pending, setPending] = useState(0);
  const [away, setAway] = useState(false);
  const [fullscreenLost, setFullscreenLost] = useState(false);
  const [offline, setOffline] = useState(false);
  const [lastNotice, setLastNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  const push = useCallback((kind: SignalKind, detail?: string) => {
    if (!activeRef.current) return;
    queue.current.push({ kind, detail, at: new Date().toISOString() });
    if (queue.current.length > MAX_QUEUE) queue.current = queue.current.slice(-MAX_QUEUE);
    setPending(queue.current.length);
  }, []);

  const flush = useCallback(async () => {
    if (!queue.current.length) return;
    const batch = queue.current.splice(0, 60);
    setPending(queue.current.length);
    const path = scope === 'arena' ? `/arena/competitions/${refId}/signals` : `/exams/${refId}/signals`;
    try {
      await api.post(path, { signals: batch, device: deviceSummary() });
    } catch {
      /*
       * A failed batch is not allowed to disturb the paper. The events are simply dropped: the runner
       * keeps working, answers keep saving, and the student is never interrupted by the integrity log.
       * Retrying forever would turn a network blip into a queue that never drains.
       */
    }
  }, [scope, refId]);

  /* Batch the queue on a timer, and immediately when the page is being hidden. */
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void flush(), FLUSH_INTERVAL_MS);
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [active, flush]);

  /* Focus, visibility and network. These are the honest "did the student leave the paper" signals. */
  useEffect(() => {
    if (!active) return;

    push('session_start');

    const onBlur = () => {
      setAway(true);
      push('focus_lost', 'window lost focus');
    };
    const onFocus = () => {
      setAway(false);
      setFullscreenLost(false);
      push('focus_regained');
      void flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        setAway(true);
        push('focus_lost', 'tab or app switched away from the paper');
      } else {
        setAway(false);
        push('focus_regained');
      }
    };
    const onOffline = () => {
      setOffline(true);
      push('offline');
    };
    const onOnline = () => {
      setOffline(false);
      push('online');
      void flush();
    };

    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [active, flush, push]);

  /*
   * Copy, cut, paste, right-click and printing.
   *
   * A student reading the paper is not blocked from copying their own working notes elsewhere; what is
   * prevented is lifting the paper itself. `preventDefault` only stops the default action — the attempt
   * is still recorded, and the student is told, plainly, that it was.
   */
  useEffect(() => {
    if (!active) return;

    const onCopy = (event: ClipboardEvent) => {
      event.preventDefault();
      push('copy', 'copy from the paper');
      setLastNotice('Copying from the paper is recorded. Work it out here instead.');
      setWarnings((count) => count + 1);
    };
    const onCut = (event: ClipboardEvent) => {
      event.preventDefault();
      push('cut', 'cut from the paper');
    };
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      push('paste', 'paste into an answer box');
      setLastNotice('Pasting into an answer box is recorded. Type your answer so it is genuinely yours.');
      setWarnings((count) => count + 1);
    };
    const onMenu = (event: MouseEvent) => {
      event.preventDefault();
      push('context_menu');
    };
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      // Print, save, view-source, developer tools and reload shortcuts.
      if ((event.ctrlKey || event.metaKey) && ['p', 's', 'u'].includes(key)) {
        event.preventDefault();
        push(key === 'p' ? 'print' : 'devtools_suspect', `shortcut ctrl+${key}`);
        setLastNotice('That shortcut is disabled during a paper.');
        return;
      }
      if (key === 'f12' || ((event.ctrlKey || event.metaKey) && event.shiftKey && ['i', 'j', 'c'].includes(key))) {
        event.preventDefault();
        push('devtools_suspect', 'developer tools shortcut');
      }
      if (key === 'escape' && requireFullscreen) {
        // Not blocked — leaving full-screen is allowed, but it is recorded and the student is told.
        push('fullscreen_exit', 'escape pressed');
      }
    };
    const onBeforePrint = () => {
      push('print', 'print dialog');
      setLastNotice('Printing the paper is recorded.');
    };

    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    document.addEventListener('contextmenu', onMenu);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('beforeprint', onBeforePrint);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('contextmenu', onMenu);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('beforeprint', onBeforePrint);
    };
  }, [active, push, requireFullscreen]);

  /* Full-screen: requested once, at entry. If the platform refuses, the paper proceeds unattended. */
  useEffect(() => {
    if (!active || !requireFullscreen) return;
    const onFullscreenChange = () => {
      const isFull = Boolean(document.fullscreenElement);
      if (!isFull) {
        setFullscreenLost(true);
        push('fullscreen_exit');
        setLastNotice('You left full-screen. The paper is still running and this was recorded.');
      } else {
        setFullscreenLost(false);
        push('fullscreen_enter');
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, [active, push, requireFullscreen]);

  /*
   * A second display is the single most common way to keep a solver open beside a paper. `screen.
   * isExtended` is best-effort — some browsers do not report it — so it is recorded as one signal and
   * never treated as proof on its own.
   */
  useEffect(() => {
    if (!active) return;
    /*
     * `screen.isExtended` has no change event in every browser (and the Screen interface in the DOM
     * typings does not declare one), so it is sampled on a slow interval instead. A second display
     * connected mid-paper is then still noticed, once, without a listener that only some browsers fire.
     */
    let reported = false;
    const check = () => {
      const screenInfo = window.screen as Screen & { isExtended?: boolean };
      if (screenInfo.isExtended && !reported) {
        reported = true;
        push('extended_display', 'more than one display is connected');
      }
    };
    check();
    const timer = window.setInterval(check, 20_000);
    return () => window.clearInterval(timer);
  }, [active, push]);

  /* Window resizes and a reload inside the paper are both worth recording, nothing more. */
  useEffect(() => {
    if (!active) return;
    let resizeTimer: number | null = null;
    const onResize = () => {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => push('resize', `${window.innerWidth}x${window.innerHeight}`), 900);
    };
    window.addEventListener('resize', onResize);
    push('resume', 'paper reopened');
    return () => {
      window.removeEventListener('resize', onResize);
      if (resizeTimer) window.clearTimeout(resizeTimer);
    };
  }, [active, push]);

  /* Leaving the page mid-paper. The browser decides the wording; we only try, and always record. */
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      push('nav_attempt', 'tried to close or navigate away');
      event.preventDefault();
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [active, push]);

  const requestFullscreen = useCallback(async (): Promise<{ ok: boolean; reason?: string }> => {
    const element = document.documentElement;
    try {
      if (element.requestFullscreen) await element.requestFullscreen({ navigationUI: 'hide' });
      return { ok: true };
    } catch (err) {
      const reason = (err as Error)?.message || 'Your browser blocked full-screen mode.';
      onFullscreenUnavailable?.(reason);
      return { ok: false, reason };
    }
  }, [onFullscreenUnavailable]);

  return {
    away,
    fullscreenLost,
    lastNotice,
    warnings,
    pending,
    offline,
    flush,
    requestFullscreen,
  };
}
