/**
 * Community chat.
 *
 * Design decisions worth stating:
 *
 *  - **Cursor pagination, not offset.** Chat grows at the head; offset paging would duplicate or skip
 *    rows as new messages arrive. `before` is the `(created_at, id)` of the oldest message the client
 *    already has, and the page size is capped (§54: never load thousands of messages at once).
 *  - **Soft delete.** `deleted_at` is set and the body is never returned again. A moderator delete is
 *    recorded so the audit trail survives without keeping the content on screen.
 *  - **Fetch in two passes.** The page of messages is loaded first, then authors, reactions and
 *    attachments for exactly those ids — a bounded number of queries rather than a query per row.
 */
import { all, bool, nowIso, one, run, uuid } from '../../db/index.js';
import { HttpError } from '../../middleware/errors.js';
import { assertCanPost, addContribution, recordModeration } from './communities.js';
import { loadForMember } from './access.js';
import { publishCommunity } from './bus.js';
import { createNotification, notifyOnce } from './notifications.js';
import { assertCan, isCommunityRole, type CommunityRole } from './permissions.js';
import { pollView } from './polls.js';
import type { ChatMessageView, PollView } from './types.js';

export const MAX_MESSAGE_LENGTH = 4000;
const PAGE_SIZE = 40;

interface MessageRow {
  id: string;
  community_id: string;
  user_id: string;
  body: string;
  parent_id: string | null;
  is_pinned: number | null;
  is_announcement: number | null;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  parent_body?: string | null;
  thread_id?: string | null;
}

/* ------------------------------------------------------------------ read ------------------------ */

export interface ListMessagesOptions {
  /** Return messages older than this cursor (walking back through history). */
  before?: string;
  /** Return messages newer than this cursor (catching up after a reconnect). */
  after?: string;
  limit?: number;
  /** Restricted to one thread's replies. */
  threadId?: string;
  /** Substring search over message bodies. Moderators and members both get this, scoped to one community. */
  search?: string;
}

function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const [createdAt, id] = cursor.split('|');
  if (!createdAt || !id) return null;
  return { createdAt, id };
}

export function encodeCursor(createdAt: string, id: string): string {
  return `${createdAt}|${id}`;
}

export async function listMessages(
  userId: string,
  communityId: string,
  options: ListMessagesOptions = {},
): Promise<{ messages: ChatMessageView[]; nextCursor: string | null; hasMore: boolean }> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  const limit = Math.min(Math.max(options.limit ?? PAGE_SIZE, 1), 80);

  const where = ['m.community_id = ?'];
  const params: unknown[] = [communityId];

  if (options.threadId) {
    where.push('m.parent_id = ?');
    params.push(options.threadId);
  } else if (!options.search) {
    // The main feed shows top-level messages; replies are fetched per thread.
    where.push('m.parent_id IS NULL');
  }

  const before = decodeCursor(options.before);
  if (before) {
    where.push('(m.created_at < ? OR (m.created_at = ? AND m.id < ?))');
    params.push(before.createdAt, before.createdAt, before.id);
  }

  const after = decodeCursor(options.after);
  if (after) {
    where.push('(m.created_at > ? OR (m.created_at = ? AND m.id > ?))');
    params.push(after.createdAt, after.createdAt, after.id);
  }

  if (options.search?.trim()) {
    where.push('LOWER(m.body) LIKE ? AND m.deleted_at IS NULL');
    params.push(`%${options.search.trim().toLowerCase().slice(0, 80)}%`);
  }

  const rows = await all<MessageRow>(
    `SELECT m.id, m.community_id, m.user_id, m.body, m.parent_id, m.is_pinned, m.is_announcement,
            m.edited_at, m.deleted_at, m.deleted_by, m.created_at,
            p.body AS parent_body
       FROM community_messages m
       LEFT JOIN community_messages p ON p.id = m.parent_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?`,
    [...params, limit + 1],
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Walking back through history: the caller wants oldest-first within the page.
  const ordered = options.after ? [...page].reverse() : page;
  const messages = await hydrate(userId, communityId, ordered, membership?.role ?? null);

  const oldest = page[page.length - 1];
  return {
    messages,
    nextCursor: hasMore && oldest ? encodeCursor(oldest.created_at, oldest.id) : null,
    hasMore,
  };
}

