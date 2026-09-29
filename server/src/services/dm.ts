/**
 * Private messaging between students (§6–§8).
 *
 * This is deliberately **not** community chat: community roles, moderators and owners have no standing
 * here, and a conversation is visible only to the two people in it. Everything a student sends is
 * stored as ciphertext — the columns are `ciphertext`, `iv`, `alg` and `key_version`; there is no
 * plaintext column for a future change to accidentally fill.
 *
 * What the server can and cannot do, stated plainly rather than implied:
 *
 *  - The server **does not** hold, derive or escrow message keys. A conversation key is generated in
 *    the sender's browser and handed to each participant's device wrapped with a key derived from an
 *    ECDH P-256 exchange (see `client/src/lib/crypto.ts` and `docs/PRIVATE-MESSAGING.md`).
 *  - The server **does** see metadata: who talks to whom, when, how many messages, and the read
 *    watermarks. That is what makes unread badges and delivery possible. It is not hidden, and the
 *    privacy screen says so.
 *  - The server **never** logs message bodies, never indexes them, and never sends them to an AI
 *    provider (§27).
 *
 * Safety rules are enforced here, not in the UI: block wins over every policy in both directions,
 * `dm_policy` decides who may start a conversation, and both a per-conversation flood limit and a
 * per-account conversation-creation limit stop a spammer from the obvious abuses.
 */
import { all, bool, nowIso, one, run, uuid } from '../db/index.js';
import { HttpError } from '../middleware/errors.js';
import { createNotification } from './communities/notifications.js';
import { publishUser } from './communities/bus.js';
import { canMessage, normalisePolicy, type DmPolicy } from './profile.js';

/* ------------------------------------------------------------------ limits ---------------------- */

export const MESSAGE_MAX_CHARS = 4000;
/** Ciphertext is base64 of the plaintext plus a 16-byte tag; this leaves room for multi-byte text. */
const CIPHERTEXT_MAX_CHARS = 12_000;
const FLOOD_WINDOW_SECONDS = 20;
const FLOOD_MAX_IN_WINDOW = 12;
const NEW_CONVERSATIONS_PER_HOUR = 12;
const MAX_ENVELOPE_CHARS = 2000;

export function assertBase64(value: string, field: string, max = CIPHERTEXT_MAX_CHARS): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) throw new HttpError(400, `The message ${field} is missing.`, 'validation_error');
  if (trimmed.length > max) throw new HttpError(413, 'That message is too large to send.', 'message_too_large');
  if (!/^[A-Za-z0-9+/=_-]+$/.test(trimmed)) {
    throw new HttpError(400, `The message ${field} is not valid.`, 'validation_error');
  }
  return trimmed;
}

/* ------------------------------------------------------------------ types ----------------------- */

/**
 * The list preview is deliberately narrower than a full message: no replies, no reactions, no
 * conversation id. A list row only ever needs enough to render one line, still as ciphertext.
 */
export interface LastMessagePreview {
  id: string;
  senderId: string;
  ciphertext: string;
  iv: string;
  alg: string;
  keyVersion: number;
  createdAt: string;
  isDeleted: boolean;
}

export interface ConversationSummary {
  id: string;
  createdAt: string;
  lastMessageAt: string | null;
  keyVersion: number;
  isMuted: boolean;
  isArchived: boolean;
  unread: number;
  /** Present only while the key envelope for this device is missing. */
  needsKey: boolean;
  other: {
    userId: string;
    name: string;
    username: string | null;
    avatarUrl: string | null;
    accent: string;
  } | null;
  lastMessage: LastMessagePreview | null;
  blocked: boolean;
  canSend: boolean;
  canSendReason: string | null;
}

export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string;
  ciphertext: string;
  iv: string;
  alg: string;
  keyVersion: number;
  replyToId: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  reactions: { userId: string; reaction: string }[];
}

