/**
 * Arena results & post-analysis.
 *
 * The order here is deliberate and mirrors how a student should read a result sheet:
 * 1. what I scored (and what it means against everyone else),
 * 2. what went wrong (subjects → topics → difficulty → types),
 * 3. how I used the time,
 * 4. what to do next (AI analysis + one-click weak-area practice),
 * 5. the actual answers.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Brain,
  CheckCircle2,
  Clock,
  Download,
  Lightbulb,
  RefreshCw,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Trophy,
  Users,
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
  SampleNotice,
  Segmented,
  StatTile,
} from '../../components/ui';
import { Markdown } from '../../components/Markdown';

import { useToast } from '../../hooks/useToast';
import { percent, scoreTone } from '../../lib/format';
import { compactMs, formatDateTimeLong, formatPercentile, stateMeta } from '../../lib/arena';
import { api } from '../../lib/api';
import { useArenaResult } from './useArena';
import { IntegrityPanel } from './proctor/components';
import { ArenaReviewList } from './ArenaReviewList';
import type { ArenaBreakdownItem, ArenaPracticeLink, ArenaPracticeSuggestion, ArenaResultPayload } from '../../types';

export function ArenaResultsPage() {
  const { attemptId } = useParams<{ attemptId: string }>();
  const navigate = useNavigate();
  const { push } = useToast();
  const { data, loading, error, refresh } = useArenaResult(attemptId);
  const [busy, setBusy] = useState<string | null>(null);
  const [breakdown, setBreakdown] = useState<'subject' | 'topic' | 'difficulty' | 'type'>('subject');

  const payload = data;
  const pending = payload ? !isPublished(payload) : false;

  async function analyse() {
    if (!attemptId) return;
    setBusy('analyze');
    try {
      const result = await api.post<{ report: ArenaResultPayload['report'] }>(`/arena/results/${attemptId}/analyze`, {});
      push({
        tone: 'success',
        title: result.report?.source === 'ai' ? 'AI analysis ready' : 'Analysis ready',
        detail:
          result.report?.source === 'ai'
            ? 'Generated from your answer sheet and timing data.'
            : 'Generated on the server without an AI provider — connect a key for a deeper read.',
      });
      await refresh();
    } catch (err) {
      push({ tone: 'error', title: 'Analysis failed', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Hands the student to the existing Practice feature. The server builds one deep link per
   * suggestion (subject, chapter, difficulty, question type and count), so "Practice this" drills
   * the topic that actually cost marks instead of whatever Practice was configured with last.
   */
  async function practiceWith(suggestion?: ArenaPracticeSuggestion) {
    if (!attemptId) return;
    setBusy(suggestion ? `practice-${suggestion.topic}` : 'practice');
    try {
      const result = await api.post<{
        suggestions: ArenaPracticeLink[];
        startWith: ArenaPracticeLink | null;
      }>(`/arena/results/${attemptId}/practice`, {});
      const target =
        (suggestion && result.suggestions.find((item) => item.subject === suggestion.subject && item.topic === suggestion.topic)) ||
        result.startWith;
      if (!target?.url) {
        push({ tone: 'warning', title: 'No practice set available yet', detail: 'Submit a few more answers first.' });
        return;
      }
      navigate(target.url);
    } catch (err) {
      push({ tone: 'error', title: 'Could not open practice', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (loading && !payload) {
    return (
      <PageBody>
        <LoadingState message="Loading your result…" />
      </PageBody>
    );
  }

  if (error || !payload) {
    return (
      <>
        <PageHeader title="Result" />
        <PageBody>
          <ErrorState message={error ?? 'This result is not available.'} onRetry={() => void refresh()} />
          <div className="mt-4">
            <Link to="/arena" className="text-[13px] text-[var(--color-primary)]">
              ← Back to Arena
            </Link>
          </div>
        </PageBody>
      </>
    );
  }

  const { result, benchmark, report, timeAnalysis, blueprint } = payload;
  const accuracy = result.accuracy;
  const meta = stateMeta(payload.state);

  return (
    <>
      <PageHeader
        title={result.competitionTitle}
        badge={<Badge tone={meta.tone}>{pending ? 'Result summary' : 'Analysis'}</Badge>}
        description={
          pending
            ? 'Your paper is scored. Detailed analysis unlocks when results are published for everyone.'
            : `Submitted ${formatDateTimeLong(result.submittedAt)}${result.autoSubmitted ? ' · auto-submitted at the deadline' : ''}`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/arena"
              className="inline-flex h-10 items-center gap-1.5 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] px-3.5 text-sm hover:border-[var(--color-border-strong)]"
            >
              <ArrowLeft size={15} /> Arena
            </Link>
            <Button
              variant="secondary"
              icon={<Download size={15} />}
              onClick={() => window.print()}
              title="Print or save this analysis as PDF"
            >
              Save report
            </Button>
            <Button variant="primary" icon={<Target size={15} />} loading={busy === 'practice'} onClick={() => void practiceWith()}>
              Practice weak areas
            </Button>
          </div>
        }
      />

      <PageBody className="space-y-5">
        {result.autoSubmitted ? (
          <SampleNotice text="The clock ran out and the paper was submitted automatically — everything you had saved was graded. Watch the per-question timings below to see where time went." />
        ) : null}

        {/* ------------------------------ score hero ----------------------------- */}
        <section aria-labelledby="arena-score" className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
          <h2 id="arena-score" className="sr-only">
            Score summary
          </h2>
          <Card className="p-4 sm:p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-[11.5px] uppercase tracking-wide text-[var(--color-muted-dim)]">Your score</p>
                <p className="mt-1 text-[34px] font-semibold leading-none">
                  {result.score}
                  <span className="text-[17px] text-[var(--color-muted)]">/{result.maxScore}</span>
                </p>
              </div>
              <div className="text-right">
                <p className="text-[11.5px] uppercase tracking-wide text-[var(--color-muted-dim)]">Accuracy</p>
                {/* scoreTone() takes a ratio, like the API's accuracy field — not a percentage. */}
                <p className={`mt-1 text-[24px] font-semibold leading-none ${ACCURACY_TEXT[scoreTone(accuracy)]}`}>
                  {percent(accuracy)}
                </p>
              </div>
            </div>
            <div className="mt-4">
              <ProgressBar
                value={result.score / Math.max(1, result.maxScore)}
                tone={scoreTone(accuracy)}
                label={`Score ${result.score} of ${result.maxScore}`}
              />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MiniStat label="Correct" value={result.correct} tone="success" />
              <MiniStat label="Wrong" value={result.incorrect} tone="error" />
              <MiniStat label="Skipped" value={result.unanswered} tone="warning" />
              <MiniStat label="Attempted" value={result.attempted} tone="primary" />
            </div>
            {/* Marking rule as it was actually applied — the server is the only authority on this. */}
            {blueprint ? (
              <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
                Marked on the server: +{blueprint.marksPerQuestion} for a correct answer, −
                {blueprint.negativeMarks} for a wrong one, nothing for a blank. Numerical answers were accepted
                within ±{blueprint.numericTolerance}% of the expected value.
              </p>
            ) : null}
          </Card>

          <Card className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <p className="inline-flex items-center gap-2 text-[13px] font-semibold">
                <Users size={15} /> Benchmark
              </p>
              <Badge tone={benchmark ? 'primary' : 'muted'}>{benchmark ? benchmark.populationLabel : 'Not available'}</Badge>
            </div>
            {benchmark ? (
              <>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[11.5px] uppercase tracking-wide text-[var(--color-muted-dim)]">Percentile</p>
                    <p className="mt-0.5 text-[24px] font-semibold leading-none">{formatPercentile(benchmark.percentile)}</p>
                  </div>
                  <div>
                    <p className="text-[11.5px] uppercase tracking-wide text-[var(--color-muted-dim)]">Position</p>
                    <p className="mt-0.5 text-[24px] font-semibold leading-none">
                      {benchmark.rank}
                      <span className="text-[13px] text-[var(--color-muted)]">/{benchmark.participantCount}</span>
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                  You are in the <span className="text-[var(--color-text)]">{benchmark.band}</span> band. Percentile is
                  relative to everyone who submitted a valid paper here — it is not a JEE/NEET rank prediction.
                </p>
              </>
            ) : (
              <p className="mt-3 text-[13px] leading-relaxed text-[var(--color-muted)]">
                Benchmarking needs at least five valid submissions. You will see your percentile and position once more
                students submit.
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-[var(--color-border)] pt-3 text-[12.5px]">
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[var(--color-muted)]">
                <Clock size={13} /> Time used {compactMs(result.timeUsedMs)}
              </span>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[var(--color-muted)]">
                <Activity size={13} /> Avg {compactMs(timeAnalysis.avgMsPerQuestion)}/question
              </span>
            </div>
          </Card>
        </section>

        {/* ------------------------- AI analysis / report ------------------------ */}
        <Card>
          <CardHeader
            title="AI post-analysis"
            subtitle={
              report
                ? `${report.source === 'ai' ? 'AI-generated' : 'Generated on the server'} · ${formatDateTimeLong(report.generatedAt)}`
                : 'Missing a clear read of what to fix? Generate one from this attempt.'
            }
            icon={<Brain size={16} />}
            right={
              <Button
                size="sm"
                variant={report ? 'secondary' : 'primary'}
                icon={report ? <RefreshCw size={13} /> : <Sparkles size={13} />}
                loading={busy === 'analyze'}
                onClick={() => void analyse()}
              >
                {report ? 'Regenerate' : 'Generate analysis'}
              </Button>
            }
          />
          <div className="space-y-4 px-4 pb-4">
            {!report ? (
              <p className="text-[13px] leading-relaxed text-[var(--color-muted)]">
                The analysis reads your subject, topic, difficulty and time data, then writes what went well, what to
                fix and which patterns cost you marks. Works with a connected AI provider; otherwise the server
                produces a deterministic version from the same data.
              </p>
            ) : (
              <>
                <Markdown content={report.summary} className="text-[13.5px]" />

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/[0.06] p-3">
                    <p className="mb-1.5 inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#86efac]">
                      <TrendingUp size={13} /> Strong areas
                    </p>
                    <ul className="space-y-1 text-[13px] text-[var(--color-text)]/90">
                      {report.strongAreas.map((area) => (
                        <li key={area}>· {area}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="rounded-xl border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/[0.06] p-3">
                    <p className="mb-1.5 inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#fcd28b]">
                      <TrendingDown size={13} /> Needs work
                    </p>
                    <ul className="space-y-1 text-[13px] text-[var(--color-text)]/90">
                      {report.needsImprovement.map((area) => (
                        <li key={area}>· {area}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                {report.patterns.length ? (
                  <div>
                    <p className="mb-2 text-[12.5px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
                      Patterns behind the marks
                    </p>
                    <ul className="space-y-2">
                      {report.patterns.map((pattern) => (
                        <li
                          key={pattern.pattern}
                          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
                        >
                          <p className="text-[13.5px] font-medium">{pattern.pattern}</p>
                          <p className="mt-1 text-[12.5px] text-[var(--color-muted)]">
                            <span className="text-[var(--color-muted-dim)]">Evidence: </span>
                            {pattern.evidence}
                          </p>
                          <p className="mt-1 text-[12.5px] text-[var(--color-primary-soft)]">
                            <span className="text-[var(--color-muted-dim)]">Fix: </span>
                            {pattern.suggestion}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div>
                  <p className="mb-2 text-[12.5px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
                    Recommended next steps
                  </p>
                  <ol className="space-y-2">
                    {report.recommendations.map((item, index) => (
                      <li key={item} className="flex gap-2.5 text-[13.5px] leading-relaxed">
                        <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[var(--color-primary)]/40 text-[11px] text-[var(--color-primary)]">
                          {index + 1}
                        </span>
                        <span className="text-[var(--color-text)]/90">{item}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </>
            )}
          </div>
        </Card>

        {/* ------------------------- weak-area practice ------------------------- */}
        {!pending && payload.practiceSuggestions.length ? (
          <Card>
            <CardHeader
              title="Fix it now"
              subtitle="One click builds a practice set from the exact topics that cost you marks."
              icon={<Target size={16} />}
              right={
                <Button size="sm" variant="primary" loading={busy === 'practice'} onClick={() => void practiceWith()}>
                  Best next set
                </Button>
              }
            />
            <ul className="grid gap-2.5 px-4 pb-4 sm:grid-cols-2">
              {payload.practiceSuggestions.map((suggestion) => (
                <li
                  key={`${suggestion.subject}-${suggestion.topic}`}
                  className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">{suggestion.subject}</Badge>
                    {suggestion.chapter ? <Badge tone="muted">{suggestion.chapter}</Badge> : null}
                    <Badge tone="primary">{suggestion.count} questions</Badge>
                  </div>
                  <p className="text-[13.5px] font-medium">{suggestion.topic}</p>
                  <p className="text-[12.5px] leading-relaxed text-[var(--color-muted)]">{suggestion.reason}</p>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-auto self-start"
                    loading={busy === `practice-${suggestion.topic}`}
                    onClick={() => void practiceWith(suggestion)}
                  >
                    Practice this
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {/* ---------------------------- breakdowns ------------------------------ */}
        <Card>
          <CardHeader
            title="Where the marks went"
            subtitle="Correct, wrong and skipped per group — accuracy is over attempted questions."
            icon={<Activity size={16} />}
            right={
              <Segmented<'subject' | 'topic' | 'difficulty' | 'type'>
                value={breakdown}
                size="sm"
                label="Breakdown view"
                onChange={setBreakdown}
                options={[
                  { value: 'subject', label: 'Subject' },
                  { value: 'topic', label: 'Topic' },
                  { value: 'difficulty', label: 'Difficulty' },
                  { value: 'type', label: 'Type' },
                ]}
              />
            }
          />
          <div className="px-4 pb-4">
            <BreakdownList
              items={
                breakdown === 'subject'
                  ? payload.subjectAnalysis
                  : breakdown === 'topic'
                    ? payload.topicAnalysis
                    : breakdown === 'difficulty'
                      ? payload.difficultyAnalysis
                      : payload.typeAnalysis
              }
            />
          </div>
        </Card>

        {/* ---------------------------- time analysis --------------------------- */}
        <Card>
          <CardHeader
            title="How you used the time"
            subtitle={`${compactMs(result.timeUsedMs)} of the ${result.durationMin}-minute paper`}
            icon={<Clock size={16} />}
          />
          <div className="space-y-3 px-4 pb-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile label="Average per question" value={compactMs(timeAnalysis.avgMsPerQuestion)} />
              <StatTile label="First third" value={compactMs(timeAnalysis.firstThirdAvgMs)} sub="per question" />
              <StatTile
                label="Last third"
                value={compactMs(timeAnalysis.lastThirdAvgMs)}
                sub={timeAnalysis.timePressure ? 'slower — time pressure' : 'per question'}
                tone={timeAnalysis.timePressure ? 'warning' : 'neutral'}
              />
            </div>
            {timeAnalysis.timePressure ? (
              <p className="inline-flex items-start gap-2 rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/[0.07] px-3 py-2 text-[12.5px] text-[#fcd28b]">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                You spent noticeably longer per question towards the end — practise holding a steady pace so the last
                questions are not rushed.
              </p>
            ) : null}
            {timeAnalysis.slowestTopics.length ? (
              <div>
                <p className="mb-2 text-[12.5px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
                  Slowest topics
                </p>
                <ul className="grid gap-2 sm:grid-cols-3">
                  {timeAnalysis.slowestTopics.map((topic) => (
                    <li
                      key={topic.topic}
                      className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12.5px]"
                    >
                      <span className="min-w-0 truncate">{topic.topic}</span>
                      <span className="shrink-0 font-mono text-[11.5px] text-[var(--color-muted)]">
                        {compactMs(topic.avgMs)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </Card>

        {/* ------------------------------ standings ----------------------------- */}
        {payload.standings?.length ? (
          <Card>
            <CardHeader
              title="Standings"
              subtitle="Names are hidden in shared standings; only you see which row is yours."
              icon={<Trophy size={16} />}
            />
            <ul className="divide-y divide-[var(--color-border)] px-4 pb-4">
              {payload.standings.map((standing) => (
                <li
                  key={`${standing.rank}-${standing.label}`}
                  className={`flex items-center justify-between gap-3 py-2 text-[13px] ${
                    standing.isYou ? 'text-[var(--color-primary)]' : 'text-[var(--color-text)]/90'
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <span className="w-7 text-right font-mono text-[12px] text-[var(--color-muted)]">
                      {standing.rank}
                    </span>
                    {standing.isYou ? <Badge tone="primary">You</Badge> : <span>{standing.label}</span>}
                  </span>
                  <span className="flex items-center gap-3 font-mono text-[12px]">
                    <span>{standing.score}</span>
                    <span className="text-[var(--color-muted)]">{formatPercentile(standing.percentile)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {/* ------------------------------- review ------------------------------- */}
        <Card>
          <CardHeader
            title="Answer review"
            subtitle={
              payload.reviewAvailable
                ? 'Question-wise key, your answer and the reasoning.'
                : 'The answer key opens after results are published.'
            }
            icon={<Lightbulb size={16} />}
          />
          <div className="px-4 pb-4">
            {payload.reviewAvailable && payload.review?.length ? (
              <ArenaReviewList review={payload.review} />
            ) : (
              <EmptyState
                icon={<CheckCircle2 size={20} />}
                title="Answer review is locked"
                description="Once the organiser publishes results, every question here shows the correct answer, your response, the explanation and the time you spent."
              />
            )}
          </div>
        </Card>
        {/* The student's own integrity record: the same evidence the host can see (§44). */}
        <IntegrityPanel scope="arena" refId={attemptId ?? ''} />

      </PageBody>
    </>
  );
}

const ACCURACY_TEXT: Record<'success' | 'warning' | 'error', string> = {
  success: 'text-[var(--color-success)]',
  warning: 'text-[var(--color-warning)]',
  error: 'text-[var(--color-error)]',
};

function isPublished(payload: ArenaResultPayload): boolean {
  return payload.state === 'RESULTS_PUBLISHED' || payload.state === 'ARCHIVED';
}

function MiniStat({ label, value, tone }: { label: string; value: number; tone: 'success' | 'error' | 'warning' | 'primary' }) {
  const color =
    tone === 'success'
      ? 'text-[var(--color-success)]'
      : tone === 'error'
        ? 'text-[var(--color-error)]'
        : tone === 'warning'
          ? 'text-[var(--color-warning)]'
          : 'text-[var(--color-primary)]';
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-[var(--color-muted-dim)]">{label}</p>
      <p className={`mt-0.5 text-[17px] font-semibold ${color}`}>{value}</p>
    </div>
  );
}

function BreakdownList({ items }: { items: ArenaBreakdownItem[] }) {
  const sorted = useMemo(
    () => [...items].sort((a, b) => a.accuracy - b.accuracy || b.total - a.total),
    [items],
  );

  if (!sorted.length) {
    return <p className="text-[13px] text-[var(--color-muted)]">Nothing to break down for this paper.</p>;
  }

  return (
    <ul className="space-y-2.5">
      {sorted.map((item) => (
        <li key={item.key} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13.5px] font-medium">{item.label}</p>
            <p className="text-[12px] text-[var(--color-muted)]">
              {item.correct} correct · {item.incorrect} wrong · {item.unanswered} skipped
            </p>
          </div>
          <div className="mt-2">
            <ProgressBar value={item.accuracy} tone={scoreTone(item.accuracy)} label={`${item.label} accuracy`} />
          </div>
          <p className="mt-1.5 text-[11.5px] text-[var(--color-muted)]">
            Accuracy {percent(item.accuracy)} over {item.attempted} attempted of {item.total}
          </p>
        </li>
      ))}
    </ul>
  );
}

export default ArenaResultsPage;
