/**
 * Learning Activity (spec §21, §27).
 *
 * Framed as the student's own progress report — never surveillance. It also states plainly what
 * is recorded, and offers a one-tap erase.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  BookOpen,
  Code2,
  Compass,
  Eye,
  Flame,
  NotebookPen,
  ShieldCheck,
  Target,
  Timer,
  TrendingDown,
  TrendingUp,
  Trash2,
} from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingState,
  ProgressBar,
  Segmented,
  StatTile,
} from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { dayLabel, formatDuration, timeAgo } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../components/Confirm';
import type { ActivityEvent, LearningSummary, TopicMastery } from '../../types';

const KIND_ICON: Record<string, React.ReactNode> = {
  tutor: <Activity size={13} />,
  practice: <Target size={13} />,
  exam: <Compass size={13} />,
  notes: <NotebookPen size={13} />,
  code: <Code2 size={13} />,
  upload: <BookOpen size={13} />,
};

export function ActivityPage() {
  const navigate = useNavigate();
  const { push } = useToast();
  const confirm = useConfirm();
  const [days, setDays] = useState<'7' | '30'>('7');
  const [summary, setSummary] = useState<LearningSummary | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [topics, setTopics] = useState<{ weak: TopicMastery[]; strong: TopicMastery[]; topics: TopicMastery[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showData, setShowData] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryResult, eventsResult, topicsResult] = await Promise.all([
        api.get<{ summary: LearningSummary }>(`/activity/summary?days=${days}`),
        api.get<{ events: ActivityEvent[] }>('/activity/events?limit=60'),
        api.get<{ weak: TopicMastery[]; strong: TopicMastery[]; topics: TopicMastery[] }>('/activity/topics'),
      ]);
      setSummary(summaryResult.summary);
      setEvents(eventsResult.events);
      setTopics(topicsResult);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your learning activity.');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const clearActivity = async () => {
    const ok = await confirm({
      title: 'Erase your learning activity?',
      description:
        'This clears your progress history — the streak, subject accuracy and weak-area rankings. Your notes, AI chats, mock exam papers and Arena results all stay.',
      confirmLabel: 'Erase activity',
    });
    if (!ok) return;
    try {
      await api.del('/settings/activity-data');
      push({ tone: 'success', title: 'Learning activity cleared' });
      await load();
    } catch (err) {
      push({ tone: 'error', title: 'Could not clear activity', detail: err instanceof ApiError ? err.message : 'Try again.' });
    }
  };

  const maxMinutes = Math.max(1, ...(summary?.timeline.map((point) => point.minutes) ?? [1]));

  return (
    <>
      <PageHeader
        title="Learning Activity"
        description="Your progress across every part of Vroqn Nexus. Only you can see this, and you can erase it any time."
        badge={
          summary?.streakDays ? (
            <Badge tone="warning" icon={<Flame size={12} />}>
              {summary.streakDays}-day streak
            </Badge>
          ) : undefined
        }
        actions={
          <>
            <Segmented
              value={days}
              onChange={setDays}
              size="sm"
              label="Time range"
              options={[
                { value: '7' as const, label: '7 days' },
                { value: '30' as const, label: '30 days' },
              ]}
            />
            <Button variant="ghost" icon={<Eye size={15} />} onClick={() => setShowData((value) => !value)}>
              {showData ? 'Hide raw data' : 'View raw data'}
            </Button>
          </>
        }
      />

      <PageBody className="space-y-5">
        {error ? <ErrorState message={error} onRetry={load} /> : null}
        {loading && !summary ? (
          <LoadingState message="Building your progress report…" />
        ) : null}

        {summary ? (
          <>
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              <StatTile
                label="Study time today"
                value={`${summary.minutes}m`}
                sub={`${summary.tutorMinutes}m tutor · ${summary.codeMinutes}m code`}
                tone="primary"
                icon={<Timer size={14} />}
              />
              <StatTile
                label="Questions today"
                value={`${summary.questionsCorrect}/${summary.questionsAttempted}`}
                sub={summary.questionsAttempted ? `${Math.round((summary.questionsCorrect / summary.questionsAttempted) * 100)}% correct` : 'none yet'}
                tone={summary.questionsAttempted && summary.questionsCorrect / summary.questionsAttempted >= 0.7 ? 'success' : 'neutral'}
                icon={<Target size={14} />}
              />
              <StatTile label="Notes organised" value={summary.notesOrganized} sub="today" icon={<NotebookPen size={14} />} />
              <StatTile
                label="Best exam"
                value={summary.bestExam ? `${summary.bestExam.score}/${summary.bestExam.total}` : '—'}
                sub={summary.bestExam?.subject ?? `${summary.examsTaken} taken today`}
                tone={summary.bestExam ? 'success' : 'neutral'}
                icon={<Compass size={14} />}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
              <Card>
                <CardHeader
                  title={`Last ${days} days`}
                  subtitle="Minutes studied per day"
                  icon={<Activity size={15} />}
                  right={<Badge tone="muted">{summary.timeline.reduce((total, point) => total + point.minutes, 0)} min total</Badge>}
                />
                <div className="p-4">
                  <div className="flex h-[150px] items-end gap-1.5" role="img" aria-label="Minutes studied per day">
                    {summary.timeline.map((point) => (
                      <div key={point.day} className="flex flex-1 flex-col items-center gap-1.5">
                        <span className="text-[11px] tabular-nums text-[var(--color-muted-dim)]">{point.minutes || ''}</span>
                        <div className="relative flex w-full flex-1 items-end rounded-md bg-white/[0.04]">
                          <div
                            className="w-full rounded-md bg-gradient-to-t from-[var(--color-primary-dim)] to-[var(--color-primary)] transition-[height] duration-500"
                            style={{ height: `${Math.max(point.minutes ? 6 : 2, (point.minutes / maxMinutes) * 100)}%` }}
                            title={`${point.minutes} min · ${point.questions} questions`}
                          />
                        </div>
                        <span className="text-[11px] text-[var(--color-muted-dim)]">{days === '7' ? dayLabel(point.day) : point.day.slice(8)}</span>
                      </div>
                    ))}
                  </div>

                  {summary.bySubject.length ? (
                    <div className="mt-5">
                      <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">By subject</p>
                      <ul className="space-y-2.5">
                        {summary.bySubject.slice(0, 6).map((entry) => {
                          const accuracy = entry.attempted ? entry.correct / entry.attempted : 0;
                          return (
                            <li key={entry.subject}>
                              <div className="flex items-center justify-between gap-2 text-[12.5px]">
                                <span className="truncate">{entry.subject}</span>
                                <span className="shrink-0 text-[var(--color-muted)]">
                                  {entry.minutes} min · {entry.attempted ? `${entry.correct}/${entry.attempted}` : 'no questions'}
                                </span>
                              </div>
                              <div className="mt-1">
                                <ProgressBar
                                  value={entry.attempted ? accuracy : Math.min(1, entry.minutes / 30)}
                                  tone={entry.attempted ? (accuracy >= 0.7 ? 'success' : 'warning') : 'primary'}
                                  label={`${entry.subject} progress`}
                                />
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : (
                    <p className="mt-4 rounded-lg border border-dashed border-[var(--color-border)] px-3 py-4 text-[12.5px] text-[var(--color-muted)]">
                      No subject activity in this window yet. Ask the AI Tutor or start a practice set to populate this chart.
                    </p>
                  )}
                </div>
              </Card>

              <div className="space-y-4">
                <Card>
                  <CardHeader title="Weak areas" subtitle="Under 70% across at least 2 attempts" icon={<TrendingDown size={15} />} />
                  <div className="p-4">
                    {topics?.weak.length ? (
                      <ul className="space-y-2">
                        {topics.weak.map((topic) => (
                          <li key={`${topic.subject}-${topic.topic}`} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-[12.5px] font-medium">{topic.topic}</span>
                              <span className="shrink-0 text-[11.5px] text-[#fca5a5]">{Math.round(topic.accuracy * 100)}%</span>
                            </div>
                            <div className="mt-1.5 flex items-center justify-between gap-2">
                              <span className="text-[11px] text-[var(--color-muted)]">
                                {topic.subject} · {topic.correct}/{topic.attempted}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  navigate(`/practice?subject=${encodeURIComponent(topic.subject)}&chapter=${encodeURIComponent(topic.topic)}`)
                                }
                                className="vroqn-tap inline-flex items-center text-[11.5px] text-[var(--color-primary)] underline decoration-dotted underline-offset-2"
                              >
                                Practise
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[12.5px] text-[var(--color-muted)]">
                        Nothing flagged. Attempt a few more questions and Vroqn Nexus will start spotting patterns.
                      </p>
                    )}
                  </div>
                </Card>

                <Card>
                  <CardHeader title="Strong areas" subtitle="80%+ across at least 3 attempts" icon={<TrendingUp size={15} />} />
                  <div className="p-4">
                    {topics?.strong.length ? (
                      <ul className="flex flex-wrap gap-1.5">
                        {topics.strong.map((topic) => (
                          <li key={`${topic.subject}-${topic.topic}`}>
                            <Badge tone="success">
                              {topic.topic} · {Math.round(topic.accuracy * 100)}%
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[12.5px] text-[var(--color-muted)]">Keep going — strong topics show up after a few attempts.</p>
                    )}
                  </div>
                </Card>

                <Card>
                  <CardHeader title="Your data" subtitle="Exactly what is stored" icon={<ShieldCheck size={15} />} />
                  <div className="space-y-2.5 p-4 text-[12px] leading-relaxed text-[var(--color-muted)]">
                    <p>
                      We record the learning actions below so this page — and your weak-topic suggestions — can work. No
                      third-party analytics, no hidden tracking, no data shared with anyone.
                    </p>
                    <ul className="space-y-1">
                      <li>• Concepts you asked about and how long you spent</li>
                      <li>• Practice answers, whether they were right, and the topic</li>
                      <li>• Mock exam scores and per-topic results</li>
                      <li>• Notes you created or organised</li>
                      <li>• Code sessions you ran</li>
                    </ul>
                    <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => void clearActivity()}>
                      Clear learning activity
                    </Button>
                  </div>
                </Card>
              </div>
            </div>

            <Card>
              <CardHeader
                title="Recent activity"
                subtitle={`${events.length} recorded action${events.length === 1 ? '' : 's'}`}
                icon={<Activity size={15} />}
                right={
                  showData ? (
                    <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(events, null, 2))}>
                      Copy JSON
                    </Button>
                  ) : undefined
                }
              />
              {showData ? (
                <pre className="vroqn-scroll-x max-h-[320px] overflow-y-auto border-b border-[var(--color-border)] bg-[#070C11] p-4 font-mono text-[11.5px] leading-relaxed text-[var(--color-muted)]">
                  {JSON.stringify(events, null, 2)}
                </pre>
              ) : null}
              {events.length ? (
                <ul className="divide-y divide-[var(--color-border)]">
                  {events.map((event) => (
                    <li key={event.id} className="flex items-start gap-3 px-4 py-2.5">
                      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-primary-soft)]">
                        {KIND_ICON[event.kind] ?? <Activity size={13} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12.5px]">{event.label}</p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-muted-dim)]">
                          <span className="capitalize">{event.kind}</span>
                          {event.subject ? <span>· {event.subject}</span> : null}
                          {event.topic ? <span>· {event.topic}</span> : null}
                          {event.durationMs ? <span>· {formatDuration(event.durationMs)}</span> : null}
                          {event.total ? (
                            <span>
                              · {event.correct}/{event.total} correct
                            </span>
                          ) : null}
                          <span>· {timeAgo(event.createdAt)}</span>
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon={<Activity size={18} />}
                  title="No activity recorded yet"
                  description="Ask the AI Tutor a question, attempt a practice set or sit a mock exam — everything you do shows up here."
                  action={
                    <Button size="sm" variant="primary" onClick={() => navigate('/tutor')}>
                      Ask the AI Tutor
                    </Button>
                  }
                />
              )}
            </Card>
          </>
        ) : null}
      </PageBody>
    </>
  );
}

export default ActivityPage;
