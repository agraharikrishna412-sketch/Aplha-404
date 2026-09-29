/**
 * Private messaging API (`/api/messages`).
 *
 * Mounted separately from `/api/communities` on purpose: nothing in the community permission matrix
 * applies here, and a community owner or moderator has no route to a student's private conversations.
 *
 * Authorisation lives in `services/dm.ts` — every handler that touches an id goes through
 * `requireMembership` there, so a forgotten check cannot leak a conversation. The route layer only
 * validates shapes and applies rate limits.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, HttpError, parseBody } from '../middleware/errors.js';
import { isAdmin, requireAdmin, requireAuth } from '../middleware/auth.js';
import { limits } from '../middleware/rateLimit.js';
import { subscribe, userChannel } from '../services/communities/bus.js';
import {
  blockUser,
  conversationDetail,
  deleteMessage,
  editMessage,
  listBlocked,
  listConversations,
  listDevices,
  listEnvelopes,
  listMessages,
  listReports,
  markRead,
  openConversation,
  putEnvelope,
  registerDevice,
  report,
  resolveReport,
  sendMessage,
  setConversationFlags,
  setMessagePolicy,
  signalTyping,
  toggleReaction,
  unblockUser,
  unreadTotal,
} from '../services/dm.js';

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

/* ------------------------------------------------------------------ conversations ---------------- */

messagesRouter.get(
  '/conversations',
  asyncRoute(async (req, res) => {
    const conversations = await listConversations(req.user!.id);
    res.json({ conversations, unread: await unreadTotal(req.user!.id) });
  }),
);

messagesRouter.get(
  '/unread',
  asyncRoute(async (req, res) => {
    res.json({ unread: await unreadTotal(req.user!.id) });
  }),
);

messagesRouter.post(
  '/conversations',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({ userId: z.string().min(1).max(60) }),
      req.body ?? {},
    );
    res.json(await openConversation(req.user!.id, body.userId));
  }),
);

messagesRouter.get(
  '/conversations/:conversationId',
  asyncRoute(async (req, res) => {
    res.json(await conversationDetail(req.user!.id, req.params.conversationId));
  }),
);

messagesRouter.post(
  '/conversations/:conversationId/read',
  asyncRoute(async (req, res) => {
    res.json(await markRead(req.user!.id, req.params.conversationId));
  }),
);

messagesRouter.post(
  '/conversations/:conversationId/flags',
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ muted: z.boolean().optional(), archived: z.boolean().optional() }), req.body ?? {});
    res.json(await setConversationFlags(req.user!.id, req.params.conversationId, body));
  }),
);

messagesRouter.post(
  '/conversations/:conversationId/typing',
  asyncRoute(async (req, res) => {
    await signalTyping(req.user!.id, req.params.conversationId);
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ messages --------------------- */

messagesRouter.get(
  '/conversations/:conversationId/messages',
  asyncRoute(async (req, res) => {
    const query = z
      .object({
        before: z.string().max(40).optional(),
        after: z.string().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(60).optional(),
      })
      .parse(req.query ?? {});
    res.json(
      await listMessages(req.user!.id, req.params.conversationId, {
        before: query.before,
        after: query.after,
        limit: query.limit,
      }),
    );
  }),
);

messagesRouter.post(
  '/conversations/:conversationId/messages',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        // The server never receives plaintext — only the ciphertext the client produced.
        ciphertext: z.string().min(1).max(12_000),
        iv: z.string().min(1).max(200),
        alg: z.string().max(40).optional(),
        keyVersion: z.number().int().min(1).max(999).optional(),
        replyToId: z.string().max(60).nullable().optional(),
      }),
      req.body ?? {},
    );
    res.status(201).json(await sendMessage(req.user!.id, req.params.conversationId, body));
  }),
);

messagesRouter.patch(
  '/messages/:messageId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({ ciphertext: z.string().min(1).max(12_000), iv: z.string().min(1).max(200) }),
      req.body ?? {},
    );
    res.json(await editMessage(req.user!.id, req.params.messageId, body));
  }),
);

messagesRouter.delete(
  '/messages/:messageId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await deleteMessage(req.user!.id, req.params.messageId);
    res.json({ ok: true });
  }),
);