export interface EnvelopeView {
  conversationId: string;
  deviceId: string;
  recipientUserId: string;
  senderUserId: string;
  wrappedKey: string;
  iv: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ access ---------------------- */

interface MembershipRow {
  conversation_id: string;
  user_id: string;
  is_muted: number;
  is_archived: number;
}

/**
 * Loads the caller's membership of a conversation or throws 404.
 *
 * 404 rather than 403 on purpose: a 403 would confirm that a conversation exists, which is exactly
 * the information a stranger must not be able to probe for (§25, IDOR).
 */
async function requireMembership(userId: string, conversationId: string): Promise<MembershipRow> {
  const row = await one<MembershipRow>(
    `SELECT conversation_id, user_id, is_muted, is_archived FROM dm_members
      WHERE conversation_id = ? AND user_id = ?`,
    [conversationId, userId],
  );
  if (!row) throw new HttpError(404, 'That conversation was not found.', 'not_found');
  return row;
}

async function memberIds(conversationId: string): Promise<string[]> {
  const rows = await all<{ user_id: string }>(
    `SELECT user_id FROM dm_members WHERE conversation_id = ?`,
    [conversationId],
  );
  return rows.map((row) => row.user_id);
}

/** The other participant of a 1:1 conversation. */
async function otherMember(conversationId: string, userId: string): Promise<string | null> {
  const row = await one<{ user_id: string }>(
    `SELECT user_id FROM dm_members WHERE conversation_id = ? AND user_id <> ? LIMIT 1`,
    [conversationId, userId],
  );
  return row?.user_id ?? null;
}

async function personCard(
  userId: string,
): Promise<{ userId: string; name: string; username: string | null; avatarUrl: string | null; accent: string } | null> {
  const row = await one<{ id: string; name: string; username: string | null; avatar_url: string | null; accent: string | null }>(
    `SELECT u.id, u.name, p.username, p.avatar_url, p.accent
       FROM users u LEFT JOIN community_profile_settings p ON p.user_id = u.id
      WHERE u.id = ?`,
    [userId],
  );
  if (!row) return null;
  return {
    userId: row.id,
    name: row.name,
    username: row.username,
    avatarUrl: row.avatar_url,
    accent: /^#[0-9a-fA-F]{6}$/.test(row.accent ?? '') ? (row.accent as string).toUpperCase() : '#00E5FF',
  };
}

/* ------------------------------------------------------------------ conversations ---------------- */

/** Existing 1:1 conversation between two students, if there is one. */
async function findDirectConversation(a: string, b: string): Promise<string | null> {
  const row = await one<{ conversation_id: string }>(
    `SELECT m1.conversation_id
       FROM dm_members m1
       JOIN dm_members m2 ON m2.conversation_id = m1.conversation_id AND m2.user_id = ?
      WHERE m1.user_id = ?
      LIMIT 1`,
    [b, a],
  );
  return row?.conversation_id ?? null;
}

/**
 * Opens a conversation with another student, creating it if this is the first message.
 *
 * The policy check happens *before* the conversation row exists, so a blocked or uninterested student
 * does not accumulate empty conversations from strangers.
 */
export async function openConversation(userId: string, targetId: string): Promise<{ conversationId: string; created: boolean }> {
  if (!targetId || targetId === userId) {
    throw new HttpError(400, 'Choose a student to message.', 'validation_error');
  }
  const target = await one<{ id: string }>(`SELECT id FROM users WHERE id = ?`, [targetId]);
  if (!target) throw new HttpError(404, 'That student was not found.', 'not_found');

  const existing = await findDirectConversation(userId, targetId);
  if (existing) {
    // A conversation that already exists stays usable unless somebody blocks — the policy on screen
    // ("who can *start* a conversation with you") deliberately does not close a thread in progress.
    const decision = await canMessage(userId, targetId, { existingConversation: true });
    if (!decision.ok) throw new HttpError(403, decision.reason, 'cannot_message');
    return { conversationId: existing, created: false };
  }

  const decision = await canMessage(userId, targetId);
  if (!decision.ok) throw new HttpError(403, decision.reason, 'cannot_message');

  const charged = await one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM dm_conversations WHERE created_by = ? AND created_at > ?`,
    [userId, new Date(Date.now() - 3_600_000).toISOString()],
  );
  if ((charged?.total ?? 0) >= NEW_CONVERSATIONS_PER_HOUR) {
    throw new HttpError(
      429,
      'You have started several new conversations in the last hour. Try again later.',
      'too_many_conversations',
    );
  }

  const id = uuid();
  const now = nowIso();
  await run(
    `INSERT INTO dm_conversations (id, created_by, key_version, last_message_at, created_at, updated_at)
     VALUES (?, ?, 1, NULL, ?, ?)`,
    [id, userId, now, now],
  );
  for (const memberId of [userId, targetId]) {
    await run(
      `INSERT INTO dm_members (id, conversation_id, user_id, joined_at, is_muted, is_archived)
       VALUES (?, ?, ?, ?, 0, 0)`,
      [uuid(), id, memberId, now],
    );
  }

  publishUser(targetId, { type: 'dm_conversation', userId: targetId, conversationId: id });
  return { conversationId: id, created: true };
}

async function unreadCount(conversationId: string, userId: string): Promise<number> {
  const receipt = await one<{ last_read_at: string }>(
    `SELECT last_read_at FROM dm_receipts WHERE conversation_id = ? AND user_id = ?`,
    [conversationId, userId],
  );
  const row = await one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM dm_messages
      WHERE conversation_id = ? AND sender_id <> ? AND deleted_at IS NULL AND created_at > ?`,
    [conversationId, userId, receipt?.last_read_at ?? ''],
  );
  return row?.total ?? 0;
}

