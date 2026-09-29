/**
 * Timed exam runner.
 * - The countdown is derived from the server's `expiresAt`, so refreshing, sleeping the laptop or
 *   reopening the paper on another device resumes the same attempt instead of restarting the clock.
 * - Answers autosave to the server as the student works (debounced), and are restored on reload.
 * - Auto-submit at zero, with a warning state in the last minute.
 * - Question palette for jumping around; flag-for-review marks the questions to revisit.
 * - Works on a phone: palette collapses, controls stay reachable with a sticky footer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  CloudOff,
  Flag,
  Loader2,
  RotateCcw,
  Save,
  Send,
} from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import { Badge, Button, Card, ErrorState, Field, LoadingState, ProgressBar, TextArea } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { mmss } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../components/Confirm';
import { AwayNotice, IntegrityNotice, ProctorBar } from '../arena/proctor/components';
import { useProctor } from '../arena/proctor/useProctor';
import type { ExamDetail } from '../../types';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function ExamRunnerPage() {
  const { examId } = useParams<{ examId: string }>();
  const navigate = useNavigate();
  const { push } = useToast();
  const confirm = useConfirm();

  const [exam, setExam] = useState<ExamDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [flagged, setFlagged] = useState<Record<string, boolean>>({});
  const [index, setIndex] = useState(0);
  const [remaining, setRemaining] = useState<number>(0);
  const [submitting, setSubmitting] = useState(false);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [resumed, setResumed] = useState(false);
  /**
   * Integrity mode for a mock exam. A personal exam has no host, so the record is the student's own —
   * it appears on their result, which is the point: they see exactly what was stored about them.
   */
  const [accepted, setAccepted] = useState(false);
  const [starting, setStarting] = useState(false);

  /** Absolute deadline in epoch ms. Everything else is derived from it, so the counter cannot drift. */
  const deadlineRef = useRef<number | null>(null);
  const submittedRef = useRef(false);
  const examRef = useRef<ExamDetail | null>(null);
  examRef.current = exam;

  /* ------------------------------------------------------------ autosave queue */

  const dirty = useRef(new Map<string, { answer?: string; flagged?: boolean }>());
  const flushTimer = useRef<number | null>(null);

  const flushSave = useCallback(async () => {
    const current = examRef.current;
    if (!current || submittedRef.current) return;
    const entries = [...dirty.current.entries()];
    if (!entries.length) return;
    dirty.current.clear();
    setSaveState('saving');
    try {
      for (const [questionId, patch] of entries) {
        await api.post(`/exams/${current.id}/answers`, { questionId, ...patch });
      }
      setSaveState('saved');
    } catch (err) {
      // Put the work back so the next flush retries it; never drop a keystroke on the floor.
      for (const [questionId, patch] of entries) {
        const queued = dirty.current.get(questionId) ?? {};
        dirty.current.set(questionId, { ...patch, ...queued });
      }
      const code = err instanceof ApiError ? err.code : '';
      if (code === 'already_submitted') {
        submittedRef.current = true;
        return;
      }
      setSaveState('error');
    }
  }, []);

  const queueSave = useCallback(
    (questionId: string, patch: { answer?: string; flagged?: boolean }, immediate = false) => {
      const queued = dirty.current.get(questionId) ?? {};
      dirty.current.set(questionId, { ...queued, ...patch });
      if (flushTimer.current) window.clearTimeout(flushTimer.current);
      if (immediate) {
        void flushSave();
        return;
      }
      flushTimer.current = window.setTimeout(() => void flushSave(), 600);
    },
    [flushSave],
  );

  /*
   * Flush on the way out.
   *
   * The 600 ms debounce means a keystroke is briefly only in memory. If the student switches apps, locks
   * the phone or closes the tab inside that window, that write would be lost — so flush whenever the
   * page is hidden and again on unmount. (The Arena runner does the same for its autosave.)
   */
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flushSave();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      if (flushTimer.current) window.clearTimeout(flushTimer.current);
      void flushSave();
    };
  }, [flushSave]);

  /* ---------------------------------------------------------------- loading */

  const load = useCallback(async () => {
    if (!examId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<{ exam: ExamDetail }>(`/exams/${examId}`);
      const loaded = result.exam;
      setExam(loaded);

      // Resume: restore what the server already has for this attempt.
      const savedAnswers = loaded.savedAnswers ?? {};
      const restored = Object.keys(savedAnswers).filter((key) => savedAnswers[key]?.trim()).length;
      setAnswers(savedAnswers);
      setFlagged(Object.fromEntries((loaded.flagged ?? []).map((id) => [id, true])));
      setResumed(restored > 0);

      // The deadline comes from the server. Only fall back to `durationMin` if the paper has never
      // been opened (which cannot happen here, because this GET is what opens it).
      const expiresAt = loaded.expiresAt ? Date.parse(loaded.expiresAt) : null;
      deadlineRef.current =
        expiresAt && Number.isFinite(expiresAt)
          ? expiresAt
          : Date.now() + (loaded.remainingMs ?? loaded.durationMin * 60_000);
      setRemaining(Math.max(0, deadlineRef.current - Date.now()));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this exam.');
    } finally {
      setLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    // Nothing is recorded, and no clock starts, until the student has read and accepted the terms.
    if (accepted) void load();
  }, [accepted, load]);

  /* ---------------------------------------------------------- integrity mode */

  const proctor = useProctor({
    scope: 'exam',
    refId: exam?.id ?? examId ?? '',
    active: Boolean(accepted && exam && !exam.expired && exam.status !== 'completed'),
    requireFullscreen: true,
  });

  /* ---------------------------------------------------------------- submit */

  const submit = useCallback(
    async (auto = false) => {
      const current = examRef.current;
      if (!current || submittedRef.current) return;
      submittedRef.current = true;
      setSubmitting(true);
      // Flush the integrity record first: the server closes it once the paper is submitted.
      await proctor.flush();
      try {
        const payload = {
          answers: current.questions.map((question) => ({
            questionId: question.id,
            answer: answers[question.id] ?? '',
          })),
          timeSpentMs: Math.max(0, Date.now() - (deadlineRef.current ?? Date.now()) + current.durationMin * 60_000),
        };
        const result = await api.post<{ result: { id: string } }>(`/exams/${current.id}/submit`, payload);
        setSubmittedId(result.result.id);
        if (auto) push({ tone: 'info', title: 'Time up', detail: 'Your paper was submitted automatically.' });
        navigate(`/mock-exam/results/${result.result.id}`);
      } catch (err) {
        // Already submitted elsewhere (another tab, or the auto-submit racing a manual one). The
        // server rejects the duplicate and hands back the result that exists, so open that instead
        // of showing an error for work that is safely stored.
        if (err instanceof ApiError && err.code === 'already_submitted') {
          const existing = (err.details as { resultId?: string } | undefined)?.resultId;
          push({ tone: 'info', title: 'Already submitted', detail: 'Opening the result you already have.' });
          navigate(existing ? `/mock-exam/results/${existing}` : '/mock-exam');
          return;
        }
        submittedRef.current = false;
        push({
          tone: 'error',
          title: 'Could not submit',
          detail: err instanceof ApiError ? err.message : 'Please try again — your answers are saved on the server.',
        });
      } finally {
        setSubmitting(false);
      }
    },
    [answers, navigate, push],
  );

  /* ----------------------------------------------------------------- timer */

  useEffect(() => {
    if (!exam || exam.status === 'completed' || submittedId) return;
    const deadline = deadlineRef.current;
    if (!deadline) return;
    const tick = () => {
      const left = deadline - Date.now();
      setRemaining(left > 0 ? left : 0);
      if (left <= 0) {
        window.clearInterval(timer);
        void submit(true);
      }
    };
    const timer = window.setInterval(tick, 1000);
    tick();
    return () => window.clearInterval(timer);
  }, [exam, submit, submittedId]);

  /* ----------------------------------------------------------------- views */

  const answeredCount = useMemo(
    () => Object.values(answers).filter((value) => value.trim()).length,
    [answers],
  );
  const current = exam?.questions[index];
  const urgent = remaining <= 60_000;
  const remainingSeconds = Math.ceil(remaining / 1000);
  /** The server clock already passed the deadline but the paper was never submitted. */
  const timeIsUp = Boolean(exam?.expired) && exam?.status !== 'completed';

  if (!accepted) {
    return (
      <PageBody>
        <IntegrityNotice
          title={examId ? 'your mock exam' : 'this paper'}
          rules={[
            'This is your own practice exam. It is not an official JEE, NEET or board examination.',
            'The clock belongs to the server: reloading the page or closing the tab does not pause it.',
            'Answers autosave as you work, so a lost connection does not cost you the paper.',
            'Integrity signals are recorded for your own review — they are never used to change your score.',
          ]}
          instructions={[
            'One question at a time, with a palette to jump around and flag questions.',
            'The paper submits automatically when the time ends.',
            'Your result shows both your answers and the integrity record for the attempt.',
          ]}
          requireFullscreen
          starting={starting}
          startLabel="Start the exam"
          onStart={async () => {
            setStarting(true);
            try {
              await proctor.requestFullscreen();
              setAccepted(true);
            } finally {
              setStarting(false);
            }
          }}
        />
      </PageBody>
    );
  }

  if (loading) {
    return (
      <PageBody>
        <LoadingState message="Loading your paper…" className="py-24" />
      </PageBody>
    );
  }

  if (error || !exam) {
    return (
      <PageBody>
        <ErrorState message={error ?? 'That exam could not be found.'} onRetry={load} />
      </PageBody>
    );
  }

  const alreadyDone = exam.status === 'completed';

  return (
    <>
      <AwayNotice visible={proctor.away} notice={proctor.lastNotice} />
      <div className="px-4 sm:px-6">
        <ProctorBar
          warnings={proctor.warnings}
          pending={proctor.pending}
          offline={proctor.offline}
          away={proctor.away}
          fullscreenLost={proctor.fullscreenLost}
          requireFullscreen
          onReenterFullscreen={() => void proctor.requestFullscreen()}
        />
      </div>
      <PageHeader
        title={exam.title}
        badge={
          alreadyDone ? (
            <Badge tone="success">Completed</Badge>
          ) : (
            <Badge tone={urgent ? 'error' : 'primary'} icon={<Clock size={12} />}>
              {mmss(remainingSeconds)} left
            </Badge>
          )
        }
        description={`${exam.subject}${exam.chapters.length ? ` · ${exam.chapters.join(', ')}` : ''} · ${exam.difficulty} · ${exam.questions.length} questions`}
        actions={
          <>
            <Button variant="ghost" icon={<ArrowLeft size={15} />} onClick={() => navigate('/mock-exam')}>
              Back
            </Button>
            {!alreadyDone ? (
              <Button
                variant="primary"
                icon={<Send size={15} />}
                loading={submitting}
                onClick={() => {
                  void (async () => {
                    if (answeredCount < exam.questions.length) {
                      const missing = exam.questions.length - answeredCount;
                      const ok = await confirm({
                        title: `Submit with ${missing} question${missing > 1 ? 's' : ''} unanswered?`,
                        description:
                          'Those questions score zero. Anything you have already answered is saved, and you can review the whole paper in your result afterwards.',
                        confirmLabel: 'Submit paper',
                        cancelLabel: 'Keep working',
                        tone: 'primary',
                      });
                      if (!ok) return;
                    }
                    void submit(false);
                  })();
                }}
              >
                Submit paper
              </Button>
            ) : null}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[200px] flex-1">
            <ProgressBar
              value={exam.questions.length ? answeredCount / exam.questions.length : 0}
              tone="primary"
              label="Answered questions"
            />
          </div>
          <span className="text-[12.5px] text-[var(--color-muted)]">
            {answeredCount}/{exam.questions.length} answered
          </span>
          {!alreadyDone ? <SaveIndicator state={saveState} /> : null}
          {urgent && !alreadyDone ? (
            <span className="flex items-center gap-1.5 text-[12.5px] text-[#fca5a5]">
              <AlertTriangle size={13} /> Under a minute — the paper submits automatically at zero.
            </span>
          ) : null}
        </div>
      </PageHeader>

      <PageBody className="space-y-4">
        {alreadyDone ? (
          <div className="rounded-xl border border-[var(--color-success)]/35 bg-[var(--color-success)]/[0.07] px-4 py-3 text-[13px] text-[#7ee2a8]">
            You already submitted this paper. You can review the questions below, or open the analysis from your results.
          </div>
        ) : resumed ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/[0.06] px-4 py-3 text-[13px] text-[var(--color-text)]">
            <RotateCcw size={14} className="text-[var(--color-primary)]" />
            Picked up where you left off — {answeredCount} saved answer{answeredCount === 1 ? '' : 's'} restored and your
            timer is still counting down from the original start.
          </div>
        ) : null}

        {timeIsUp && !alreadyDone ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-warning)]/35 bg-[var(--color-warning)]/[0.07] px-4 py-3 text-[13px] text-[var(--color-warning)]">
            <AlertTriangle size={14} /> Time for this paper has run out on the server. Submit to lock in the answers
            that were saved.
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
          <Card>
            {current ? (
              <div className="space-y-4 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="muted">Q{index + 1}</Badge>
                  <Badge tone="muted">{current.topic}</Badge>
                  <Badge tone="muted" className="capitalize">
                    {current.type}
                  </Badge>
                  <Badge tone="muted">
                    {current.marks} mark{current.marks > 1 ? 's' : ''}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => {
                      const next = !flagged[current.id];
                      setFlagged((value) => ({ ...value, [current.id]: next }));
                      queueSave(current.id, { flagged: next }, true);
                    }}
                    className={[
                      'ml-auto flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors',
                      flagged[current.id]
                        ? 'border-[var(--color-warning)]/50 bg-[var(--color-warning)]/12 text-[#fcd28b]'
                        : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-text)]',
                    ].join(' ')}
                    aria-pressed={Boolean(flagged[current.id])}
                  >
                    <Flag size={12} /> {flagged[current.id] ? 'Flagged' : 'Flag for review'}
                  </button>
                </div>

                <p className="text-[15px] font-medium leading-relaxed">{current.prompt}</p>

                {current.type === 'mcq' && current.options ? (
                  <div className="space-y-2" role="radiogroup" aria-label="Options">
                    {current.options.map((option) => {
                      const selected = answers[current.id] === option;
                      return (
                        <button
                          key={option}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          disabled={alreadyDone}
                          onClick={() => {
                            setAnswers((value) => ({ ...value, [current.id]: option }));
                            queueSave(current.id, { answer: option });
                          }}
                          className={[
                            'flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left text-[13.5px] transition-colors',
                            selected
                              ? 'border-[var(--color-primary)]/50 bg-[var(--color-primary)]/[0.08]'
                              : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]',
                            'disabled:cursor-default',
                          ].join(' ')}
                        >
                          <span
                            className={[
                              'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] font-semibold',
                              selected
                                ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                                : 'border-[var(--color-border-strong)] text-transparent',
                            ].join(' ')}
                          >
                            ✓
                          </span>
                          <span className="min-w-0 flex-1">{option}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <Field label="Your answer" htmlFor="exam-answer" hint="Write the steps you would show in an exam.">
                    <TextArea
                      id="exam-answer"
                      rows={4}
                      value={answers[current.id] ?? ''}
                      disabled={alreadyDone}
                      onChange={(event) => {
                        const value = event.target.value;
                        setAnswers((state) => ({ ...state, [current.id]: value }));
                        queueSave(current.id, { answer: value });
                      }}
                      placeholder="Your answer…"
                    />
                  </Field>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    variant="secondary"
                    icon={<ArrowLeft size={14} />}
                    onClick={() => setIndex((value) => Math.max(0, value - 1))}
                    disabled={index === 0}
                  >
                    Previous
                  </Button>
                  {answers[current.id]?.trim() ? (
                    <span className="flex items-center gap-1.5 text-[12px] text-[#7ee2a8]">
                      <CheckCircle2 size={13} /> Answer saved
                    </span>
                  ) : (
                    <span className="text-[12px] text-[var(--color-muted-dim)]">Unanswered</span>
                  )}
                  <Button
                    variant="secondary"
                    iconRight={<ArrowRight size={14} />}
                    onClick={() => setIndex((value) => Math.min(exam.questions.length - 1, value + 1))}
                    disabled={index >= exam.questions.length - 1}
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </Card>

          <Card className="h-fit lg:sticky lg:top-4">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3.5 py-2.5">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
                Question palette
              </p>
              {!alreadyDone ? <SaveIndicator state={saveState} compact /> : null}
            </div>
            <div className="grid grid-cols-6 gap-1.5 p-3 lg:grid-cols-5">
              {exam.questions.map((question, questionIndex) => {
                const isAnswered = Boolean(answers[question.id]?.trim());
                return (
                  <button
                    key={question.id}
                    type="button"
                    onClick={() => setIndex(questionIndex)}
                    aria-label={`Question ${questionIndex + 1}${isAnswered ? ' (answered)' : ''}${
                      flagged[question.id] ? ' (flagged)' : ''
                    }`}
                    className={[
                      'relative grid h-9 place-items-center rounded-lg border text-[12.5px] font-medium transition-colors',
                      questionIndex === index
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/15 text-[var(--color-primary)]'
                        : isAnswered
                          ? 'border-[var(--color-success)]/40 bg-[var(--color-success)]/10 text-[#7ee2a8]'
                          : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] hover:border-[var(--color-border-strong)]',
                    ].join(' ')}
                  >
                    {questionIndex + 1}
                    {flagged[question.id] ? (
                      <span
                        className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--color-warning)]"
                        aria-hidden="true"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div className="space-y-1.5 border-t border-[var(--color-border)] px-3.5 py-3 text-[11.5px] text-[var(--color-muted)]">
              <p className="flex items-center gap-2">
                <span className="h-3 w-3 rounded border border-[var(--color-success)]/40 bg-[var(--color-success)]/10" />{' '}
                answered
              </p>
              <p className="flex items-center gap-2">
                <span className="h-3 w-3 rounded border border-[var(--color-border)] bg-[var(--color-surface)]" /> not
                answered
              </p>
              <p className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-[var(--color-warning)]" /> flagged for review
              </p>
              {!alreadyDone ? (
                <Button
                  variant="primary"
                  block
                  className="mt-2"
                  icon={<Send size={14} />}
                  loading={submitting}
                  onClick={() => void submit(false)}
                >
                  Submit paper
                </Button>
              ) : null}
            </div>
          </Card>
        </div>
      </PageBody>
    </>
  );
}

/** Honest autosave state — no "your work is safe" claim unless the server actually confirmed it. */
function SaveIndicator({ state, compact = false }: { state: SaveState; compact?: boolean }) {
  if (state === 'idle') return null;
  const map = {
    saving: {
      icon: <Loader2 size={12} className="animate-spin" />,
      label: 'Saving…',
      className: 'text-[var(--color-muted)]',
    },
    saved: {
      icon: <Save size={12} />,
      label: 'Saved',
      className: 'text-[#7ee2a8]',
    },
    error: {
      icon: <CloudOff size={12} />,
      label: 'Not saved — retrying',
      className: 'text-[#fca5a5]',
    },
  } as const;
  const entry = map[state];
  return (
    <span
      className={['flex items-center gap-1.5 text-[11.5px]', entry.className].join(' ')}
      role="status"
      aria-live="polite"
    >
      {entry.icon}
      {compact ? <span className="sr-only">{entry.label}</span> : entry.label}
    </span>
  );
}

export default ExamRunnerPage;
