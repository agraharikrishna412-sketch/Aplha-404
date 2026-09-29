/**
 * Learning Analytics — the dashboard's deep view of a student's own studying.
 *
 * The design principle that governs every panel here: **the screen may only say what the data says.**
 *
 *  - No score is invented, smoothed or extrapolated. Each figure is rendered from `GET
 *    /api/activity/analytics`, which counts the student's own recorded events.
 *  - A rate built on a handful of attempts is shown as *provisional* rather than as a proud green
 *    number. Seeing "100%" after one correct answer is worse than seeing nothing, and it trains a
 *    student to trust a figure that means nothing.
 *  - Gaps are shown as gaps. A quiet day is a zero in the chart, not a missing column that flatters
 *    the average.
 *  - Empty state is honest: a new student is told exactly which action creates the first data point
 *    instead of being shown a dashboard of zeros pretending to be a report.
 *
 * Nothing here is compared with other students — there is no leaderboard, no percentile and no
 * "students like you". Personal study data is the student's own (§27), and the server never sends
 * anyone else's numbers to this page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  Clock,
  Flame,
  LineChart,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, ProgressBar, Skeleton, StatTile } from '../../components/ui';
import { api, ApiError } from '../../lib/api';

/* ---------------------------------- types ---------------------------------- */

interface TrendPoint {
  date: string;
  minutes: number;
  questions: number;
  correct: number;
}

interface SubjectRow {
  subject: string;
  questions: number;
  correct: number;
  accuracy: number;
  minutes: number;
  provisional: boolean;
}

interface TopicRow {
  subject: string;
  topic: string;
  attempts: number;
  correct: number;
  accuracy: number;
  lastSeenAt: string;
  provisional: boolean;
}

interface Analytics {
  days: number;
  generatedAt: string;
  notes: string[];
  totals: {
    minutes: number;
    questions: number;
    correct: number;
    accuracy: number;
    activeDays: number;
    quietDays: number;
    streakDays: number;
    sessions: number;
  };
  trend: TrendPoint[];
  subjects: SubjectRow[];
  byKind: { kind: string; label: string; events: number; minutes: number }[];
  topics: { weak: TopicRow[]; strong: TopicRow[]; all: TopicRow[] };
  exams: { id: string; title: string; subject: string | null; score: number; total: number; accuracy: number; createdAt: string }[];
  consistency: { weekdayMinutes: { weekday: string; averageMinutes: number }[]; bestDay: { date: string; minutes: number } | null };
}

const WINDOWS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Counts are grouped the Indian way (1,20,000) — the audience this screen is built for. */
function count(value: number): string {
  return value.toLocaleString('en-IN');
}

