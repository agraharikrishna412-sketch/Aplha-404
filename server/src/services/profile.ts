/**
 * Student profiles (§19).
 *
 * One profile per student, stored in `community_profile_settings` — the table that already held a bio
 * and privacy switches — extended in migration 0009 with a handle, an avatar, an accent and a message
 * policy. Keeping one row per student means there is no second source of truth to drift.
 *
 * Three rules shape this module:
 *
 *  - **Privacy is decided server-side.** `profileFor` returns different fields depending on who is
 *    asking and how the owner set `profile_visibility`. A private profile still answers with the
 *    minimum a stranger needs (name, handle, avatar) and nothing else.
 *  - **No contact details, ever.** There is no email, phone or address field to leak (§43). The handle
 *    exists so a student can be found and messaged inside Vroqn without exchanging anything personal.
 *  - **Nothing arbitrary is stored.** Accent is validated as a hex colour, handle against a strict
 *    pattern, bio and interests are length-capped text rendered as text.
 */
import path from 'node:path';
import { all, bool, nowIso, one, run, uuid } from '../db/index.js';
import { HttpError } from '../middleware/errors.js';
import { config } from '../config/env.js';

/* ------------------------------------------------------------------ types ----------------------- */

export type ProfileVisibility = 'public' | 'members' | 'private';
export type DmPolicy = 'everyone' | 'communities' | 'nobody';

export interface ProfileView {
  userId: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  accent: string;
  bio: string;
  interests: string[];
  classLevel: string | null;
  board: string | null;
  joinedAt: string;
  /** Only present when the viewer is allowed to see them. */
  communities?: { id: string; name: string; slug: string; role: string }[];
  /**
   * How many communities the viewer and this student share.
   *
   * Not a privacy leak: the viewer can already tell who is in their own communities, and it is the
   * single most useful line when deciding whether to reach out. Omitted for your own profile.
   */
  sharedCommunities?: number;
  badges?: { key: string; label: string; awardedAt: string }[];
  stats?: { practiceSets: number; mockExams: number; arenaAttempts: number; notes: number };
  visibility: {
    profile: ProfileVisibility;
    activity: boolean;
    communities: boolean;
    achievements: boolean;
    dmPolicy: DmPolicy;
  };
  /** What this viewer may do about this person, decided here rather than guessed by the UI. */
  viewer: {
    isSelf: boolean;
    canMessage: boolean;
    messageBlockedReason: string | null;
    isBlockedByMe: boolean;
    hasBlockedMe: boolean;
    isMessageable: boolean;
  };
}

interface ProfileRow {
  user_id: string;
  username: string | null;
  avatar_url: string | null;
  accent: string;
  bio: string;
  interests: string;
  is_profile_public: number;
  is_activity_visible: number;
  is_communities_visible: number;
  achievements_visibility: number;
  dm_policy: string;
}

const DEFAULT_ACCENT = '#00E5FF';
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._]{2,23}$/;
/** Handles that would collide with a route or impersonate the platform. */
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'vroqn', 'support', 'help', 'system', 'root', 'moderator', 'staff',
  'api', 'settings', 'profile', 'messages', 'news', 'login', 'signup', 'me', 'null', 'undefined',
]);

/* ------------------------------------------------------------------ helpers --------------------- */

function validAccent(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

function parseInterests(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 12)
      : [];
  } catch {
    return [];
  }
}