/**
 * Turns rows into views with a bounded number of queries: one for authors, one for reactions, one
 * for polls, one for attachments. No per-message round trips, so a 40-message page is always cheap.
 */
async function hydrate(
  userId: string,
  communityId: string,
  rows: MessageRow[],
  role: CommunityRole | null,
): Promise<ChatMessageView[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);

  const [authors, reactions, polls, attachments] = await Promise.all([
    (async () => {
      const authorIds = [...new Set(rows.map((row) => row.user_id))];
      const placeholders = authorIds.map(() => '?').join(', ');
      const names = await all<{ id: string; name: string }>(
        `SELECT id, name FROM users WHERE id IN (${placeholders})`,
        authorIds,
      );
      const roles = await all<{ user_id: string; role: string }>(
        `SELECT user_id, role FROM community_members WHERE community_id = ? AND user_id IN (${placeholders})`,
        [communityId, ...authorIds],
      );
      return {
        name: new Map(names.map((n) => [n.id, n.name])),
        role: new Map(roles.map((r) => [r.user_id, isCommunityRole(r.role) ? r.role : 'member'])),
      };
    })(),
    (async () => {
      const placeholders = ids.map(() => '?').join(', ');
      const rows2 = await all<{ message_id: string; emoji: string; user_id: string }>(
        `SELECT message_id, emoji, user_id FROM message_reactions WHERE message_id IN (${placeholders})`,
        ids,
      );
      const map = new Map<string, Map<string, { count: number; mine: boolean }>>();
      for (const row of rows2) {
        const perMessage = map.get(row.message_id) ?? new Map();
        const entry = perMessage.get(row.emoji) ?? { count: 0, mine: false };
        entry.count += 1;
        if (row.user_id === userId) entry.mine = true;
        perMessage.set(row.emoji, entry);
        map.set(row.message_id, perMessage);
      }
      return map;
    })(),
    pollViewForMessages(userId, ids),
    attachmentsFor(rows),
  ]);

  const moderator = role === 'owner' || role === 'admin' || role === 'moderator';

  return rows.map((row) => {
    const isDeleted = Boolean(row.deleted_at);
    const reactionMap = reactions.get(row.id);
    return {
      id: row.id,
      communityId: row.community_id,
      userId: row.user_id,
      authorName: authors.name.get(row.user_id) ?? 'A Vroqn student',
      authorRole: authors.role.get(row.user_id) ?? 'member',
      // A deleted message keeps its place in the timeline but loses its content.
      body: isDeleted ? '' : row.body,
      editedAt: row.edited_at,
      isDeleted,
      deletedByModerator: Boolean(row.deleted_by && row.deleted_by !== row.user_id),
      isPinned: bool(row.is_pinned),
      isAnnouncement: bool(row.is_announcement),
      parentId: row.parent_id,
      parentPreview: row.parent_body ? row.parent_body.slice(0, 120) : null,
      reactions: reactionMap
        ? [...reactionMap.entries()].map(([emoji, entry]) => ({ emoji, count: entry.count, mine: entry.mine }))
        : [],
      attachment: attachments.get(row.id) ?? null,
      poll: polls.get(row.id) ?? null,
      createdAt: row.created_at,
      isMine: row.user_id === userId,
      canDelete: !isDeleted && (row.user_id === userId || moderator),
    };
  });
}

/**
 * Shared-content attachments are encoded in the message body as a compact marker written by
 * `sendMessage`. Keeping them in the body means sharing works with no extra table, and the marker is
 * stripped from the rendered text so it never shows up as noise.
 */
const ATTACH_RE = /^\[\[vroqn:(doubt|resource|competition|note):([\w-]+):([^\]|]+)\]\]\n?/;