async function lastMessage(conversationId: string): Promise<LastMessagePreview | null> {
  const row = await one<{
    id: string;
    sender_id: string;
    ciphertext: string;
    iv: string;
    alg: string;
    key_version: number;
    reply_to_id: string | null;
    edited_at: string | null;
    deleted_at: string | null;
    created_at: string;
  }>(
    `SELECT id, sender_id, ciphertext, iv, alg, key_version, reply_to_id, edited_at, deleted_at, created_at
       FROM dm_messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [conversationId],
  );
  if (!row) return null;
  return {
    id: row.id,
    senderId: row.sender_id,
    ciphertext: row.ciphertext,
    iv: row.iv,
    alg: row.alg,
    keyVersion: row.key_version,
    createdAt: row.created_at,
    isDeleted: Boolean(row.deleted_at),
  };
}

export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  const rows = await all<{
    id: string;
    created_at: string;
    last_message_at: string | null;
    key_version: number;
    is_muted: number;
    is_archived: number;
  }>(
    `SELECT c.id, c.created_at, c.last_message_at, c.key_version, m.is_muted, m.is_archived
       FROM dm_members m JOIN dm_conversations c ON c.id = m.conversation_id
      WHERE m.user_id = ?
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
      LIMIT 100`,
    [userId],
  );

  const out: ConversationSummary[] = [];
  for (const row of rows) {
    const otherId = await otherMember(row.id, userId);
    const other = otherId ? await personCard(otherId) : null;
    // Existing conversations are gated by blocks only, so a policy change never disables a thread.
    const decision = otherId ? await canMessage(userId, otherId, { existingConversation: true }) : { ok: true as const };
    const envelope = await one<{ total: number }>(
      `SELECT COUNT(*) AS total FROM dm_key_envelopes WHERE conversation_id = ? AND recipient_user_id = ?`,
      [row.id, userId],
    );
    out.push({
      id: row.id,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
      keyVersion: row.key_version,
      isMuted: bool(row.is_muted),
      isArchived: bool(row.is_archived),
      unread: await unreadCount(row.id, userId),
      needsKey: (envelope?.total ?? 0) === 0,
      other,
      lastMessage: await lastMessage(row.id),
      blocked: !decision.ok,
      canSend: decision.ok,
      canSendReason: decision.ok ? null : decision.reason,
    });
  }
  return out;
}

export async function conversationDetail(userId: string, conversationId: string): Promise<ConversationSummary> {
  const membership = await requireMembership(userId, conversationId);
  const conversation = await one<{ id: string; created_at: string; last_message_at: string | null; key_version: number }>(
    `SELECT id, created_at, last_message_at, key_version FROM dm_conversations WHERE id = ?`,
    [conversationId],
  );
  if (!conversation) throw new HttpError(404, 'That conversation was not found.', 'not_found');

  const otherId = await otherMember(conversationId, userId);
  const other = otherId ? await personCard(otherId) : null;
  const decision = otherId ? await canMessage(userId, otherId, { existingConversation: true }) : { ok: true as const };
  const envelope = await one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM dm_key_envelopes WHERE conversation_id = ? AND recipient_user_id = ?`,
    [conversationId, userId],
  );
  return {
    id: conversation.id,
    createdAt: conversation.created_at,
    lastMessageAt: conversation.last_message_at,
    keyVersion: conversation.key_version,
    isMuted: bool(membership.is_muted),
    isArchived: bool(membership.is_archived),
    unread: await unreadCount(conversationId, userId),
    needsKey: (envelope?.total ?? 0) === 0,
    other,
    lastMessage: await lastMessage(conversationId),
    blocked: !decision.ok,
    canSend: decision.ok,
    canSendReason: decision.ok ? null : decision.reason,
  };
}

/** Unread total across every conversation, for the header badge and the nav item. */
export async function unreadTotal(userId: string): Promise<number> {
  const row = await one<{ total: number }>(
    `SELECT COUNT(*) AS total
       FROM dm_messages msg
       JOIN dm_members m ON m.conversation_id = msg.conversation_id AND m.user_id = ?
       LEFT JOIN dm_receipts r ON r.conversation_id = msg.conversation_id AND r.user_id = ?
      WHERE msg.sender_id <> ?
        AND msg.deleted_at IS NULL
        AND msg.created_at > COALESCE(r.last_read_at, '')`,
    [userId, userId, userId],
  );
  return row?.total ?? 0;
}

/* ------------------------------------------------------------------ messages --------------------- */

function toMessageView(row: {
  id: string;
  conversation_id: string;
  sender_id: string;
  ciphertext: string;
  iv: string;
  alg: string;
  key_version: number;
  reply_to_id: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
}): MessageView {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    ciphertext: row.ciphertext,
    iv: row.iv,
    alg: row.alg,
    keyVersion: row.key_version,
    replyToId: row.reply_to_id,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    reactions: [],
  };
}

