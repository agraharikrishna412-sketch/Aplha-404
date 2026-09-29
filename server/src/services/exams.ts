/**
 * Mock Exam service — generation, submission, scoring and revision planning.
 *
 * Grading is deterministic first (MCQ/numerical are checked locally, instantly), then one AI call
 * produces the qualitative analysis. That keeps a 20-question exam fast and cheap while still
 * ending with genuinely useful "what should I revise" guidance.
 */
import * as db from '../db/index.js';
import { nowIso, uuid } from '../db/index.js';
import { completeJson } from './ai/router.js';
import { examAnalysisSystem, questionGenSystem } from './ai/prompts.js';
import { demoQuestions } from './ai/demoBank.js';
import { sampleQuestions } from './arena/sampleBank.js';
import { gradeQuestion } from './practice.js';
import { promptContextFor } from './tutor.js';
import { HttpError } from '../middleware/errors.js';
import { classifyTopics, listTopicStats, recordActivity, recordTopicResult } from './activity.js';
import type { ExamAnalysis, ExamRecord, ExamResult, PracticeQuestion, QuestionType } from '../types/domain.js';

interface ExamRow {
  id: string;
  user_id: string;
  title: string;
  subject: string;
  chapters: string | null;
  difficulty: string;
  duration_min: number;
  questions: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  started_at: string | null;
  expires_at: string | null;
}

function toExam(row: ExamRow): ExamRecord {
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    chapters: db.json<string[]>(row.chapters, []),
    difficulty: row.difficulty,
    durationMin: Number(row.duration_min ?? 30),
    questions: db.json<PracticeQuestion[]>(row.questions, []),
    status: row.status as ExamRecord['status'],
    createdAt: row.created_at,
    completedAt: row.completed_at,
    startedAt: row.started_at ?? null,
    expiresAt: row.expires_at ?? null,
  };
}

export interface CreateExamArgs {
  userId: string;
  subject: string;
  chapters: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  questionCount: number;
  questionType: QuestionType | 'mixed';
  durationMin: number;
  title?: string;
}