async function attachmentsFor(rows: MessageRow[]) {
  const map = new Map<string, { kind: 'doubt' | 'resource' | 'competition' | 'note'; id: string; title: string }>();
  for (const row of rows) {
    const match = ATTACH_RE.exec(row.body ?? '');
    if (!match) continue;
    map.set(row.id, {
      kind: match[1] as 'doubt' | 'resource' | 'competition' | 'note',
      id: match[2]!,
      title: match[3]!.slice(0, 120),
    });
  }
  return map;
}

async function pollViewForMessages(userId: string, messageIds: string[]): Promise<Map<string, PollView>> {
  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = await all<{ id: string; message_id: string | null }>(
    `SELECT id, message_id FROM community_polls WHERE message_id IN (${placeholders})`,
    messageIds,
  );
  const map = new Map<string, PollView>();
  for (const row of rows) {
    if (!row.message_id) continue;
    const view = await pollView(userId, row.id);
    if (view) map.set(row.message_id, view);
  }
  return map;
}

/* ------------------------------------------------------------------ write ----------------------- */

export interface SendMessageArgs {
  body: string;
  parentId?: string | null;
  isAnnouncement?: boolean;
  attachment?: { kind: 'doubt' | 'resource' | 'competition' | 'note'; id: string; title: string } | null;
}