export async function listMessages(
  userId: string,
  conversationId: string,
  options: { before?: string; after?: string; limit?: number; search?: string } = {},
): Promise<{ messages: MessageView[]; hasMore: boolean }> {
  await requireMembership(userId, conversationId);
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 60);
  const params: unknown[] = [conversationId];
  const clauses = ['conversation_id = ?'];
  if (options.before) {
    clauses.push('created_at < ?');
    params.push(options.before);
  }
  if (options.after) {
    clauses.push('created_at > ?');
    params.push(options.after);
  }

  const rows = await all<{
    id: string;
    conversation_id: string;
    sender_id: string;
    ciphertext: string;
    iv: string;
    alg: string;
    key_version: number;
    reply_to_id: string | null;
    edited_at: string | null;
    deleted_at: string | null;
    created_at: string;
  }>(
    `SELECT id, conversation_id, sender_id, ciphertext, iv, alg, key_version, reply_to_id, edited_at, deleted_at, created_at
       FROM dm_messages
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [...params, limit + 1],
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse().map(toMessageView);
  if (page.length) {
    const placeholders = page.map(() => '?').join(', ');
    const reactions = await all<{ message_id: string; user_id: string; reaction: string }>(
      `SELECT message_id, user_id, reaction FROM dm_reactions WHERE message_id IN (${placeholders})`,
      page.map((message) => message.id),
    );
    const byMessage = new Map<string, { userId: string; reaction: string }[]>();
    for (const reaction of reactions) {
      const list = byMessage.get(reaction.message_id) ?? [];
      list.push({ userId: reaction.user_id, reaction: reaction.reaction });
      byMessage.set(reaction.message_id, list);
    }
    for (const message of page) message.reactions = byMessage.get(message.id) ?? [];
  }
  return { messages: page, hasMore };
}

export async function sendMessage(
  userId: string,
  conversationId: string,
  input: { ciphertext: string; iv: string; alg?: string; keyVersion?: number; replyToId?: string | null },
): Promise<MessageView> {
  await requireMembership(userId, conversationId);
  const otherId = await otherMember(conversationId, userId);
  if (otherId) {
    // Sending is an existing-conversation act, so only a block refuses it.
    const decision = await canMessage(userId, otherId, { existingConversation: true });
    if (!decision.ok) throw new HttpError(403, decision.reason, 'cannot_message');
  }

  const ciphertext = assertBase64(input.ciphertext, 'content');
  const iv = assertBase64(input.iv, 'encryption', 200);
  const alg = (input.alg ?? 'AES-256-GCM').slice(0, 40);
  if (alg !== 'AES-256-GCM') throw new HttpError(400, 'Unsupported message encryption.', 'bad_algorithm');
  const keyVersion = Math.min(Math.max(Math.trunc(input.keyVersion ?? 1), 1), 999);

  // Flood protection: a burst is refused with a readable message rather than silently dropped.
  const recent = await one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM dm_messages WHERE conversation_id = ? AND sender_id = ? AND created_at > ?`,
    [userId, conversationId, new Date(Date.now() - FLOOD_WINDOW_SECONDS * 1000).toISOString()],
  );
  if ((recent?.total ?? 0) >= FLOOD_MAX_IN_WINDOW) {
    throw new HttpError(429, 'You are sending messages very quickly. Take a breath and try again.', 'rate_limited');
  }

  let replyToId: string | null = null;
  if (input.replyToId) {
    const parent = await one<{ id: string }>(
      `SELECT id FROM dm_messages WHERE id = ? AND conversation_id = ?`,
      [input.replyToId, conversationId],
    );
    if (!parent) throw new HttpError(400, 'The message you replied to is no longer available.', 'validation_error');
    replyToId = parent.id;
  }

  const id = uuid();
  const now = nowIso();
  await run(
    `INSERT INTO dm_messages (id, conversation_id, sender_id, ciphertext, iv, alg, key_version, reply_to_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, conversationId, userId, ciphertext, iv, alg, keyVersion, replyToId, now],
  );
  await run(`UPDATE dm_conversations SET last_message_at = ?, updated_at = ? WHERE id = ?`, [now, now, conversationId]);

  const sender = await personCard(userId);
  for (const memberId of await memberIds(conversationId)) {
    if (memberId === userId) continue;
    const muted = await one<{ is_muted: number }>(
      `SELECT is_muted FROM dm_members WHERE conversation_id = ? AND user_id = ?`,
      [conversationId, memberId],
    );
    if (bool(muted?.is_muted)) continue;
    /*
     * Privacy-aware notification: the title names the sender and nothing else. A preview is not
     * possible anyway — the server holds ciphertext — and §28 asks that previews not leak content.
     */
    await createNotification({
      userId: memberId,
      kind: 'dm_message',
      title: `New message from ${sender?.name ?? 'a student'}`,
      body: '',
      link: `/messages/${conversationId}`,
    });
    publishUser(memberId, {
      type: 'dm_message',
      userId: memberId,
      conversationId,
      messageId: id,
      senderId: userId,
    });
  }

  return {
    id,
    conversationId,
    senderId: userId,
    ciphertext,
    iv,
    alg,
    keyVersion,
    replyToId,
    editedAt: null,
    deletedAt: null,
    createdAt: now,
    reactions: [],
  };
}

export async function editMessage(
  userId: string,
  messageId: string,
  input: { ciphertext: string; iv: string },
): Promise<MessageView> {
  const row = await one<{ id: string; conversation_id: string; sender_id: string; key_version: number; reply_to_id: string | null; created_at: string; deleted_at: string | null }>(
    `SELECT id, conversation_id, sender_id, key_version, reply_to_id, created_at, deleted_at FROM dm_messages WHERE id = ?`,
    [messageId],
  );
  if (!row) throw new HttpError(404, 'That message was not found.', 'not_found');
  await requireMembership(userId, row.conversation_id);
  if (row.sender_id !== userId) throw new HttpError(403, 'You can only edit your own message.', 'forbidden');
  if (row.deleted_at) throw new HttpError(400, 'That message was deleted.', 'validation_error');

  const ciphertext = assertBase64(input.ciphertext, 'content');
  const iv = assertBase64(input.iv, 'encryption', 200);
  const now = nowIso();
  await run(`UPDATE dm_messages SET ciphertext = ?, iv = ?, edited_at = ? WHERE id = ?`, [ciphertext, iv, now, messageId]);

  for (const memberId of await memberIds(row.conversation_id)) {
    if (memberId === userId) continue;
    publishUser(memberId, { type: 'dm_message_updated', userId: memberId, conversationId: row.conversation_id, messageId });
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    ciphertext,
    iv,
    alg: 'AES-256-GCM',
    keyVersion: row.key_version,
    replyToId: row.reply_to_id,
    editedAt: now,
    deletedAt: null,
    createdAt: row.created_at,
    reactions: [],
  };
}

export async function deleteMessage(userId: string, messageId: string): Promise<void> {
  const row = await one<{ id: string; conversation_id: string; sender_id: string }>(
    `SELECT id, conversation_id, sender_id FROM dm_messages WHERE id = ?`,
    [messageId],
  );
  if (!row) throw new HttpError(404, 'That message was not found.', 'not_found');
  await requireMembership(userId, row.conversation_id);
  // Private messages have no moderators: only the author can delete, and the ciphertext goes with it.
  if (row.sender_id !== userId) throw new HttpError(403, 'You can only delete your own message.', 'forbidden');

  await run(`UPDATE dm_messages SET deleted_at = ?, ciphertext = '', iv = '' WHERE id = ?`, [nowIso(), messageId]);
  await run(`DELETE FROM dm_reactions WHERE message_id = ?`, [messageId]);
  for (const memberId of await memberIds(row.conversation_id)) {
    if (memberId === userId) continue;
    publishUser(memberId, { type: 'dm_message_deleted', userId: memberId, conversationId: row.conversation_id, messageId });
  }
}

/**
 * Toggles one student's reaction.
 *
 * Returns the new tally, not just a boolean: the caller can render the result without a second read,
 * and the count it shows is the server's own.
 */
export async function toggleReaction(userId: string, messageId: string, reaction: string): Promise<{ added: boolean; reactions: { userId: string; reaction: string }[] }> {
  const emoji = String(reaction ?? '').trim().slice(0, 8);
  if (!emoji) throw new HttpError(400, 'Pick a reaction.', 'validation_error');
  const row = await one<{ conversation_id: string }>(`SELECT conversation_id FROM dm_messages WHERE id = ?`, [messageId]);
  if (!row) throw new HttpError(404, 'That message was not found.', 'not_found');
  await requireMembership(userId, row.conversation_id);

  const existing = await one<{ id: string }>(
    `SELECT id FROM dm_reactions WHERE message_id = ? AND user_id = ? AND reaction = ?`,
    [messageId, userId, emoji],
  );
  if (existing) {
    await run(`DELETE FROM dm_reactions WHERE id = ?`, [existing.id]);
  } else {
    await run(
      `INSERT INTO dm_reactions (id, message_id, conversation_id, user_id, reaction, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), messageId, row.conversation_id, userId, emoji, nowIso()],
    );
  }
  const reactions = await all<{ user_id: string; reaction: string }>(
    `SELECT user_id, reaction FROM dm_reactions WHERE message_id = ? ORDER BY created_at`,
    [messageId],
  );
  return { added: !existing, reactions: reactions.map((entry) => ({ userId: entry.user_id, reaction: entry.reaction })) };
}

