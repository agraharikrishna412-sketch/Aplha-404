/** Practice API — generate sets, check answers, review attempts. */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, HttpError, parseBody } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { limits } from '../middleware/rateLimit.js';
import { CHAPTER_SUGGESTIONS, SUBJECTS, checkAnswer, generateSet, getSet, listAttempts, listSets } from '../services/practice.js';
import { listTopicStats } from '../services/activity.js';
import { getSettings } from '../services/settings.js';
import type { PracticeQuestion, PracticeSet } from '../types/domain.js';

export const practiceRouter = Router();
practiceRouter.use(requireAuth);

/**
 * Removes the answer key from a practice set before it is sent to the browser.
 *
 * `POST /practice/generate` used to return every question complete with `answer`, `explanation` and
 * the worked `steps`. A student could open DevTools and read the whole key before attempting
 * anything, which defeats the point of Practice — and the client never needs those fields, because
 * it renders the explanation from the `/practice/check` response *after* an answer is submitted.
 *
 * `hint` is deliberately kept: it is a nudge shown on request, not the answer. The Mock Exam runner
 * and the Arena runner already strip the same fields, so this brings Practice in line with them.
 */
function withoutAnswerKey(set: PracticeSet): PracticeSet {
  return {
    ...set,
    questions: set.questions.map((question): PracticeQuestion => ({
      ...question,
      answer: '',
      explanation: '',
      steps: undefined,
    })),
  };
}

practiceRouter.get('/catalog', asyncRoute(async (req, res) => {
  const [settings, topics] = await Promise.all([getSettings(req.user!.id), listTopicStats(req.user!.id)]);
  res.json({
    subjects: SUBJECTS,
    chapters: CHAPTER_SUGGESTIONS,
    difficulty: [
      { id: 'easy', label: 'Easy', hint: 'One step, direct recall' },
      { id: 'medium', label: 'Medium', hint: 'Two steps or a small trap' },
      { id: 'hard', label: 'Hard', hint: 'Multi-step, exam level' },
    ],
    questionTypes: [
      { id: 'mcq', label: 'MCQ' },
      { id: 'short', label: 'Short answer' },
      { id: 'numerical', label: 'Numerical' },
      { id: 'conceptual', label: 'Conceptual' },
      { id: 'mixed', label: 'Mixed' },
    ],
    defaults: settings.subjectDefaults,
    weakTopics: topics.filter((t) => t.attempted >= 2 && t.correct / t.attempted < 0.7).slice(0, 6),
  });
}));

const generateSchema = z.object({
  subject: z.string().trim().min(1).max(60),
  chapter: z.string().trim().max(80).optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  questionType: z.enum(['mcq', 'short', 'numerical', 'conceptual', 'mixed']),
  count: z.number().int().min(1).max(20),
});

practiceRouter.post(
  '/generate',
  limits.ai(),
  asyncRoute(async (req, res) => {
    const body = parseBody(generateSchema, req.body);
    const result = await generateSet({ userId: req.user!.id, ...body });
    res.status(201).json({ ...result, set: withoutAnswerKey(result.set) });
  }),
);

practiceRouter.get(
  '/sets',
  asyncRoute(async (req, res) => {
    const sets = await listSets(req.user!.id, 25);
    res.json({ sets: sets.map((s) => ({ ...s, questions: s.questions.length })) });
  }),
);

practiceRouter.get(
  '/sets/:id',
  asyncRoute(async (req, res) => {
    const set = await getSet(req.user!.id, req.params.id);
    if (!set) throw new HttpError(404, 'That practice set was not found.');
    res.json({ set: withoutAnswerKey(set) });
  }),
);

const checkSchema = z.object({
  setId: z.string().trim().min(1),
  questionId: z.string().trim().min(1),
  answer: z.string().max(4000).default(''),
  skipped: z.boolean().optional(),
  timeSpentMs: z.number().int().min(0).max(3_600_000).default(0),
});

practiceRouter.post(
  '/check',
  limits.ai(),
  asyncRoute(async (req, res) => {
    const body = parseBody(checkSchema, req.body);
    const feedback = await checkAnswer({ userId: req.user!.id, ...body });
    res.json({ feedback });
  }),
);

practiceRouter.get(
  '/attempts',
  asyncRoute(async (req, res) => {
    res.json({ attempts: await listAttempts(req.user!.id, 60) });
  }),
);
