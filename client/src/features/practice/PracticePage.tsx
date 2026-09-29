/**
 * Practice (spec §18, §31).
 *
 * The loop that matters: generate → attempt → instant feedback with reasoning → detect weak topics
 * → hand off to a mock exam or a fresh set. Every answer is graded and recorded to Learning Activity.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  BadgeCheck,
  BookOpenCheck,
  CheckCircle2,
  ChevronRight,
  Compass,
  Lightbulb,
  RotateCcw,
  SkipForward,
  Sparkles,
  Target,
  Timer,
  Wand2,
  XCircle,
} from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import { VroqnSection, VroqnSelectMenu } from '../../components/vroqn';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, ProgressBar, SampleNotice, Segmented, Spinner, StatTile, TextArea, TextInput } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { api, ApiError } from '../../lib/api';
import { formatDuration, scoreTone } from '../../lib/format';
import { useSettings } from '../../hooks/useSettings';
import { useToast } from '../../hooks/useToast';
import type { AttemptFeedback, PracticeQuestion, PracticeSet, QuestionTypeChoice } from '../../types';

interface Catalog {
  subjects: string[];
  chapters: Record<string, string[]>;
  difficulty: { id: string; label: string; hint: string }[];
  questionTypes: { id: string; label: string }[];
  defaults: { subject: string; chapter: string; difficulty: string };
  weakTopics: { subject: string; topic: string; attempted: number; correct: number }[];
}

interface QuestionResult {
  feedback: AttemptFeedback;
  answer: string;
  timeMs: number;
}

export function PracticePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { push } = useToast();
  const { settings, hasConnectedKey, save } = useSettings();

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * The URL parameters are how other features hand work over to Practice — the tutor ("practise
   * this answer") and Arena ("practice my weak areas") both deep-link here, and Arena also passes
   * the difficulty, question type and count it derived from the paper. Unknown values are ignored
   * so a hand-edited link cannot put the form into an invalid state.
   */
  const paramDifficulty = params.get('difficulty');
  const paramType = params.get('questionType');
  const paramCount = Number(params.get('count'));
  const allTypes: QuestionTypeChoice[] = ['mcq', 'short', 'numerical', 'conceptual', 'mixed'];
  const [subject, setSubject] = useState(params.get('subject') ?? 'Physics');
  const [chapter, setChapter] = useState(params.get('chapter') ?? '');
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>(
    paramDifficulty === 'easy' || paramDifficulty === 'hard' || paramDifficulty === 'medium' ? paramDifficulty : 'medium',
  );
  const [questionType, setQuestionType] = useState<QuestionTypeChoice>(
    allTypes.includes(paramType as QuestionTypeChoice) ? (paramType as QuestionTypeChoice) : 'mixed',
  );
  const [count, setCount] = useState(Number.isFinite(paramCount) && paramCount >= 1 ? Math.min(10, paramCount) : 5);
  /** Set when the student arrived from Arena (or a tutor answer) so the hand-off can be explained. */
  const handoffTopic = params.get('from') ? params.get('topic') : null;

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [set, setSet] = useState<PracticeSet | null>(null);
  const [degraded, setDegraded] = useState<string | null>(null);

  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [results, setResults] = useState<Record<string, QuestionResult>>({});
  const [showHint, setShowHint] = useState(false);
  const questionStart = useRef<number>(Date.now());
  const setStart = useRef<number>(Date.now());

  /* --------------------------------- loading -------------------------------- */

  useEffect(() => {
    api
      .get<Catalog>('/practice/catalog')
      .then((result) => {
        setCatalog(result);
        if (!params.get('subject') && result.defaults.subject) setSubject(result.defaults.subject);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Could not load practice options.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chapters = useMemo(() => (catalog && subject ? catalog.chapters[subject] ?? [] : []), [catalog, subject]);
  const current: PracticeQuestion | undefined = set?.questions[index];
  const currentResult = current ? results[current.id] : undefined;
  const answered = Object.keys(results).length;
  const correctCount = Object.values(results).filter((entry) => entry.feedback.isCorrect).length;

  /* -------------------------------- generate -------------------------------- */

  const generate = useCallback(async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const result = await api.post<{ set: PracticeSet; degraded?: string }>('/practice/generate', {
        subject,
        chapter: chapter || undefined,
        difficulty,
        questionType,
        count,
      });
      setSet(result.set);
      setDegraded(result.degraded ?? null);
      setIndex(0);
      setAnswer('');
      setSelectedOption(null);
      setResults({});
      setShowHint(false);
      questionStart.current = Date.now();
      setStart.current = Date.now();
      void save({ subjectDefaults: { subject, chapter, difficulty } }).catch(() => undefined);
    } catch (err) {
      setGenerateError(err instanceof ApiError ? err.message : 'Could not generate questions right now.');
    } finally {
      setGenerating(false);
    }
  }, [chapter, count, difficulty, questionType, save, subject]);

  /* --------------------------------- checking ------------------------------- */

  const submitAnswer = useCallback(
    async (options: { skipped?: boolean } = {}) => {
      if (!set || !current || currentResult || checking) return;
      const given = options.skipped ? '' : current.type === 'mcq' ? selectedOption ?? '' : answer;
      if (!options.skipped && !given.trim()) {
        push({ tone: 'warning', title: 'Answer needed', detail: 'Type your answer or pick an option first.' });
        return;
      }
      setChecking(true);
      try {
        const timeMs = Date.now() - questionStart.current;
        const result = await api.post<{ feedback: AttemptFeedback }>('/practice/check', {
          setId: set.id,
          questionId: current.id,
          answer: given ?? '',
          skipped: options.skipped,
          timeSpentMs: timeMs,
        });
        setResults((current_) => ({ ...current_, [current.id]: { feedback: result.feedback, answer: given ?? '', timeMs } }));
      } catch (err) {
        push({
          tone: 'error',
          title: 'Could not check that answer',
          detail: err instanceof ApiError ? err.message : 'Please try again.',
        });
      } finally {
        setChecking(false);
      }
    },
    [answer, checking, current, currentResult, push, selectedOption, set],
  );

  const nextQuestion = () => {
    if (!set) return;
    if (index + 1 >= set.questions.length) return;
    setIndex((value) => value + 1);
    setAnswer('');
    setSelectedOption(null);
    setShowHint(false);
    questionStart.current = Date.now();
  };

  const weakTopics = useMemo(() => {
    const map = new Map<string, { correct: number; total: number }>();
    for (const result of Object.values(results)) {
      const entry = map.get(result.feedback.topic) ?? { correct: 0, total: 0 };
      entry.total += 1;
      if (result.feedback.isCorrect) entry.correct += 1;
      map.set(result.feedback.topic, entry);
    }
    return [...map.entries()]
      .filter(([, value]) => value.correct / value.total < 0.7)
      .map(([topic, value]) => ({ topic, ...value }));
  }, [results]);

  const finished = set != null && answered === set.questions.length;

  /* ---------------------------------- render -------------------------------- */

  return (
    <>
      <PageHeader
        title="Practice"
        description="Generate a set, answer one question at a time, and see exactly why an answer is right or wrong."
        badge={
          set ? (
            <Badge tone="primary">
              {set.subject}
              {set.chapter ? ` · ${set.chapter}` : ''}
            </Badge>
          ) : handoffTopic ? (
            <Badge tone="warning">From your Arena result</Badge>
          ) : undefined
        }
        actions={
          set ? (
            <Button
              variant="secondary"
              icon={<RotateCcw size={15} />}
              onClick={() => {
                setSet(null);
                setResults({});
                setDegraded(null);
              }}
            >
              New set
            </Button>
          ) : undefined
        }
      />

      <PageBody className="space-y-5">
        {/* ------------------------------ config panel ----------------------------- */}
        {!set ? (
          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <Card>
              <CardHeader title="Build a practice set" subtitle="Choose what you want to work on" icon={<Target size={15} />} />
              <div className="space-y-4 p-4">
                {loadError ? <ErrorState message={loadError} onRetry={() => navigate(0)} /> : null}

                {handoffTopic ? (
                  <SampleNotice
                    text={`Your Arena result flagged “${handoffTopic}”. The subject, chapter, difficulty and question count below were filled in from that attempt — change anything before generating.`}
                  />
                ) : null}
                {/*
                  Searchable pickers instead of native <select> (§3): a phone with 40 chapters should
                  let a student type three letters, not thumb through a native wheel. On a desktop both
                  sit side by side; on a phone they stack, and each opens a sheet with its own search.
                */}
                <VroqnSection
                  title="Subject and chapter"
                  description="Pick a subject, then say what you want to work on in your own words — or leave it empty for mixed topics."
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Subject">
                      <VroqnSelectMenu
                        label="Subject"
                        value={subject}
                        searchPlaceholder="Search subjects…"
                        placeholder="Choose a subject"
                        options={(catalog?.subjects ?? ['Physics', 'Mathematics', 'Chemistry', 'Biology']).map((option) => ({
                          value: option,
                          label: option,
                        }))}
                        onChange={(value) => {
                          setSubject(value);
                          setChapter('');
                        }}
                      />
                    </Field>
                    <Field
                      label="Chapter / topic"
                      optional
                      hint={
                        chapters.length
                          ? `Type anything — ${chapters.length} ${subject} chapters are suggested as you type. Leave it empty for mixed topics.`
                          : 'Type any topic you want to work on, or leave it empty for mixed topics.'
                      }
                    >
                      {/*
                        Writable, not a picker. A chapter list can never cover what a student is
                        actually stuck on — "rotational motion", "my school's chapter 7", a topic the
                        textbook names differently — and forcing a choice from seven options meant the
                        only way to practise that was to pick the wrong one. Typing is now the primary
                        action; the list below it is a suggestion list, not a gate.
                      */}
                      <TextInput
                        value={chapter}
                        onChange={(event) => setChapter(event.target.value)}
                        placeholder="Any chapter — or type your own, e.g. Rotational Motion"
                        maxLength={80}
                        list="practice-chapter-suggestions"
                      />
                      {chapters.length ? (
                        <datalist id="practice-chapter-suggestions">
                          {chapters.map((option) => (
                            <option key={option} value={option} />
                          ))}
                        </datalist>
                      ) : null}
                    </Field>
                  </div>
                </VroqnSection>

                <Field label="Difficulty">
                  <Segmented
                    value={difficulty}
                    onChange={setDifficulty}
                    label="Difficulty"
                    options={(catalog?.difficulty ?? [
                      { id: 'easy', label: 'Easy', hint: '' },
                      { id: 'medium', label: 'Medium', hint: '' },
                      { id: 'hard', label: 'Hard', hint: '' },
                    ]).map((option) => ({ value: option.id as 'easy' | 'medium' | 'hard', label: option.label, hint: option.hint }))}
                  />
                </Field>

                <Field label="Question type">
                  <Segmented
                    value={questionType}
                    onChange={setQuestionType}
                    label="Question type"
                    options={(catalog?.questionTypes ?? [{ id: 'mixed', label: 'Mixed' }]).map((option) => ({
                      value: option.id as QuestionTypeChoice,
                      label: option.label,
                    }))}
                  />
                </Field>

                <Field label="How many questions">
                  <Segmented
                    value={String(count)}
                    onChange={(value) => setCount(Number(value))}
                    label="Number of questions"
                    options={[
                      { value: '5', label: '5' },
                      { value: '8', label: '8' },
                      { value: '10', label: '10' },
                      { value: '15', label: '15' },
                    ]}
                  />
                </Field>

                {generateError ? <ErrorState message={generateError} onRetry={generate} /> : null}

                <Button variant="primary" size="lg" block loading={generating} icon={<Wand2 size={16} />} onClick={generate}>
                  {generating ? 'Generating questions…' : 'Generate practice set'}
                </Button>

                {!hasConnectedKey ? (
                  <SampleNotice text="No verified AI key yet — sets will come from the built-in verified question bank until a key is connected." />
                ) : null}
                {settings?.demoMode === false && !hasConnectedKey ? (
                  <SampleNotice text="Sample mode is switched off and no key is working, so generation will fail until a key is fixed. Change this in AI Settings." />
                ) : null}
              </div>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader title="How practice works here" icon={<BookOpenCheck size={15} />} />
                <ol className="space-y-2.5 p-4 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                  <li className="flex gap-2">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-primary)]/12 text-[11px] font-semibold text-[var(--color-primary)]">1</span>
                    Questions are generated for your subject, chapter and level.
                  </li>
                  <li className="flex gap-2">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-primary)]/12 text-[11px] font-semibold text-[var(--color-primary)]">2</span>
                    Answer one at a time — hints are available if you get stuck.
                  </li>
                  <li className="flex gap-2">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-primary)]/12 text-[11px] font-semibold text-[var(--color-primary)]">3</span>
                    Every answer is explained, with full working for numericals.
                  </li>
                  <li className="flex gap-2">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-primary)]/12 text-[11px] font-semibold text-[var(--color-primary)]">4</span>
                    Mistakes feed your weak-topic list, which shapes the next mock exam.
                  </li>
                </ol>
              </Card>

              {catalog?.weakTopics.length ? (
                <Card>
                  <CardHeader title="Worth revisiting" subtitle="From your previous attempts" icon={<Lightbulb size={15} />} />
                  <ul className="divide-y divide-[var(--color-border)]">
                    {catalog.weakTopics.map((topic) => (
                      <li key={`${topic.subject}-${topic.topic}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-[12.5px] font-medium">{topic.topic}</p>
                          <p className="text-[11.5px] text-[var(--color-muted)]">{topic.subject}</p>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<ChevronRight size={14} />}
                          onClick={() => {
                            setSubject(topic.subject);
                            setChapter(topic.topic);
                          }}
                        >
                          Use
                        </Button>
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* -------------------------------- the set -------------------------------- */}
        {set ? (
          <>
            <Card>
              <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
                    <span>
                      Question {index + 1} of {set.questions.length}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="capitalize">{current?.type}</span>
                    <span aria-hidden="true">·</span>
                    <span>{current?.marks} mark{current && current.marks > 1 ? 's' : ''}</span>
                  </div>
                  <div className="mt-2 max-w-md">
                    <ProgressBar
                      value={(index + (currentResult ? 1 : 0)) / set.questions.length}
                      tone="primary"
                      label="Practice progress"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2 text-[12.5px]">
                  <Badge tone="success" icon={<CheckCircle2 size={12} />}>
                    {correctCount} correct
                  </Badge>
                  <Badge tone={answered - correctCount ? 'error' : 'muted'} icon={<XCircle size={12} />}>
                    {answered - correctCount} wrong
                  </Badge>
                </div>
              </div>
            </Card>

            {degraded ? (
              <SampleNotice
                text={degraded}
                action={
                  <Button size="sm" variant="secondary" onClick={() => navigate('/settings')}>
                    AI Settings
                  </Button>
                }
              />
            ) : null}

            {finished ? (
              <Card>
                <CardHeader title="Set complete" subtitle="Here is how this practice round went" icon={<BadgeCheck size={15} />} />
                <div className="space-y-4 p-4">
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                    <StatTile label="Score" value={`${correctCount}/${set.questions.length}`} tone={scoreTone(correctCount / set.questions.length)} />
                    <StatTile label="Accuracy" value={`${Math.round((correctCount / set.questions.length) * 100)}%`} tone={scoreTone(correctCount / set.questions.length)} />
                    <StatTile
                      label="Time"
                      value={formatDuration(Date.now() - setStart.current).replace(' min', 'm')}
                      icon={<Timer size={14} />}
                    />
                    <StatTile label="Weak topics" value={weakTopics.length} tone={weakTopics.length ? 'warning' : 'success'} />
                  </div>

                  {weakTopics.length ? (
                    <div className="rounded-xl border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/[0.06] p-3.5">
                      <p className="text-[12.5px] font-semibold text-[#fcd28b]">Needs another round</p>
                      <ul className="mt-1.5 space-y-1 text-[12.5px] text-[var(--color-muted)]">
                        {weakTopics.map((topic) => (
                          <li key={topic.topic}>
                            • {topic.topic} — {topic.correct}/{topic.total} correct
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/[0.06] p-3.5 text-[12.5px] text-[#7ee2a8]">
                      Strong work — no weak topics detected in this set. A mock exam will confirm it under time pressure.
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      icon={<Target size={15} />}
                      onClick={() => {
                        if (weakTopics[0]) {
                          setChapter(weakTopics[0].topic);
                        }
                        setSet(null);
                        setResults({});
                        void generate();
                      }}
                    >
                      Practise weak topics again
                    </Button>
                    <Button variant="secondary" icon={<Compass size={15} />} onClick={() => navigate('/mock-exam')}>
                      Take a mock exam
                    </Button>
                    <Button variant="ghost" icon={<ArrowRight size={15} />} onClick={() => navigate('/activity')}>
                      See progress
                    </Button>
                  </div>
                </div>
              </Card>
            ) : current ? (
              <Card>
                <div className="space-y-4 p-4">
                  <div>
                    <Badge tone="muted">{current.topic}</Badge>
                    <p className="mt-2.5 text-[15px] font-medium leading-relaxed">{current.prompt}</p>
                  </div>

                  {current.type === 'mcq' && current.options ? (
                    <div className="space-y-2" role="radiogroup" aria-label="Answer options">
                      {current.options.map((option) => {
                        const selected = selectedOption === option;
                        const isRight = currentResult && currentResult.feedback.isCorrect && selected;
                        const isWrong = currentResult && !currentResult.feedback.isCorrect && selected;
                        const revealed = currentResult && option === currentResult.feedback.correctAnswer;
                        return (
                          <button
                            key={option}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={Boolean(currentResult)}
                            onClick={() => setSelectedOption(option)}
                            className={[
                              'flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left text-[13.5px] transition-colors',
                              isRight || revealed
                                ? 'border-[var(--color-success)]/50 bg-[var(--color-success)]/[0.08]'
                                : isWrong
                                  ? 'border-[var(--color-error)]/50 bg-[var(--color-error)]/[0.08]'
                                  : selected
                                    ? 'border-[var(--color-primary)]/50 bg-[var(--color-primary)]/[0.08]'
                                    : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]',
                              'disabled:cursor-default',
                            ].join(' ')}
                          >
                            <span
                              className={[
                                'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] font-semibold',
                                isRight || revealed
                                  ? 'border-[var(--color-success)] text-[#7ee2a8]'
                                  : isWrong
                                    ? 'border-[var(--color-error)] text-[#fca5a5]'
                                    : selected
                                      ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                                      : 'border-[var(--color-border-strong)] text-[var(--color-muted)]',
                              ].join(' ')}
                            >
                              {isRight || revealed ? '✓' : isWrong ? '✕' : ''}
                            </span>
                            <span className="min-w-0 flex-1">{option}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <Field label="Your answer" htmlFor="answer" hint="Write the steps, not just the final value.">
                      <TextArea
                        id="answer"
                        value={answer}
                        onChange={(event) => setAnswer(event.target.value)}
                        placeholder={current.type === 'numerical' ? 'e.g. 15 m/s (show your working)' : 'Write your answer…'}
                        disabled={Boolean(currentResult)}
                        rows={3}
                      />
                    </Field>
                  )}

                  {showHint && current.hint && !currentResult ? (
                    <p className="rounded-lg border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/[0.06] px-3 py-2 text-[12.5px] text-[var(--color-primary-soft)]">
                      Hint: {current.hint}
                    </p>
                  ) : null}

                  {currentResult ? (
                    <div
                      className={[
                        'rounded-xl border p-3.5',
                        currentResult.feedback.isCorrect
                          ? 'border-[var(--color-success)]/40 bg-[var(--color-success)]/[0.07]'
                          : 'border-[var(--color-error)]/40 bg-[var(--color-error)]/[0.07]',
                      ].join(' ')}
                      role="status"
                    >
                      <p className="flex items-center gap-2 text-[13.5px] font-semibold">
                        {currentResult.feedback.isCorrect ? (
                          <>
                            <CheckCircle2 size={15} className="text-[#7ee2a8]" /> {currentResult.feedback.verdict}
                          </>
                        ) : (
                          <>
                            <XCircle size={15} className="text-[#fca5a5]" /> {currentResult.feedback.verdict}
                          </>
                        )}
                      </p>
                      <div className="mt-2">
                        <Markdown content={currentResult.feedback.explanation} />
                      </div>
                      {currentResult.feedback.steps?.length ? (
                        <div className="mt-2.5">
                          <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
                            Step-by-step working
                          </p>
                          <ol className="space-y-1 text-[13px]">
                            {currentResult.feedback.steps.map((step, stepIndex) => (
                              <li key={stepIndex} className="flex gap-2">
                                <span className="text-[var(--color-primary)]">{stepIndex + 1}.</span>
                                <span>{step}</span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      ) : null}
                      {!currentResult.feedback.isCorrect ? (
                        <p className="mt-2.5 text-[12.5px] text-[var(--color-muted)]">
                          Correct answer: <span className="text-[var(--color-text)]">{currentResult.feedback.correctAnswer}</span>
                        </p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<Sparkles size={13} />}
                          onClick={() =>
                            navigate(`/tutor?q=${encodeURIComponent(`Explain this ${set.subject} question: ${current.prompt}`)}`)
                          }
                        >
                          Ask AI Tutor about this
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<Target size={13} />}
                          onClick={() => {
                            setChapter(current.topic);
                            setSet(null);
                            setResults({});
                          }}
                        >
                          More questions on {current.topic}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    {!currentResult ? (
                      <>
                        <Button variant="primary" loading={checking} onClick={() => void submitAnswer()}>
                          Check answer
                        </Button>
                        {current.hint ? (
                          <Button variant="ghost" icon={<Lightbulb size={14} />} onClick={() => setShowHint(true)} disabled={showHint}>
                            Hint
                          </Button>
                        ) : null}
                        <Button variant="ghost" icon={<SkipForward size={14} />} onClick={() => void submitAnswer({ skipped: true })}>
                          Skip
                        </Button>
                      </>
                    ) : (
                      <Button variant="primary" icon={<ArrowRight size={15} />} onClick={nextQuestion} disabled={index + 1 >= set.questions.length}>
                        {index + 1 >= set.questions.length ? 'Last question' : 'Next question'}
                      </Button>
                    )}
                    {checking ? (
                      <span className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
                        <Spinner size={13} /> Checking your answer…
                      </span>
                    ) : null}
                  </div>
                </div>
              </Card>
            ) : (
              <EmptyState icon={<Target size={18} />} title="This set has no questions" description="Generate a fresh set to continue." />
            )}
          </>
        ) : null}
      </PageBody>
    </>
  );
}

export default PracticePage;
