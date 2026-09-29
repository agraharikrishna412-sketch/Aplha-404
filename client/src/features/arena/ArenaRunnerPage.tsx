/**
 * Arena exam runner.
 *
 * Differences from the casual mock exam runner, and the reasons:
 * - The clock belongs to the server. `deadlineAt` is authoritative, so refreshing, closing the laptop or
 *   stopping the clock on the device changes nothing.
 * - Answers autosave to the server (debounced) and are re-fetched on resume, so a lost connection or a
 *   dead battery does not destroy the paper.
 * - The paper is auto-submitted the moment the server deadline passes; the student is told before that happens.
 * - One question at a time with a palette, flagging and per-question timing (the analysis uses those timings).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  Flag,
  Grid3X3,
  Loader2,
  Send,
  Timer,
  X,
} from 'lucide-react';
import { Badge, Button, Card, ErrorState, LoadingState, Modal } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { compactMs, formatClock, useExamTimer, useServerClock, useUnsavedGuard } from '../../lib/arena';
import { AwayNotice, IntegrityNotice, ProctorBar } from './proctor/components';
import { useProctor } from './proctor/useProctor';
import { useArenaCompetition } from './useArena';
import type { ArenaAttemptStatus, ArenaExamPayload, ArenaQuestionForStudent } from '../../types';

interface AnswerState {
  answer: string;
  flagged: boolean;
  timeSpentMs: number;
  visited: boolean;
}

interface ApiUpdate {
  questionId: string;
  answer?: string;
  flagged?: boolean;
  timeSpentMs?: number;
}

export function ArenaRunnerPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { push } = useToast();

  const meta = useArenaCompetition(id);
  const [exam, setExam] = useState<ArenaExamPayload | null>(null);
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [syncDetail, setSyncDetail] = useState<string | null>(null);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [warning60, setWarning60] = useState(false);
  const [warning300, setWarning300] = useState(false);
  /**
   * The paper does not start until the student has read what integrity mode does and accepted it.
   * Starting a timed paper without that is how a student ends up surprised by a recorded event.
   */
  const [accepted, setAccepted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [fullscreenNote, setFullscreenNote] = useState<string | null>(null);

  const dirty = useRef<Map<string, ApiUpdate>>(new Map());
  /** Mirror of `answers` for effects/callbacks that must not close over a stale render. */
  const answersRef = useRef<Record<string, AnswerState>>({});
  const questionStartedAt = useRef<number>(Date.now());
  const submittedRef = useRef(false);
  const saveTimer = useRef<number | null>(null);

  /** Every `setAnswers` goes through here so the ref mirror can never drift from the state. */
  const syncMirror = useCallback((updater: (current: Record<string, AnswerState>) => Record<string, AnswerState>) => {
    setAnswers((current) => {
      const next = updater(current);
      answersRef.current = next;
      return next;
    });
  }, []);

  useUnsavedGuard(dirtyCount > 0 || syncState === 'saving', 'Answers are still syncing to the server.');

  /* ---------------------------------- load --------------------------------- */

  const start = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.post<{ exam: ArenaExamPayload }>(`/arena/competitions/${id}/start`, {});
      const payload = result.exam;
      const initial: Record<string, AnswerState> = {};
      for (const question of payload.questions) {
        const saved = payload.answers?.[question.id];
        initial[question.id] = {
          answer: saved?.answer ?? '',
          flagged: Boolean(saved?.flagged),
          timeSpentMs: saved?.timeSpentMs ?? 0,
          visited: Boolean(saved?.answer) || Boolean(saved?.flagged),
        };
      }
      setExam(payload);
      setAnswers(initial);
      answersRef.current = initial;
      setIndex(0);
      questionStartedAt.current = Date.now();
      if (payload.attempt.status !== 'in_progress') {
        // Already submitted (e.g. auto-submitted while away) — no point showing the paper.
        navigate(`/arena/results/${payload.attempt.id}`, { replace: true });
        return;
      }
    } catch (err) {
      // The paper was already submitted (this tab, another tab, or the auto-submit timer). The first
      // submission is the one that counts, so open that result instead of a dead-end error.
      if (err instanceof ApiError && err.code === 'already_submitted') {
        const details = err.details as { attemptId?: string } | undefined;
        if (details?.attemptId) {
          navigate(`/arena/results/${details.attemptId}`, { replace: true });
          return;
        }
      }
      if (err instanceof ApiError && err.code === 'paper_not_ready') {
        setError(
          'This paper is still being prepared by the organiser — every question has to be reviewed and approved first. Try again shortly.',
        );
      } else if (err instanceof ApiError && err.code === 'attempt_expired') {
        setError(err.message);
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not open this paper.');
      }
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  /**
   * A paper the student has already submitted must never sit behind the integrity gate.
   *
   * The gate explains full-screen and event recording, so it is the wrong thing to show for a paper
   * that is finished — the student reads a warning about a timed paper they are not about to take,
   * accepts terms that no longer apply, and only then gets bounced to their result. Asking for the
   * attempt status first turns that dead end into the answer they wanted. `start()` keeps its own
   * `already_submitted` handling as the backstop for a paper submitted in another tab while this one
   * is open.
   */
  const [checkingAttempt, setCheckingAttempt] = useState(true);
  useEffect(() => {
    if (!id || accepted) return;
    let cancelled = false;
    void (async () => {
      try {
        const status = await api.get<ArenaAttemptStatus>(`/arena/competitions/${id}/status`);
        if (cancelled) return;
        if (status.attempt && status.attempt.status !== 'in_progress') {
          navigate(`/arena/results/${status.attempt.id}`, { replace: true });
          return;
        }
      } catch {
        /* No usable status (offline, not registered, paper withdrawn): let the gate do its job and
           let `start()` report whatever the server says. */
      } finally {
        if (!cancelled) setCheckingAttempt(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, accepted, navigate]);

  useEffect(() => {
    if (accepted) void start();
  }, [accepted, start]);

  const clock = useServerClock(exam?.competition.serverNow ?? null);
  const timer = useExamTimer(exam?.attempt.deadlineAt, clock.serverNowMs);

  /*
   * Integrity mode (§44). It records; it never gates. The clock, the paper and the marking stay on the
   * server, and a signal that fails to send does not interrupt the paper.
   */
  const competitionId = exam?.competition.id ?? id ?? '';
  const proctor = useProctor({
    scope: 'arena',
    refId: competitionId,
    active: Boolean(exam && exam.attempt.status === 'in_progress'),
    requireFullscreen: Boolean(exam && !exam.competition.isDemo),
    onFullscreenUnavailable: (reason) => setFullscreenNote(reason),
  });

  /* --------------------------------- saving -------------------------------- */

  const flush = useCallback(
    async (keepalive = false) => {
      if (!exam || dirty.current.size === 0) return;
      const batch = Array.from(dirty.current.values()).slice(0, 120);
      for (const update of batch) dirty.current.delete(update.questionId);
      setDirtyCount(dirty.current.size);
      setSyncState('saving');
      try {
        await api.post(`/arena/competitions/${exam.competition.id}/answers`, { updates: batch });
        setSyncState('saved');
        setSyncDetail(new Date().toLocaleTimeString());
      } catch (err) {
        // Put the batch back so the next tick retries it — losing answers silently is unacceptable.
        for (const update of batch) {
          if (!dirty.current.has(update.questionId)) dirty.current.set(update.questionId, update);
        }
        setDirtyCount(dirty.current.size);
        setSyncState('error');
        setSyncDetail(err instanceof ApiError ? err.message : 'Connection problem.');
        if (keepalive === false) return;
      }
    },
    [exam],
  );

  const schedule = useCallback(
    (update: ApiUpdate) => {
      dirty.current.set(update.questionId, { ...dirty.current.get(update.questionId), ...update });
      setDirtyCount(dirty.current.size);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flush(), 1800);
    },
    [flush],
  );

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush(true);
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [flush]);

  /* ------------------------------ question timing -------------------------- */

  const commitTime = useCallback(
    (questionId: string) => {
      const spent = Date.now() - questionStartedAt.current;
      if (spent <= 0) return;
      questionStartedAt.current = Date.now();
      // Read the accumulated time from the ref, not from the render closure: navigating quickly
      // between questions used to compare against a stale value and under-report the time spent.
      const previous = answersRef.current[questionId]?.timeSpentMs ?? 0;
      const total = previous + spent;
      setAnswers((current) => {
        const existing = current[questionId];
        if (!existing) return current;
        const next = { ...current, [questionId]: { ...existing, timeSpentMs: total } };
        answersRef.current = next;
        return next;
      });
      schedule({ questionId, timeSpentMs: total });
    },
    [schedule],
  );

  const goTo = useCallback(
    (nextIndex: number) => {
      if (!exam) return;
      const current = exam.questions[index];
      if (current) commitTime(current.id);
      const bounded = Math.max(0, Math.min(exam.questions.length - 1, nextIndex));
      setIndex(bounded);
      const nextQuestion = exam.questions[bounded];
      if (nextQuestion) {
        syncMirror((state) => ({
          ...state,
          [nextQuestion.id]: { ...state[nextQuestion.id], visited: true },
        }));
      }
    },
    [commitTime, exam, index],
  );

  /* --------------------------------- submit -------------------------------- */

  const submit = useCallback(
    async (auto = false) => {
      if (!exam || submittedRef.current) return;
      submittedRef.current = true;
      setSubmitting(true);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      /*
       * Signals are flushed *before* submitting: the server freezes the record once the paper is
       * submitted, so anything still queued afterwards would be dropped. A failed flush is ignored —
       * it must never stop a submission.
       */
      await proctor.flush();
      try {
        const payload = exam.questions.map((question) => ({
          questionId: question.id,
          answer: answers[question.id]?.answer ?? '',
          flagged: Boolean(answers[question.id]?.flagged),
          timeSpentMs: answers[question.id]?.timeSpentMs ?? 0,
        }));
        const result = await api.post<{ outcome: { attemptId: string; autoSubmitted: boolean } }>(
          `/arena/competitions/${exam.competition.id}/submit`,
          { answers: payload },
        );
        push({
          tone: 'success',
          title: auto ? 'Time up — paper submitted automatically' : 'Paper submitted',
          detail: 'Your analysis will be ready when results are published.',
        });
        navigate(`/arena/results/${result.outcome.attemptId}`, { replace: true });
      } catch (err) {
        submittedRef.current = false;
        setSubmitting(false);
        // Already submitted (usually the other tab / the auto-submit timer won the race): the first
        // submission is the one that counts, so send the student to that result rather than an error.
        if (err instanceof ApiError && err.code === 'already_submitted') {
          const details = err.details as { attemptId?: string } | undefined;
          push({ tone: 'info', title: 'This paper was already submitted', detail: 'Opening your result.' });
          if (details?.attemptId) {
            navigate(`/arena/results/${details.attemptId}`, { replace: true });
            return;
          }
        }
        push({
          tone: 'error',
          title: 'Could not submit',
          detail: err instanceof ApiError ? err.message : 'Check your connection and try again.',
        });
      }
    },
    [answers, exam, navigate, push],
  );

  // Server clock crossed the deadline → submit. (The server enforces this anyway; this is just UX.)
  useEffect(() => {
    if (!exam || loading) return;
    if (timer.expired && !submittedRef.current) void submit(true);
  }, [exam, loading, submit, timer.expired]);

  useEffect(() => {
    if (!exam) return;
    if (timer.remainingSeconds <= 300 && !warning300) {
      setWarning300(true);
      push({ tone: 'warning', title: '5 minutes left', detail: 'Answers autosave, but finish the paper you meant to finish.' });
    }
    if (timer.remainingSeconds <= 60 && !warning60) {
      setWarning60(true);
      push({ tone: 'error', title: '1 minute left', detail: 'The paper submits itself at zero.' });
    }
  }, [exam, push, timer.remainingSeconds, warning300, warning60]);

  /* -------------------------------- shortcuts ------------------------------ */

  const current: ArenaQuestionForStudent | undefined = exam?.questions[index];

  const setAnswer = useCallback(
    (questionId: string, value: string) => {
      syncMirror((state) => ({ ...state, [questionId]: { ...state[questionId], answer: value, visited: true } }));
      schedule({ questionId, answer: value });
    },
    [schedule],
  );

  const toggleFlag = useCallback(
    (questionId: string) => {
      const next = !answers[questionId]?.flagged;
      syncMirror((state) => ({ ...state, [questionId]: { ...state[questionId], flagged: next, visited: true } }));
      schedule({ questionId, flagged: next });
    },
    [answers, schedule],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!exam || !current || confirmSubmit) return;
      const target = event.target as HTMLElement | null;
      const typing = target && ['INPUT', 'TEXTAREA'].includes(target.tagName);
      if (event.key === 'ArrowLeft' && !typing) goTo(index - 1);
      if (event.key === 'ArrowRight' && !typing) goTo(index + 1);
      if ((event.key === 'f' || event.key === 'F') && !typing) toggleFlag(current.id);
      if (!typing && ['1', '2', '3', '4', '5', '6'].includes(event.key) && current.options?.[Number(event.key) - 1]) {
        setAnswer(current.id, current.options[Number(event.key) - 1]!);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmSubmit, current, exam, goTo, index, setAnswer, toggleFlag]);

  /* --------------------------------- render -------------------------------- */

  const counts = useMemo(() => {
    if (!exam) return { answered: 0, flagged: 0, unseen: 0 };
    let answered = 0;
    let flagged = 0;
    let unseen = 0;
    for (const question of exam.questions) {
      const state = answers[question.id];
      if (state?.answer.trim()) answered += 1;
      if (state?.flagged) flagged += 1;
      if (!state?.visited) unseen += 1;
    }
    return { answered, flagged, unseen };
  }, [answers, exam]);

  /*
   * Before anything is recorded, the student is told what integrity mode does, what it cannot see, and
   * what will be stored — and must accept it. This is also where they are warned about a second
   * display, being offline, or a browser that cannot go full-screen, while there is still time to fix
   * it. Nothing is recorded until they press start.
   */
  if (!accepted) {
    /*
     * While the attempt status is being fetched, show a neutral loading line rather than the gate: a
     * student whose paper is already submitted would otherwise see the rules, read them, and only then
     * be sent to their result.
     */
    if (checkingAttempt && !meta.error) {
      return <LoadingState message="Checking this paper…" className="min-h-[60vh]" />;
    }
    if (meta.error) {
      return (
        <div className="mx-auto max-w-xl px-4 py-16">
          <ErrorState message={meta.error} onRetry={() => void meta.refresh()} />
        </div>
      );
    }
    if (meta.loading && !meta.data) {
      return <LoadingState message="Checking this paper…" className="min-h-[60vh]" />;
    }
    const competition = meta.data?.competition;
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <IntegrityNotice
          title={competition?.title ?? 'this competition'}
          rules={competition?.rules ?? []}
          instructions={competition?.instructions ?? []}
          requireFullscreen={Boolean(competition && !competition.isDemo)}
          starting={starting}
          onStart={async () => {
            setStarting(true);
            try {
              if (competition && !competition.isDemo && typeof document.documentElement.requestFullscreen === 'function') {
                const result = await proctor.requestFullscreen();
                if (!result.ok) {
                  // Refused full-screen is not a reason to block the paper. It is recorded, and the
                  // student carries on with a note explaining the difference.
                  setFullscreenNote(result.reason ?? 'Full-screen was refused by your browser.');
                }
              }
              setAccepted(true);
            } finally {
              setStarting(false);
            }
          }}
        />
        {fullscreenNote ? (
          <p className="mx-auto mt-3 max-w-2xl text-center text-[12px] text-[var(--color-muted)]">{fullscreenNote}</p>
        ) : null}
      </div>
    );
  }

  if (loading || !exam || !current) {
    if (error) {
      return (
        <div className="mx-auto max-w-xl px-4 py-16">
          <ErrorState message={error} onRetry={() => void start()} />
        </div>
      );
    }
    return (
      <LoadingState message="Loading your paper…" className="min-h-[60vh]" />
    );
  }

  const currentState: AnswerState =
    answers[current.id] ?? { answer: '', flagged: false, timeSpentMs: 0, visited: true };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-[var(--color-bg)] safe-top safe-bottom">
      {/* Sticky exam header: identity, clock, autosave state */}
      <header className="vroqn-glass sticky top-0 z-30 border-b border-[var(--color-border)]">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-3 py-2.5 sm:px-5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-semibold">{exam.competition.title}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--color-muted)]">
              <span>
                Question {index + 1}/{exam.questions.length}
              </span>
              <span className="text-[var(--color-border-strong)]">|</span>
              <span>{current.subject}</span>
              <span className="text-[var(--color-border-strong)]">|</span>
              <span>
                +{current.marks} / −{current.negativeMarks}
              </span>
            </p>
          </div>

          <div
            className={[
              'flex items-center gap-2 rounded-xl border px-3 py-1.5 font-mono text-[15px] font-semibold tabular-nums',
              timer.critical
                ? 'animate-pulse border-[var(--color-error)]/50 bg-[var(--color-error)]/10 text-[#fca5a5]'
                : timer.low
                  ? 'border-[var(--color-warning)]/45 bg-[var(--color-warning)]/10 text-[#fcd28b]'
                  : 'border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-text)]',
            ].join(' ')}
            role="timer"
            aria-live="off"
          >
            <Timer size={14} aria-hidden="true" />
            {formatClock(timer.remainingSeconds)}
          </div>
        </div>

        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-3 pb-2 text-[11px] sm:px-5">
          <div className="flex items-center gap-2">
            <SyncBadge state={syncState} detail={syncDetail} dirty={dirtyCount} />
            <span className="text-[var(--color-muted-dim)]">
              {counts.answered}/{exam.questions.length} answered
            </span>
            {executionModeNote(exam.competition.isDemo)}
          </div>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="vroqn-tap inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[11.5px] text-[var(--color-muted)] hover:text-[var(--color-text)] lg:hidden"
          >
            <Grid3X3 size={12} /> Palette
          </button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-3 pt-3 sm:px-5">
        <ProctorBar
          warnings={proctor.warnings}
          pending={proctor.pending}
          offline={proctor.offline}
          away={proctor.away}
          fullscreenLost={proctor.fullscreenLost}
          requireFullscreen={Boolean(exam && !exam.competition.isDemo)}
          onReenterFullscreen={() => void proctor.requestFullscreen()}
        />
        {fullscreenNote ? <p className="mt-1.5 text-[11.5px] text-[var(--color-muted-dim)]">{fullscreenNote}</p> : null}
      </div>

      <AwayNotice visible={proctor.away} notice={proctor.lastNotice} />

      <div className="mx-auto grid w-full max-w-6xl flex-1 gap-4 px-3 py-4 sm:px-5 lg:grid-cols-[1fr_260px]">
        <div className="flex flex-col gap-3">
          <Card className="flex-1 p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge tone="neutral">Q{index + 1}</Badge>
              <Badge tone="muted" className="capitalize">
                {current.type}
              </Badge>
              <Badge tone={current.difficulty === 'easy' ? 'success' : current.difficulty === 'hard' ? 'error' : 'warning'}>
                {current.difficulty}
              </Badge>
              <span className="text-[11.5px] text-[var(--color-muted-dim)]">{current.topic}</span>
              <button
                type="button"
                onClick={() => toggleFlag(current.id)}
                aria-pressed={currentState.flagged}
                className={[
                  'ml-auto inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11.5px]',
                  currentState.flagged
                    ? 'border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 text-[#fcd28b]'
                    : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-text)]',
                ].join(' ')}
              >
                <Flag size={12} /> {currentState.flagged ? 'Flagged' : 'Flag for review'}
              </button>
            </div>

            <p className="whitespace-pre-wrap text-[15.5px] leading-relaxed text-[var(--color-text)]">{current.prompt}</p>

            <div className="mt-4">
              {current.options?.length ? (
                <ul className="grid gap-2">
                  {current.options.map((option, optionIndex) => {
                    const selected = currentState.answer === option;
                    return (
                      <li key={option}>
                        <button
                          type="button"
                          onClick={() => setAnswer(current.id, option)}
                          aria-pressed={selected}
                          className={[
                            'flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left text-[14px] transition-colors',
                            selected
                              ? 'border-[var(--color-primary)]/60 bg-[var(--color-primary)]/[0.09] text-[var(--color-text)]'
                              : 'border-[var(--color-border)] bg-[var(--color-card)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-card-hover)]',
                          ].join(' ')}
                        >
                          <span
                            className={[
                              'grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11.5px] font-semibold',
                              selected
                                ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[#04161b]'
                                : 'border-[var(--color-border-strong)] text-[var(--color-muted)]',
                            ].join(' ')}
                          >
                            {selected ? <Check size={13} /> : String.fromCharCode(65 + optionIndex)}
                          </span>
                          <span className="min-w-0 flex-1">{option}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div>
                  <label htmlFor="arena-answer" className="mb-1.5 block text-[12.5px] text-[var(--color-muted)]">
                    {current.type === 'numerical' ? 'Enter your answer (numbers only)' : 'Write your answer'}
                  </label>
                  <input
                    id="arena-answer"
                    value={currentState.answer}
                    inputMode={current.type === 'numerical' ? 'decimal' : 'text'}
                    onChange={(event) => setAnswer(current.id, event.target.value)}
                    placeholder={current.type === 'numerical' ? 'e.g. 9.8' : 'Type your response'}
                    className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3 text-[15px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-muted-dim)] focus:border-[var(--color-primary)]/60"
                  />
                  <p className="mt-1.5 text-[11.5px] text-[var(--color-muted-dim)]">
                    {current.type === 'numerical'
                      ? 'Units are optional unless the question asks for them. Give your answer as a number.'
                      : 'Short conceptual answers are graded on the key ideas, so be specific.'}
                  </p>
                </div>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAnswer(current.id, '');
                  push({ tone: 'info', title: 'Response cleared' });
                }}
                disabled={!currentState.answer}
              >
                Clear response
              </Button>
              <span className="ml-auto text-[11.5px] text-[var(--color-muted-dim)]">
                Time on this question: {compactMs(currentState.timeSpentMs)}
              </span>
            </div>
          </Card>

          {/* Sticky controls: always reachable with a thumb on a phone */}
          <div className="vroqn-glass sticky bottom-0 z-20 -mx-3 border-t border-[var(--color-border)] px-3 py-2.5 sm:-mx-5 sm:px-5">
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                icon={<ChevronLeft size={15} />}
                disabled={index === 0}
                onClick={() => goTo(index - 1)}
              >
                <span className="hidden sm:inline">Previous</span>
              </Button>
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  toggleFlag(current.id);
                }}
                icon={<Flag size={15} />}
              >
                <span className="hidden sm:inline">{currentState.flagged ? 'Unflag' : 'Mark for review'}</span>
                <span className="sm:hidden">{currentState.flagged ? 'Unflag' : 'Flag'}</span>
              </Button>
              {index === exam.questions.length - 1 ? (
                <Button variant="primary" icon={<Send size={15} />} onClick={() => setConfirmSubmit(true)}>
                  Submit
                </Button>
              ) : (
                <Button
                  variant="primary"
                  iconRight={<ChevronRight size={15} />}
                  className="flex-1 sm:flex-none"
                  onClick={() => goTo(index + 1)}
                >
                  Save &amp; Next
                </Button>
              )}
            </div>
            <p className="mt-1.5 hidden text-center text-[11px] text-[var(--color-muted-dim)] sm:block">
              Keys: ← → question · 1–4 select option · F flag
            </p>
          </div>
        </div>

        {/* Desktop palette rail */}
        <aside className="hidden lg:block">
          <Card className="sticky top-24 p-3.5">
            <p className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
              Question palette
            </p>
            <div className="mt-2.5 grid grid-cols-5 gap-1.5">
              {exam.questions.map((question, questionIndex) => (
                <PaletteButton
                  key={question.id}
                  index={questionIndex}
                  state={answers[question.id]}
                  isCurrent={questionIndex === index}
                  onClick={() => goTo(questionIndex)}
                />
              ))}
            </div>
            <PaletteLegend />
            <div className="mt-3 border-t border-[var(--color-border)] pt-3">
              <Button variant="primary" block icon={<Send size={15} />} onClick={() => setConfirmSubmit(true)}>
                Submit paper
              </Button>
            </div>
          </Card>
        </aside>
      </div>

      {/* Mobile palette sheet */}
      {paletteOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Question palette">
          <button
            type="button"
            aria-label="Close palette"
            className="absolute inset-0 bg-black/60"
            onClick={() => setPaletteOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl border-t border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[13px] font-semibold">Question palette</p>
              <button type="button" onClick={() => setPaletteOpen(false)} aria-label="Close" className="p-1">
                <X size={16} />
              </button>
            </div>
            <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8">
              {exam.questions.map((question, questionIndex) => (
                <PaletteButton
                  key={question.id}
                  index={questionIndex}
                  state={answers[question.id]}
                  isCurrent={questionIndex === index}
                  onClick={() => {
                    goTo(questionIndex);
                    setPaletteOpen(false);
                  }}
                />
              ))}
            </div>
            <PaletteLegend />
            <Button variant="primary" block className="mt-4" icon={<Send size={15} />} onClick={() => setConfirmSubmit(true)}>
              Submit paper
            </Button>
          </div>
        </div>
      ) : null}

      <Modal
        open={confirmSubmit}
        onClose={() => setConfirmSubmit(false)}
        title="Submit this paper?"
        description="Once submitted you cannot reopen it. Your analysis appears when results are published."
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => setConfirmSubmit(false)}>
              Keep working
            </Button>
            <Button
              variant="primary"
              loading={submitting}
              icon={<Send size={15} />}
              onClick={() => void submit(false)}
            >
              Submit final answers
            </Button>
          </div>
        }
      >
        <ul className="space-y-1.5 text-[13px] text-[var(--color-muted)]">
          <li>Answered: {counts.answered} of {exam.questions.length}</li>
          <li>Flagged for review: {counts.flagged}</li>
          <li>Not yet visited: {counts.unseen}</li>
          <li>Time left: {formatClock(timer.remainingSeconds)}</li>
        </ul>
      </Modal>
    </div>
  );
}