export async function markRead(userId: string, conversationId: string): Promise<{ unread: number }> {
  await requireMembership(userId, conversationId);
  const now = nowIso();
  const existing = await one<{ id: string }>(
    `SELECT id FROM dm_receipts WHERE conversation_id = ? AND user_id = ?`,
    [conversationId, userId],
  );
  if (existing) {
    await run(`UPDATE dm_receipts SET last_read_at = ?, updated_at = ? WHERE id = ?`, [now, now, existing.id]);
  } else {
    await run(
      `INSERT INTO dm_receipts (id, conversation_id, user_id, last_read_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), conversationId, userId, now, now],
    );
  }
  const otherId = await otherMember(conversationId, userId);
  if (otherId) publishUser(otherId, { type: 'dm_read', userId: otherId, conversationId });
  return { unread: 0 };
}

export async function setConversationFlags(
  userId: string,
  conversationId: string,
  flags: { muted?: boolean; archived?: boolean },
): Promise<{ isMuted: boolean; isArchived: boolean }> {
  const membership = await requireMembership(userId, conversationId);
  const isMuted = flags.muted === undefined ? bool(membership.is_muted) : flags.muted;
  const isArchived = flags.archived === undefined ? bool(membership.is_archived) : flags.archived;
  await run(`UPDATE dm_members SET is_muted = ?, is_archived = ? WHERE conversation_id = ? AND user_id = ?`, [
    isMuted ? 1 : 0,
    isArchived ? 1 : 0,
    conversationId,
    userId,
  ]);
  return { isMuted, isArchived };
}

/** Typing is ephemeral by design: it is never stored, only relayed to the other participant. */
export async function signalTyping(userId: string, conversationId: string): Promise<void> {
  await requireMembership(userId, conversationId);
  const otherId = await otherMember(conversationId, userId);
  if (!otherId) return;
  publishUser(otherId, { type: 'dm_typing', userId: otherId, conversationId, senderId: userId });
}

/* ------------------------------------------------------------------ keys ------------------------- */

export async function registerDevice(
  userId: string,
  input: { deviceId: string; publicKey: unknown; label?: string },
): Promise<{ deviceId: string; alg: string }> {
  const deviceId = String(input.deviceId ?? '').trim().slice(0, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) {
    throw new HttpError(400, 'That device id is not valid.', 'validation_error');
  }
  const publicKey = input.publicKey as { kty?: string; crv?: string; x?: string; y?: string } | null;
  // Only the public half is ever accepted. A payload carrying `d` (the private scalar) is refused
  // rather than stored — the server must never hold a private key by accident (§7).
  if (
    !publicKey ||
    publicKey.kty !== 'EC' ||
    publicKey.crv !== 'P-256' ||
    typeof publicKey.x !== 'string' ||
    typeof publicKey.y !== 'string' ||
    'd' in publicKey
  ) {
    throw new HttpError(400, 'That public key is not valid.', 'validation_error');
  }

  const now = nowIso();
  const existing = await one<{ id: string }>(
    `SELECT id FROM dm_device_keys WHERE user_id = ? AND device_id = ?`,
    [userId, deviceId],
  );
  if (existing) {
    await run(`UPDATE dm_device_keys SET public_key = ?, last_seen_at = ?, label = ? WHERE id = ?`, [
      JSON.stringify(publicKey),
      now,
      String(input.label ?? '').slice(0, 60),
      existing.id,
    ]);
  } else {
    await run(
      `INSERT INTO dm_device_keys (id, user_id, device_id, public_key, alg, label, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'ECDH-P256', ?, ?, ?)`,
      [uuid(), userId, deviceId, JSON.stringify(publicKey), String(input.label ?? '').slice(0, 60), now, now],
    );
  }
  return { deviceId, alg: 'ECDH-P256' };
}

export async function listDevices(
  viewerId: string,
  userIds: string[],
): Promise<{ userId: string; deviceId: string; publicKey: unknown; createdAt: string }[]> {
  /*
   * A student may only read the device keys of somebody they are allowed to message, so the endpoint
   * cannot be used to enumerate keys across the platform.
   */
  const allowed: string[] = [];
  for (const id of [...new Set(userIds)].slice(0, 10)) {
    if (id === viewerId) {
      allowed.push(id);
      continue;
    }
    const decision = await canMessage(viewerId, id);
    if (decision.ok) allowed.push(id);
  }
  if (!allowed.length) return [];
  const placeholders = allowed.map(() => '?').join(', ');
  const rows = await all<{ user_id: string; device_id: string; public_key: string; created_at: string }>(
    `SELECT user_id, device_id, public_key, created_at FROM dm_device_keys
      WHERE user_id IN (${placeholders}) ORDER BY created_at LIMIT 50`,
    allowed,
  );
  return rows.map((row) => {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(row.public_key);
    } catch {
      parsed = null;
    }
    return { userId: row.user_id, deviceId: row.device_id, publicKey: parsed, createdAt: row.created_at };
  });
}

export async function listEnvelopes(userId: string, conversationId: string): Promise<EnvelopeView[]> {
  await requireMembership(userId, conversationId);
  const rows = await all<{
    conversation_id: string;
    device_id: string;
    recipient_user_id: string;
    sender_user_id: string;
    wrapped_key: string;
    iv: string;
    created_at: string;
  }>(
    // A student can read their own key envelopes only; another member's envelope is useless to them
    // anyway, and refusing it keeps the endpoint honest.
    `SELECT conversation_id, device_id, recipient_user_id, sender_user_id, wrapped_key, iv, created_at
       FROM dm_key_envelopes WHERE conversation_id = ? AND recipient_user_id = ?`,
    [conversationId, userId],
  );
  return rows.map((row) => ({
    conversationId: row.conversation_id,
    deviceId: row.device_id,
    recipientUserId: row.recipient_user_id,
    senderUserId: row.sender_user_id,
    wrappedKey: row.wrapped_key,
    iv: row.iv,
    createdAt: row.created_at,
  }));
}

/**
 * Stores the conversation key wrapped for one device.
 *
 * Only a member of the conversation may publish an envelope, and only for a device that belongs to a
 * member — so the table cannot be used as a general-purpose key drop. The caller supplies the wrapped
 * key; the server stores an opaque blob it cannot open.
 */
export async function putEnvelope(
  userId: string,
  conversationId: string,
  input: { recipientUserId: string; deviceId: string; wrappedKey: string; iv: string; keyVersion?: number },
): Promise<{ ok: true }> {
  await requireMembership(userId, conversationId);
  const members = await memberIds(conversationId);
  if (!members.includes(input.recipientUserId)) {
    throw new HttpError(403, 'That student is not part of this conversation.', 'forbidden');
  }
  const device = await one<{ id: string }>(
    `SELECT id FROM dm_device_keys WHERE user_id = ? AND device_id = ?`,
    [input.recipientUserId, input.deviceId],
  );
  if (!device) throw new HttpError(404, 'That device is not registered.', 'not_found');

  const wrappedKey = assertBase64(input.wrappedKey, 'key', MAX_ENVELOPE_CHARS);
  const iv = assertBase64(input.iv, 'key encryption', 200);

  const existing = await one<{ id: string }>(
    `SELECT id FROM dm_key_envelopes WHERE conversation_id = ? AND device_id = ?`,
    [conversationId, input.deviceId],
  );
  if (existing) {
    await run(`UPDATE dm_key_envelopes SET wrapped_key = ?, iv = ?, sender_user_id = ?, created_at = ? WHERE id = ?`, [
      wrappedKey,
      iv,
      userId,
      nowIso(),
      existing.id,
    ]);
  } else {
    await run(
      `INSERT INTO dm_key_envelopes (id, conversation_id, device_id, recipient_user_id, sender_user_id, wrapped_key, iv, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), conversationId, input.deviceId, input.recipientUserId, userId, wrappedKey, iv, nowIso()],
    );
  }
  if (input.recipientUserId !== userId) {
    publishUser(input.recipientUserId, { type: 'dm_key', userId: input.recipientUserId, conversationId });
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ blocks & prefs --------------- */

export async function blockUser(userId: string, targetId: string): Promise<{ blocked: boolean }> {
  if (userId === targetId) throw new HttpError(400, 'You cannot block yourself.', 'validation_error');
  const target = await one<{ id: string }>(`SELECT id FROM users WHERE id = ?`, [targetId]);
  if (!target) throw new HttpError(404, 'That student was not found.', 'not_found');

  const existing = await one<{ id: string }>(
    `SELECT id FROM community_blocks WHERE user_id = ? AND blocked_user_id = ?`,
    [userId, targetId],
  );
  if (!existing) {
    await run(`INSERT INTO community_blocks (id, user_id, blocked_user_id, created_at) VALUES (?, ?, ?, ?)`, [
      uuid(),
      userId,
      targetId,
      nowIso(),
    ]);
  }
  return { blocked: true };
}

export async function unblockUser(userId: string, targetId: string): Promise<{ blocked: boolean }> {
  await run(`DELETE FROM community_blocks WHERE user_id = ? AND blocked_user_id = ?`, [userId, targetId]);
  return { blocked: false };
}

export async function listBlocked(userId: string): Promise<{ userId: string; name: string; blockedAt: string }[]> {
  return all<{ userId: string; name: string; blockedAt: string }>(
    `SELECT b.blocked_user_id AS userId, u.name, b.created_at AS blockedAt
       FROM community_blocks b JOIN users u ON u.id = b.blocked_user_id
      WHERE b.user_id = ? ORDER BY b.created_at DESC LIMIT 100`,
    [userId],
  );
}

export async function setMessagePolicy(userId: string, policy: string): Promise<{ dmPolicy: DmPolicy }> {
  const normalised = normalisePolicy(policy);
  const existing = await one<{ id: string }>(`SELECT id FROM community_profile_settings WHERE user_id = ?`, [userId]);
  if (existing) {
    await run(`UPDATE community_profile_settings SET dm_policy = ?, updated_at = ? WHERE user_id = ?`, [
      normalised,
      nowIso(),
      userId,
    ]);
  } else {
    await run(
      `INSERT INTO community_profile_settings (id, user_id, bio, interests, is_profile_public, is_activity_visible,
        is_communities_visible, achievements_visibility, accent, dm_policy, updated_at)
       VALUES (?, ?, '', '[]', 1, 1, 1, 1, '', ?, ?)`,
      [uuid(), userId, normalised, nowIso()],
    );
  }
  return { dmPolicy: normalised };
}

/** A report about a conversation or a message. Stored in the same moderation table as everything else. */
export async function report(
  userId: string,
  input: { conversationId?: string; messageId?: string; targetUserId?: string; reason: string; note?: string },
): Promise<{ ok: true; reportId: string }> {
  const reason = String(input.reason ?? '').trim().slice(0, 120);
  if (!reason) throw new HttpError(400, 'Choose a reason for the report.', 'validation_error');

  let entityId = input.targetUserId ?? '';
  if (input.messageId) {
    const row = await one<{ conversation_id: string; sender_id: string }>(
      `SELECT conversation_id, sender_id FROM dm_messages WHERE id = ?`,
      [input.messageId],
    );
    if (!row) throw new HttpError(404, 'That message was not found.', 'not_found');
    await requireMembership(userId, row.conversation_id);
    entityId = row.sender_id;
  } else if (input.conversationId) {
    await requireMembership(userId, input.conversationId);
    entityId = (await otherMember(input.conversationId, userId)) ?? '';
  }
  if (!entityId) throw new HttpError(400, 'Nothing to report.', 'validation_error');
  if (input.targetUserId && input.targetUserId === userId) {
    throw new HttpError(400, 'You cannot report yourself.', 'validation_error');
  }

  const id = uuid();
  await run(
    `INSERT INTO dm_reports (id, reporter_id, conversation_id, message_id, target_user_id, reason, note, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    [
      id,
      userId,
      input.conversationId ?? null,
      input.messageId ?? null,
      entityId,
      reason,
      String(input.note ?? '').slice(0, 400),
      nowIso(),
    ],
  );
  return { ok: true, reportId: id };
}

/**
 * A student sees the reports they filed (and their outcome); staff see the whole queue. The check
 * happens in the route, because "who may read everything" is an authorisation decision, not a query
 * decision.
 */
export async function listReports(
  userId: string,
  options: { all?: boolean } = {},
): Promise<
  {
    id: string;
    reason: string;
    note: string;
    status: string;
    actionTaken: string | null;
    createdAt: string;
    resolvedAt: string | null;
    mine: boolean;
    targetUserId: string;
    conversationId: string | null;
  }[]
> {
  const rows = await all<{
    id: string;
    reporter_id: string;
    reason: string;
    note: string;
    status: string;
    action_taken: string | null;
    created_at: string;
    resolved_at: string | null;
    target_user_id: string;
    conversation_id: string | null;
  }>(
    options.all
      ? `SELECT id, reporter_id, reason, note, status, action_taken, created_at, resolved_at, target_user_id, conversation_id
           FROM dm_reports ORDER BY created_at DESC LIMIT 200`
      : `SELECT id, reporter_id, reason, note, status, action_taken, created_at, resolved_at, target_user_id, conversation_id
           FROM dm_reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 100`,
    options.all ? [] : [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    reason: row.reason,
    note: row.note,
    status: row.status,
    actionTaken: row.action_taken,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    mine: row.reporter_id === userId,
    targetUserId: row.target_user_id,
    conversationId: row.conversation_id,
  }));
}

/** Staff decision on a report. Only the status, the action and the timestamp are recorded. */
export async function resolveReport(
  adminId: string,
  reportId: string,
  input: { status: 'reviewing' | 'actioned' | 'dismissed'; actionTaken?: string },
): Promise<{ ok: true; status: string }> {
  const existing = await one<{ id: string }>(`SELECT id FROM dm_reports WHERE id = ?`, [reportId]);
  if (!existing) throw new HttpError(404, 'That report was not found.', 'not_found');
  await run(`UPDATE dm_reports SET status = ?, action_taken = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`, [
    input.status,
    String(input.actionTaken ?? '').slice(0, 200) || null,
    adminId,
    input.status === 'reviewing' ? null : nowIso(),
    reportId,
  ]);
  return { ok: true, status: input.status };
}
