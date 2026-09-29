/** Exam result + analysis (spec §19, §31) with a direct hand-off back into practice. */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Compass,
  Lightbulb,
  Target,
  Timer,
  TrendingDown,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import { Badge, Button, Card, CardHeader, ErrorState, LoadingState, ProgressBar, StatTile } from '../../components/ui';
import { IntegrityPanel } from '../arena/proctor/components';
import { Markdown } from '../../components/Markdown';
import { api, ApiError } from '../../lib/api';
import { formatDuration, scoreTone } from '../../lib/format';
import type { ExamDetail, ExamResult } from '../../types';

export function ExamResultPage() {
  const { resultId } = useParams<{ resultId: string }>();
  const navigate = useNavigate();
  const [result, setResult] = useState<ExamResult | null>(null);
  const [exam, setExam] = useState<ExamDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!resultId) return;
    setLoading(true);
    setError(null);
    try {
      const resultResponse = await api.get<{ result: ExamResult }>(`/exams/results/${resultId}`);
      setResult(resultResponse.result);
      const examResponse = await api.get<{ exam: ExamDetail }>(`/exams/${resultResponse.result.examId}`);
      setExam(examResponse.exam);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this result.');
    } finally {
      setLoading(false);
    }
  }, [resultId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <PageBody>
        <LoadingState message="Crunching your results…" className="py-24" />
      </PageBody>
    );
  }

  if (error || !result) {
    return (
      <PageBody>
        <ErrorState message={error ?? 'That result was not found.'} onRetry={load} />
      </PageBody>
    );
  }

  const ratio = result.accuracy;

  return (
    <>
      <PageHeader
        title={exam?.title ?? 'Mock Exam Result'}
        badge={<Badge tone={scoreTone(ratio)}>{Math.round(ratio * 100)}% accuracy</Badge>}
        description="Where you stand, what went wrong, and exactly what to revise next."
        actions={
          <>
            <Button variant="ghost" icon={<ArrowLeft size={15} />} onClick={() => navigate('/mock-exam')}>
              All exams
            </Button>
            <Button
              variant="primary"
              icon={<Target size={15} />}
              onClick={() => {
                const weakest = result.weakTopics[0];
                navigate(
                  weakest
                    ? `/practice?subject=${encodeURIComponent(exam?.subject ?? 'Physics')}&chapter=${encodeURIComponent(weakest)}`
                    : '/practice',
                );
              }}
            >
              Practise weak topics
            </Button>
          </>
        }
      />

      <PageBody className="space-y-5">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatTile
            label="Score"
            value={`${result.correct}/${result.total}`}
            sub={`${result.score}% marks`}
            tone={scoreTone(ratio)}
            icon={<Compass size={14} />}
          />
          <StatTile label="Accuracy" value={`${Math.round(result.accuracy * 100)}%`} tone={scoreTone(ratio)} icon={<CheckCircle2 size={14} />} />
          <StatTile label="Time taken" value={formatDuration(result.timeSpentMs)} icon={<Timer size={14} />} />
          <StatTile
            label="Topics to revise"
            value={result.weakTopics.length}
            tone={result.weakTopics.length ? 'warning' : 'success'}
            sub={result.strongTopics[0] ? `strong in ${result.strongTopics[0]}` : undefined}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
          <Card>
            <CardHeader title="AI analysis" subtitle="Based on this paper and your recent attempts" icon={<Lightbulb size={15} />} />
            <div className="space-y-3 p-4">
              <Markdown content={result.summary} />
              {result.perTopic.length ? (
                <div>
                  <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">Topic breakdown</p>
                  <ul className="space-y-2.5">
                    {result.perTopic.map((topic) => {
                      const topicRatio = topic.total ? topic.correct / topic.total : 0;
                      return (
                        <li key={topic.topic}>
                          <div className="flex items-center justify-between gap-2 text-[12.5px]">
                            <span className="truncate">{topic.topic}</span>
                            <span className="shrink-0 tabular-nums text-[var(--color-muted)]">
                              {topic.correct}/{topic.total}
                            </span>
                          </div>
                          <div className="mt-1">
                            <ProgressBar value={topicRatio} tone={scoreTone(topicRatio)} label={`${topic.topic} score`} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </div>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader title="Weak topics" subtitle="Under 70% — worth a focused round" icon={<TrendingDown size={15} />} />
              <div className="p-4">
                {result.weakTopics.length ? (
                  <ul className="flex flex-wrap gap-1.5">
                    {result.weakTopics.map((topic) => (
                      <li key={topic}>
                        <button
                          type="button"
                          onClick={() =>
                            navigate(
                              `/practice?subject=${encodeURIComponent(exam?.subject ?? 'Physics')}&chapter=${encodeURIComponent(topic)}`,
                            )
                          }
                          className="vroqn-tap rounded-full border border-[var(--color-error)]/40 bg-[var(--color-error)]/[0.09] px-2.5 py-1.5 text-[12px] text-[#fca5a5] transition-colors hover:bg-[var(--color-error)]/15"
                        >
                          {topic} →
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12.5px] text-[var(--color-muted)]">No weak topics in this paper — nice work.</p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Strong topics" subtitle="Keep these warm" icon={<TrendingUp size={15} />} />
              <div className="p-4">
                {result.strongTopics.length ? (
                  <ul className="flex flex-wrap gap-1.5">
                    {result.strongTopics.map((topic) => (
                      <li key={topic}>
                        <Badge tone="success">{topic}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12.5px] text-[var(--color-muted)]">
                    Not enough evidence yet — a couple more sets will make your strengths clear.
                  </p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Recommended revision" icon={<BookOpen size={15} />} />
              <ol className="space-y-2 p-4 text-[12.5px] leading-relaxed">
                {result.recommendedRevision.map((item, index) => (
                  <li key={index} className="flex gap-2">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-primary)]/12 text-[11px] font-semibold text-[var(--color-primary)]">
                      {index + 1}
                    </span>
                    <span className="text-[var(--color-muted)]">{item}</span>
                  </li>
                ))}
                {!result.recommendedRevision.length ? (
                  <li className="text-[var(--color-muted)]">Revise the weak topics above, then re-attempt this paper.</li>
                ) : null}
              </ol>
            </Card>
          </div>
        </div>

        {exam ? (
          <Card>
            <CardHeader
              title="Question by question"
              subtitle="Your answer, the correct answer and why"
              icon={<CheckCircle2 size={15} />}
              right={
                <Button size="sm" variant="secondary" iconRight={<ArrowRight size={13} />} onClick={() => navigate('/activity')}>
                  Progress
                </Button>
              }
            />
            <ul className="divide-y divide-[var(--color-border)]">
              {exam.questions.map((question, index) => {
                const answer = result.answers.find((entry) => entry.questionId === question.id);
                const isCorrect = Boolean(answer?.isCorrect);
                return (
                  <li key={question.id} className="px-4 py-3.5">
                    <div className="flex items-start gap-2.5">
                      <span className="mt-0.5 shrink-0">
                        {isCorrect ? (
                          <CheckCircle2 size={16} className="text-[#7ee2a8]" aria-label="Correct" />
                        ) : (
                          <XCircle size={16} className="text-[#fca5a5]" aria-label="Incorrect" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13.5px] font-medium">
                          Q{index + 1}. {question.prompt}
                        </p>
                        <div className="mt-1.5 space-y-1 text-[12.5px]">
                          <p className="text-[var(--color-muted)]">
                            Your answer:{' '}
                            <span className={isCorrect ? 'text-[#7ee2a8]' : 'text-[#fca5a5]'}>
                              {answer?.answer?.trim() || '(left blank)'}
                            </span>
                          </p>
                          {!isCorrect ? (
                            <p className="text-[var(--color-muted)]">
                              Correct answer: <span className="text-[var(--color-text)]">{question.answer}</span>
                            </p>
                          ) : null}
                        </div>
                        {question.explanation ? (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-[12px] text-[var(--color-primary-soft)]">Why</summary>
                            <div className="mt-1.5">
                              <Markdown content={question.explanation} />
                              {question.steps?.length ? (
                                <ol className="mt-2 space-y-1 text-[12.5px] text-[var(--color-muted)]">
                                  {question.steps.map((step, stepIndex) => (
                                    <li key={stepIndex}>
                                      {stepIndex + 1}. {step}
                                    </li>
                                  ))}
                                </ol>
                              ) : null}
                            </div>
                          </details>
                        ) : null}
                      </div>
                      <Badge tone="muted" className="shrink-0">
                        {question.topic}
                      </Badge>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        ) : null}
        {/* The student's own integrity record — a personal exam has no other reader. */}
        <IntegrityPanel scope="exam" refId={result.examId} />
      </PageBody>
    </>
  );
}

export default ExamResultPage;
