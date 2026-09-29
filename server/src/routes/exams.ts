/** Mock Exam API — generate an exam, submit it, read the analysis. */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, HttpError, parseBody } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { limits } from '../middleware/rateLimit.js';
import { integrityFor, recordSignals, SIGNAL_KINDS } from '../services/arena/proctor.js';
import {
  clockFor,
  createExam,
  deleteExam,
  getExamAnswers,
  getResult,
  listExams,
  listResults,
  openExam,
  saveExamAnswer,
  submitExam,
} from '../services/exams.js';

export const examsRouter = Router();
examsRouter.use(requireAuth);

const createSchema = z.object({
  subject: z.string().trim().min(1).max(60),
  chapters: z.array(z.string().trim().max(80)).max(8).default([]),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  questionCount: z.number().int().min(1).max(40),
  questionType: z.enum(['mcq', 'short', 'numerical', 'conceptual', 'mixed']),
  durationMin: z.number().int().min(5).max(180),
  title: z.string().trim().max(140).optional(),
});

examsRouter.post(
  '/',
  limits.ai(),
  asyncRoute(async (req, res) => {
    const body = parseBody(createSchema, req.body);
    const result = await createExam({ userId: req.user!.id, ...body });
    res.status(201).json(result);
  }),
);

examsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const [exams, results] = await Promise.all([listExams(req.user!.id, 30), listResults(req.user!.id, 10)]);
    res.json({
      exams: exams.map((e) => ({ ...e, questions: e.questions.length })),
      recentResults: results.map((r) => ({
        id: r.id,
        examId: r.examId,
        score: r.score,
        total: r.total,
        correct: r.correct,
        accuracy: r.accuracy,
        weakTopics: r.weakTopics,
        createdAt: r.createdAt,
        timeSpentMs: r.timeSpentMs,
      })),
    });
  }),
);

examsRouter.get(
  '/results',
  asyncRoute(async (req, res) => {
    res.json({ results: await listResults(req.user!.id, 30) });
  }),
);

examsRouter.get(
  '/results/:resultId',
  asyncRoute(async (req, res) => {
    const result = await getResult(req.user!.id, req.params.resultId);
    if (!result) throw new HttpError(404, 'That result was not found.');
    res.json({ result });
  }),
);

examsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    // Opening the paper starts the server-side clock (once) and hands back whatever was autosaved,
    // so a refresh resumes the attempt instead of restarting it.
    const exam = await openExam(req.user!.id, req.params.id);
    if (!exam) throw new HttpError(404, 'That exam was not found.');

    const [saved, clock] = [await getExamAnswers(exam.id), clockFor(exam)];
    // Answers are stripped while the exam is in progress so the UI cannot leak them.
    const questions =
      exam.status === 'completed'
        ? exam.questions
        : exam.questions.map(({ answer, explanation, steps, ...rest }) => ({ ...rest, answer: '', explanation: '', steps: undefined }));

    res.json({
      exam: {
        ...exam,
        questions,
        ...clock,
        savedAnswers: saved.answers,
        flagged: saved.flagged,
      },
    });
  }),
);

const answerSchema = z.object({
  questionId: z.string().trim().min(1).max(80),
  answer: z.string().max(4000).optional(),
  flagged: z.boolean().optional(),
});

/**
 * Autosave one answer (or one flag toggle).
 *
 * Answers are written here as the student works, so a refresh, a crash or a flat battery no longer
 * costs the whole attempt. `submitExam` still accepts a final payload and merges the two.
 */
examsRouter.post(
  '/:id/answers',
  asyncRoute(async (req, res) => {
    const body = parseBody(answerSchema, req.body);
    const saved = await saveExamAnswer({ userId: req.user!.id, examId: req.params.id, ...body });
    res.json(saved);
  }),
);

const submitSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().trim().min(1),
        answer: z.string().max(4000).default(''),
        timeMs: z.number().int().min(0).max(3_600_000).optional(),
      }),
    )
    .max(60),
  timeSpentMs: z.number().int().min(0).max(6 * 3_600_000),
});

examsRouter.post(
  '/:id/submit',
  limits.ai(),
  asyncRoute(async (req, res) => {
    const body = parseBody(submitSchema, req.body);
    const result = await submitExam({ userId: req.user!.id, examId: req.params.id, ...body });
    res.json({ result });
  }),
);

/* ------------------------------------------------------------------ */
/* Exam integrity                                                      */
/* ------------------------------------------------------------------ */

const signalsSchema = z.object({
  signals: z
    .array(
      z.object({
        kind: z.string().max(40),
        detail: z.string().max(300).optional(),
        at: z.string().max(40).optional(),
      }),
    )
    .max(60),
  device: z.string().max(200).optional(),
});

/**
 * Records what the mock-exam runner observed (§44).
 *
 * A personal mock exam has no host, so this record is for the student themselves: it appears on their
 * own result. The same mechanism and the same tables are used for Arena papers, keyed by scope.
 */
examsRouter.post(
  '/:id/signals',
  limits.proctor(),
  asyncRoute(async (req, res) => {
    const body = parseBody(signalsSchema, req.body ?? {});
    const result = await recordSignals({
      userId: req.user!.id,
      scope: 'exam',
      refId: req.params.id,
      signals: body.signals,
      device: body.device,
    });
    res.json({ ...result, kinds: SIGNAL_KINDS });
  }),
);

examsRouter.get(
  '/:id/integrity',
  asyncRoute(async (req, res) => {
    res.json({ report: await integrityFor(req.user!.id, 'exam', req.params.id) });
  }),
);

examsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    await deleteExam(req.user!.id, req.params.id);
    res.json({ ok: true });
  }),
);
