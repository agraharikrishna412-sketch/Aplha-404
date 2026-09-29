/**
 * Notification centre.
 *
 * Notifications are written by the services that cause them (a join request, a reply, a result) and
 * read back here. Two principles from §37 and §43 shape it:
 *
 *  - **Never spam.** A preference row per user can mute whole kinds, and the `notifyOnce` helper
 *    collapses repeats of the same event into one row rather than one row per occurrence.
 *  - **Never leak.** Notification text is generated server-side and only ever describes things the
 *    recipient is already entitled to see; the link is re-authorised when it is followed.
 */
import { all, bool, nowIso, one, run, uuid } from '../../db/index.js';
import { publishUser } from './bus.js';
import { NOTIFICATION_KINDS, type NotificationView } from './types.js';

export interface CreateNotificationArgs {
  userId: string;
  communityId?: string | null;
  kind: string;
  title: string;
  body?: string;
  link?: string | null;
}

/** Kinds the recipient has muted. Cached implicitly by the DB; the table is tiny. */
async function mutedKinds(userId: string): Promise<Set<string>> {
  const row = await one<{ muted_kinds: string | null }>(
    `SELECT muted_kinds FROM community_notification_prefs WHERE user_id = ?`,
    [userId],
  );
  if (!row?.muted_kinds) return new Set();
  try {
    const parsed = JSON.parse(row.muted_kinds);
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

export async function createNotification(args: CreateNotificationArgs): Promise<void> {
  if (!args.userId) return;
  if (await isMuted(args.userId, args.kind)) return;

  const id = uuid();
  await run(
    `INSERT INTO community_notifications (id, user_id, community_id, kind, title, body, link, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      id,
      args.userId,
      args.communityId ?? null,
      args.kind.slice(0, 40),
      args.title.slice(0, 160),
      (args.body ?? '').slice(0, 400),
      args.link ?? null,
      nowIso(),
    ],
  );

  // Push to the user's open streams so the badge updates without a refresh.
  publishUser(args.userId, { type: 'notification', userId: args.userId, notificationId: id });
}

/**
 * Collapse repeats: only create the notification if nothing identical was sent to this user in the
 * last `windowMinutes`. Used for chatty events (a busy thread mentioning the same person).
 */
export async function notifyOnce(
  args: CreateNotificationArgs & { dedupeKey: string; windowMinutes?: number },
): Promise<void> {
  const windowMs = (args.windowMinutes ?? 60) * 60_000;
  const since = new Date(Date.now() - windowMs).toISOString();
  const existing = await one<{ id: string }>(
    `SELECT id FROM community_notifications
      WHERE user_id = ? AND kind = ? AND title = ? AND body = ? AND created_at > ?`,
    [args.userId, args.kind.slice(0, 40), args.title.slice(0, 160), (args.body ?? '').slice(0, 400), since],
  );
  if (existing) return;
  await createNotification(args);
}

async function isMuted(userId: string, kind: string): Promise<boolean> {
  const muted = await mutedKinds(userId);
  return muted.has(kind);
}

/* ------------------------------------------------------------------ reads ----------------------- */

export async function listNotifications(
  userId: string,
  options: { limit?: number; offset?: number; unreadOnly?: boolean } = {},
): Promise<{ notifications: NotificationView[]; unread: number }> {
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  const rows = await all<{
    id: string;
    community_id: string | null;
    community_name: string | null;
    kind: string;
    title: string;
    body: string;
    link: string | null;
    is_read: number;
    created_at: string;
  }>(
    `SELECT n.id, n.community_id, c.name AS community_name, n.kind, n.title, n.body, n.link,
            n.is_read, n.created_at
       FROM community_notifications n
       LEFT JOIN communities c ON c.id = n.community_id
      WHERE n.user_id = ?${options.unreadOnly ? ' AND n.is_read = 0' : ''}
      ORDER BY n.created_at DESC
      LIMIT ? OFFSET ?`,
    [userId, limit, offset],
  );

  const unread = await one<{ count: number }>(
    `SELECT COUNT(*) AS count FROM community_notifications WHERE user_id = ? AND is_read = 0`,
    [userId],
  );

  return {
    notifications: rows.map((row) => ({
      id: row.id,
      communityId: row.community_id,
      communityName: row.community_name,
      kind: row.kind,
      title: row.title,
      body: row.body,
      link: row.link,
      isRead: bool(row.is_read),
      createdAt: row.created_at,
    })),
    unread: unread?.count ?? 0,
  };
}

export async function unreadCount(userId: string): Promise<number> {
  const row = await one<{ count: number }>(
    `SELECT COUNT(*) AS count FROM community_notifications WHERE user_id = ? AND is_read = 0`,
    [userId],
  );
  return row?.count ?? 0;
}

export async function markRead(userId: string, notificationId: string): Promise<void> {
  await run(`UPDATE community_notifications SET is_read = 1 WHERE id = ? AND user_id = ?`, [notificationId, userId]);
}

export async function markAllRead(userId: string): Promise<number> {
  const before = await unreadCount(userId);
  await run(`UPDATE community_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`, [userId]);
  return before;
}

/* ------------------------------------------------------------------ preferences ----------------- */

export async function getPreferences(userId: string): Promise<{ mutedKinds: string[]; allKinds: string[] }> {
  const muted = await mutedKinds(userId);
  return { mutedKinds: [...muted], allKinds: [...NOTIFICATION_KINDS] };
}

export async function setPreferences(userId: string, mutedKinds: unknown): Promise<{ mutedKinds: string[] }> {
  const valid = new Set<string>(NOTIFICATION_KINDS);
  const list = Array.isArray(mutedKinds)
    ? [...new Set(mutedKinds.filter((k): k is string => typeof k === 'string' && valid.has(k)))]
    : [];
  const encoded = JSON.stringify(list);
  const existing = await one<{ id: string }>(
    `SELECT id FROM community_notification_prefs WHERE user_id = ?`,
    [userId],
  );
  if (existing) {
    await run(`UPDATE community_notification_prefs SET muted_kinds = ?, updated_at = ? WHERE id = ?`, [
      encoded,
      nowIso(),
      existing.id,
    ]);
  } else {
    await run(
      `INSERT INTO community_notification_prefs (id, user_id, muted_kinds, updated_at) VALUES (?, ?, ?, ?)`,
      [uuid(), userId, encoded, nowIso()],
    );
  }
  return { mutedKinds: list };
}

/**
 * Fan a notification out to community members.
 *
 * `roles` narrows delivery (for example "only mentors+"), and `exclude` keeps the actor from being
 * notified about their own action.
 */
export async function notifyCommunityMembers(args: {
  communityId: string;
  kind: string;
  title: string;
  body?: string;
  link?: string | null;
  excludeUserId?: string;
  roles?: string[];
}): Promise<number> {
  const params: unknown[] = [args.communityId];
  let roleFilter = '';
  if (args.roles?.length) {
    roleFilter = ` AND role IN (${args.roles.map(() => '?').join(', ')})`;
    params.push(...args.roles);
  }
  const members = await all<{ user_id: string }>(
    `SELECT user_id FROM community_members
      WHERE community_id = ? AND status IN ('active','muted')${roleFilter}`,
    params,
  );
  let sent = 0;
  for (const member of members) {
    if (member.user_id === args.excludeUserId) continue;
    await notifyOnce({
      userId: member.user_id,
      communityId: args.communityId,
      kind: args.kind,
      title: args.title,
      body: args.body,
      link: args.link,
      dedupeKey: `${args.kind}:${args.title}`,
    });
    sent += 1;
  }
  return sent;
}
