/**
 * AI Tutor API.
 *
 * `POST /api/tutor/stream` is the heart of the product: it streams Server-Sent Events that mirror
 * the AI layer's RouterEvent union (plan → attempt → deltas → done), so the UI can show *why*
 * something is slow or which connection answered.
 */
import { Router } from 'express';
import { z } from 'zod';
import * as db from '../db/index.js';
import { PROVIDER_IDS, type ProviderId } from '../config/models.js';
import { asyncRoute, parseBody, HttpError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { limits } from '../middleware/rateLimit.js';
import { stream } from '../services/ai/router.js';
import { QUICK_ACTIONS } from '../services/ai/prompts.js';
import {
  conversationHistory,
  createConversation,
  deleteConversation,
  finaliseTutorAnswer,
  getConversation,
  listConversations,
  prepareTutorRequest,
  promptContextFor,
  renameConversation,
} from '../services/tutor.js';
import { saveToNotes } from '../services/notes.js';
import { recordActivity } from '../services/activity.js';
import type { RouterEvent } from '../services/ai/types.js';

export const tutorRouter = Router();
tutorRouter.use(requireAuth);

tutorRouter.get(
  '/conversations',
  asyncRoute(async (req, res) => {
    res.json({ conversations: await listConversations(req.user!.id) });
  }),
);

tutorRouter.post(
  '/conversations',
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({ title: z.string().trim().max(120).optional(), subject: z.string().trim().max(60).optional() }),
      req.body,
    );
    res.status(201).json({ conversation: await createConversation(req.user!.id, body) });
  }),
);

tutorRouter.get(
  '/conversations/:id',
  asyncRoute(async (req, res) => {
    const data = await getConversation(req.user!.id, req.params.id);
    if (!data) throw new HttpError(404, 'That conversation was not found.');
    res.json(data);
  }),
);

tutorRouter.patch(
  '/conversations/:id',
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ title: z.string().trim().min(1).max(120) }), req.body);
    await renameConversation(req.user!.id, req.params.id, body.title);
    res.json({ ok: true });
  }),
);

tutorRouter.delete(
  '/conversations/:id',
  asyncRoute(async (req, res) => {
    await deleteConversation(req.user!.id, req.params.id);
    res.json({ ok: true });
  }),
);

tutorRouter.get('/quick-actions', (_req, res) => {
  res.json({
    quickActions: [
      { id: 'simpler', label: 'Simpler', icon: 'minus' },
      { id: 'example', label: 'Another example', icon: 'shapes' },
      { id: 'why', label: 'Why?', icon: 'help' },
      { id: 'steps', label: 'Step by step', icon: 'list' },
      { id: 'testme', label: 'Test me', icon: 'check' },
      { id: 'practice', label: 'Make practice set', icon: 'target' },
    ],
  });
});

const streamSchema = z.object({
  conversationId: z.string().trim().min(1).optional(),
  content: z.string().trim().min(1, 'Type a question first.').max(6000, 'That question is very long — split it up.'),
  attachments: z
    .array(
      z.object({
        mimeType: z.string().max(80),
        data: z.string().max(6_000_000),
        name: z.string().max(120).optional(),
      }),
    )
    .max(3)
    .optional(),
  quickAction: z.enum(Object.keys(QUICK_ACTIONS) as [string, ...string[]]).optional(),
  subject: z.string().trim().max(60).optional(),
  regenerate: z.boolean().optional(),
  provider: z.enum(['gemini', 'groq', 'openrouter']).optional(),
  model: z.string().trim().max(120).optional(),
});