function PaletteButton({
  index,
  state,
  isCurrent,
  onClick,
}: {
  index: number;
  state?: AnswerState;
  isCurrent: boolean;
  onClick: () => void;
}) {
  const answered = Boolean(state?.answer.trim());
  const flagged = Boolean(state?.flagged);
  const visited = Boolean(state?.visited);

  const tone = flagged
    ? 'border-[var(--color-warning)]/60 bg-[var(--color-warning)]/15 text-[#fcd28b]'
    : answered
      ? 'border-[var(--color-success)]/50 bg-[var(--color-success)]/15 text-[#86efac]'
      : visited
        ? 'border-[var(--color-error)]/40 bg-[var(--color-error)]/10 text-[#fca5a5]'
        : 'border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-muted)]';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isCurrent ? 'true' : undefined}
      aria-label={`Question ${index + 1}${answered ? ' answered' : ''}${flagged ? ' flagged' : ''}`}
      className={[
        'relative grid h-9 w-full place-items-center rounded-lg border text-[12px] font-medium transition-transform active:scale-95',
        tone,
        isCurrent ? 'ring-2 ring-[var(--color-primary)]/70' : '',
      ].join(' ')}
    >
      {index + 1}
      {flagged ? <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--color-warning)]" /> : null}
    </button>
  );
}