function normaliseInterests(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of input) {
    const value = String(entry ?? '').trim().slice(0, 40);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * Visibility, with the legacy boolean kept as a fallback.
 *
 * `profile_visibility` (0011) is the source of truth. `is_profile_public` is still read for rows
 * written before that migration existed and by anything that has not been updated yet, so a profile
 * can never silently become more or less visible than its owner chose.
 */
export function visibilityOf(row: { profile_visibility?: string | null; is_profile_public?: number | null }): ProfileVisibility {
  const stored = String(row.profile_visibility ?? '').trim();
  if (stored === 'public' || stored === 'members' || stored === 'private') return stored;
  return bool(row.is_profile_public ?? 1) ? 'public' : 'private';
}

/** The visitor's own row plus the target's row, in one place. */
async function rowsFor(userId: string, targetId: string): Promise<{ target: ProfileRow | null; mine: ProfileRow | null }> {
  const [target, mine] = await Promise.all([
    one<ProfileRow>(`SELECT * FROM community_profile_settings WHERE user_id = ?`, [targetId]),
    one<ProfileRow>(`SELECT * FROM community_profile_settings WHERE user_id = ?`, [userId]),
  ]);
  return { target, mine };
}

/** Shared communities between two students — the basis of the "communities" message policy. */
export async function sharesCommunity(userId: string, otherId: string): Promise<boolean> {
  const row = await one<{ total: number }>(
    `SELECT COUNT(*) AS total
       FROM community_members a
       JOIN community_members b ON a.community_id = b.community_id
      WHERE a.user_id = ? AND b.user_id = ?
        AND a.status IN ('active','muted') AND b.status IN ('active','muted')`,
    [userId, otherId],
  );
  return (row?.total ?? 0) > 0;
}

/* ------------------------------------------------------------------ reads ----------------------- */

export async function profileFor(viewerId: string, targetId: string): Promise<ProfileView> {
  const isSelf = viewerId === targetId;
  const person = await one<{
    id: string;
    name: string;
    class_level: string | null;
    board: string | null;
    created_at: string;
  }>(`SELECT id, name, class_level, board, created_at FROM users WHERE id = ?`, [targetId]);
  if (!person) throw new HttpError(404, 'That student was not found.', 'not_found');

  const { target } = await rowsFor(viewerId, targetId);
  const visibility: ProfileVisibility = target ? visibilityOf(target) : 'public';
  const sameCommunity = isSelf ? true : await sharesCommunity(viewerId, targetId);

  /*
   * Who may see a profile's details:
   *   public   — anyone signed in
   *   members  — students who share an active community with the owner
   *   private  — the owner only
   *
   * The profile *card* (name, class, handle) is visible to a fellow community member in every case,
   * because that handle is how you message a classmate — but 'private' still hides the bio, interests
   * and everything else beyond the card. 'members' is the middle setting students asked for: "my
   * classmates can see this, strangers cannot".
   */
  const canSeeDetails =
    isSelf || visibility === 'public' || (visibility === 'members' && sameCommunity);

  const view: ProfileView = {
    userId: person.id,
    name: person.name,
    username: target?.username ?? null,
    avatarUrl: target?.avatar_url ?? null,
    accent: validAccent(target?.accent) ?? DEFAULT_ACCENT,
    bio: canSeeDetails ? (target?.bio ?? '') : '',
    interests: canSeeDetails ? parseInterests(target?.interests) : [],
    classLevel: person.class_level,
    board: person.board,
    joinedAt: person.created_at,
    visibility: {
      profile: visibility,
      activity: bool(target?.is_activity_visible ?? 1),
      communities: bool(target?.is_communities_visible ?? 1),
      achievements: bool(target?.achievements_visibility ?? 1),
      dmPolicy: normalisePolicy(target?.dm_policy),
    },
    viewer: {
      isSelf,
      canMessage: false,
      messageBlockedReason: null,
      isBlockedByMe: false,
      hasBlockedMe: false,
      isMessageable: true,
    },
  };

  if (canSeeDetails && bool(target?.is_communities_visible ?? 1)) {
    view.communities = (
      await all<{ id: string; name: string; slug: string; role: string }>(
        `SELECT c.id, c.name, c.slug, m.role
           FROM community_members m JOIN communities c ON c.id = m.community_id
          WHERE m.user_id = ? AND m.status IN ('active','muted') AND c.status = 'active'
          ORDER BY c.name LIMIT 12`,
        [targetId],
      )
    ).filter(Boolean);
  }

  if (!isSelf && bool(target?.achievements_visibility ?? 1)) {
    view.badges = await all<{ key: string; label: string; awardedAt: string }>(
      // user_badges stores a badge_key, not a badge id — join on the key it actually carries.
      `SELECT b.badge_key AS key, b.label, ub.earned_at AS awardedAt
         FROM user_badges ub JOIN community_badges b ON b.badge_key = ub.badge_key
        WHERE ub.user_id = ?
        ORDER BY ub.earned_at DESC LIMIT 12`,
      [targetId],
    );
  }

  if (bool(target?.is_activity_visible ?? 1) || isSelf) {
    const [practice, exams, arena, notes] = await Promise.all([
      one<{ total: number }>(`SELECT COUNT(*) AS total FROM practice_sets WHERE user_id = ?`, [targetId]),
      one<{ total: number }>(`SELECT COUNT(*) AS total FROM exams WHERE user_id = ? AND status = 'completed'`, [targetId]),
      one<{ total: number }>(`SELECT COUNT(*) AS total FROM arena_attempts WHERE user_id = ?`, [targetId]),
      one<{ total: number }>(`SELECT COUNT(*) AS total FROM notes WHERE user_id = ?`, [targetId]),
    ]);
    view.stats = {
      practiceSets: practice?.total ?? 0,
      mockExams: exams?.total ?? 0,
      arenaAttempts: arena?.total ?? 0,
      notes: notes?.total ?? 0,
    };
  }

  if (!isSelf) {
    const shared = await one<{ total: number }>(
      `SELECT COUNT(*) AS total
         FROM community_members a
         JOIN community_members b ON a.community_id = b.community_id
        WHERE a.user_id = ? AND b.user_id = ?
          AND a.status IN ('active','muted') AND b.status IN ('active','muted')`,
      [viewerId, targetId],
    );
    view.sharedCommunities = shared?.total ?? 0;

    const [blockedByMe, blockedMe] = await Promise.all([
      one<{ total: number }>(
        `SELECT COUNT(*) AS total FROM community_blocks WHERE user_id = ? AND blocked_user_id = ?`,
        [viewerId, targetId],
      ),
      one<{ total: number }>(
        `SELECT COUNT(*) AS total FROM community_blocks WHERE user_id = ? AND blocked_user_id = ?`,
        [targetId, viewerId],
      ),
    ]);
    view.viewer.isBlockedByMe = (blockedByMe?.total ?? 0) > 0;
    view.viewer.hasBlockedMe = (blockedMe?.total ?? 0) > 0;

    const decision = await canMessage(viewerId, targetId);
    view.viewer.canMessage = decision.ok;
    view.viewer.messageBlockedReason = decision.ok ? null : decision.reason;
    view.viewer.isMessageable = decision.ok;
  }

  return view;
}

export function normalisePolicy(value: string | null | undefined): DmPolicy {
  return value === 'everyone' || value === 'nobody' || value === 'communities' ? value : 'communities';
}

/**
 * May `userId` talk to `targetId`?
 *
 * Blocks win over every policy, in both directions and for both kinds of check (§8: "no bypass around
 * blocks"). The `dmPolicy` is only consulted when a **new** conversation is being opened, because that
 * is exactly what the setting says on screen: "Who can start a conversation with you — existing
 * conversations continue." A student who wants a specific person to stop is choosing Block, and both
 * the profile screen and the safety sheet offer it right beside this setting.
 */
export async function canMessage(
  userId: string,
  targetId: string,
  options: { existingConversation?: boolean } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (userId === targetId) return { ok: false, reason: 'You cannot message yourself.' };
  const [blockedByMe, blockedMe] = await Promise.all([
    one<{ total: number }>(
      `SELECT COUNT(*) AS total FROM community_blocks WHERE user_id = ? AND blocked_user_id = ?`,
      [userId, targetId],
    ),
    one<{ total: number }>(
      `SELECT COUNT(*) AS total FROM community_blocks WHERE user_id = ? AND blocked_user_id = ?`,
      [targetId, userId],
    ),
  ]);
  if ((blockedByMe?.total ?? 0) > 0) return { ok: false, reason: 'You blocked this student. Unblock them to message.' };
  /*
   * Deliberately the same message in both directions: telling a sender they were blocked is how
   * blocking turns into a tool for harassment.
   */
  if ((blockedMe?.total ?? 0) > 0) {
    return { ok: false, reason: 'You cannot message this student right now.' };
  }
  if (options.existingConversation) return { ok: true };

  const target = await one<{ dm_policy: string; is_profile_public: number }>(
    `SELECT dm_policy, is_profile_public FROM community_profile_settings WHERE user_id = ?`,
    [targetId],
  );
  const policy = normalisePolicy(target?.dm_policy);
  if (policy === 'everyone') return { ok: true };
  if (policy === 'nobody') {
    return { ok: false, reason: 'This student is not accepting new conversations right now.' };
  }
  if (await sharesCommunity(userId, targetId)) return { ok: true };
  return { ok: false, reason: 'You need to be in the same community as this student to message them.' };
}

/* ------------------------------------------------------------------ writes ---------------------- */

export interface ProfileUpdate {
  name?: string;
  username?: string | null;
  bio?: string;
  interests?: unknown;
  accent?: string | null;
  classLevel?: string | null;
  board?: string | null;
  profileVisibility?: ProfileVisibility;
  dmPolicy?: DmPolicy;
  activityVisible?: boolean;
  communitiesVisible?: boolean;
  achievementsVisible?: boolean;
}

export async function updateProfile(userId: string, patch: ProfileUpdate): Promise<ProfileView> {
  const existing = await one<{ id: string }>(
    `SELECT id FROM community_profile_settings WHERE user_id = ?`,
    [userId],
  );

  const name = patch.name === undefined ? undefined : patch.name.trim().slice(0, 80);
  if (name !== undefined) {
    if (name.length < 2) throw new HttpError(400, 'Enter your name (at least 2 characters).', 'validation_error');
    await run(`UPDATE users SET name = ?, updated_at = ? WHERE id = ?`, [name, nowIso(), userId]);
  }

  let username: string | null | undefined;
  if (patch.username !== undefined) {
    const raw = (patch.username ?? '').trim().toLowerCase().replace(/^@/, '');
    if (!raw) {
      username = null;
    } else {
      if (!USERNAME_PATTERN.test(raw)) {
        throw new HttpError(
          400,
          'A handle is 3–24 characters: letters, numbers, dot or underscore, starting with a letter or number.',
          'validation_error',
        );
      }
      if (RESERVED_USERNAMES.has(raw)) throw new HttpError(400, 'That handle is reserved.', 'username_taken');
      const taken = await one<{ user_id: string }>(
        `SELECT user_id FROM community_profile_settings WHERE username = ? AND user_id <> ?`,
        [raw, userId],
      );
      if (taken) throw new HttpError(409, 'That handle is already taken. Try another one.', 'username_taken');
      username = raw;
    }
  }

  const fields: string[] = [];
  const params: unknown[] = [];
  const setField = (column: string, value: unknown) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };

  if (username !== undefined) setField('username', username);
  if (patch.bio !== undefined) setField('bio', patch.bio.trim().slice(0, 600));
  if (patch.interests !== undefined) setField('interests', JSON.stringify(normaliseInterests(patch.interests)));
  if (patch.accent !== undefined) {
    const accent = validAccent(patch.accent);
    if (patch.accent && !accent) throw new HttpError(400, 'Pick a colour like #00E5FF.', 'validation_error');
    setField('accent', accent ?? '');
  }
  if (patch.profileVisibility !== undefined) {
    setField('profile_visibility', patch.profileVisibility);
    // Mirrored so the community layer (which still reads the boolean) agrees with this setting.
    setField('is_profile_public', patch.profileVisibility === 'public' ? 1 : 0);
  }
  if (patch.dmPolicy !== undefined) setField('dm_policy', patch.dmPolicy);
  if (patch.activityVisible !== undefined) setField('is_activity_visible', patch.activityVisible ? 1 : 0);
  if (patch.communitiesVisible !== undefined) setField('is_communities_visible', patch.communitiesVisible ? 1 : 0);
  if (patch.achievementsVisible !== undefined) setField('achievements_visibility', patch.achievementsVisible ? 1 : 0);

  if (patch.classLevel !== undefined || patch.board !== undefined) {
    const userFields: string[] = [];
    const userParams: unknown[] = [];
    if (patch.classLevel !== undefined) {
      userFields.push('class_level = ?');
      userParams.push(patch.classLevel ? patch.classLevel.slice(0, 40) : null);
    }
    if (patch.board !== undefined) {
      userFields.push('board = ?');
      userParams.push(patch.board ? patch.board.slice(0, 40) : null);
    }
    await run(`UPDATE users SET ${userFields.join(', ')}, updated_at = ? WHERE id = ?`, [...userParams, nowIso(), userId]);
  }

  if (existing) {
    if (fields.length) {
      setField('updated_at', nowIso());
      await run(`UPDATE community_profile_settings SET ${fields.join(', ')} WHERE user_id = ?`, [...params, userId]);
    }
  } else {
    // Rows are created lazily: a student may never have opened a community profile.
    await run(
      `INSERT INTO community_profile_settings
         (id, user_id, bio, interests, is_profile_public, is_activity_visible, is_communities_visible,
          achievements_visibility, username, avatar_url, accent, dm_policy, profile_visibility, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      [
        uuid(),
        userId,
        patch.bio !== undefined ? patch.bio.trim().slice(0, 600) : '',
        JSON.stringify(normaliseInterests(patch.interests)),
        patch.profileVisibility === 'private' ? 0 : 1,
        patch.activityVisible === false ? 0 : 1,
        patch.communitiesVisible === false ? 0 : 1,
        patch.achievementsVisible === false ? 0 : 1,
        username ?? null,
        validAccent(patch.accent) ?? '',
        patch.dmPolicy ?? 'communities',
        patch.profileVisibility ?? 'public',
        nowIso(),
      ],
    );
  }

  return profileFor(userId, userId);
}

/** Records where a student's avatar file lives. The file itself is handled by the route. */
export async function setAvatar(userId: string, url: string | null): Promise<ProfileView> {
  const existing = await one<{ id: string }>(`SELECT id FROM community_profile_settings WHERE user_id = ?`, [userId]);
  if (!existing) {
    await updateProfile(userId, {});
  }
  await run(`UPDATE community_profile_settings SET avatar_url = ?, updated_at = ? WHERE user_id = ?`, [
    url,
    nowIso(),
    userId,
  ]);
  return profileFor(userId, userId);
}

/** Absolute path of an avatar on disk, after checking the owner actually set one. */
export async function avatarPathFor(targetId: string): Promise<{ path: string; mime: string } | null> {
  const row = await one<{ avatar_url: string | null }>(
    `SELECT avatar_url FROM community_profile_settings WHERE user_id = ?`,
    [targetId],
  );
  const url = row?.avatar_url;
  if (!url) return null;
  // Only files served by this app are accepted; an external URL is never fetched server-side.
  const match = /^\/api\/profile\/avatar\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(url);
  if (!match) return null;
  const stored = path.join(config.uploadDir, 'avatars', path.basename(match[2]));
  return { path: stored, mime: /\.png$/i.test(stored) ? 'image/png' : /\.webp$/i.test(stored) ? 'image/webp' : 'image/jpeg' };
}

/** Handles search, used by the recipient picker when starting a conversation (§6). */
export async function searchPeople(
  userId: string,
  term: string,
  limit = 10,
): Promise<{ userId: string; name: string; username: string | null; avatarUrl: string | null; canMessage: boolean; reason: string | null }[]> {
  const trimmed = term.trim().replace(/^@/, '');
  if (trimmed.length < 2) return [];
  const pattern = `%${trimmed.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await all<{ id: string; name: string; username: string | null; avatar_url: string | null }>(
    `SELECT u.id, u.name, p.username, p.avatar_url
       FROM users u
       LEFT JOIN community_profile_settings p ON p.user_id = u.id
      WHERE u.id <> ?
        AND (LOWER(u.name) LIKE LOWER(?) ESCAPE '\\' OR LOWER(p.username) LIKE LOWER(?) ESCAPE '\\')
      ORDER BY CASE WHEN LOWER(p.username) = LOWER(?) THEN 0 ELSE 1 END, u.name
      LIMIT ?`,
    [userId, pattern, pattern, trimmed, Math.min(Math.max(limit, 1), 25)],
  );
  const out: { userId: string; name: string; username: string | null; avatarUrl: string | null; canMessage: boolean; reason: string | null }[] = [];
  for (const row of rows) {
    const decision = await canMessage(userId, row.id);
    out.push({
      userId: row.id,
      name: row.name,
      username: row.username,
      avatarUrl: row.avatar_url,
      canMessage: decision.ok,
      reason: decision.ok ? null : decision.reason,
    });
  }
  return out;
}
