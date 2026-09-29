/**
 * Vroqn Arena API.
 *
 * Student surface (any signed-in user) plus a deliberately small admin surface for authoring,
 * reviewing and publishing competitions. Authentication and rate limiting reuse the existing
 * middleware; standings and benchmarks never expose other students' identity.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, HttpError, parseBody } from '../middleware/errors.js';
import { isAdmin, requireAdmin, requireAuth } from '../middleware/auth.js';
import { arenaAttemptId, competitionIntegrity, integrityFor, recordSignals, SIGNAL_KINDS } from '../services/arena/proctor.js';
import { limits } from '../middleware/rateLimit.js';
import { CHAPTER_SUGGESTIONS } from '../services/practice.js';
import {
  applyAdminAction,
  arenaCatalog,
  arenaOverview,
  blueprintForCompetition,
  blueprintView,
  createCompetition,
  deleteCompetition,
  getCompetition,
  listCompetitions,
  myCompetitions,
  register,
  updateSchedule,
  withdraw,
  type AdminAction,
} from '../services/arena/competitions.js';
import { normaliseBlueprint, totalQuestions } from '../services/arena/blueprint.js';
import {
  deleteQuestion,
  generatePaper,
  listQuestions,
  paperReadiness,
  paperTotals,
  reviewCounts,
  toQuestionRecord,
  updateQuestionReview,
} from '../services/arena/questions.js';
import { attemptStatus, saveAnswers, startAttempt } from '../services/arena/attempts.js';
import { assertCommunityPaperSealed } from '../services/communities/paper.js';
import {
  competitionHistory,
  generatePerformanceReport,
  getResultForUser,
  recalculateBenchmarks,
  submitAttempt,
} from '../services/arena/results.js';
import { promptContextFor } from '../services/tutor.js';

export const arenaRouter = Router();
arenaRouter.use(requireAuth);

/* ------------------------------------------------------------------ */
/* Catalogue + home                                                    */
/* ------------------------------------------------------------------ */

arenaRouter.get('/catalog', (_req, res) => {
  res.json(arenaCatalog());
});

/** Compact summary for the dashboard card. */
arenaRouter.get(
  '/overview',
  asyncRoute(async (req, res) => {
    const overview = await arenaOverview(req.user!.id);
    res.json(overview);
  }),
);

arenaRouter.get(
  '/competitions',
  asyncRoute(async (req, res) => {
    const includeDrafts = req.query.includeDrafts === 'true' && isAdmin(req.user);
    const competitions = await listCompetitions(req.user!.id, { includeUnpublished: includeDrafts });
    res.json({ competitions, serverNow: new Date().toISOString() });
  }),
);

arenaRouter.get(
  '/my-competitions',
  asyncRoute(async (req, res) => {
    const data = await myCompetitions(req.user!.id);
    res.json({ ...data, serverNow: new Date().toISOString() });
  }),
);

arenaRouter.get(
  '/history',
  asyncRoute(async (req, res) => {
    const history = await competitionHistory(req.user!.id, Number(req.query.limit ?? 30) || 30);
    res.json({ history });
  }),
);

/* ------------------------------------------------------------------ */
/* Admin (must be declared before /competitions/:id to avoid clashes)  */
/* ------------------------------------------------------------------ */

const scheduleSchema = z.object({
  title: z.string().trim().min(4).max(140),
  description: z.string().trim().min(10).max(1200),
  category: z.string().trim().min(2).max(60),
  blueprint: z.unknown(),
  registrationOpensAt: z.string().trim().min(4),
  registrationClosesAt: z.string().trim().min(4),
  startsAt: z.string().trim().min(4),
  endsAt: z.string().trim().min(4),
  difficulty: z.string().trim().max(20).optional(),
  rules: z.array(z.string().trim().max(400)).max(12).optional(),
  instructions: z.array(z.string().trim().max(400)).max(12).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  inviteCode: z.string().trim().min(4).max(24).optional(),
  isDemo: z.boolean().optional(),
  publish: z.boolean().optional(),
});

arenaRouter.get(
  '/admin/competitions',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const competitions = await listCompetitions(req.user!.id, { includeUnpublished: true, limit: 100 });
    // Readiness travels with each row so the console can say why a start is blocked.
    const withReadiness = await Promise.all(
      competitions.map(async (competition) => ({ ...competition, readiness: await paperReadiness(competition.id) })),
    );
    res.json({
      competitions: withReadiness,
      presets: (await import('../services/arena/blueprint.js')).BLUEPRINT_PRESETS,
      categories: arenaCatalog().categories,
    });
  }),
);

