/**
 * My competitions — registered/scheduled exams on one side, attempt history and trend on the other.
 * Progress here is competition-relative (score, accuracy, percentile) and clearly labelled as such.
 */
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  BarChart3,
  CalendarClock,
  PartyPopper,
  Radio,
  Swords,
  Trophy,
} from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import { Badge, Card, EmptyState, ErrorState, LoadingState, ProgressBar, StatTile } from '../../components/ui';
import { percent, scoreTone, timeAgo } from '../../lib/format';
import { formatDateTimeLong, formatPercentile } from '../../lib/arena';
import { useArenaHistory, useMyCompetitions } from './useArena';
import { CompetitionCard, SectionTitle, StateBadge } from './components';

export function ArenaMyPage() {
  const { data: mine, loading: loadingMine, error: mineError, refresh: refreshMine } = useMyCompetitions();
  const { data: history, loading: loadingHistory, error: historyError, refresh: refreshHistory } = useArenaHistory();

  const attempts = history?.history ?? [];
  const withPercentile = attempts.filter((attempt) => attempt.percentile !== null);
  const bestPercentile = withPercentile.length ? Math.max(...withPercentile.map((a) => a.percentile ?? 0)) : null;
  const trend = attempts.slice(0, 8).reverse();
  const loading = loadingMine || loadingHistory;
  const error = mineError ?? historyError;

  return (
    <>
      <PageHeader
        title="My competitions"
        badge={<Badge tone="primary">Arena</Badge>}
        description="Everything you have registered for, everything running now, and how each attempt compares with the field."
        actions={
          <Link
            to="/arena"
            className="inline-flex h-10 items-center gap-1.5 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] px-3.5 text-sm hover:border-[var(--color-border-strong)]"
          >
            <ArrowLeft size={15} /> Browse competitions
          </Link>
        }
      />

      <PageBody className="space-y-6">
        {error ? (
          <ErrorState
            message={error}
            onRetry={() => {
              void refreshMine();
              void refreshHistory();
            }}
          />
        ) : null}

        {loading && !mine && !history ? (
          <LoadingState message="Loading your Arena activity…" />
        ) : null}

        <section className="grid gap-3 sm:grid-cols-3">
          <StatTile label="Attempts submitted" value={attempts.length} icon={<Trophy size={15} />} />
          <StatTile
            label="Live now"
            value={mine?.live.length ?? 0}
            icon={<Radio size={15} />}
            tone={mine?.live.length ? 'success' : 'muted'}
            sub="Papers you can still write"
          />
          <StatTile
            label="Best percentile"
            value={bestPercentile !== null ? formatPercentile(bestPercentile) : '—'}
            icon={<BarChart3 size={15} />}
            sub={withPercentile.length ? `Across ${withPercentile.length} published result(s)` : 'No published results yet'}
          />
        </section>

        <section aria-labelledby="arena-mine-live">
          <SectionTitle note={mine?.live.length ? 'The clock is running' : undefined}>Live now</SectionTitle>
          {mine?.live.length ? (
            <ul className="grid gap-3 lg:grid-cols-2">
              {mine.live.map((competition) => {
                const attempt = mine.attempts[competition.id];
                const inProgress = attempt?.status === 'in_progress';
                return (
                  <CompetitionCard
                    key={competition.id}
                    competition={competition}
                    actions={
                      <div className="flex flex-wrap items-center gap-2">
                        {inProgress ? (
                          <Link
                            to={`/arena/${competition.id}/start`}
                            className="inline-flex h-10 items-center rounded-lg bg-[var(--color-primary)] px-3 text-[13px] font-semibold text-[#04161b]"
                          >
                            Continue paper
                          </Link>
                        ) : attempt?.status === 'submitted' ? (
                          <Link
                            to={`/arena/results/${attempt.attemptId}`}
                            className="inline-flex h-10 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 text-[13px]"
                          >
                            View result
                          </Link>
                        ) : (
                          <Link
                            to={`/arena/${competition.id}`}
                            className="inline-flex h-10 items-center rounded-lg bg-[var(--color-primary)] px-3 text-[13px] font-semibold text-[#04161b]"
                          >
                            Open competition
                          </Link>
                        )}
                      </div>
                    }
                  />
                );
              })}
            </ul>
          ) : (
            <Card className="p-4 text-[13px] text-[var(--color-muted)]">
              No competition is live for you right now.
            </Card>
          )}
        </section>

        <section aria-labelledby="arena-mine-upcoming">
          <SectionTitle>Registered / upcoming</SectionTitle>
          {mine?.upcoming.length ? (
            <ul className="grid gap-3 lg:grid-cols-2">
              {mine.upcoming.map((competition) => (
                <CompetitionCard
                  key={competition.id}
                  competition={competition}
                  footer={
                    <p className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
                      <CalendarClock size={12} /> Starts {formatDateTimeLong(competition.startsAt)}
                    </p>
                  }
                />
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<Swords size={20} />}
              title="Nothing scheduled"
              description="Register for an open competition and it will show up here with its start time."
              action={
                <Link
                  to="/arena"
                  className="inline-flex h-10 items-center rounded-[10px] bg-[var(--color-primary)] px-4 text-sm font-semibold text-[#04161b]"
                >
                  Browse competitions
                </Link>
              }
            />
          )}
        </section>

        {mine?.completed.length ? (
          <section aria-labelledby="arena-mine-completed">
            <SectionTitle>Completed</SectionTitle>
            <ul className="grid gap-2.5 lg:grid-cols-2">
              {mine.completed.map((competition) => (
                <Card as="li" key={competition.id} className="flex flex-wrap items-center justify-between gap-3 p-3.5">
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-medium">{competition.title}</p>
                    <p className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">
                      {competition.subjects.join(' · ')} · {competition.questionCount} questions
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StateBadge state={competition.state} />
                    {mine.attempts[competition.id]?.resultId ? (
                      <Link
                        to={`/arena/results/${mine.attempts[competition.id]?.attemptId}`}
                        className="inline-flex h-10 items-center rounded-lg border border-[var(--color-border)] px-3 text-[12.5px] hover:border-[var(--color-border-strong)]"
                      >
                        Analysis
                      </Link>
                    ) : (
                      <span className="text-[11.5px] text-[var(--color-warning)]">results pending</span>
                    )}
                  </div>
                </Card>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="arena-history">
          <SectionTitle note={trend.length > 1 ? 'Accuracy across your last attempts' : undefined}>
            Attempt history
          </SectionTitle>
          {attempts.length === 0 ? (
            <EmptyState
              icon={<Activity size={20} />}
              title="No attempts yet"
              description="Your score, accuracy and percentile for each competition will be listed here."
            />
          ) : (
            <div className="space-y-3">
              {trend.length > 1 ? (
                <Card className="p-4">
                  <div className="flex items-end justify-between gap-2">
                    <p className="text-[12.5px] text-[var(--color-muted)]">Accuracy trend</p>
                    <p className="text-[12px] text-[var(--color-muted)]">
                      {trend[0].accuracyDelta !== null && trend[trend.length - 1].accuracyDelta !== null
                        ? latestMovement(trend)
                        : ''}
                    </p>
                  </div>
                  <div className="mt-3 flex items-end gap-1.5" role="img" aria-label="Accuracy per attempt">
                    {trend.map((attempt) => (
                      <div key={attempt.attemptId} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                        {/* History accuracy arrives as a ratio (0–1); the chart shows it as a percentage. */}
                        <span className="text-[11.5px] text-[var(--color-muted)]">
                          {Math.round(attempt.accuracy * 100)}%
                        </span>
                        <div className="flex h-24 w-full items-end rounded-md bg-[var(--color-surface)]">
                          <div
                            className={`w-full rounded-md ${
                              attempt.accuracy >= 0.75
                                ? 'bg-[var(--color-success)]/70'
                                : attempt.accuracy >= 0.45
                                  ? 'bg-[var(--color-warning)]/70'
                                  : 'bg-[var(--color-error)]/70'
                            }`}
                            style={{ height: `${Math.max(6, Math.min(100, attempt.accuracy * 100))}%` }}
                          />
                        </div>
                        <span className="w-full truncate text-center text-[11px] text-[var(--color-muted-dim)]">
                          {attempt.title.split(' ').slice(0, 2).join(' ')}
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>
              ) : null}

              <ul className="space-y-2.5">
                {attempts.map((attempt) => {
                  const scorePercent = (attempt.score / Math.max(1, attempt.maxScore)) * 100;
                  return (
                    <Card as="li" key={attempt.attemptId} className="p-4" interactive>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone="neutral">{attempt.category}</Badge>
                            {attempt.isDemo ? <Badge tone="muted">Demo</Badge> : null}
                            {!attempt.resultsPublished ? <Badge tone="warning">Results pending</Badge> : null}
                          </div>
                          <p className="mt-1.5 text-[14.5px] font-medium">{attempt.title}</p>
                          <p className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">
                            {timeAgo(attempt.submittedAt)}
                            {attempt.rank !== null && attempt.participantCount
                              ? ` · rank ${attempt.rank}/${attempt.participantCount}`
                              : ''}
                            {attempt.percentile !== null ? ` · percentile ${formatPercentile(attempt.percentile)}` : ''}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-[18px] font-semibold">
                            {attempt.score}
                            <span className="text-[12.5px] text-[var(--color-muted)]">/{attempt.maxScore}</span>
                          </p>
                          <p className="text-[11.5px] text-[var(--color-muted)]">Accuracy {percent(attempt.accuracy)}</p>
                        </div>
                      </div>

                      <div className="mt-3">
                        <ProgressBar value={scorePercent / 100} tone={scoreTone(scorePercent / 100)} label="Score" />
                      </div>

                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <p className="flex flex-wrap items-center gap-2 text-[11.5px]">
                          {attempt.accuracyDelta !== null ? (
                            <span
                              className={
                                attempt.accuracyDelta >= 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'
                              }
                            >
                              {attempt.accuracyDelta >= 0 ? '▲' : '▼'} {Math.abs(attempt.accuracyDelta).toFixed(1)} pts
                              accuracy vs previous attempt
                            </span>
                          ) : (
                            <span className="text-[var(--color-muted-dim)]">First attempt in this series</span>
                          )}
                        </p>
                        {attempt.resultsPublished ? (
                          <Link
                            to={`/arena/results/${attempt.attemptId}`}
                            className="inline-flex h-10 items-center rounded-lg bg-[var(--color-primary)] px-3 text-[12.5px] font-semibold text-[#04161b]"
                          >
                            Open analysis
                          </Link>
                        ) : (
                          <span className="text-[11.5px] text-[var(--color-muted)]">
                            Analysis unlocks when results publish
                          </span>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </ul>
            </div>
          )}
        </section>

        {attempts.length && attempts.every((attempt) => attempt.percentile === null) ? (
          <Card className="flex flex-wrap items-center gap-3 p-4 text-[13px] text-[var(--color-muted)]">
            <PartyPopper size={16} className="text-[var(--color-primary)]" />
            <span>
              You have attempts but no published benchmarks yet. Benchmarking appears once a competition publishes
              results with at least five valid submissions.
            </span>
          </Card>
        ) : null}
      </PageBody>
    </>
  );
}

function latestMovement(trend: { accuracy: number; accuracyDelta: number | null }[]): string {
  const latest = trend[trend.length - 1];
  const previous = trend[trend.length - 2];
  if (!previous) return '';
  const delta = latest.accuracy - previous.accuracy;
  if (Math.abs(delta) < 0.5) return 'steady';
  return delta > 0 ? `up ${delta.toFixed(1)} pts in the latest attempt` : `down ${Math.abs(delta).toFixed(1)} pts in the latest attempt`;
}

export default ArenaMyPage;