export async function sendMessage(
  userId: string,
  communityId: string,
  args: SendMessageArgs,
): Promise<ChatMessageView> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCanPost(membership);

  const raw = (args.body ?? '').trim();
  if (!raw) throw new HttpError(400, 'Write a message first.', 'validation_error');
  if (raw.length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(400, `Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`, 'validation_error');
  }

  // Announcements are a privileged message type, not something anyone can flag on their own post.
  const announcement = Boolean(args.isAnnouncement);
  if (announcement) assertCan(membership?.role ?? null, 'create_announcement');

  let parentId: string | null = null;
  if (args.parentId) {
    const parent = await one<{ id: string; community_id: string; parent_id: string | null }>(
      `SELECT id, community_id, parent_id FROM community_messages WHERE id = ?`,
      [args.parentId],
    );
    // A parent from another community would let one community's message quote another's — refuse it.
    if (!parent || parent.community_id !== communityId) {
      throw new HttpError(400, 'The message you are replying to is not in this community.', 'validation_error');
    }
    // Flatten nested threads to two levels: replies to replies attach to the original.
    parentId = parent.parent_id ?? parent.id;
  }

  let body = raw;
  if (args.attachment) {
    const title = args.attachment.title.replace(/[\]|\n]/g, ' ').slice(0, 120);
    body = `[[vroqn:${args.attachment.kind}:${args.attachment.id}:${title}]]\n${raw}`;
  }

  const id = uuid();
  const now = nowIso();
  await run(
    `INSERT INTO community_messages
       (id, community_id, user_id, body, parent_id, is_pinned, is_announcement, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    [id, communityId, userId, body, parentId, announcement ? 1 : 0, now],
  );

  // Posting is a small contribution; it is deliberately worth less than a helpful answer (§36).
  await addContribution(communityId, userId, 1);

  publishCommunity(communityId, { type: 'message', communityId, messageId: id, authorId: userId });

  await notifyRecipients({ communityId, messageId: id, parentId, authorId: userId, preview: raw });

  const rows = await all<MessageRow>(
    `SELECT m.id, m.community_id, m.user_id, m.body, m.parent_id, m.is_pinned, m.is_announcement,
            m.edited_at, m.deleted_at, m.deleted_by, m.created_at, p.body AS parent_body
       FROM community_messages m LEFT JOIN community_messages p ON p.id = m.parent_id
      WHERE m.id = ?`,
    [id],
  );
  const [view] = await hydrate(userId, communityId, rows, membership?.role ?? null);
  return view!;
}

/** Reply → the parent's author. @mention → that student, once per hour at most. */
async function notifyRecipients(args: {
  communityId: string;
  messageId: string;
  parentId: string | null;
  authorId: string;
  preview: string;
}): Promise<void> {
  const community = await one<{ name: string }>(`SELECT name FROM communities WHERE id = ?`, [args.communityId]);
  const link = `/communities/${args.communityId}?tab=chat`;

  if (args.parentId) {
    const parent = await one<{ user_id: string }>(
      `SELECT user_id FROM community_messages WHERE id = ?`,
      [args.parentId],
    );
    if (parent && parent.user_id !== args.authorId) {
      await createNotification({
        userId: parent.user_id,
        communityId: args.communityId,
        kind: 'reply',
        title: `New reply in ${community?.name ?? 'your community'}`,
        body: args.preview.slice(0, 140),
        link,
      });
    }
  }

  // Mentions are resolved against actual members only, so a mention cannot be used to probe for
  // usernames that are not in the community.
  const mentions = [...new Set((args.preview.match(/@([\w.\-]{2,40})/g) ?? []).map((m) => m.slice(1)))].slice(0, 5);
  if (!mentions.length) return;

  for (const handle of mentions) {
    const mentioned = await one<{ id: string; name: string }>(
      `SELECT u.id, u.name FROM users u
         JOIN community_members m ON m.user_id = u.id
        WHERE m.community_id = ? AND m.status IN ('active','muted')
          AND (LOWER(REPLACE(u.name, ' ', '')) = ? OR LOWER(u.name) = ?)
        LIMIT 1`,
      [args.communityId, handle.toLowerCase(), handle.toLowerCase()],
    );
    if (!mentioned || mentioned.id === args.authorId) continue;
    await notifyOnce({
      userId: mentioned.id,
      communityId: args.communityId,
      kind: 'mention',
      title: `You were mentioned in ${community?.name ?? 'a community'}`,
      body: args.preview.slice(0, 140),
      link,
      dedupeKey: `mention:${args.messageId}`,
      windowMinutes: 60,
    });
  }
}

export async function editMessage(
  userId: string,
  communityId: string,
  messageId: string,
  body: string,
): Promise<ChatMessageView> {
  const { role } = await loadForMember(userId, communityId, { requireMembership: true });
  const message = await one<{ id: string; user_id: string; deleted_at: string | null }>(
    `SELECT id, user_id, deleted_at FROM community_messages WHERE id = ? AND community_id = ?`,
    [messageId, communityId],
  );
  if (!message) throw new HttpError(404, 'That message no longer exists.', 'not_found');
  if (message.user_id !== userId) throw new HttpError(403, 'You can only edit your own messages.', 'forbidden');
  if (message.deleted_at) throw new HttpError(400, 'That message was deleted.', 'validation_error');

  const text = body.trim();
  if (!text) throw new HttpError(400, 'A message cannot be empty.', 'validation_error');
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(400, `Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`, 'validation_error');
  }

  await run(`UPDATE community_messages SET body = ?, edited_at = ? WHERE id = ?`, [
    text,
    nowIso(),
    messageId,
  ]);
  publishCommunity(communityId, { type: 'message_updated', communityId, messageId });

  // The canonical row comes back, so an edit is never rendered from a client-side guess.
  const rows = await all<MessageRow>(`SELECT * FROM community_messages WHERE id = ?`, [messageId]);
  const [view] = await hydrate(userId, communityId, rows, role);
  if (!view) throw new HttpError(404, 'That message no longer exists.', 'not_found');
  return view;
}

export async function deleteMessage(
  userId: string,
  communityId: string,
  messageId: string,
): Promise<void> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  const message = await one<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM community_messages WHERE id = ? AND community_id = ?`,
    [messageId, communityId],
  );
  if (!message) throw new HttpError(404, 'That message no longer exists.', 'not_found');

  const isOwn = message.user_id === userId;
  if (!isOwn) {
    assertCan(membership?.role ?? null, 'moderate_messages');
  }

  const now = nowIso();
  await run(`UPDATE community_messages SET deleted_at = ?, deleted_by = ?, body = '' WHERE id = ?`, [
    now,
    userId,
    messageId,
  ]);

  if (!isOwn) {
    await recordModeration(communityId, userId, 'message_deleted', 'message', messageId, 'Moderator removal', message.user_id);
    await createNotification({
      userId: message.user_id,
      communityId,
      kind: 'moderation',
      title: 'A message of yours was removed',
      body: 'A community moderator removed a message for breaking the community rules.',
      link: `/communities/${communityId}?tab=chat`,
    });
  }

  publishCommunity(communityId, { type: 'message_deleted', communityId, messageId });
}

