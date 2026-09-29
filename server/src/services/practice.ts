/**
 * Practice service — question generation, answer checking, attempt history.
 * Question generation and grading both go through the AI router, so any provider can serve them
 * and the fallback chain still applies when a key fails mid-session.
 */
import * as db from '../db/index.js';
import { nowIso, uuid } from '../db/index.js';
import { completeJson } from './ai/router.js';
import { gradingSystem, practiceIntroUser } from './ai/prompts.js';
import { questionGenSystem } from './ai/prompts.js';
import { demoQuestions, gradeLocally } from './ai/demoBank.js';
import { promptContextFor } from './tutor.js';
import { recordActivity, recordTopicResult } from './activity.js';
import type {
  AttemptFeedback,
  PracticeAttempt,
  PracticeQuestion,
  PracticeSet,
  QuestionType,
  QuestionTypeChoice,
} from '../types/domain.js';

interface SetRow {
  id: string;
  subject: string;
  chapter: string | null;
  difficulty: string;
  question_type: string;
  questions: string;
  source_kind: string;
  created_at: string;
}

export const SUBJECTS = [
  'Physics',
  'Chemistry',
  'Biology',
  'Mathematics',
  'Computer Science',
  'English',
  'Social Science',
  'General Knowledge',
];

export const CHAPTER_SUGGESTIONS: Record<string, string[]> = {
  Physics: ['Motion', 'Force and Laws of Motion', 'Gravitation', 'Work Energy and Power', 'Light', 'Electricity', 'Magnetism'],
  Chemistry: ['Matter', 'Atoms and Molecules', 'Chemical Reactions', 'Acids Bases and Salts', 'Metals and Non-metals', 'Carbon Compounds'],
  Biology: ['Cell Structure', 'Photosynthesis', 'Life Processes', 'Control and Coordination', 'Heredity', 'Ecosystem'],
  Mathematics: ['Linear Equations', 'Quadratic Equations', 'Arithmetic Progressions', 'Trigonometry', 'Geometry', 'Statistics', 'Probability'],
  'Computer Science': ['Programming Basics', 'Loops and Logic', 'Arrays and Strings', 'Functions', 'HTML and CSS', 'JavaScript DOM'],
  English: ['Reading Comprehension', 'Grammar', 'Tenses', 'Writing Skills', 'Literature'],
  'Social Science': ['Nationalism in India', 'Resources', 'Democracy', 'Federalism', 'Nationalism in Europe', 'Globalisation'],
  'General Knowledge': ['Current Affairs', 'Science and Technology', 'Sports', 'Geography'],
};

function normaliseQuestion(raw: Record<string, unknown>, index: number): PracticeQuestion | null {
  const prompt = String(raw.prompt ?? raw.question ?? '').trim();
  if (!prompt) return null;
  const type = String(raw.type ?? 'short').toLowerCase();
  const allowed: QuestionType[] = ['mcq', 'short', 'numerical', 'conceptual'];
  const options = Array.isArray(raw.options) ? raw.options.map((o) => String(o)).slice(0, 6) : undefined;
  const steps = Array.isArray(raw.steps) ? raw.steps.map((s) => String(s)).filter(Boolean).slice(0, 10) : undefined;
  return {
    id: String(raw.id ?? `q${index + 1}`).slice(0, 24),
    topic: String(raw.topic ?? 'General').slice(0, 90),
    type: (allowed.includes(type as QuestionType) ? type : 'short') as QuestionType,
    prompt,
    options: options && options.length >= 2 ? options : undefined,
    answer: String(raw.answer ?? '').trim() || 'See explanation',
    explanation: String(raw.explanation ?? '').trim(),
    steps,
    marks: Number(raw.marks ?? (type === 'numerical' ? 3 : 1)) || 1,
    hint: raw.hint ? String(raw.hint).slice(0, 200) : undefined,
  };
}

export interface GenerateArgs {
  userId: string;
  subject: string;
  chapter?: string;
  difficulty: 'easy' | 'medium' | 'hard';
  questionType: QuestionType | 'mixed';
  count: number;
}