function PaletteLegend() {
  return (
    <div className="mt-3 grid grid-cols-2 gap-1.5 text-[11px] text-[var(--color-muted)]">
      <LegendDot className="border-[var(--color-success)]/50 bg-[var(--color-success)]/20" label="Answered" />
      <LegendDot className="border-[var(--color-error)]/40 bg-[var(--color-error)]/15" label="Not answered" />
      <LegendDot className="border-[var(--color-warning)]/60 bg-[var(--color-warning)]/20" label="Flagged" />
      <LegendDot className="border-[var(--color-border)] bg-[var(--color-card)]" label="Not visited" />
    </div>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-3 w-3 rounded border ${className}`} aria-hidden="true" />
      {label}
    </span>
  );
}

function SyncBadge({ state, detail, dirty }: { state: 'idle' | 'saving' | 'saved' | 'error'; detail: string | null; dirty: number }) {
  if (state === 'saving') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[var(--color-muted)]">
        <Loader2 size={11} className="animate-spin" /> Saving{dirty ? ` (${dirty})` : ''}…
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[var(--color-error)]" title={detail ?? undefined}>
        <CloudOff size={11} /> Not saved — retrying
      </span>
    );
  }
  if (state === 'saved') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[var(--color-success)]" title={detail ?? undefined}>
        <Check size={11} /> Answers saved
      </span>
    );
  }
  return <span className="text-[var(--color-muted-dim)]">Autosave on</span>;
}

function executionModeNote(isDemo?: boolean) {
  if (!isDemo) return null;
  return (
    <span className="hidden items-center gap-1 text-[var(--color-warning)] sm:inline-flex">
      <AlertTriangle size={11} /> Demo paper
    </span>
  );
}

export default ArenaRunnerPage;