export async function createExam(args: CreateExamArgs): Promise<{ exam: ExamRecord; degraded?: string }> {
  const count = Math.min(Math.max(args.questionCount, 1), 40);
  const ctx = await promptContextFor(args.userId, args.subject, args.chapters[0]);

  let questions: PracticeQuestion[] = [];
  let degraded: string | undefined;

  try {
    const { data, summary } = await completeJson<{ questions: Record<string, unknown>[] }>({
      userId: args.userId,
      task: 'exam',
      system: questionGenSystem(ctx, {
        count,
        type: args.questionType,
        difficulty: args.difficulty,
        subject: args.subject,
        chapter: args.chapters.join(', ') || undefined,
        includeSteps: true,
      }),
      messages: [
        {
          role: 'user',
          content: [
            `Create a ${count}-question mock exam.`,
            `subject: ${args.subject}`,
            `chapters: ${args.chapters.join(', ') || 'any'}`,
            `difficulty: ${args.difficulty}`,
            `questionType: ${args.questionType}`,
            'Mix topics across the listed chapters and order questions from easier to harder.',
          ].join('\n'),
        },
      ],
      temperature: 0.65,
      maxTokens: 4000,
    });
    questions = (data.questions ?? [])
      .map((raw, index): PracticeQuestion | null => {
        const prompt = String(raw.prompt ?? raw.question ?? '').trim();
        if (!prompt) return null;
        const type = String(raw.type ?? 'short').toLowerCase();
        return {
          id: String(raw.id ?? `q${index + 1}`),
          topic: String(raw.topic ?? 'General'),
          type: (['mcq', 'short', 'numerical', 'conceptual'].includes(type) ? type : 'short') as QuestionType,
          prompt,
          options: Array.isArray(raw.options) ? (raw.options as unknown[]).map(String).slice(0, 6) : undefined,
          answer: String(raw.answer ?? '').trim() || 'See explanation',
          explanation: String(raw.explanation ?? '').trim(),
          steps: Array.isArray(raw.steps) ? (raw.steps as unknown[]).map(String).slice(0, 10) : undefined,
          marks: Number(raw.marks ?? 1) || 1,
          hint: raw.hint ? String(raw.hint) : undefined,
        };
      })
      .filter((q): q is PracticeQuestion => Boolean(q));
    if (!questions.length) throw new Error('empty');
    if (summary.demo) degraded = 'Sample exam (no AI key connected yet) — questions come from the built-in bank.';
    else if (questions.length < count) degraded = `The model produced ${questions.length} of ${count} questions.`;
  } catch {
    questions = demoQuestions({
      subject: args.subject,
      chapter: args.chapters[0],
      count,
      type: args.questionType,
    });
    degraded = 'Could not reach a model — using the built-in verified question bank so you can still practise.';
  }

  /**
   * Top up to the requested size.
   *
   * A generated paper can come back short — the model may return fewer questions than asked, and the
   * offline bank holds a limited number of curated items per chapter. Before this, a student who
   * configured "20 questions" silently received 5, which breaks the whole point of a customised exam.
   * The parameterised question bank used by Arena fills the gap, so the exam matches the configuration
   * the student chose. If even that cannot reach the count, the student is told the real number instead
   * of being left to notice it.
   */
  if (questions.length < count) {
    const existing = new Set(questions.map((q) => q.prompt.trim().toLowerCase()));
    const wanted = count - questions.length;
    // The parameterised bank speaks Arena's question types (no 'short'), so 'short' draws as conceptual.
    const bankType = args.questionType === 'short' || args.questionType === 'mixed' ? 'conceptual' : args.questionType;
    const filler = sampleQuestions({
      subject: args.subject,
      chapters: args.chapters,
      difficulty: args.difficulty,
      type: bankType,
      count: wanted + 8,
      marks: 1,
      negativeMarks: 0,
      seed: Date.now() % 100_000,
      keepTemplateDifficulty: true,
    });
    for (const item of filler) {
      if (questions.length >= count) break;
      const key = item.prompt.trim().toLowerCase();
      if (existing.has(key)) continue;
      existing.add(key);
      const type: QuestionType = ['mcq', 'numerical', 'conceptual', 'short'].includes(item.type)
        ? (item.type as QuestionType)
        : 'short';
      questions.push({
        id: `bank-${questions.length + 1}`,
        topic: item.topic || 'General',
        type,
        prompt: item.prompt,
        options: type === 'mcq' && item.options?.length ? item.options : undefined,
        answer: item.answer,
        explanation: item.explanation,
        marks: 1,
      });
    }
    if (questions.length < count) {
      degraded = [
        degraded,
        `Your exam has ${questions.length} of the ${count} questions you asked for — the available question bank for ${args.subject} ran out. It is still a valid shorter paper.`,
      ]
        .filter(Boolean)
        .join(' ');
    }
  }

  /**
   * An MCQ without options cannot be answered, so treat the paper as invalid rather than shipping it.
   * (The offline generator coerces most items, but a defensive check keeps the runner usable.)
   */
  questions = questions.filter((q) => q.type !== 'mcq' || (q.options?.length ?? 0) >= 2);
  if (!questions.length) {
    throw new HttpError(502, 'That exam could not be prepared. Please try again in a moment.', 'exam_unavailable');
  }

  const id = uuid();
  const createdAt = nowIso();
  const title = args.title?.trim() || `${args.subject} Mock Exam`;
  await db.run(
    `INSERT INTO exams (id, user_id, title, subject, chapters, difficulty, duration_min, questions, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
    [
      id,
      args.userId,
      title.slice(0, 140),
      args.subject,
      JSON.stringify(args.chapters),
      args.difficulty,
      args.durationMin,
      JSON.stringify(questions),
      createdAt,
    ],
  );

  return { exam: (await getExam(args.userId, id))!, degraded };
}

export async function getExam(userId: string, examId: string): Promise<ExamRecord | null> {
  const row = await db.one<ExamRow>('SELECT * FROM exams WHERE id = ? AND user_id = ?', [examId, userId]);
  return row ? toExam(row) : null;
}

export async function listExams(userId: string, limit = 30): Promise<ExamRecord[]> {
  const rows = await db.all<ExamRow>('SELECT * FROM exams WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [
    userId,
    limit,
  ]);
  return rows.map(toExam);
}

export async function deleteExam(userId: string, examId: string): Promise<void> {
  await db.run('DELETE FROM exam_answers WHERE exam_id = ?', [examId]);
  await db.run('DELETE FROM exam_results WHERE exam_id = ? AND user_id = ?', [examId, userId]);
  await db.run('DELETE FROM exams WHERE id = ? AND user_id = ?', [examId, userId]);
}

/* ------------------------------------------------------------------ timing */

/**
 * Starts the paper clock the first time the student opens it.
 *
 * The countdown used to be re-initialised in the browser on every mount, so a page refresh handed the
 * student a brand-new full-length timer. The deadline is now anchored to the server clock and only
 * ever set once, which also makes `remainingMs` survive a reload or a second device.
 *
 * A side effect on `GET` is deliberate here: the student cannot open the paper without spending time
 * on it, and starting the clock at creation time instead would punish anyone who creates a paper and
 * comes back later.
 */
export async function openExam(userId: string, examId: string): Promise<ExamRecord | null> {
  const exam = await getExam(userId, examId);
  if (!exam) return null;
  if (exam.status === 'completed' || exam.startedAt) return exam;

  const startedAt = nowIso();
  const expiresAt = new Date(Date.parse(startedAt) + exam.durationMin * 60_000).toISOString();
  await db.run("UPDATE exams SET started_at = ?, expires_at = ?, status = 'in_progress' WHERE id = ? AND user_id = ?", [
    startedAt,
    expiresAt,
    examId,
    userId,
  ]);
  return getExam(userId, examId);
}

export interface ExamClock {
  startedAt: string | null;
  expiresAt: string | null;
  /** Milliseconds left, floored at zero. */
  remainingMs: number;
  /** True once the server clock has passed the deadline. */
  expired: boolean;
  durationMs: number;
}

export function clockFor(exam: ExamRecord): ExamClock {
  const durationMs = Math.max(exam.durationMin, 1) * 60_000;
  if (!exam.expiresAt) {
    return { startedAt: exam.startedAt, expiresAt: null, remainingMs: durationMs, expired: false, durationMs };
  }
  const remainingMs = Math.max(0, Date.parse(exam.expiresAt) - Date.now());
  return {
    startedAt: exam.startedAt,
    expiresAt: exam.expiresAt,
    remainingMs,
    expired: remainingMs <= 0,
    durationMs,
  };
}

/* ------------------------------------------------------------- autosaved answers */

export interface SavedAnswers {
  answers: Record<string, string>;
  flagged: string[];
}

export async function getExamAnswers(examId: string): Promise<SavedAnswers> {
  const rows = await db.all<{ question_id: string; answer: string; flagged: number }>(
    'SELECT question_id, answer, flagged FROM exam_answers WHERE exam_id = ?',
    [examId],
  );
  const answers: Record<string, string> = {};
  const flagged: string[] = [];
  for (const row of rows) {
    if (row.answer) answers[row.question_id] = row.answer;
    if (row.flagged) flagged.push(row.question_id);
  }
  return { answers, flagged };
}

/**
 * Upserts one answer (or one flag change).
 *
 * Guarded three ways: the exam must belong to the caller, it must not already be submitted, and the
 * server clock must still be inside the window — otherwise a student could keep editing after time
 * expired by calling the endpoint directly.
 */
export async function saveExamAnswer(args: {
  userId: string;
  examId: string;
  questionId: string;
  answer?: string;
  flagged?: boolean;
}): Promise<SavedAnswers> {
  const exam = await getExam(args.userId, args.examId);
  if (!exam) throw new HttpError(404, 'That exam was not found.');
  if (exam.status === 'completed') {
    throw new HttpError(409, 'This paper is already submitted.', 'already_submitted');
  }
  if (!exam.questions.some((q) => q.id === args.questionId)) {
    throw new HttpError(400, 'That question is not part of this paper.', 'unknown_question');
  }
  const clock = clockFor(exam);
  const flagged = args.flagged ?? false;
  if (clock.expired) {
    // Quieten the flag write but never accept an answer after the deadline.
    if (args.answer !== undefined) throw new HttpError(409, 'Time is up for this paper.', 'time_up');
    return getExamAnswers(args.examId);
  }

  const existing = await db.one<{ answer: string; flagged: number }>(
    'SELECT answer, flagged FROM exam_answers WHERE exam_id = ? AND question_id = ?',
    [args.examId, args.questionId],
  );
  const answer = args.answer !== undefined ? args.answer.slice(0, 4000) : (existing?.answer ?? '');
  const flagValue = args.flagged !== undefined ? (flagged ? 1 : 0) : (existing?.flagged ?? 0);
  const updatedAt = nowIso();

  if (existing) {
    await db.run('UPDATE exam_answers SET answer = ?, flagged = ?, updated_at = ? WHERE exam_id = ? AND question_id = ?', [
      answer,
      flagValue,
      updatedAt,
      args.examId,
      args.questionId,
    ]);
  } else {
    await db.run(
      'INSERT INTO exam_answers (exam_id, question_id, answer, flagged, updated_at) VALUES (?, ?, ?, ?, ?)',
      [args.examId, args.questionId, answer, flagValue, updatedAt],
    );
  }
  return getExamAnswers(args.examId);
}

export interface SubmitArgs {
  userId: string;
  examId: string;
  answers: { questionId: string; answer: string; timeMs?: number }[];
  timeSpentMs: number;
}

export async function submitExam(args: SubmitArgs): Promise<ExamResult> {
  const exam = await getExam(args.userId, args.examId);
  if (!exam) throw new HttpError(404, 'That exam was not found.');

  /*
   * First submission wins.
   *
   * A second submit (double-tap, a refresh mid-request, or the auto-submit racing a manual one) used
   * to insert another `exam_results` row AND re-run the per-question loop, which recorded every topic
   * result again. That silently double-counted correct answers in `topic_stats`, so weak-area
   * diagnosis drifted upward the more times a paper was submitted.
   */
  if (exam.status === 'completed') {
    const previous = await db.one<{ id: string }>(
      'SELECT id FROM exam_results WHERE exam_id = ? AND user_id = ? ORDER BY created_at ASC LIMIT 1',
      [args.examId, args.userId],
    );
    throw new HttpError(
      409,
      'This paper is already submitted.',
      'already_submitted',
      previous ? { resultId: previous.id } : undefined,
      'Open the result you already have — submitting again would not change it.',
    );
  }

  // Anything the student typed that never made it through an autosave is still honoured, so a
  // request that races the autosave cannot silently drop the last answer.
  const saved = await getExamAnswers(args.examId);
  const submittedMap = new Map(args.answers.map((a) => [a.questionId, a.answer]));

  const perQuestion: ExamResult['answers'] = [];
  const topicMap = new Map<string, { correct: number; total: number }>();
  let correct = 0;

  for (const question of exam.questions) {
    const submitted = args.answers.find((a) => a.questionId === question.id);
    const answer = String(submittedMap.get(question.id) ?? saved.answers[question.id] ?? '').slice(0, 4000);
    const feedback = await gradeQuestion({
      userId: args.userId,
      question,
      answer,
      subject: exam.subject,
      chapter: exam.chapters[0] ?? null,
    });
    if (feedback.isCorrect) correct += 1;
    perQuestion.push({ questionId: question.id, answer, isCorrect: feedback.isCorrect, timeMs: submitted?.timeMs ?? 0 });

    const entry = topicMap.get(question.topic) ?? { correct: 0, total: 0 };
    entry.total += 1;
    if (feedback.isCorrect) entry.correct += 1;
    topicMap.set(question.topic, entry);

    await recordTopicResult({
      userId: args.userId,
      subject: exam.subject,
      topic: question.topic,
      isCorrect: feedback.isCorrect,
    });
  }

  /*
   * The clock is the server's, not the browser's.
   *
   * `args.timeSpentMs` is kept only as a fallback for papers that predate the timing migration; for
   * anything started through the runner the elapsed time is derived from `started_at`, so a client
   * cannot report a flattering number. It is capped at the paper's own duration so a tab left open
   * overnight does not record a 14-hour attempt.
   */
  const clock = clockFor(exam);
  const derived = clock.startedAt
    ? Date.now() - Date.parse(clock.startedAt)
    : Math.max(0, Math.round(args.timeSpentMs));
  const timeSpentMs = Math.max(0, Math.min(Math.round(derived), clock.durationMs + 60_000));

  const total = exam.questions.length;
  const accuracy = total ? Math.round((correct / total) * 1000) / 1000 : 0;
  const score = Math.round((correct / Math.max(total, 1)) * 100);

  const perTopic = [...topicMap.entries()].map(([topic, v]) => ({ topic, correct: v.correct, total: v.total }));
  const weakFromExam = perTopic.filter((t) => t.correct / t.total < 0.7).map((t) => t.topic);
  const strongFromExam = perTopic.filter((t) => t.correct / t.total >= 0.8).map((t) => t.topic);

  const stats = await listTopicStats(args.userId);
  const { weak: weakOverall, strong: strongOverall } = classifyTopics(stats);

  let analysis: { summary: string; weakTopics: string[]; strongTopics: string[]; recommendedRevision: string[] } = {
    summary: '',
    weakTopics: [],
    strongTopics: [],
    recommendedRevision: [],
  };

  try {
    const ctx = await promptContextFor(args.userId, exam.subject, exam.chapters[0]);
    const { data } = await completeJson<typeof analysis>({
      userId: args.userId,
      task: 'exam',
      system: examAnalysisSystem(ctx),
      temperature: 0.5,
      maxTokens: 900,
      messages: [
        {
          role: 'user',
          content: [
            `Exam: ${exam.title} (${exam.subject}, ${exam.difficulty})`,
            `Chapters: ${exam.chapters.join(', ') || 'mixed'}`,
            `Score: ${correct}/${total}`,
            'Per-question results:',
            ...perQuestion.map((a) => {
              const q = exam.questions.find((x) => x.id === a.questionId)!;
              return `- [${a.isCorrect ? 'correct' : 'wrong'}] ${q.topic} (${q.type}) — ${q.prompt.slice(0, 160)}`;
            }),
          ].join('\n'),
        },
      ],
    });
    analysis = {
      summary: String(data.summary ?? ''),
      weakTopics: Array.isArray(data.weakTopics) ? data.weakTopics.map(String).slice(0, 8) : [],
      strongTopics: Array.isArray(data.strongTopics) ? data.strongTopics.map(String).slice(0, 8) : [],
      recommendedRevision: Array.isArray(data.recommendedRevision) ? data.recommendedRevision.map(String).slice(0, 8) : [],
    };
  } catch {
    analysis = {
      summary: `You scored ${correct} of ${total} on ${exam.subject}.`,
      weakTopics: weakFromExam,
      strongTopics: strongFromExam,
      recommendedRevision: weakFromExam.slice(0, 4).map((t) => `Revise ${t} and attempt 5 fresh questions on it.`),
    };
  }

  if (!analysis.weakTopics.length) analysis.weakTopics = weakFromExam.length ? weakFromExam : weakOverall.map((w) => w.topic);
  if (!analysis.strongTopics.length) analysis.strongTopics = strongFromExam.length ? strongFromExam : strongOverall.map((s) => s.topic);
  if (!analysis.recommendedRevision.length) {
    analysis.recommendedRevision = analysis.weakTopics
      .slice(0, 4)
      .map((t) => `Practise 5 ${t} questions in Practice, then re-attempt this exam.`);
  }
  if (!analysis.summary) analysis.summary = `You scored ${correct} of ${total} on ${exam.subject}.`;

  const id = uuid();
  const createdAt = nowIso();
  await db.run(
    `INSERT INTO exam_results
       (id, user_id, exam_id, score, total, correct, accuracy, time_spent_ms, answers, weak_topics, strong_topics, analysis, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      args.userId,
      args.examId,
      score,
      total,
      correct,
      accuracy,
      timeSpentMs,
      JSON.stringify(perQuestion),
      JSON.stringify(analysis.weakTopics),
      JSON.stringify(analysis.strongTopics),
      JSON.stringify({ summary: analysis.summary, recommendedRevision: analysis.recommendedRevision, perTopic }),
      createdAt,
    ],
  );
  await db.run("UPDATE exams SET status = 'completed', completed_at = ? WHERE id = ?", [createdAt, args.examId]);
  // The answers now live inside the immutable result row; the working copy is no longer needed.
  await db.run('DELETE FROM exam_answers WHERE exam_id = ?', [args.examId]);

  await recordActivity({
    userId: args.userId,
    kind: 'exam',
    subject: exam.subject,
    topic: exam.chapters.join(', ') || null,
    durationMs: timeSpentMs,
    correct,
    total,
    label: `${exam.title}: ${correct}/${total}`,
    meta: { examId: args.examId, resultId: id, weakTopics: analysis.weakTopics },
  });

  return {
    id,
    examId: args.examId,
    score,
    total,
    correct,
    accuracy,
    timeSpentMs,
    weakTopics: analysis.weakTopics,
    strongTopics: analysis.strongTopics,
    recommendedRevision: analysis.recommendedRevision,
    perTopic,
    summary: analysis.summary,
    createdAt,
    answers: perQuestion,
  };
}

