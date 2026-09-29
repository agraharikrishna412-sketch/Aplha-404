/** Learning Activity API — what the student (and only the student) can see about their study. */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, parseBody } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { classifyTopics, learningSummary, listActivity, listTopicStats } from '../services/activity.js';
import { learningAnalytics } from '../services/analytics.js';

export const activityRouter = Router();
activityRouter.use(requireAuth);

activityRouter.get(
  '/summary',
  asyncRoute(async (req, res) => {
    const query = parseBody(z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }), req.query);
    const summary = await learningSummary(req.user!.id, query.days);
    res.json({ summary });
  }),
);

/**
 * Learning analytics (§ turn 8: "add page in dashboard for learning analytics").
 *
 * A wider, deeper view than `/summary`: daily trend, subject breakdown, activity mix, topic strengths
 * and weaknesses, exam outcomes and study rhythm — every figure derived from the caller's own rows.
 */
activityRouter.get(
  '/analytics',
  asyncRoute(async (req, res) => {
    const query = parseBody(
      z.object({ days: z.coerce.number().int().min(7).max(180).default(30) }),
      req.query,
    );
    res.json(await learningAnalytics(req.user!.id, query.days));
  }),
);

activityRouter.get(
  '/events',
  asyncRoute(async (req, res) => {
    const query = parseBody(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    res.json({ events: await listActivity(req.user!.id, query.limit) });
  }),
);

activityRouter.get(
  '/topics',
  asyncRoute(async (req, res) => {
    const stats = await listTopicStats(req.user!.id, 60);
    const { weak, strong } = classifyTopics(stats);
    res.json({
      topics: stats,
      weak,
      strong,
      note: 'Weak = under 70% accuracy with at least 2 attempts. Strong = 80%+ with at least 3 attempts.',
    });
  }),
);