arenaRouter.post(
  '/admin/competitions',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const body = parseBody(scheduleSchema, req.body);
    const competition = await createCompetition({
      ...body,
      blueprint: normaliseBlueprint(body.blueprint),
      createdBy: req.user!.id,
    });
    res.status(201).json({ competition });
  }),
);

arenaRouter.patch(
  '/admin/competitions/:id',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const body = parseBody(scheduleSchema.partial(), req.body);
    await updateSchedule(req.params.id, body);
    const competition = await getCompetition(req.user!.id, req.params.id, { includeUnpublished: true });
    if (!competition) throw new HttpError(404, 'That competition was not found.', 'not_found');
    res.json({ competition });
  }),
);

const actionSchema = z.object({
  action: z.enum(['publish', 'open_registration', 'close_registration', 'start_now', 'close_submissions', 'publish_results', 'archive']),
  extendMinutes: z.number().int().min(0).max(120).optional(),
});

arenaRouter.post(
  '/admin/competitions/:id/action',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const body = parseBody(actionSchema, req.body);
    const outcome = await applyAdminAction(req.params.id, body.action as AdminAction, { extendMinutes: body.extendMinutes });
    let recalculated = 0;
    if (body.action === 'publish_results') recalculated = await recalculateBenchmarks(req.params.id);
    // Keep the stored duration in step with any extension granted at start time.
    const competition = await getCompetition(req.user!.id, req.params.id, { includeUnpublished: true });
    res.json({ ...outcome, recalculated, competition });
  }),
);

const generateSchema = z.object({
  bankOnly: z.boolean().optional(),
  replace: z.boolean().optional().default(true),
  /** Explicitly regenerate a paper that is locked because the competition already ran. */
  force: z.boolean().optional().default(false),
});

arenaRouter.post(
  '/admin/competitions/:id/generate',
  requireAdmin,
  limits.ai(),
  asyncRoute(async (req, res) => {
    const body = parseBody(generateSchema, req.body);
    const blueprint = await blueprintForCompetition(req.params.id);
    if (!blueprint) throw new HttpError(404, 'That competition was not found.', 'not_found');
    const ctx = await promptContextFor(req.user!.id, blueprint.subjects[0]?.subject);
    const outcome = await generatePaper({
      userId: req.user!.id,
      competitionId: req.params.id,
      blueprint,
      ctx,
      bankOnly: body.bankOnly,
      replace: body.replace,
      force: body.force,
    });
    const totals = await paperTotals(req.params.id);
    res.status(201).json({
      ...outcome,
      totals,
      review: await reviewCounts(req.params.id),
      readiness: await paperReadiness(req.params.id),
    });
  }),
);

arenaRouter.delete(
  '/admin/competitions/:id',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const outcome = await deleteCompetition(req.params.id);
    if (!outcome.deleted) {
      if (outcome.reason === 'not_found') throw new HttpError(404, 'That competition was not found.', 'not_found');
      throw new HttpError(
        409,
        'This competition already has student attempts, so it cannot be deleted — archive it instead.',
        'has_attempts',
      );
    }
    res.json({ ok: true, deleted: true });
  }),
);

arenaRouter.get(
  '/admin/competitions/:id/questions',
  requireAdmin,
  asyncRoute(async (req, res) => {
    /* A community's paper is sealed to everyone, operators included, until its window ends. */
    await assertCommunityPaperSealed(req.params.id);
    const rows = await listQuestions(req.params.id);
    res.json({
      questions: rows.map(toQuestionRecord),
      review: await reviewCounts(req.params.id),
      readiness: await paperReadiness(req.params.id),
    });
  }),
);

const reviewSchema = z.object({
  reviewStatus: z.enum(['pending', 'approved', 'flagged', 'rejected']).optional(),
  prompt: z.string().trim().min(5).max(900).optional(),
  answer: z.string().trim().min(1).max(200).optional(),
  explanation: z.string().trim().min(1).max(1200).optional(),
  options: z.array(z.string().trim().min(1).max(200)).length(4).optional(),
});

arenaRouter.patch(
  '/admin/questions/:questionId',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const body = parseBody(reviewSchema, req.body);
    const competitionId = String(req.query.competitionId ?? '');
    if (!competitionId) throw new HttpError(400, 'competitionId query parameter is required.', 'bad_request');
    await assertCommunityPaperSealed(competitionId);
    const ok = await updateQuestionReview(competitionId, req.params.questionId, body);
    if (!ok) throw new HttpError(404, 'That question was not found.', 'not_found');
    res.json({ ok: true, review: await reviewCounts(competitionId) });
  }),
);