export async function togglePin(
  userId: string,
  communityId: string,
  messageId: string,
): Promise<{ isPinned: boolean }> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCan(membership?.role ?? null, 'moderate_messages');

  const message = await one<{ id: string; is_pinned: number | null }>(
    `SELECT id, is_pinned FROM community_messages WHERE id = ? AND community_id = ? AND deleted_at IS NULL`,
    [messageId, communityId],
  );
  if (!message) throw new HttpError(404, 'That message no longer exists.', 'not_found');

  const next = bool(message.is_pinned) ? 0 : 1;
  await run(`UPDATE community_messages SET is_pinned = ? WHERE id = ?`, [next, messageId]);
  await recordModeration(communityId, userId, next ? 'message_pinned' : 'message_unpinned', 'message', messageId, '');
  publishCommunity(communityId, { type: 'message_updated', communityId, messageId });
  return { isPinned: Boolean(next) };
}

/* ------------------------------------------------------------------ reactions ------------------- */

/** A small, curated set — an arbitrary emoji picker invites noise and makes moderation harder. */
export const ALLOWED_REACTIONS = ['👍', '🎯', '💡', '🔥', '🙏', '😂', '❤️', '✅'] as const;

export async function toggleReaction(
  userId: string,
  communityId: string,
  messageId: string,
  emoji: string,
): Promise<{ reactions: { emoji: string; count: number; mine: boolean }[] }> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCanPost(membership);

  if (!(ALLOWED_REACTIONS as readonly string[]).includes(emoji)) {
    throw new HttpError(400, 'That reaction is not available.', 'validation_error');
  }

  const message = await one<{ id: string; deleted_at: string | null }>(
    `SELECT id, deleted_at FROM community_messages WHERE id = ? AND community_id = ?`,
    [messageId, communityId],
  );
  if (!message || message.deleted_at) throw new HttpError(404, 'That message no longer exists.', 'not_found');

  const existing = await one<{ id: string }>(
    `SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
    [messageId, userId, emoji],
  );
  if (existing) {
    await run(`DELETE FROM message_reactions WHERE id = ?`, [existing.id]);
  } else {
    await run(
      `INSERT INTO message_reactions (id, message_id, community_id, user_id, emoji, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), messageId, communityId, userId, emoji, nowIso()],
    );
  }

  publishCommunity(communityId, { type: 'reaction', communityId, messageId });

  const rows = await all<{ emoji: string; user_id: string }>(
    `SELECT emoji, user_id FROM message_reactions WHERE message_id = ?`,
    [messageId],
  );
  const tally = new Map<string, { count: number; mine: boolean }>();
  for (const row of rows) {
    const entry = tally.get(row.emoji) ?? { count: 0, mine: false };
    entry.count += 1;
    if (row.user_id === userId) entry.mine = true;
    tally.set(row.emoji, entry);
  }
  return {
    reactions: [...tally.entries()].map(([key, value]) => ({ emoji: key, ...value })),
  };
}

/* ------------------------------------------------------------------ threads --------------------- */

/** Reply count per top-level message, so the feed can show "3 replies" without loading them. */
export async function replyCounts(communityId: string, messageIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!messageIds.length) return map;
  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = await all<{ parent_id: string; count: number }>(
    `SELECT parent_id, COUNT(*) AS count FROM community_messages
      WHERE community_id = ? AND parent_id IN (${placeholders}) AND deleted_at IS NULL
      GROUP BY parent_id`,
    [communityId, ...messageIds],
  );
  for (const row of rows) map.set(row.parent_id, row.count);
  return map;
}

/** Strip the attachment marker so the UI renders the attachment separately from the text. */
export function cleanBody(body: string): string {
  return body.replace(ATTACH_RE, '');
}

export { cleanBody as stripAttachmentMarker };
