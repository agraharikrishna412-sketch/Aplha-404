/**
 * Dashboard aggregate — one request so the first screen is fast on slow connections (spec §6, §26).
 * Everything returned here is derived from the student's own activity.
 */
import { Router } from 'express';
import * as db from '../db/index.js';
import { asyncRoute } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { learningSummary, listActivity } from '../services/activity.js';
import { listConversations } from '../services/tutor.js';
import { listNotes } from '../services/notes.js';
import { listSets } from '../services/practice.js';
import { listExams, listResults } from '../services/exams.js';
import { keyOverview } from '../services/ai/keyManager.js';
import { getSettings } from '../services/settings.js';
import { PROVIDER_CATALOG, PROVIDER_IDS } from '../config/models.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

dashboardRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const userId = req.user!.id;
    const [summary, activity, conversations, notes, sets, exams, results, keys, settings, userRow] = await Promise.all([
      learningSummary(userId, 7),
      listActivity(userId, 12),
      listConversations(userId, 4),
      listNotes(userId, { limit: 4 }),
      listSets(userId, 3),
      listExams(userId, 3),
      listResults(userId, 3),
      keyOverview(userId),
      getSettings(userId),
      db.one<{ name: string; class_level: string | null; board: string | null }>(
        'SELECT name, class_level, board FROM users WHERE id = ?',
        [userId],
      ),
    ]);

    const configuredProviders = PROVIDER_IDS.filter((id) => keys[id].enabled > 0);
    const connectedProviders = PROVIDER_IDS.filter((id) => keys[id].connected > 0);
    const needsAttention = PROVIDER_IDS.flatMap((id) =>
      keys[id].keys.filter((k) => k.status === 'invalid' || k.status === 'error').map((k) => ({ provider: id, key: k })),
    );

    // "Where to go next" — derived from real gaps, never random.
    const suggestions: { id: string; title: string; detail: string; cta: string; href: string; tone: string }[] = [];
    if (!configuredProviders.length) {
      suggestions.push({
        id: 'connect-key',
        title: 'Connect your first AI key',
        detail: 'Add a free Gemini, Groq or OpenRouter key to unlock real AI answers, practice generation and reviews.',
        cta: 'Open AI Settings',
        href: '/settings',
        tone: 'warning',
      });
    } else if (!connectedProviders.length) {
      suggestions.push({
        id: 'test-keys',
        title: 'Your keys have not been verified yet',
        detail: 'Run Test on your keys so Vroqn Nexus can rotate them safely when one gets rate limited.',
        cta: 'Test connections',
        href: '/settings',
        tone: 'warning',
      });
    }
    for (const weak of summary.weakTopics.slice(0, 2)) {
      suggestions.push({
        id: `weak-${weak.topic}`,
        title: `Weak area: ${weak.topic}`,
        detail: `${Math.round(weak.accuracy * 100)}% accuracy over ${weak.attempted} attempts in ${weak.subject}. A short set now will fix it fast.`,
        cta: 'Practise this',
        href: `/practice?subject=${encodeURIComponent(weak.subject)}&chapter=${encodeURIComponent(weak.topic)}`,
        tone: 'error',
      });
    }
    const incompleteExam = exams.find((e) => e.status !== 'completed');
    if (incompleteExam) {
      suggestions.push({
        id: `exam-${incompleteExam.id}`,
        title: `Finish "${incompleteExam.title}"`,
        detail: `${incompleteExam.questions.length} questions · ${incompleteExam.durationMin} min suggested.`,
        cta: 'Resume exam',
        href: `/mock-exam/${incompleteExam.id}`,
        tone: 'info',
      });
    }
    if (!suggestions.length) {
      suggestions.push({
        id: 'explore',
        title: 'Try a mock exam',
        detail: 'A 20-question exam gives the sharpest picture of what to revise next.',
        cta: 'Create mock exam',
        href: '/mock-exam',
        tone: 'info',
      });
    }

    res.json({
      user: {
        name: userRow?.name ?? req.user!.name,
        classLevel: userRow?.class_level ?? null,
        board: userRow?.board ?? null,
      },
      greeting: `Namaste, ${(userRow?.name ?? req.user!.name).split(' ')[0]}`,
      summary,
      activity,
      suggestions: suggestions.slice(0, 4),
      recent: {
        conversations,
        notes,
        practiceSets: sets.map((s) => ({ id: s.id, subject: s.subject, chapter: s.chapter, questions: s.questions.length, createdAt: s.createdAt })),
        exams: exams.map((e) => ({ id: e.id, title: e.title, subject: e.subject, questionCount: e.questions.length, status: e.status, createdAt: e.createdAt })),
        results,
      },
      ai: {
        configuredProviders: configuredProviders.map((id) => PROVIDER_CATALOG[id].label),
        connectedProviders: connectedProviders.map((id) => PROVIDER_CATALOG[id].label),
        needsAttention: needsAttention.map((n) => ({ provider: PROVIDER_CATALOG[n.provider].label, label: n.key.label, status: n.key.status })),
        totalKeys: PROVIDER_IDS.reduce((acc, id) => acc + keys[id].total, 0),
        demoMode: settings.demoMode,
        routing: settings.routing,
      },
    });
  }),
);