arenaRouter.delete(
  '/admin/questions/:questionId',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const competitionId = String(req.query.competitionId ?? '');
    if (!competitionId) throw new HttpError(400, 'competitionId query parameter is required.', 'bad_request');
    await assertCommunityPaperSealed(competitionId);
    const ok = await deleteQuestion(competitionId, req.params.questionId);
    if (!ok) throw new HttpError(404, 'That question was not found.', 'not_found');
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ */
/* Competition details + registration                                  */
/* ------------------------------------------------------------------ */

arenaRouter.get(
  '/competitions/:id',
  asyncRoute(async (req, res) => {
    const competition = await getCompetition(req.user!.id, req.params.id, { includeUnpublished: isAdmin(req.user) });
    if (!competition) throw new HttpError(404, 'That competition was not found.', 'not_found');
    const totals = isAdmin(req.user) ? await paperTotals(competition.id) : null;
    const blueprint = await blueprintForCompetition(competition.id);
    res.json({
      competition,
      blueprint: blueprint ? blueprintView(blueprint) : null,
      questionCount: blueprint ? totalQuestions(blueprint) : competition.questionCount,
      paper: totals,
    });
  }),
);

const registerSchema = z.object({ inviteCode: z.string().trim().max(24).optional() });

arenaRouter.post(
  '/competitions/:id/register',
  asyncRoute(async (req, res) => {
    const body = parseBody(registerSchema, req.body);
    const outcome = await register(req.user!.id, req.params.id, { inviteCode: body.inviteCode });
    res.status(outcome.alreadyRegistered ? 200 : 201).json({
      registration: outcome,
      message: outcome.alreadyRegistered ? 'You are registered.' : 'You are registered. Good luck!',
    });
  }),
);

arenaRouter.delete(
  '/competitions/:id/register',
  asyncRoute(async (req, res) => {
    await withdraw(req.user!.id, req.params.id);
    res.json({ ok: true, message: 'Your registration was withdrawn.' });
  }),
);

arenaRouter.get(
  '/competitions/:id/status',
  asyncRoute(async (req, res) => {
    const status = await attemptStatus(req.user!.id, req.params.id);
    res.json({
      state: status.state,
      serverNow: status.now,
      remainingSeconds: status.remainingSeconds,
      canAnswer: status.canAnswer,
      expired: status.expired,
      closedReason: status.closedReason,
      attempt: status.attempt
        ? {
            id: status.attempt.id,
            status: status.attempt.status,
            startedAt: status.attempt.started_at,
            deadlineAt: status.attempt.deadline_at,
            submittedAt: status.attempt.submitted_at,
            autoSubmitted: status.attempt.auto_submitted === 1,
          }
        : null,
    });
  }),
);

/* ------------------------------------------------------------------ */
/* Exam attempt                                                        */
/* ------------------------------------------------------------------ */

const driftSchema = z.object({ clientClockMs: z.number().optional() });

arenaRouter.post(
  '/competitions/:id/start',
  asyncRoute(async (req, res) => {
    const body = parseBody(driftSchema, req.body ?? {});
    // Recorded only for diagnostics — timing is decided by the server regardless.
    const drift = body.clientClockMs ? Math.abs(Date.now() - body.clientClockMs) : 0;
    const payload = await startAttempt(req.user!.id, req.params.id, { clockDriftMs: drift });
    res.status(201).json({ exam: payload });
  }),
);

const answersSchema = z.object({
  updates: z
    .array(
      z.object({
        questionId: z.string().trim().min(1),
        answer: z.string().max(600).optional(),
        flagged: z.boolean().optional(),
        timeSpentMs: z.number().int().min(0).max(86_400_000).optional(),
      }),
    )
    .min(1)
    .max(120),
});

arenaRouter.post(
  '/competitions/:id/answers',
  asyncRoute(async (req, res) => {
    const body = parseBody(answersSchema, req.body);
    const outcome = await saveAnswers({ userId: req.user!.id, competitionId: req.params.id, updates: body.updates });
    res.json(outcome);
  }),
);

/* ------------------------------------------------------------------ */
/* Exam integrity signals                                              */
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
 * Records what the runner observed during the paper (§44).
 *
 * This is deliberately a low-friction, batched endpoint: the runner sends groups of signals every few
 * seconds, and a lost batch is not a failure of the paper. It never gates answering or submission,
 * and it refuses to write anything once the paper has been submitted.
 */
arenaRouter.post(
  '/competitions/:id/signals',
  limits.proctor(),
  asyncRoute(async (req, res) => {
    const body = parseBody(signalsSchema, req.body ?? {});
    /*
     * The caller addresses the competition; the server resolves *their own* attempt from it. An
     * attempt id is never accepted from the client, so there is no way to write into someone
     * else's record by guessing an id.
     */
    const attemptId = await arenaAttemptId(req.user!.id, req.params.id);
    if (!attemptId) throw new HttpError(404, 'Start the paper before it can report anything.', 'not_found');
    const result = await recordSignals({
      userId: req.user!.id,
      scope: 'arena',
      refId: attemptId,
      signals: body.signals,
      device: body.device,
    });
    res.json({ ...result, kinds: SIGNAL_KINDS });
  }),
);

const submitSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().trim().min(1),
        answer: z.string().max(600).default(''),
        timeSpentMs: z.number().int().min(0).max(86_400_000).optional(),
        flagged: z.boolean().optional(),
      }),
    )
    .max(120)
    .default([]),
});

