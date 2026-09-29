/** Student settings: task routing, learning profile, activity controls. */
import { Router } from 'express';
import { z } from 'zod';
import { PROVIDER_CATALOG, PROVIDER_IDS } from '../config/models.js';
import { asyncRoute, parseBody } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { getSettings, saveSettings } from '../services/settings.js';
import { aiRuntimeInfo } from '../services/ai/router.js';
import { clearActivity, listActivity, listTopicStats } from '../services/activity.js';
import { config } from '../config/env.js';
import type { TaskKind } from '../config/models.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

const taskEnum = z.enum(['general', 'coding', 'notes', 'exam', 'practice', 'vision', 'grading', 'fallback']);

const settingsSchema = z.object({
  routing: z.record(taskEnum, z.enum(['gemini', 'groq', 'openrouter'])).optional(),
  modelPrefs: z.record(z.enum(['gemini', 'groq', 'openrouter']), z.string().max(120)).optional(),
  demoMode: z.boolean().optional(),
  explanationLevel: z.enum(['class6_8', 'class9_10', 'class11_12', 'beginner_college']).optional(),
  language: z.enum(['english', 'hinglish', 'hindi']).optional(),
  subjectDefaults: z
    .object({
      subject: z.string().max(60),
      chapter: z.string().max(80),
      difficulty: z.string().max(20),
    })
    .partial()
    .optional(),
});

settingsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const settings = await getSettings(req.user!.id);
    res.json({
      settings,
      runtime: {
        ...aiRuntimeInfo,
        demoModeAllowed: config.demoModeDefault,
        codeRunEnabled: config.code.enabled,
        providers: PROVIDER_IDS.map((id) => ({
          id,
          label: PROVIDER_CATALOG[id].label,
          capabilities: aiRuntimeInfo.providers.find((p) => p.id === id)?.capabilities,
        })),
      },
    });
  }),
);

settingsRouter.put(
  '/',
  asyncRoute(async (req, res) => {
    const body = parseBody(settingsSchema, req.body);
    const settings = await saveSettings(req.user!.id, {
      ...body,
      routing: body.routing as Partial<Record<TaskKind, 'gemini' | 'groq' | 'openrouter'>> | undefined,
    } as never);
    res.json({ settings });
  }),
);

/** Transparency: exactly what learning activity is stored, and a one-tap way to erase it. */
settingsRouter.get(
  '/activity-data',
  asyncRoute(async (req, res) => {
    const [events, topics] = await Promise.all([listActivity(req.user!.id, 200), listTopicStats(req.user!.id)]);
    res.json({
      explanation:
        'Vroqn Nexus stores only the learning actions listed here so it can show your progress and suggest revision. Nothing is shared or sold, and nothing is recorded while you are away from the app.',
      events,
      topics,
    });
  }),
);

settingsRouter.delete(
  '/activity-data',
  asyncRoute(async (req, res) => {
    await clearActivity(req.user!.id);
    res.json({ ok: true, message: 'Learning activity cleared.' });
  }),
);
