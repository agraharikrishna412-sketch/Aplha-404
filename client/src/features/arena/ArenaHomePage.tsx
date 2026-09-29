/**
 * Arena home — "what can I do here?" in one glance:
 * live exams to join, open registrations, what is coming, and how my last attempts went.
 */
import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, ArrowRight, Radio, Swords, Target, Trophy } from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Segmented, StatTile } from '../../components/ui';
import { useToast } from '../../hooks/useToast';
import { percent, timeAgo } from '../../lib/format';
import { formatDateTimeLong, formatPercentile, useTicker } from '../../lib/arena';
import { useArenaAction, useArenaCatalog, useArenaHistory, useArenaOverview, useMyCompetitions } from './useArena';
import { useAuth } from '../../hooks/useAuth';
import { CompetitionCard, SectionTitle, StateBadge } from './components';
import { api } from '../../lib/api';
import { useState } from 'react';
import type { ArenaCompetitionSummary } from '../../types';

type Tab = 'all' | 'live' | 'open' | 'upcoming';

export function ArenaHomePage() {
  const navigate = useNavigate();
  const { data: overview, loading: loadingOverview, error: overviewError, refresh } = useArenaOverview();
  const { data: catalog, loading: loadingCatalog, error: catalogError, refresh: refreshCatalog } = useArenaCatalog();
  const { data: mine, refresh: refreshMine } = useMyCompetitions();
  const { data: history } = useArenaHistory();
  const { busy, run } = useArenaAction();
  const { push } = useToast();
  const { user } = useAuth();
  const isOrganiser = user?.role === 'admin';
  const [tab, setTab] = useState<Tab>('all');
  useTicker(1000);

  const competitions = catalog?.competitions ?? [];
  const filtered = useMemo(() => {
    if (tab === 'live') return competitions.filter((item) => item.state === 'LIVE');
    if (tab === 'open') return competitions.filter((item) => item.state === 'REGISTRATION_OPEN');
    if (tab === 'upcoming') return competitions.filter((item) => item.state === 'UPCOMING');
    return competitions;
  }, [competitions, tab]);

  const attempts = history?.history ?? [];
  const averaged = attempts.filter((attempt) => attempt.percentile !== null);
  const bestPercentile = averaged.length ? Math.max(...averaged.map((attempt) => attempt.percentile ?? 0)) : null;

  async function quickRegister(competition: ArenaCompetitionSummary) {
    const created = await run(`register-${competition.id}`, () =>
      api.post<{ message: string }>(`/arena/competitions/${competition.id}/register`, {}),
    ).catch((err: unknown) => {
      push({ tone: 'error', title: 'Could not register', detail: (err as Error).message });
      return null;
    });
    if (created) {
      push({ tone: 'success', title: 'You are registered', detail: competition.title });
      await Promise.all([refresh(), refreshCatalog(), refreshMine()]);
    }
  }

  async function quickStart(competition: ArenaCompetitionSummary) {
    const started = await run(`start-${competition.id}`, () =>
      api.post<{ attemptId: string }>(`/arena/competitions/${competition.id}/start`, {}),
    ).catch((err: unknown) => {
      push({ tone: 'error', title: 'Could not start', detail: (err as Error).message });
      return null;
    });
    if (started) {
      navigate(`/arena/${competition.id}/start`);
    }
  }

  function actionsFor(competition: ArenaCompetitionSummary) {
    const attempt = mine?.attempts?.[competition.id];
    const inProgress = attempt && attempt.status === 'in_progress';
    const registered = competition.registration?.status === 'registered';

    if (competition.state === 'LIVE' && inProgress) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/arena/${competition.id}/start`}
            className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-3 text-[13px] font-semibold text-[#04161b]"
          >
            Continue exam <ArrowRight size={13} />
          </Link>
          <span className="text-[11.5px] text-[var(--color-warning)]">Clock is running</span>
        </div>
      );
    }

    if (competition.state === 'LIVE' && registered && !attempt) {
      return (
        <Button
          size="sm"
          variant="primary"
          loading={busy === `start-${competition.id}`}
          onClick={() => void quickStart(competition)}
        >
          Start paper
        </Button>
      );
    }

    if (competition.state === 'REGISTRATION_OPEN' && !registered) {
      return (
        <Button
          size="sm"
          variant="primary"
          loading={busy === `register-${competition.id}`}
          onClick={() => void quickRegister(competition)}
        >
          Register free
        </Button>
      );
    }

    if ((competition.state === 'RESULTS_PUBLISHED' || competition.state === 'ARCHIVED') && attempt?.resultId) {
      return (
        <Link
          to={`/arena/results/${attempt.attemptId}`}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 text-[13px] font-medium hover:border-[var(--color-border-strong)]"
        >
          <Activity size={13} /> View analysis
        </Link>
      );
    }

    return undefined;
  }

  const loading = loadingOverview || loadingCatalog;
  const error = overviewError ?? catalogError;

  return (
    <>
      <PageHeader
        title="Arena"
        badge={<Badge tone="primary">Competitive exams</Badge>}
        description="Timed papers created and run inside Vroqn Nexus. Sit one under a real clock, then see your score, percentile and an analysis of what to fix next. Arena is a Vroqn-created competition — not an official JEE, NEET or board examination."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              to="/arena/my-competitions"
              className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] px-4 text-sm hover:border-[var(--color-border-strong)]"
            >
              <Trophy size={15} /> My competitions
            </Link>
            <Link
              to="/practice"
              className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] px-4 text-sm hover:border-[var(--color-border-strong)]"
            >
              <Target size={15} /> Weak-area practice
            </Link>
          </div>
        }
      />

      <PageBody className="space-y-6">
        {error ? (
          <ErrorState
            message={error}
            onRetry={() => {
              void refresh();
              void refreshCatalog();
            }}
          />
        ) : null}

        {loading && !overview && !catalog ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((key) => (
              <Card key={key} className="h-[92px] animate-pulse bg-[var(--color-card)]">
              <span className="sr-only">Loading</span>
            </Card>
            ))}
          </div>
        ) : null}

        {isOrganiser ? (
          <Card className="flex flex-wrap items-center justify-between gap-3 border-[color-mix(in_srgb,var(--color-primary)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-primary)_8%,var(--color-card))] p-4">
            <div className="min-w-[15rem] flex-1">
              <p className="flex items-center gap-2 text-[13px] font-semibold">
                <Swords size={15} /> You run competitions here
              </p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                Scheduling a competition takes three steps: name the paper, add questions, then open registration.
                Nothing is visible to students until you publish it.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                to="/arena/admin?create=1"
                className="inline-flex h-10 items-center gap-1.5 rounded-[10px] bg-[var(--color-primary)] px-4 text-[13px] font-semibold text-[#04161b]"
              >
                Create a competition <ArrowRight size={14} />
              </Link>
              <Link
                to="/arena/admin"
                className="inline-flex h-10 items-center rounded-[10px] border border-[var(--color-border)] px-4 text-[13px] font-semibold"
              >
                Manage papers
              </Link>
            </div>
          </Card>
        ) : (
          <Card className="p-4">
            <details className="group">
              <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 text-[13px] font-semibold">
                <Trophy size={15} /> How competitions are created
                <span className="text-[var(--color-muted)] transition-transform group-open:rotate-90" aria-hidden>
                  ›
                </span>
              </summary>
              <ol className="mt-3 grid gap-2 text-[12.5px] leading-relaxed text-[var(--color-muted)] sm:grid-cols-2">
                <li className="rounded-lg border border-[var(--color-border)] p-2.5">
                  <span className="font-semibold text-[var(--color-text)]">1 · An organiser writes the paper.</span> A teacher
                  or a Vroqn organiser builds the question set and picks a duration, marks and windows for
                  registration and the exam itself.
                </li>
                <li className="rounded-lg border border-[var(--color-border)] p-2.5">
                  <span className="font-semibold text-[var(--color-text)]">2 · You register while it is open.</span> The
                  competition shows up on this page at the same time — with a countdown and a Register button.
                </li>
                <li className="rounded-lg border border-[var(--color-border)] p-2.5">
                  <span className="font-semibold text-[var(--color-text)]">3 · It goes live.</span> At start time the
                  Register button becomes Start attempt. Your answers are saved as you go, so a refresh costs you
                  nothing.
                </li>
                <li className="rounded-lg border border-[var(--color-border)] p-2.5">
                  <span className="font-semibold text-[var(--color-text)]">4 · Results and a leaderboard.</span> Solutions
                  unlock once the paper closes, never before — and your own attempts stay in “My recent attempts”.
                </li>
              </ol>
            </details>
          </Card>
        )}

        {overview ? (
          <section aria-labelledby="arena-overview" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <h2 id="arena-overview" className="sr-only">
              Arena overview
            </h2>
            <StatTile label="Live now" value={overview.live} icon={<Radio size={15} />} tone={overview.live ? 'success' : 'muted'} sub={overview.live ? 'Exams you can enter' : 'Nothing running'} />
            <StatTile label="Open for registration" value={overview.open} icon={<Swords size={15} />} tone="primary" sub={overview.next ? `Next: ${shortTitle(overview.next.title)}` : '—'} />
            <StatTile label="Registered" value={overview.registered} icon={<Trophy size={15} />} sub="Competitions you joined" />
            <StatTile
              label="Competitions completed"
              value={overview.completed}
              icon={<Activity size={15} />}
              sub={bestPercentile !== null ? `Best percentile ${formatPercentile(bestPercentile)}` : 'No results yet'}
            />
          </section>
        ) : null}

        <section aria-labelledby="arena-catalog">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 id="arena-catalog" className="text-[15px] font-semibold tracking-tight">
              Competitions
            </h2>
            <div className="w-full sm:w-auto">
              <Segmented<Tab>
                value={tab}
                size="sm"
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'live', label: 'Live' },
                  { value: 'open', label: 'Open' },
                  { value: 'upcoming', label: 'Upcoming' },
                ]}
                onChange={setTab}
                label="Filter competitions"
              />
            </div>
          </div>

          {loadingCatalog && !catalog ? (
            <LoadingState message="Loading competitions…" className="py-10" />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Swords size={22} />}
              title={tab === 'all' ? 'No competitions yet' : `No ${tab} competitions`}
              description={
                tab === 'all'
                  ? 'Competitions are published by an Arena organiser — a teacher, or someone on the Vroqn team. Once one is scheduled it appears here automatically; the step-by-step is in the card above.'
                  : 'Try another filter — or start a practice set to stay sharp.'
              }
              action={
                <Link
                  to="/practice"
                  className="inline-flex h-10 items-center rounded-[10px] bg-[var(--color-primary)] px-4 text-sm font-semibold text-[#04161b]"
                >
                  Start practice
                </Link>
              }
            />
          ) : (
            <ul className="grid gap-3 lg:grid-cols-2">
              {filtered.map((competition) => (
                <CompetitionCard key={competition.id} competition={competition} actions={actionsFor(competition)} />
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="arena-recent">
          <SectionTitle note={attempts.length ? 'Most recent first' : undefined}>My recent attempts</SectionTitle>
          {attempts.length === 0 ? (
            <Card className="p-4 text-[13px] text-[var(--color-muted)]">
              You have not attempted a competition yet. A first paper gives you a benchmark to improve from.
            </Card>
          ) : (
            <ul className="grid gap-2.5 lg:grid-cols-2">
              {attempts.slice(0, 4).map((attempt) => (
                <Card as="li" key={attempt.attemptId} className="flex items-center justify-between gap-3 p-3.5" interactive>
                  <div className="min-w-0">
                    <Link
                      to={
                        attempt.resultsPublished
                          ? `/arena/results/${attempt.attemptId}`
                          : `/arena/${attempt.competitionId}`
                      }
                      className="vroqn-tap block truncate text-[14px] font-medium hover:text-[var(--color-primary)]"
                    >
                      {attempt.title}
                    </Link>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-[var(--color-muted)]">
                      <span>{timeAgo(attempt.submittedAt)}</span>
                      <span className="text-[var(--color-border-strong)]">|</span>
                      <span>Accuracy {percent(attempt.accuracy)}</span>
                      {attempt.percentile !== null ? (
                        <>
                          <span className="text-[var(--color-border-strong)]">|</span>
                          <span>Percentile {formatPercentile(attempt.percentile)}</span>
                        </>
                      ) : null}
                      {attempt.accuracyDelta !== null ? (
                        <>
                          <span className="text-[var(--color-border-strong)]">|</span>
                          <span className={attempt.accuracyDelta >= 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}>
                            {attempt.accuracyDelta >= 0 ? '+' : ''}
                            {attempt.accuracyDelta.toFixed(1)} pts vs previous
                          </span>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-[15px] font-semibold">
                      {attempt.score}
                      <span className="text-[12px] text-[var(--color-muted)]">/{attempt.maxScore}</span>
                    </p>
                    {attempt.rank !== null && attempt.participantCount ? (
                      <p className="text-[11px] text-[var(--color-muted)]">
                        rank {attempt.rank}/{attempt.participantCount}
                      </p>
                    ) : attempt.resultsPublished ? (
                      <p className="text-[11px] text-[var(--color-muted)]">unranked</p>
                    ) : (
                      <p className="text-[11px] text-[var(--color-warning)]">awaiting results</p>
                    )}
                  </div>
                </Card>
              ))}
            </ul>
          )}
        </section>

        {mine?.live?.length ? (
          <section aria-labelledby="arena-mine-live">
            <SectionTitle note="Clock is running on the server">Happening now</SectionTitle>
            <ul className="grid gap-2.5 lg:grid-cols-2">
              {mine.live.map((competition) => (
                <Card as="li" key={competition.id} className="flex flex-wrap items-center justify-between gap-3 p-3.5">
                  <div>
                    <p className="text-[14px] font-medium">{competition.title}</p>
                    <p className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">
                      Ends {formatDateTimeLong(competition.endsAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StateBadge state={competition.state} />
                    <Link
                      to={`/arena/${competition.id}`}
                      className="inline-flex h-10 items-center rounded-lg bg-[var(--color-primary)] px-3 text-[13px] font-semibold text-[#04161b]"
                    >
                      Open
                    </Link>
                  </div>
                </Card>
              ))}
            </ul>
          </section>
        ) : null}
      </PageBody>
    </>
  );
}

function shortTitle(title: string): string {
  const cleaned = title.replace(/—\s*Demo.*/i, '').trim();
  return cleaned.length > 34 ? `${cleaned.slice(0, 32)}…` : cleaned;
}

export default ArenaHomePage;