export async function generateSet(args: GenerateArgs): Promise<{ set: PracticeSet; degraded?: string }> {
  const count = Math.min(Math.max(args.count, 1), 20);
  const ctx = await promptContextFor(args.userId, args.subject, args.chapter);

  const system = questionGenSystem(ctx, {
    count,
    type: args.questionType,
    difficulty: args.difficulty,
    subject: args.subject,
    chapter: args.chapter,
    includeSteps: args.questionType === 'numerical' || args.questionType === 'mixed',
  });

  let questions: PracticeQuestion[] = [];
  let degraded: string | undefined;

  try {
    const { data, summary } = await completeJson<{ questions: Record<string, unknown>[] }>({
      userId: args.userId,
      task: 'practice',
      system,
      messages: [
        {
          role: 'user',
          content: practiceIntroUser({
            count,
            type: args.questionType,
            difficulty: args.difficulty,
            subject: args.subject,
            chapter: args.chapter,
          }),
        },
      ],
      temperature: 0.7,
      maxTokens: 3200,
    });
    questions = (data.questions ?? []).map(normaliseQuestion).filter((q): q is PracticeQuestion => Boolean(q));
    if (summary.demo && !questions.length) throw new Error('demo-empty');
    if (!questions.length) throw new Error('no questions returned');
    if (questions.length < count) degraded = `The model returned ${questions.length} of ${count} questions.`;
    if (summary.demo) degraded = 'Sample questions (no AI key connected yet).';
  } catch (err) {
    // Never leave a blank practice screen: fall back to the built-in bank.
    degraded =
      degraded ??
      'Could not reach a model just now — here is a verified set from the built-in question bank.';
    questions = demoQuestions({
      subject: args.subject,
      chapter: args.chapter,
      count,
      type: args.questionType,
    });
  }

  const id = uuid();
  const createdAt = nowIso();
  await db.run(
    `INSERT INTO practice_sets (id, user_id, subject, chapter, difficulty, question_type, questions, source_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      args.userId,
      args.subject,
      args.chapter ?? null,
      args.difficulty,
      args.questionType,
      JSON.stringify(questions),
      degraded ? 'demo' : 'generated',
      createdAt,
    ],
  );

  await recordActivity({
    userId: args.userId,
    kind: 'practice',
    subject: args.subject,
    topic: args.chapter ?? null,
    label: `Started a ${args.difficulty} ${args.subject} practice set (${questions.length} questions)`,
    meta: { setId: id, questionType: args.questionType },
  });

  return {
    set: {
      id,
      subject: args.subject,
      chapter: args.chapter ?? null,
      difficulty: args.difficulty,
      questionType: args.questionType,
      questions,
      sourceKind: degraded ? 'demo' : 'generated',
      createdAt,
    },
    degraded,
  };
}

export async function getSet(userId: string, setId: string): Promise<PracticeSet | null> {
  const row = await db.one<SetRow>('SELECT * FROM practice_sets WHERE id = ? AND user_id = ?', [setId, userId]);
  if (!row) return null;
  return {
    id: row.id,
    subject: row.subject,
    chapter: row.chapter,
    difficulty: row.difficulty,
    questionType: row.question_type as QuestionTypeChoice,
    questions: db.json<PracticeQuestion[]>(row.questions, []),
    sourceKind: row.source_kind as PracticeSet['sourceKind'],
    createdAt: row.created_at,
  };
}

export async function listSets(userId: string, limit = 20): Promise<PracticeSet[]> {
  const rows = await db.all<SetRow>(
    'SELECT * FROM practice_sets WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [userId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    chapter: row.chapter,
    difficulty: row.difficulty,
    questionType: row.question_type as QuestionTypeChoice,
    questions: db.json<PracticeQuestion[]>(row.questions, []),
    sourceKind: row.source_kind as PracticeSet['sourceKind'],
    createdAt: row.created_at,
  }));
}

export interface CheckAnswerArgs {
  userId: string;
  setId: string;
  questionId: string;
  answer: string;
  skipped?: boolean;
  timeSpentMs: number;
}

/**
 * Checks one answer. Objective question types are graded locally first (fast + free), and the
 * AI grader is used for anything that needs judgement (short answers, conceptual explanations,
 * or a numerically close-but-not-exact response).
 */
export async function checkAnswer(args: CheckAnswerArgs): Promise<AttemptFeedback> {
  const set = await getSet(args.userId, args.setId);
  if (!set) throw new Error('Practice set not found');
  const question = set.questions.find((q) => q.id === args.questionId);
  if (!question) throw new Error('Question not found');

  const studentAnswer = args.answer.trim();
  let feedback: AttemptFeedback;

  if (args.skipped || !studentAnswer) {
    feedback = {
      isCorrect: false,
      verdict: 'Skipped',
      explanation: question.explanation || 'Try this one again after revising the topic.',
      steps: question.steps,
      correctAnswer: question.answer,
      topic: question.topic,
    };
  } else {
    const local = gradeLocally(question, studentAnswer);
    const needsAI = question.type === 'short' || question.type === 'conceptual' || !local.isCorrect;

    if (needsAI && !question.id.startsWith('demo-')) {
      const ctx = await promptContextFor(args.userId, set.subject, set.chapter ?? undefined);
      try {
        const { data, summary } = await completeJson<{ isCorrect?: boolean; verdict?: string; explanation?: string; steps?: string[] }>({
          userId: args.userId,
          task: 'grading',
          system: gradingSystem(ctx),
          maxTokens: 700,
          temperature: 0.2,
          messages: [
            {
              role: 'user',
              content: [
                `Subject: ${set.subject}${set.chapter ? ` · ${set.chapter}` : ''}`,
                `Question (${question.type}): ${question.prompt}`,
                question.options ? `Options: ${question.options.join(' | ')}` : '',
                `Model answer: ${question.answer}`,
                `Student answer: ${studentAnswer}`,
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        });
        const isCorrect = Boolean(data.isCorrect);
        feedback = {
          isCorrect,
          verdict: String(data.verdict ?? (isCorrect ? 'Correct' : 'Not quite')).slice(0, 60),
          explanation: String(data.explanation ?? question.explanation),
          steps: Array.isArray(data.steps) ? data.steps.map(String).slice(0, 8) : question.steps,
          correctAnswer: question.answer,
          topic: question.topic,
        };
        if (summary.demo) feedback.explanation ||= question.explanation;
      } catch {
        feedback = {
          isCorrect: local.isCorrect,
          verdict: local.verdict,
          explanation: local.explanation || question.explanation,
          steps: local.steps ?? question.steps,
          correctAnswer: question.answer,
          topic: question.topic,
        };
      }
    } else {
      feedback = {
        isCorrect: local.isCorrect,
        verdict: local.verdict,
        explanation: local.explanation || question.explanation,
        steps: local.steps ?? question.steps,
        correctAnswer: question.answer,
        topic: question.topic,
      };
    }
  }

  const id = uuid();
  const createdAt = nowIso();
  await db.run(
    `INSERT INTO practice_attempts
       (id, user_id, set_id, question_id, topic, subject, difficulty, answer, is_correct, skipped, feedback, time_spent_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      args.userId,
      args.setId,
      args.questionId,
      question.topic,
      set.subject,
      set.difficulty,
      studentAnswer,
      feedback.isCorrect ? 1 : 0,
      args.skipped ? 1 : 0,
      JSON.stringify(feedback),
      Math.max(0, Math.round(args.timeSpentMs)),
      createdAt,
    ],
  );

  await recordTopicResult({
    userId: args.userId,
    subject: set.subject,
    topic: question.topic,
    isCorrect: feedback.isCorrect,
  });

  if (args.skipped) {
    await recordActivity({
      userId: args.userId,
      kind: 'practice',
      subject: set.subject,
      topic: question.topic,
      durationMs: args.timeSpentMs,
      correct: 0,
      total: 1,
      label: `Skipped: ${question.topic}`,
    });
  } else {
    await recordActivity({
      userId: args.userId,
      kind: 'practice',
      subject: set.subject,
      topic: question.topic,
      durationMs: args.timeSpentMs,
      correct: feedback.isCorrect ? 1 : 0,
      total: 1,
      label: `${feedback.isCorrect ? 'Correct' : 'Incorrect'} · ${question.topic}`,
    });
  }

  return feedback;
}

