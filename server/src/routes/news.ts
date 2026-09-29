/**
 * News API (`/api/news`).
 *
 * Public reading news — the same selection a student would get from a newspaper app, filtered for a
 * general audience (a school platform shows general news, not a personalised feed, and never anything
 * derived from what a student does inside Vroqn).
 *
 * `requireAuth` is applied because this is a signed-in workspace screen; nothing here is user-specific.
 */
import { Router } from 'express';
import { asyncRoute } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { limits } from '../middleware/rateLimit.js';
import { getFeed, health, NEWS_CATEGORIES, search } from '../services/news.js';

export const newsRouter = Router();
newsRouter.use(requireAuth);

newsRouter.get(
  '/categories',
  asyncRoute(async (_req, res) => {
    res.json({ categories: NEWS_CATEGORIES.map((entry) => ({ id: entry.id, label: entry.label })) });
  }),
);

newsRouter.get(
  '/',
  /*
   * Reading the cached feed is cheap, but a forced refresh hits several publishers at once, so the
   * whole router sits behind the general bucket: one student cannot turn a refresh loop into a
   * denial-of-service against the newspapers that publish these feeds.
   */
  limits.general(),
  asyncRoute(async (req, res) => {
    const category = String(req.query.category ?? 'top');
    const force = req.query.refresh === '1';
    const feed = await getFeed(category, { force });
    res.json(feed);
  }),
);

newsRouter.get(
  '/search',
  limits.general(),
  asyncRoute(async (req, res) => {
    const term = String(req.query.q ?? '');
    res.json({ items: await search(term) });
  }),
);

/** Whether the upstream feeds were reachable, surfaced so the page can be honest when they are not. */
newsRouter.get(
  '/health',
  asyncRoute(async (_req, res) => {
    res.json({ categories: await health() });
  }),
);
