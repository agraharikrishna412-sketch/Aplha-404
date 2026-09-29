/** Mock Exam (spec §19) — build an exam, resume a draft, review past results. */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Clock, Compass, FileCheck2, Play, Plus, RotateCcw, Trash2, TrendingUp } from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  ProgressBar,
  SampleNotice,
  Segmented,
} from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { formatDuration, scoreTone, timeAgo } from '../../lib/format';
import { useSettings } from '../../hooks/useSettings';
import { useToast } from '../../hooks/useToast';
import type { ExamResult, ExamSummary, QuestionTypeChoice } from '../../types';
import { VroqnFilterSelect } from '../../components/vroqn';

interface Catalog {
  subjects: string[];
  chapters: Record<string, string[]>;
}

export function ExamsPage() {
  const navigate = useNavigate();
  const { push } = useToast();
  const { hasConnectedKey } = useSettings();

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [exams, setExams] = useState<ExamSummary[]>([]);
  const [results, setResults] = useState<ExamResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [subject, setSubject] = useState('Physics');
  const [chapters, setChapters] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [questionCount, setQuestionCount] = useState(10);
  const [questionType, setQuestionType] = useState<QuestionTypeChoice>('mixed');
  const [durationMin, setDurationMin] = useState(30);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [catalogResult, examsResult] = await Promise.all([
        api.get<Catalog>('/practice/catalog'),
        api.get<{ exams: ExamSummary[]; recentResults: ExamResult[] }>('/exams'),
      ]);
      setCatalog(catalogResult);
      setExams(examsResult.exams);
      setResults(examsResult.recentResults);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your exams.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const result = await api.post<{ exam: { id: string }; degraded?: string }>('/exams', {
        subject,
        chapters,
        difficulty,
        questionCount,
        questionType,
        durationMin,
      });
      if (result.degraded) {
        push({ tone: 'warning', title: 'Exam created with notes', detail: result.degraded });
      } else {
        push({ tone: 'success', title: 'Exam ready', detail: `${questionCount} questions · ${durationMin} minutes. Good luck!` });
      }
      navigate(`/mock-exam/${result.exam.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Could not create the exam.');
    } finally {
      setCreating(false);
    }
  };

  const remove = async (id: string) => {
    await api.del(`/exams/${id}`).catch(() => undefined);
    setExams((current) => current.filter((exam) => exam.id !== id));
  };

  const chapterOptions = catalog?.chapters[subject] ?? [];

  return (
    <>
      <PageHeader
        title="Mock Exam"
        description="Sit a timed test, then get a clear picture of weak topics and what to revise first."
        actions={
          <Button variant="ghost" icon={<RotateCcw size={15} />} onClick={load} loading={loading}>
            Refresh
          </Button>
        }
      />

      <PageBody className="space-y-5">
        <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
          {/* ------------------------------ create exam ----------------------------- */}
          <Card>
            <CardHeader title="Create an exam" subtitle="Choose the scope — the analysis gets sharper when you keep it focused" icon={<Plus size={15} />} />
            <div className="space-y-4 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Subject">
                  <VroqnFilterSelect
                    label="Exam subject"
                    value={subject}
                    onChange={(next) => {
                      setSubject(next);
                      setChapters([]);
                    }}
                    placeholder="Choose a subject"
                    options={(catalog?.subjects ?? ['Physics', 'Mathematics', 'Chemistry', 'Biology']).map((option) => ({
                      value: option,
                      label: option,
                    }))}
                  />
                </Field>
                <Field label="Duration">
                  <VroqnFilterSelect
                    label="Exam duration"
                    value={String(durationMin)}
                    onChange={(next) => setDurationMin(Number(next))}
                    options={[15, 20, 30, 45, 60, 90].map((minutes) => ({ value: String(minutes), label: `${minutes} minutes` }))}
                  />
                </Field>
              </div>

              <div>
                <p className="mb-1.5 text-[12.5px] font-medium text-[var(--color-muted)]">
                  Chapters <span className="text-[11px] text-[var(--color-muted-dim)]">(pick a few, or leave empty for all)</span>
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {chapterOptions.map((chapter) => {
                    const selected = chapters.includes(chapter);
                    return (
                      <button
                        key={chapter}
                        type="button"
                        aria-pressed={selected}
                        onClick={() =>
                          setChapters((current) =>
                            selected ? current.filter((item) => item !== chapter) : [...current, chapter].slice(0, 5),
                          )
                        }
                        className={[
                          'vroqn-tap rounded-full border px-2.5 py-1.5 text-[12px] transition-colors',
                          selected
                            ? 'border-[var(--color-primary)]/50 bg-[var(--color-primary)]/12 text-[var(--color-primary)]'
                            : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] hover:border-[var(--color-border-strong)]',
                        ].join(' ')}
                      >
                        {chapter}
                      </button>
                    );
                  })}
                  {!chapterOptions.length ? (
                    <span className="text-[12px] text-[var(--color-muted-dim)]">No chapter list for this subject — the exam will cover the whole subject.</span>
                  ) : null}
                </div>
              </div>

              <Field label="Difficulty">
                <Segmented
                  value={difficulty}
                  onChange={setDifficulty}
                  label="Difficulty"
                  options={[
                    { value: 'easy', label: 'Easy' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'hard', label: 'Hard' },
                  ]}
                />
              </Field>

              <Field label="Question type">
                <Segmented
                  value={questionType}
                  onChange={setQuestionType}
                  label="Question type"
                  options={[
                    { value: 'mcq', label: 'MCQ' },
                    { value: 'short', label: 'Short' },
                    { value: 'numerical', label: 'Numerical' },
                    { value: 'mixed', label: 'Mixed' },
                  ]}
                />
              </Field>

              <Field label="Number of questions">
                <Segmented
                  value={String(questionCount)}
                  onChange={(value) => setQuestionCount(Number(value))}
                  label="Number of questions"
                  options={[
                    { value: '5', label: '5' },
                    { value: '10', label: '10' },
                    { value: '15', label: '15' },
                    { value: '20', label: '20' },
                  ]}
                />
              </Field>

              {createError ? <ErrorState message={createError} onRetry={create} /> : null}

              <Button variant="primary" size="lg" block loading={creating} icon={<Compass size={16} />} onClick={create}>
                {creating ? 'Preparing your paper…' : 'Generate exam paper'}
              </Button>

              {!hasConnectedKey ? (
                <SampleNotice text="No verified AI key — the exam will be built from the built-in verified question bank." />
              ) : null}
            </div>
          </Card>

          {/* -------------------------------- history ------------------------------- */}
          <div className="space-y-4">
            {error ? <ErrorState message={error} onRetry={load} /> : null}

            <Card>
              <CardHeader
                title="Your exams"
                subtitle={`${exams.length} paper${exams.length === 1 ? '' : 's'}`}
                icon={<FileCheck2 size={15} />}
              />
              {loading && !exams.length ? (
                <LoadingState message="Loading your exams…" className="py-8" />
              ) : exams.length ? (
                <ul className="divide-y divide-[var(--color-border)]">
                  {exams.map((exam) => (
                    <li key={exam.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium">{exam.title}</p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--color-muted)]">
                          <span>{exam.questions} questions</span>
                          <span aria-hidden="true">·</span>
                          <span className="flex items-center gap-1">
                            <Clock size={11} /> {exam.durationMin} min
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{timeAgo(exam.createdAt)}</span>
                        </p>
                      </div>
                      <Badge tone={exam.status === 'completed' ? 'success' : 'warning'}>
                        {exam.status === 'completed' ? 'Completed' : 'Not finished'}
                      </Badge>
                      <Button
                        size="sm"
                        variant={exam.status === 'completed' ? 'ghost' : 'primary'}
                        icon={exam.status === 'completed' ? <ArrowRight size={13} /> : <Play size={13} />}
                        onClick={() => navigate(`/mock-exam/${exam.id}`)}
                      >
                        {exam.status === 'completed' ? 'Review' : 'Start'}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Delete ${exam.title}`}
                        onClick={() => void remove(exam.id)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon={<Compass size={18} />}
                  title="No exams yet"
                  description="Create your first paper above. A 10-question exam takes about 20 minutes and gives the sharpest revision picture."
                />
              )}
            </Card>

            {results.length ? (
              <Card>
                <CardHeader title="Recent results" subtitle="Open any result for the full analysis" icon={<TrendingUp size={15} />} />
                <ul className="divide-y divide-[var(--color-border)]">
                  {results.map((result) => (
                    <li key={result.id}>
                      <Link
                        to={`/mock-exam/results/${result.id}`}
                        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]"
                      >
                        <span className="text-[15px] font-semibold tabular-nums text-[var(--color-text)]">
                          {result.correct}/{result.total}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="mb-1.5">
                            <ProgressBar value={result.accuracy} tone={scoreTone(result.accuracy)} label="Score" />
                          </div>
                          <p className="truncate text-[11.5px] text-[var(--color-muted)]">
                            {timeAgo(result.createdAt)} · {formatDuration(result.timeSpentMs)}
                            {result.weakTopics.length ? ` · revise: ${result.weakTopics.slice(0, 2).join(', ')}` : ''}
                          </p>
                        </div>
                        <ArrowRight size={14} className="shrink-0 text-[var(--color-muted-dim)]" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : (
              <Card>
                <CardHeader title="How the analysis works" icon={<TrendingUp size={15} />} />
                <div className="space-y-2.5 p-4 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                  <p>1. Each answer is graded, and numericals are marked on working as well as the final value.</p>
                  <p>2. Topics are tracked across every practice set and exam, not just this one paper.</p>
                  <p>3. You get weak topics, strong topics and a concrete revision list — plus a one-tap way to practise the weak ones.</p>
                </div>
              </Card>
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}

export default ExamsPage;