export async function listAttempts(userId: string, limit = 60): Promise<PracticeAttempt[]> {
  const rows = await db.all<{
    id: string;
    set_id: string;
    question_id: string;
    topic: string | null;
    subject: string | null;
    difficulty: string | null;
    answer: string | null;
    is_correct: number;
    skipped: number;
    feedback: string | null;
    time_spent_ms: number;
    created_at: string;
  }>('SELECT * FROM practice_attempts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);

  return rows.map((r) => ({
    id: r.id,
    setId: r.set_id,
    questionId: r.question_id,
    topic: r.topic,
    subject: r.subject,
    difficulty: r.difficulty,
    answer: r.answer,
    isCorrect: r.is_correct === 1,
    skipped: r.skipped === 1,
    feedback: db.json<AttemptFeedback | null>(r.feedback, null),
    timeSpentMs: Number(r.time_spent_ms ?? 0),
    createdAt: r.created_at,
  }));
}

/** Called by the exam service so exam questions reuse the same grading path. */
export async function gradeQuestion(args: {
  userId: string;
  question: PracticeQuestion;
  answer: string;
  subject: string;
  chapter?: string | null;
}): Promise<AttemptFeedback> {
  const local = gradeLocally(args.question, args.answer);
  if (args.answer.trim() && (args.question.type === 'mcq' || args.question.type === 'numerical') && local.isCorrect) {
    return {
      isCorrect: true,
      verdict: 'Correct',
      explanation: args.question.explanation,
      steps: args.question.steps,
      correctAnswer: args.question.answer,
      topic: args.question.topic,
    };
  }
  const ctx = await promptContextFor(args.userId, args.subject, args.chapter ?? undefined);
  try {
    const { data } = await completeJson<{ isCorrect?: boolean; verdict?: string; explanation?: string; steps?: string[] }>({
      userId: args.userId,
      task: 'grading',
      system: gradingSystem(ctx),
      maxTokens: 600,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          content: [
            `Subject: ${args.subject}`,
            `Question: ${args.question.prompt}`,
            args.question.options ? `Options: ${args.question.options.join(' | ')}` : '',
            `Model answer: ${args.question.answer}`,
            `Student answer: ${args.answer.trim() || '(left blank)'}`,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });
    return {
      isCorrect: Boolean(data.isCorrect),
      verdict: String(data.verdict ?? 'Checked'),
      explanation: String(data.explanation ?? args.question.explanation),
      steps: Array.isArray(data.steps) ? data.steps.map(String).slice(0, 8) : args.question.steps,
      correctAnswer: args.question.answer,
      topic: args.question.topic,
    };
  } catch {
    return {
      isCorrect: local.isCorrect,
      verdict: local.verdict,
      explanation: args.question.explanation,
      steps: args.question.steps,
      correctAnswer: args.question.answer,
      topic: args.question.topic,
    };
  }
}