function dayLabelShort(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

/* --------------------------------- page ---- */

export function LearningAnalyticsPage() {
  const navigate = useNavigate();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<Analytics>(`/activity/analytics?days=${days}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your learning analytics.');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  /* --------------------------------- charts -------------------------------- */

  /*
   * The minutes chart is drawn as plain SVG rather than pulling in a chart library. Two reasons: a
   * charting package is roughly the size of the entire rest of this chunk, and a hand-drawn polyline
   * gives exact control over the parts that matter for a study chart — a visible zero line, one label
   * per week rather than fifty unreadable ones, and an accessible summary underneath.
   */
  const chart = useMemo(() => {
    const trend = data?.trend ?? [];
    if (trend.length < 2) return null;

    const width = 640;
    const height = 170;
    const padX = 6;
    const padTop = 12;
    const padBottom = 26;
    const peak = Math.max(1, ...trend.map((point) => point.minutes));
    // Round the axis top up to a friendly number so the gridlines are readable values.
    const top = peak <= 15 ? 15 : peak <= 30 ? 30 : peak <= 60 ? 60 : Math.ceil(peak / 30) * 30;

    const x = (index: number) => padX + (index / (trend.length - 1)) * (width - padX * 2);
    const y = (minutes: number) => padTop + (1 - minutes / top) * (height - padTop - padBottom);

    const points = trend.map((point, index) => `${x(index).toFixed(1)},${y(point.minutes).toFixed(1)}`).join(' ');
    const area = `${padX},${y(0).toFixed(1)} ${points} ${(width - padX).toFixed(1)},${y(0).toFixed(1)}`;

    // One tick per week (or a handful for short windows) keeps the axis legible on a phone.
    const step = Math.max(1, Math.ceil(trend.length / 6));
    const labels = trend
      .map((point, index) => ({ index, date: point.date }))
      .filter((entry) => entry.index % step === 0 || entry.index === trend.length - 1);

    const totalMinutes = trend.reduce((sum, point) => sum + point.minutes, 0);
    return { width, height, padX, padTop, padBottom, top, y, x, points, area, labels, trend, totalMinutes };
  }, [data]);

  const hasData = (data?.totals.sessions ?? 0) > 0;

  return (
    <>
      <PageHeader
        title="Learning analytics"
        description="Your own study record — where your time went, what you get right, and what needs another pass."
        badge={
          data?.totals.streakDays ? (
            <Badge tone="warning" icon={<Flame size={12} />} title="Consecutive days with recorded study activity">
              {data.totals.streakDays}-day streak
            </Badge>
          ) : undefined
        }
        actions={
          <>
            <div className="flex items-center gap-1 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5" role="group" aria-label="Time window">
              {WINDOWS.map((option) => (
                <button
                  key={option.days}
                  type="button"
                  onClick={() => setDays(option.days)}
                  aria-pressed={days === option.days}
                  className={[
                    'vroqn-tap rounded-[8px] px-2.5 py-1 text-[12px] transition-colors',
                    days === option.days
                      ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary)]'
                      : 'text-[var(--color-muted)] hover:text-[var(--color-text)]',
                  ].join(' ')}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <Button variant="secondary" icon={<Activity size={15} />} onClick={() => navigate('/activity')}>
              Activity log
            </Button>
            <Button variant="primary" icon={<Target size={15} />} onClick={() => navigate('/practice')}>
              Practise
            </Button>
          </>
        }
      />

      <PageBody className="space-y-5">
        {error ? <ErrorState message={error} onRetry={load} /> : null}

        {loading && !data ? (
          <div className="space-y-4" role="status" aria-live="polite">
            <span className="sr-only">Loading your learning analytics…</span>
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-[86px]" rounded="lg" />
              ))}
            </div>
            <Skeleton className="h-[230px]" rounded="lg" />
            <Skeleton className="h-[200px]" rounded="lg" />
          </div>
        ) : !hasData ? (
          <EmptyState
            icon={<LineChart size={20} />}
            title="No analytics yet — because there is nothing to measure"
            description="This page is built only from your own recorded attempts. Answer a practice set, finish a mock exam or ask the tutor a question, and the charts below fill in from that moment."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" icon={<Target size={15} />} onClick={() => navigate('/practice')}>
                  Start a practice set
                </Button>
                <Button variant="secondary" icon={<Sparkles size={15} />} onClick={() => navigate('/tutor')}>
                  Ask a doubt
                </Button>
              </div>
            }
          />
        ) : (
          <>
            {/* ------------------------------- headline ------------------------------ */}
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              <StatTile
                label="Accuracy"
                value={data?.totals.questions ? percent(data.totals.accuracy) : '—'}
                sub={
                  (data?.totals.questions ?? 0) < 3
                    ? `${count(data?.totals.correct ?? 0)} of ${count(data?.totals.questions ?? 0)} correct — too few attempts to read as a score`
                    : `${count(data?.totals.correct ?? 0)} of ${count(data?.totals.questions ?? 0)} correct`
                }
                icon={<CheckCircle2 size={14} />}
              />
              <StatTile
                label="Questions"
                value={count(data?.totals.questions ?? 0)}
                sub={`across ${count(data?.totals.sessions ?? 0)} recorded session${(data?.totals.sessions ?? 0) === 1 ? '' : 's'}`}
                icon={<Target size={14} />}
              />
              <StatTile
                label="Study time"
                value={`${count(data?.totals.minutes ?? 0)}m`}
                sub={`${data?.totals.activeDays ?? 0} active day${(data?.totals.activeDays ?? 0) === 1 ? '' : 's'} of ${data?.days ?? days}`}
                icon={<Clock size={14} />}
              />
              <StatTile
                label="Study days"
                value={`${data?.totals.activeDays ?? 0}/${data?.days ?? days}`}
                sub={`${data?.totals.quietDays ?? 0} quiet day${(data?.totals.quietDays ?? 0) === 1 ? '' : 's'} in this window`}
                icon={<CalendarDays size={14} />}
              />
            </div>

            {/* -------------------------------- trend -------------------------------- */}
            <Card>
              <CardHeader
                title="Minutes studied per day"
                subtitle={`Every day in the last ${data?.days ?? days} days, including the quiet ones`}
                icon={<TrendingUp size={15} />}
                right={
                  data?.consistency.bestDay?.minutes ? (
                    <Badge tone="muted" icon={<Sparkles size={12} />}>
                      Best: {data.consistency.bestDay.minutes}m on {dayLabelShort(data.consistency.bestDay.date)}
                    </Badge>
                  ) : undefined
                }
              />
              <div className="px-3.5 pb-3.5">
                {chart ? (
                  <>
                    <svg
                      viewBox={`0 0 ${chart.width} ${chart.height}`}
                      className="h-[170px] w-full"
                      role="img"
                      aria-label={`Minutes studied per day over ${chart.trend.length} days. Total ${chart.totalMinutes} minutes.`}
                    >
                      {/* Horizontal gridlines at 0, half and the rounded axis top. */}
                      {[0, 0.5, 1].map((fraction) => {
                        const value = chart.top * fraction;
                        const y = chart.y(value);
                        return (
                          <g key={fraction}>
                            <line
                              x1={chart.padX}
                              x2={chart.width - chart.padX}
                              y1={y}
                              y2={y}
                              stroke="var(--color-border)"
                              strokeWidth="1"
                              strokeDasharray={fraction === 0 ? undefined : '3 5'}
                            />
                            <text x={chart.padX} y={y - 3} fill="var(--color-muted-dim)" fontSize="9">
                              {value}m
                            </text>
                          </g>
                        );
                      })}
                      <polygon points={chart.area} fill="var(--color-primary)" opacity="0.12" />
                      <polyline points={chart.points} fill="none" stroke="var(--color-primary)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
                      {/* Only the last point gets a dot: it is "today", the number a student checks. */}
                      {chart.trend.length ? (
                        <circle
                          cx={chart.x(chart.trend.length - 1)}
                          cy={chart.y(chart.trend[chart.trend.length - 1].minutes)}
                          r="3"
                          fill="var(--color-primary)"
                        />
                      ) : null}
                      {chart.labels.map((entry) => (
                        <text
                          key={entry.date}
                          x={chart.x(entry.index)}
                          y={chart.height - 8}
                          fill="var(--color-muted-dim)"
                          fontSize="9"
                          textAnchor={entry.index === 0 ? 'start' : entry.index === chart.trend.length - 1 ? 'end' : 'middle'}
                        >
                          {dayLabelShort(entry.date)}
                        </text>
                      ))}
                    </svg>
                    <p className="mt-1 text-[11.5px] text-[var(--color-muted)]">
                      {chart.totalMinutes} minutes recorded in this window. Days with no activity count as zero — the chart is not smoothed.
                    </p>
                  </>
                ) : (
                  <p className="py-6 text-center text-[12.5px] text-[var(--color-muted)]">
                    A trend line needs at least two recorded sessions in this window.
                  </p>
                )}
              </div>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              {/* ------------------------------ subjects ------------------------------ */}
              <Card>
                <CardHeader
                  title="By subject"
                  subtitle="Accuracy and time, from your own answers"
                  icon={<BarChart3 size={15} />}
                />
                <div className="space-y-3 px-3.5 pb-3.5">
                  {data?.subjects.length ? (
                    data.subjects.map((row) => (
                      <div key={row.subject}>
                        <div className="mb-1 flex items-baseline justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-[13px] text-[var(--color-text)]">
                            {row.subject}
                            {row.provisional ? (
                              <span
                                className="rounded-full border border-[var(--color-border)] px-1.5 py-px text-[11px] text-[var(--color-muted-dim)]"
                                title="Fewer than 3 attempts — this rate is provisional"
                              >
                                provisional
                              </span>
                            ) : null}
                          </span>
                          <span className="vroqn-tabular shrink-0 text-[12px] text-[var(--color-muted)]">
                            {row.questions ? percent(row.accuracy) : '—'}
                            <span className="text-[var(--color-muted-dim)]"> · {row.questions}q · {row.minutes}m</span>
                          </span>
                        </div>
                        <ProgressBar
                          value={row.questions ? row.accuracy : 0}
                          tone={row.provisional ? 'muted' : row.accuracy >= 0.8 ? 'success' : row.accuracy >= 0.6 ? 'warning' : 'error'}
                          label={`${row.subject} accuracy`}
                        />
                      </div>
                    ))
                  ) : (
                    <p className="text-[12.5px] text-[var(--color-muted)]">
                      No subject data in this window — practice or an exam writes the first row.
                    </p>
                  )}
                </div>
              </Card>

              {/* ------------------------------- rhythm ------------------------------- */}
              <Card>
                <CardHeader
                  title="When you study"
                  subtitle="Average minutes per weekday across the window"
                  icon={<CalendarDays size={15} />}
                />
                <div className="px-3.5 pb-3.5">
                  {data ? (
                    <ul className="space-y-1.5">
                      {data.consistency.weekdayMinutes.map((entry) => {
                        const peak = Math.max(1, ...data.consistency.weekdayMinutes.map((row) => row.averageMinutes));
                        return (
                          <li key={entry.weekday} className="flex items-center gap-2">
                            <span className="w-[62px] shrink-0 text-[11.5px] text-[var(--color-muted)]">{entry.weekday.slice(0, 3)}</span>
                            <span className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-surface)]">
                              <span
                                className="block h-full rounded-full bg-[var(--color-primary)]/60"
                                style={{ width: `${Math.max(entry.averageMinutes > 0 ? 3 : 0, (entry.averageMinutes / peak) * 100)}%` }}
                              />
                            </span>
                            <span className="vroqn-tabular w-[54px] shrink-0 text-right text-[11.5px] text-[var(--color-muted)]">
                              {entry.averageMinutes}m
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  <p className="mt-2.5 text-[11.5px] text-[var(--color-muted)]">
                    A bar with nothing in it is a day you studied 0 minutes on average — it is left visible on purpose.
                  </p>
                </div>
              </Card>
            </div>

            {/* -------------------------------- topics -------------------------------- */}
            <Card>
              <CardHeader
                title="Topics"
                subtitle="Weak = under 70% after 2+ attempts. Strong = 80%+ after 3+ attempts."
                icon={<Target size={15} />}
              />
              <div className="grid gap-4 px-3.5 pb-3.5 md:grid-cols-2">
                <div>
                  <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
                    <AlertTriangle size={13} className="text-[var(--color-warning)]" /> Needs another pass
                  </p>
                  {data?.topics.weak.length ? (
                    <ul className="space-y-1.5">
                      {data.topics.weak.map((row) => (
                        <li
                          key={`${row.subject}-${row.topic}`}
                          className="flex items-center justify-between gap-2 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-[13px]">{row.topic}</span>
                            <span className="block text-[11px] text-[var(--color-muted-dim)]">{row.subject}</span>
                          </span>
                          <span className="shrink-0 text-right">
                            <span className="vroqn-tabular block text-[13px] text-[var(--color-text)]">{percent(row.accuracy)}</span>
                            <span className="block text-[11px] text-[var(--color-muted-dim)]">{row.correct}/{row.attempts}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[12.5px] text-[var(--color-muted)]">
                      Nothing flagged yet. Topics appear here once a subject has at least two attempts.
                    </p>
                  )}
                </div>
                <div>
                  <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
                    <CheckCircle2 size={13} /> On solid ground
                  </p>
                  {data?.topics.strong.length ? (
                    <ul className="space-y-1.5">
                      {data.topics.strong.map((row) => (
                        <li
                          key={`${row.subject}-${row.topic}`}
                          className="flex items-center justify-between gap-2 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-[13px]">{row.topic}</span>
                            <span className="block text-[11px] text-[var(--color-muted-dim)]">{row.subject}</span>
                          </span>
                          <span className="shrink-0 text-right">
                            <span className="vroqn-tabular block text-[13px] text-[var(--color-text)]">{percent(row.accuracy)}</span>
                            <span className="block text-[11px] text-[var(--color-muted-dim)]">{row.correct}/{row.attempts}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[12.5px] text-[var(--color-muted)]">
                      No topic has 3 clean attempts at 80% yet. That is a statement about the data, not about you.
                    </p>
                  )}
                </div>
              </div>
              {data?.topics.all.length ? (
                <div className="border-t border-[var(--color-border)] px-3.5 py-3">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
                    Every topic you have touched
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {data.topics.all.map((row) => (
                      <span
                        key={`${row.subject}-${row.topic}`}
                        title={`${row.correct}/${row.attempts} correct${row.provisional ? ' — provisional' : ''}`}
                        className={[
                          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px]',
                          row.provisional
                            ? 'border-[var(--color-border)] text-[var(--color-muted)]'
                            : row.accuracy >= 0.8
                              ? 'border-[var(--color-success)]/40 text-[var(--color-success)]'
                              : row.accuracy >= 0.7
                                ? 'border-[var(--color-border)] text-[var(--color-text)]'
                                : 'border-[var(--color-danger)]/40 text-[var(--color-danger)]',
                        ].join(' ')}
                      >
                        {row.topic}
                        <span className="vroqn-tabular text-[11px] opacity-70">{percent(row.accuracy)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              {/* ------------------------------ activity mix ----------------------------- */}
              <Card>
                <CardHeader title="Where your time went" subtitle="Recorded sessions by activity" icon={<Activity size={15} />} />
                <div className="px-3.5 pb-3.5">
                  {data?.byKind.length ? (
                    <ul className="space-y-2">
                      {data.byKind.map((row) => (
                        <li key={row.kind} className="flex items-center justify-between gap-3 text-[12.5px]">
                          <span className="text-[var(--color-text)]">{row.label}</span>
                          <span className="text-[var(--color-muted)]">
                            {row.events} session{row.events === 1 ? '' : 's'}
                            {row.minutes ? ` · ${row.minutes}m` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[12.5px] text-[var(--color-muted)]">No sessions recorded in this window.</p>
                  )}
                </div>
              </Card>

              {/* --------------------------------- exams -------------------------------- */}
              <Card>
                <CardHeader title="Mock exams" subtitle="Your last completed papers" icon={<CheckCircle2 size={15} />} />
                <div className="px-3.5 pb-3.5">
                  {data?.exams.length ? (
                    <ul className="space-y-1.5">
                      {data.exams.slice(0, 6).map((exam) => (
                        <li key={`${exam.id}-${exam.createdAt}`}>
                          <button
                            type="button"
                            onClick={() => navigate(`/mock-exam/results/${exam.id}`)}
                            className="vroqn-tap flex w-full items-center justify-between gap-3 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-left transition-colors hover:border-[var(--color-primary)]/45"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-[13px]">{exam.title}</span>
                              <span className="block text-[11px] text-[var(--color-muted-dim)]">
                                {exam.subject ?? 'Mixed'} · {new Date(exam.createdAt).toLocaleDateString()}
                              </span>
                            </span>
                            <span className="shrink-0 text-right">
                              <span className="vroqn-tabular block text-[13px]">
                                {exam.score}/{exam.total}
                              </span>
                              <span className="block text-[11px] text-[var(--color-muted-dim)]">{percent(exam.accuracy)}</span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[12.5px] text-[var(--color-muted)]">
                      No completed mock exam yet.{' '}
                      <button type="button" onClick={() => navigate('/mock-exam')} className="text-[var(--color-primary)] underline-offset-2 hover:underline">
                        Build one
                      </button>
                      .
                    </p>
                  )}
                </div>
              </Card>
            </div>

            {/* ------------------------------ methodology ----------------------------- */}
            <Card className="border-dashed">
              <CardHeader title="How these numbers are produced" subtitle="No estimation, no comparison, no sharing" icon={<BarChart3 size={15} />} />
              <ul className="space-y-1.5 px-3.5 pb-3.5 text-[12px] leading-relaxed text-[var(--color-muted)]">
                {data?.notes.map((note) => (
                  <li key={note} className="flex gap-2">
                    <span aria-hidden="true" className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-[var(--color-primary)]/70" />
                    {note}
                  </li>
                ))}
                <li className="flex gap-2">
                  <span aria-hidden="true" className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-[var(--color-primary)]/70" />
                  This page shows only your data. It is never shown to another student, a group, or a competition.
                </li>
              </ul>
              <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] px-3.5 py-3">
                <Button size="sm" variant="secondary" icon={<ArrowRight size={13} />} onClick={() => navigate('/mock-exam')}>
                  Take a mock exam
                </Button>
                <Button size="sm" variant="ghost" icon={<Activity size={13} />} onClick={() => navigate('/activity')}>
                  Open the raw activity log
                </Button>
              </div>
            </Card>
          </>
        )}

        {/* The window label is repeated in text for anyone who cannot see the active chip. */}
        <p className="sr-only" role="status" aria-live="polite">
          {loading ? 'Loading analytics' : `Showing the last ${days} days.`}
        </p>
      </PageBody>
    </>
  );
}