arenaRouter.post(
  '/competitions/:id/submit',
  asyncRoute(async (req, res) => {
    const body = parseBody(submitSchema, req.body ?? {});
    const status = await attemptStatus(req.user!.id, req.params.id);
    if (!status.attempt) throw new HttpError(409, 'Start the competition before submitting.', 'not_started');

    /**
     * Timing is decided here, from the server clock:
     *  - once the deadline (or the competition end) has passed the paper is closed, and whatever the
     *    server already holds is graded — a late flush of client answers is ignored so nobody can
     *    keep answering after time;
     *  - otherwise the answers in the request are the final ones.
     * Either way `submitAttempt` refuses a second submission, so the first one is the only one that
     * counts, and the caller is pointed at the result that already exists.
     */
    const expired = status.expired || status.state === 'SUBMISSION_CLOSED' || status.state === 'RESULTS_PUBLISHED' || status.state === 'ARCHIVED';
    const outcome = await submitAttempt({
      userId: req.user!.id,
      attemptId: status.attempt.id,
      answers: expired ? [] : body.answers,
      autoSubmitted: expired,
      reason: expired ? 'The competition time ran out.' : undefined,
    });
    res.json({ outcome });
  }),
);

/* ------------------------------------------------------------------ */
/* Results + analysis + improvement hand-off                           */
/* ------------------------------------------------------------------ */

arenaRouter.get(
  '/results/:attemptId',
  asyncRoute(async (req, res) => {
    const payload = await getResultForUser(req.user!.id, req.params.attemptId);
    res.json(payload);
  }),
);

/** The student's own integrity summary for their own attempt. */
arenaRouter.get(
  '/results/:attemptId/integrity',
  asyncRoute(async (req, res) => {
    res.json({ report: await integrityFor(req.user!.id, 'arena', req.params.attemptId) });
  }),
);

/** Host (or admin) view: which attempts of this competition need a closer look. */
arenaRouter.get(
  '/competitions/:id/integrity',
  asyncRoute(async (req, res) => {
    res.json(
      await competitionIntegrity({
        userId: req.user!.id,
        competitionId: req.params.id,
        isAdmin: isAdmin(req.user!),
      }),
    );
  }),
);

arenaRouter.post(
  '/results/:attemptId/analyze',
  limits.ai(),
  asyncRoute(async (req, res) => {
    const report = await generatePerformanceReport(req.user!.id, req.params.attemptId);
    res.json({ report });
  }),
);

/**
 * One-click improvement (spec §12). Returns the practice plan the client hands to the existing
 * Practice feature, so no topic has to be re-entered by hand.
 */
arenaRouter.post(
  '/results/:attemptId/practice',
  asyncRoute(async (req, res) => {
    const payload = await getResultForUser(req.user!.id, req.params.attemptId);
    const suggestions = payload.practiceSuggestions;
    if (!suggestions.length) {
      throw new HttpError(409, 'There is nothing specific to drill from this attempt yet — try a longer paper.', 'no_suggestions');
    }

    /**
     * Deep links into the existing Practice feature. Arena subjects are the same subject names
     * Practice uses; a chapter is only passed on when Practice actually knows it, otherwise the
     * student would land on a set for a chapter that does not exist in the syllabus list.
     */
    const linkFor = (suggestion: (typeof suggestions)[number]) => {
      const chapter = suggestion.chapter && CHAPTER_SUGGESTIONS[suggestion.subject]?.includes(suggestion.chapter)
        ? suggestion.chapter
        : null;
      const query = new URLSearchParams({
        subject: suggestion.subject,
        difficulty: suggestion.difficulty,
        questionType: suggestion.questionType,
        count: String(suggestion.count),
        from: 'arena',
        topic: suggestion.topic,
      });
      if (chapter) query.set('chapter', chapter);
      return {
        ...suggestion,
        chapter,
        url: `/practice?${query.toString()}`,
      };
    };

    const withLinks = suggestions.map(linkFor);
    res.json({ suggestions: withLinks, startWith: withLinks[0] });
  }),
);