messagesRouter.post(
  '/messages/:messageId/reactions',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ reaction: z.string().min(1).max(8) }), req.body ?? {});
    res.json(await toggleReaction(req.user!.id, req.params.messageId, body.reaction));
  }),
);

/* ------------------------------------------------------------------ keys ------------------------- */

messagesRouter.post(
  '/devices',
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        deviceId: z.string().min(8).max(64),
        publicKey: z.record(z.unknown()),
        label: z.string().max(60).optional(),
      }),
      req.body ?? {},
    );
    res.json(await registerDevice(req.user!.id, body));
  }),
);

messagesRouter.get(
  '/devices',
  asyncRoute(async (req, res) => {
    const userIds = String(req.query.userIds ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    res.json({ devices: await listDevices(req.user!.id, userIds) });
  }),
);

messagesRouter.get(
  '/conversations/:conversationId/keys',
  asyncRoute(async (req, res) => {
    res.json({ envelopes: await listEnvelopes(req.user!.id, req.params.conversationId) });
  }),
);

messagesRouter.post(
  '/conversations/:conversationId/keys',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        recipientUserId: z.string().min(1).max(60),
        deviceId: z.string().min(8).max(64),
        wrappedKey: z.string().min(1).max(2000),
        iv: z.string().min(1).max(200),
        keyVersion: z.number().int().min(1).max(999).optional(),
      }),
      req.body ?? {},
    );
    res.json(await putEnvelope(req.user!.id, req.params.conversationId, body));
  }),
);

/* ------------------------------------------------------------------ safety ----------------------- */

messagesRouter.get(
  '/blocks',
  asyncRoute(async (req, res) => {
    res.json({ blocked: await listBlocked(req.user!.id) });
  }),
);

messagesRouter.post(
  '/blocks',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ userId: z.string().min(1).max(60) }), req.body ?? {});
    res.json(await blockUser(req.user!.id, body.userId));
  }),
);

messagesRouter.delete(
  '/blocks/:userId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    res.json(await unblockUser(req.user!.id, req.params.userId));
  }),
);

messagesRouter.put(
  '/prefs',
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ dmPolicy: z.enum(['everyone', 'communities', 'nobody']) }), req.body ?? {});
    res.json(await setMessagePolicy(req.user!.id, body.dmPolicy));
  }),
);

messagesRouter.post(
  '/reports',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        conversationId: z.string().max(60).optional(),
        messageId: z.string().max(60).optional(),
        targetUserId: z.string().max(60).optional(),
        reason: z.string().min(2).max(120),
        note: z.string().max(400).optional(),
      }),
      req.body ?? {},
    );
    if (!body.conversationId && !body.messageId && !body.targetUserId) {
      throw new HttpError(400, 'Nothing to report.', 'validation_error');
    }
    res.json(await report(req.user!.id, body));
  }),
);

/**
 * Report history. A student sees the reports they filed; `?scope=all` is the staff queue and is
 * refused for anyone else — the same read would otherwise expose other students' safety reports.
 */
messagesRouter.get(
  '/reports',
  asyncRoute(async (req, res) => {
    const wantsAll = String(req.query.scope ?? '') === 'all';
    if (wantsAll && !isAdmin(req.user)) throw new HttpError(403, 'That queue is for staff only.', 'forbidden');
    res.json({ reports: await listReports(req.user!.id, { all: wantsAll }) });
  }),
);

messagesRouter.post(
  '/reports/:reportId/resolve',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        status: z.enum(['reviewing', 'actioned', 'dismissed']),
        actionTaken: z.string().max(200).optional(),
      }),
      req.body ?? {},
    );
    res.json(await resolveReport(req.user!.id, req.params.reportId, body));
  }),
);

/* ------------------------------------------------------------------ live stream ------------------ */

/**
 * Personal event stream for the messages screens.
 *
 * Same shape as the community stream: the browser cannot send a POST with `EventSource`, so the client
 * uses its fetch-based streamer. Events carry ids only; the client re-reads the thread it is showing.
 */
messagesRouter.post(
  '/stream',
  asyncRoute(async (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    req.on('close', () => {
      closed = true;
    });
    const send = (event: string, data: unknown) => {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('ready', { unread: await unreadTotal(req.user!.id) });
    const unsubscribe = subscribe(userChannel(req.user!.id), (event) => send('messages', event));
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 20_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }),
);
