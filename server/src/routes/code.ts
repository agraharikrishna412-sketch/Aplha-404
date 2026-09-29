/** Code Lab API — run code, save snippets, get AI review/explanation. */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, HttpError, parseBody } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { limits } from '../middleware/rateLimit.js';
import {
  LANGUAGES,
  STARTERS,
  codeAssist,
  deleteSession,
  isLanguage,
  listSessions,
  recordCodeRun,
  runCode,
  saveSession,
} from '../services/code.js';

export const codeRouter = Router();
codeRouter.use(requireAuth);

codeRouter.get('/catalog', (_req, res) => {
  res.json({ languages: LANGUAGES, starters: STARTERS });
});

const runSchema = z.object({
  language: z.string().trim().max(30),
  code: z.string().max(60_000),
});

codeRouter.post(
  '/run',
  limits.code(),
  asyncRoute(async (req, res) => {
    const body = parseBody(runSchema, req.body);
    if (!isLanguage(body.language)) throw new HttpError(400, 'Choose JavaScript, Python or HTML first.');
    const result = await runCode({ language: body.language, code: body.code });
    await recordCodeRun({
      userId: req.user!.id,
      language: body.language,
      ok: result.ok,
      durationMs: result.durationMs,
    });
    res.json({ result });
  }),
);

const assistSchema = z.object({
  mode: z.enum(['review', 'explain', 'bugs', 'improve', 'ask', 'build']),
  language: z.string().trim().max(30),
  code: z.string().max(60_000).default(''),
  question: z.string().max(2000).optional(),
  output: z.string().max(8000).optional(),
  /*
   * Recent turns of the Code Lab conversation, so follow-ups ("iska matlab kya hai?", "isko fix karo")
   * have something to refer to. Bounded here as well as in the service: a client cannot make the
   * prompt unbounded by sending a long history.
   */
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(4000),
      }),
    )
    .max(8)
    .optional(),
});

codeRouter.post(
  '/assist',
  limits.ai(),
  asyncRoute(async (req, res) => {
    const body = parseBody(assistSchema, req.body);
    if (!body.code.trim() && !body.question?.trim()) throw new HttpError(400, 'Write some code or ask a question first.');
    const result = await codeAssist({ userId: req.user!.id, ...body });
    res.json(result);
  }),
);

const sessionSchema = z.object({
  id: z.string().trim().max(60).optional(),
  title: z.string().trim().max(120).optional(),
  language: z.string().trim().max(30),
  code: z.string().max(60_000),
  lastOutput: z.string().max(8000).optional(),
});

codeRouter.get(
  '/sessions',
  asyncRoute(async (req, res) => {
    res.json({ sessions: await listSessions(req.user!.id, 30) });
  }),
);

codeRouter.post(
  '/sessions',
  asyncRoute(async (req, res) => {
    const body = parseBody(sessionSchema, req.body);
    res.status(201).json({ session: await saveSession(req.user!.id, body) });
  }),
);

codeRouter.delete(
  '/sessions/:id',
  asyncRoute(async (req, res) => {
    await deleteSession(req.user!.id, req.params.id);
    res.json({ ok: true });
  }),
);