tutorRouter.post(
  '/stream',
  limits.ai(),
  asyncRoute(async (req, res) => {
    const body = parseBody(streamSchema, req.body);
    const userId = req.user!.id;

    const prepared = await prepareTutorRequest({
      userId,
      conversationId: body.conversationId,
      content: body.content,
      attachments: body.attachments,
      quickAction: body.quickAction as keyof typeof QUICK_ACTIONS | undefined,
      subject: body.subject,
      regenerate: body.regenerate,
      preferredProvider: body.provider as ProviderId | undefined,
      preferredModel: body.model,
    });

    // ---- SSE plumbing -------------------------------------------------
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const controller = new AbortController();
    let closed = false;
    req.on('close', () => {
      closed = true;
      // Stop the upstream request when the student closes the tab or presses Stop.
      controller.abort(new Error('client closed'));
    });

    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15_000);

    const send = (event: string, data: unknown) => {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const startedAt = Date.now();
    let finalText = '';
    let meta: Record<string, unknown> = {};
    let hadError: { message: string; hint?: string; failure: string } | null = null;

    send('meta', {
      conversationId: prepared.conversationId,
      userMessageId: prepared.userMessageId ?? null,
      task: prepared.taskKind,
    });

    try {
      for await (const event of stream({
        userId,
        task: prepared.taskKind,
        system: prepared.system,
        messages: prepared.messages,
        signal: controller.signal,
        temperature: 0.55,
        maxTokens: 2400,
        preferredProvider: body.provider as ProviderId | undefined,
        preferredModel: body.model,
      }) as AsyncGenerator<RouterEvent>) {
        send(event.type, event);
        if (event.type === 'delta') finalText += event.text;
        if (event.type === 'restart') finalText = '';
        if (event.type === 'done') {
          finalText = event.text || finalText;
          meta = {
            provider: event.provider,
            model: event.model,
            keyLabel: event.keyLabel,
            attempts: event.attempts,
            fellBack: event.fellBack,
            demo: event.demo,
            latencyMs: event.latencyMs,
          };
        }
        if (event.type === 'error') {
          hadError = { message: event.message, hint: event.hint, failure: event.failure };
        }
      }
    } catch (err) {
      hadError = {
        message: err instanceof Error ? err.message : 'The AI connection failed.',
        failure: 'unknown',
      };
    } finally {
      clearInterval(heartbeat);
    }

    if (closed) return;

    if (!finalText.trim()) {
      send('final', {
        conversationId: prepared.conversationId,
        error: hadError ?? { message: 'No answer was generated. Please retry.', failure: 'empty_response' },
      });
      res.end();
      return;
    }

    try {
      const { message, visuals, followUps } = await finaliseTutorAnswer({
        userId,
        conversationId: prepared.conversationId,
        text: finalText,
        meta: { ...meta, degradedReason: hadError?.failure },
        durationMs: Date.now() - startedAt,
        subject: body.subject,
      });
      send('final', { conversationId: prepared.conversationId, message, visuals, followUps });
    } catch (err) {
      send('final', {
        conversationId: prepared.conversationId,
        error: { message: 'The answer arrived but could not be saved.', failure: 'server_error' },
      });
    }
    res.end();
  }),
);

/** Save an AI answer into Notes (the Learn → Revise handoff). */
tutorRouter.post(
  '/messages/:id/save-to-notes',
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({ subject: z.string().trim().max(60).optional(), chapter: z.string().trim().max(80).optional() }),
      req.body,
    );
    const message = await db.one<{ id: string; content: string; role: string; conversation_id: string }>(
      'SELECT id, content, role, conversation_id FROM messages WHERE id = ? AND user_id = ?',
      [req.params.id, req.user!.id],
    );
    if (!message || message.role !== 'assistant') throw new HttpError(404, 'That answer was not found.');
    const conversation = await db.one<{ title: string; subject: string | null }>(
      'SELECT title, subject FROM conversations WHERE id = ?',
      [message.conversation_id],
    );

    const note = await saveToNotes({
      userId: req.user!.id,
      title: conversation?.title ?? 'Saved AI answer',
      content: message.content,
      subject: body.subject ?? conversation?.subject ?? undefined,
      chapter: body.chapter,
      source: 'tutor',
    });
    res.status(201).json({ note });
  }),
);

/** Replay TTS-ready text + everything the UI needs for "read aloud" on an old answer. */
tutorRouter.get(
  '/conversations/:id/context',
  asyncRoute(async (req, res) => {
    const data = await getConversation(req.user!.id, req.params.id);
    if (!data) throw new HttpError(404, 'That conversation was not found.');
    res.json({
      conversation: data.conversation,
      history: await conversationHistory(req.params.id, 12),
      promptContext: await promptContextFor(req.user!.id, data.conversation.subject ?? undefined),
    });
  }),
);

/** Used by the "Practice" button under a tutor answer to pre-fill the Practice module. */
tutorRouter.post(
  '/practice-from-answer',
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        messageId: z.string().trim().min(1),
        count: z.number().int().min(3).max(10).optional(),
      }),
      req.body,
    );
    const message = await db.one<{ content: string; conversation_id: string }>(
      'SELECT content, conversation_id FROM messages WHERE id = ? AND user_id = ?',
      [body.messageId, req.user!.id],
    );
    if (!message) throw new HttpError(404, 'That answer was not found.');
    const conversation = await db.one<{ title: string; subject: string | null }>(
      'SELECT title, subject FROM conversations WHERE id = ?',
      [message.conversation_id],
    );
    const topic = conversation?.title ?? 'this topic';
    await recordActivity({
      userId: req.user!.id,
      kind: 'practice',
      subject: conversation?.subject ?? null,
      topic: topic.slice(0, 80),
      label: `Started practice from an AI answer: ${topic.slice(0, 60)}`,
    });
    res.json({
      suggestion: {
        subject: conversation?.subject ?? 'Physics',
        chapter: topic.slice(0, 80),
        difficulty: 'medium',
        questionType: 'mixed',
        count: body.count ?? 5,
      },
    });
  }),
);

export const SUPPORTED_PROVIDERS = PROVIDER_IDS;