export async function listResults(userId: string, limit = 20): Promise<ExamResult[]> {
  const rows = await db.all<{
    id: string;
    exam_id: string;
    score: number;
    total: number;
    correct: number;
    accuracy: number;
    time_spent_ms: number;
    answers: string;
    weak_topics: string | null;
    strong_topics: string | null;
    analysis: string | null;
    created_at: string;
  }>('SELECT * FROM exam_results WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);

  return rows.map((r) => {
    const analysis = db.json<{ summary?: string; recommendedRevision?: string[]; perTopic?: ExamAnalysis['perTopic'] }>(r.analysis, {});
    return {
      id: r.id,
      examId: r.exam_id,
      score: Number(r.score),
      total: Number(r.total),
      correct: Number(r.correct),
      accuracy: Number(r.accuracy),
      timeSpentMs: Number(r.time_spent_ms),
      weakTopics: db.json<string[]>(r.weak_topics, []),
      strongTopics: db.json<string[]>(r.strong_topics, []),
      recommendedRevision: analysis.recommendedRevision ?? [],
      perTopic: analysis.perTopic ?? [],
      summary: analysis.summary ?? '',
      createdAt: r.created_at,
      answers: db.json<ExamResult['answers']>(r.answers, []),
    };
  });
}

export async function getResult(userId: string, resultId: string): Promise<ExamResult | null> {
  const results = await listResults(userId, 200);
  return results.find((r) => r.id === resultId) ?? null;
}
