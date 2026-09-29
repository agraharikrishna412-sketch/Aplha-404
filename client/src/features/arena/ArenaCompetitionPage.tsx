/**
 * Competition detail — everything a student needs before committing: what it covers, how marking
 * works, the rules, the clock, and one clear primary action.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Info,
  Play,
  ShieldCheck,
  Timer,
  Trophy,
  Users,
} from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import {
  Button,
  Card,
  CardHeader,
  ErrorState,
  LoadingState,
  Modal,
  SampleNotice,
  StatTile,
} from '../../components/ui';
import { useToast } from '../../hooks/useToast';
import { useAuth } from '../../hooks/useAuth';
import { formatDateTimeLong, useServerClock, useTicker } from '../../lib/arena';
import { api, ApiError } from '../../lib/api';

import { useArenaAttemptStatus, useArenaCompetition } from './useArena';
import { HostIntegrityList } from './proctor/components';
import { CountdownPill, DifficultyMix, StateBadge } from './components';

export function ArenaCompetitionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { push } = useToast();
  const { user } = useAuth();
  const { data, loading, error, refresh } = useArenaCompetition(id);
  const { data: status, refresh: refreshStatus } = useArenaAttemptStatus(id, true, 15000);
  const clock = useServerClock(data?.competition.serverNow ?? status?.serverNow ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmStart, setConfirmStart] = useState(false);
  useTicker(1000);

  const competition = data?.competition ?? null;
  const state = status?.state ?? competition?.state ?? 'UPCOMING';
  const registered = competition?.registration?.status === 'registered';
  const attempt = status?.attempt ?? null;
  const inProgress = attempt?.status === 'in_progress';

  const totalMarks = useMemo(() => competition?.maxScore ?? 0, [competition]);

  async function register() {
    if (!id) return;
    setBusy('register');
    try {
      const result = await api.post<{ message: string }>(`/arena/competitions/${id}/register`, {});
      push({ tone: 'success', title: 'You are registered', detail: result.message });
      await Promise.all([refresh(), refreshStatus()]);
    } catch (err) {
      push({ tone: 'error', title: 'Could not register', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function unregister() {
    if (!id) return;
    setBusy('unregister');
    try {
      await api.del(`/arena/competitions/${id}/register`);
      push({ tone: 'info', title: 'Registration withdrawn' });
      await Promise.all([refresh(), refreshStatus()]);
    } catch (err) {
      push({ tone: 'error', title: 'Could not withdraw', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    if (!id) return;
    setBusy('start');
    try {
      await api.post(`/arena/competitions/${id}/start`, {});
      setConfirmStart(false);
      navigate(`/arena/${id}/start`);
    } catch (err) {
      setConfirmStart(false);
      push({
        tone: 'error',
        title: 'Could not start the paper',
        detail: err instanceof ApiError ? err.message : 'Try again in a moment.',
      });
    } finally {
      setBusy(null);
    }
  }

  if (loading && !competition) {
    return (
      <PageBody>
        <LoadingState message="Loading this competition…" />
      </PageBody>
    );
  }

  if (error || !competition) {
    return (
      <>
        <PageHeader title="Competition" />
        <PageBody>
          <ErrorState message={error ?? 'This competition is not available.'} onRetry={() => void refresh()} />
          <div className="mt-4">
            <Link to="/arena" className="text-[13px] text-[var(--color-primary)]">
              ← Back to Arena
            </Link>
          </div>
        </PageBody>
      </>
    );
  }

  const remainingToEnd = clock.remainingSeconds(competition.endsAt);
  const canStart = state === 'LIVE' && registered && !attempt;
  const canResume = state === 'LIVE' && inProgress;
  const canViewResults = (state === 'RESULTS_PUBLISHED' || state === 'ARCHIVED') && attempt?.status === 'submitted';

  return (
    <>
      <PageHeader
        title={competition.title}
        badge={<StateBadge state={state} />}
        description={competition.description}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/arena"
              className="inline-flex h-10 items-center gap-1.5 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] px-3.5 text-sm hover:border-[var(--color-border-strong)]"
            >
              <ArrowLeft size={15} /> Arena
            </Link>
            {canResume ? (
              <Button variant="primary" icon={<Play size={15} />} onClick={() => navigate(`/arena/${competition.id}/start`)}>
                Continue ({Math.max(0, Math.round((status?.remainingSeconds ?? 0) / 60))} min left)
              </Button>
            ) : canStart ? (
              <Button variant="primary" icon={<Play size={15} />} onClick={() => setConfirmStart(true)}>
                Start paper
              </Button>
            ) : canViewResults ? (
              <Button
                variant="primary"
                icon={<Trophy size={15} />}
                onClick={() => navigate(`/arena/results/${attempt?.id}`)}
              >
                View my analysis
              </Button>
            ) : state === 'REGISTRATION_OPEN' && !registered ? (
              <Button variant="primary" loading={busy === 'register'} onClick={() => void register()}>
                Register
              </Button>
            ) : registered ? (
              <Button variant="secondary" loading={busy === 'unregister'} onClick={() => void unregister()}>
                Withdraw registration
              </Button>
            ) : null}
          </div>
        }
      />

      <PageBody className="space-y-5">
        {/*
          * Only the host of this paper (its creator) or a site admin can read the integrity overview,
          * and the API enforces that independently — this condition only decides whether to ask.
          */}
        {competition.isHost || user?.role === 'admin' ? <HostIntegrityList competitionId={competition.id} /> : null}

        {competition.isDemo ? (
          <SampleNotice text="This is a demo competition seeded for previews — real papers are created by your school or Vroqn admin." />
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Questions" value={competition.questionCount} icon={<ClipboardList size={15} />} />
          <StatTile label="Duration" value={`${competition.durationMin} min`} icon={<Timer size={15} />} />
          <StatTile
            label="Marking"
            value={`+${competition.marksPerQuestion} / −${competition.negativeMarks}`}
            icon={<BadgeCheck size={15} />}
            sub={`Max ${totalMarks} marks`}
          />
          <StatTile
            label={state === 'LIVE' ? 'Ends in' : 'Starts'}
            value={state === 'LIVE' ? formatClockShort(remainingToEnd) : formatDateTimeLong(competition.startsAt)}
            icon={<CalendarClock size={15} />}
            sub={`${competition.participantCount} participating`}
          />
        </div>

        {(state === 'RESULTS_PUBLISHED' || state === 'ARCHIVED') && attempt?.status === 'submitted' ? (
          <Card className="border-[var(--color-primary)]/30 bg-[var(--color-primary)]/[0.05] p-4">
            <p className="text-[13.5px] leading-relaxed text-[var(--color-text)]">
              Results are out. Your analysis includes subject/topic breakdown, time behaviour, benchmark percentile and
              AI recommendations for what to study next.
            </p>
            <div className="mt-3">
              <Button variant="primary" size="sm" onClick={() => navigate(`/arena/results/${attempt.id}`)}>
                Open my analysis
              </Button>
            </div>
          </Card>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
          <div className="space-y-4">
            <Card>
              <CardHeader
                title="How this paper is structured"
                subtitle="Questions are drawn from the blueprint ordered by subject, difficulty and type."
                icon={<ClipboardList size={16} />}
              />
              <div className="space-y-3 px-4 pb-4">
                <ul className="space-y-2">
                  {(data?.blueprint?.subjects ?? []).map((entry) => (
                    <li
                      key={entry.subject}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px]"
                    >
                      <span className="font-medium">{entry.subject}</span>
                      <span className="text-[12px] text-[var(--color-muted)]">
                        {entry.count} questions
                        {entry.chapters?.length ? ` · ${entry.chapters.join(', ')}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
                <DifficultyMix mix={competition.difficultyMix} />
                <p className="text-[12.5px] text-[var(--color-muted)]">
                  Types:{' '}
                  {Object.entries(competition.typeMix ?? {})
                    .filter(([, share]) => share)
                    .map(([type, share]) => `${type} ${share}%`)
                    .join(' · ')}
                </p>
              </div>
            </Card>

            <Card>
              <CardHeader title="Instructions" subtitle="Read once — the clock starts when you press start." icon={<Info size={16} />} />
              <ol className="space-y-2 px-4 pb-4 text-[13px] leading-relaxed text-[var(--color-muted)]">
                {competition.instructions.map((line, index) => (
                  <li key={line} className="flex gap-2.5">
                    <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[var(--color-border)] text-[11px] text-[var(--color-primary)]">
                      {index + 1}
                    </span>
                    <span className="text-[var(--color-text)]/90">{line}</span>
                  </li>
                ))}
              </ol>
            </Card>

            <Card>
              <CardHeader title="Rules" subtitle="Breaking these can void your answer sheet." icon={<ShieldCheck size={16} />} />
              <ul className="space-y-2 px-4 pb-4 text-[13px] text-[var(--color-muted)]">
                {competition.rules.map((rule) => (
                  <li key={rule} className="flex gap-2.5">
                    <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
                    <span className="text-[var(--color-text)]/90">{rule}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader title="Schedule" icon={<CalendarClock size={16} />} />
              <dl className="space-y-2.5 px-4 pb-4 text-[13px]">
                <ScheduleRow label="Registration opens" value={formatDateTimeLong(competition.registrationOpensAt)} />
                <ScheduleRow label="Registration closes" value={formatDateTimeLong(competition.registrationClosesAt)} />
                <ScheduleRow label="Paper starts" value={formatDateTimeLong(competition.startsAt)} />
                <ScheduleRow label="Paper ends" value={formatDateTimeLong(competition.endsAt)} />
                {competition.resultsPublishedAt ? (
                  <ScheduleRow label="Results published" value={formatDateTimeLong(competition.resultsPublishedAt)} />
                ) : null}
                <ScheduleRow label="Server time now" value={clock.serverNow.toLocaleTimeString()} mono />
              </dl>
              <div className="px-4 pb-4">
                <CountdownPill iso={competition.registrationClosesAt} label="Registration closes" />
              </div>
            </Card>

            <Card>
              <CardHeader title="Standing" icon={<Users size={16} />} />
              <div className="space-y-2 px-4 pb-4 text-[13px]">
                <p className="text-[var(--color-muted)]">
                  {competition.participantCount} students have joined this competition.
                </p>
                {registered ? (
                  <p className="inline-flex items-center gap-1.5 text-[var(--color-success)]">
                    <CheckCircle2 size={14} /> You are registered
                  </p>
                ) : (
                  <p className="text-[var(--color-muted-dim)]">You have not registered yet.</p>
                )}
                {attempt ? (
                  <p className="text-[12.5px] text-[var(--color-muted)]">
                    Your attempt: <span className="text-[var(--color-text)]">{attempt.status.replace('_', ' ')}</span>
                    {attempt.submittedAt ? ` · submitted ${formatDateTimeLong(attempt.submittedAt)}` : ''}
                  </p>
                ) : null}
                {status?.expired ? (
                  <p className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--color-warning)]">
                    <AlertTriangle size={13} /> The writing window for this paper has closed.
                  </p>
                ) : null}
              </div>
            </Card>

            {data?.blueprint ? (
              <Card className="p-4 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                <p className="mb-1 font-semibold text-[var(--color-text)]">How marking works</p>
                Every question is worth {competition.marksPerQuestion} mark
                {competition.marksPerQuestion === 1 ? '' : 's'}, with {competition.negativeMarks} negative for a wrong
                answer. Unanswered questions cost nothing. Numerical answers are accepted within ±
                {data?.blueprint?.numericTolerance ?? 1}% of the expected value. Your score, the timer, submission and
                the percentile are all decided by the server, and the answer key stays hidden until results are
                published. Percentile is computed from everyone who submitted a valid paper here — a
                competition-relative score, not an exam-rank prediction.
                {competition.participantCount < 5
                  ? ' Very few students have joined so far, so a percentile may not be shown this time.'
                  : ''}
              </Card>
            ) : null}
          </div>
        </div>
      </PageBody>

      <Modal
        open={confirmStart}
        onClose={() => setConfirmStart(false)}
        title="Start this paper now?"
        description="The clock runs continuously on the server and cannot be paused. Closing the tab does not stop it —  your saved answers are restored when you come back."
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => setConfirmStart(false)}>
              Not yet
            </Button>
            <Button variant="primary" loading={busy === 'start'} icon={<Play size={15} />} onClick={() => void start()}>
              Start {competition.durationMin}-minute paper
            </Button>
          </div>
        }
      >
        <ul className="space-y-2 text-[13px] text-[var(--color-muted)]">
          <li>· {competition.questionCount} questions across {competition.subjects.join(', ')}</li>
          <li>· {competition.durationMin} minutes, auto-submitted when time runs out</li>
          <li>· +{competition.marksPerQuestion} for correct, −{competition.negativeMarks} for wrong</li>
          <li>· You can jump between questions and flag the ones to revisit</li>
        </ul>
      </Modal>
    </>
  );
}

function ScheduleRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className={`text-right text-[var(--color-text)] ${mono ? 'font-mono text-[12px]' : ''}`}>{value}</dd>
    </div>
  );
}

function formatClockShort(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export default ArenaCompetitionPage;
