/**
 * Community lifecycle: discovery, creation, membership, roles, join requests and invites.
 *
 * Two rules run through the whole file:
 *  1. Nothing is trusted from the client. Visibility, role and ownership come from the database, and
 *     the caller's own role decides what they may do (see `permissions.ts`).
 *  2. Leave/limit/ban state is enforced here, not in the UI. A full community or a banned user is
 *     refused on the server even if the button was somehow rendered.
 */
import { all, bool, nowIso, one, run, uuid } from '../../db/index.js';
import { HttpError } from '../../middleware/errors.js';
import {
  canActOnMember,
  canChangeRole,
  isActiveMember,
  isCommunityRole,
  membershipOf,
  memberCommunityIds,
  roleRank,
  COMMUNITY_ROLES,
  type CommunityRole,
  type MemberStatus,
} from './permissions.js';
import {
  capabilitiesOf,
  getCommunityRow,
  loadForMember,
  tagsOf,
  visibilityOf,
  type CommunityRow,
} from './access.js';
import {
  COMMUNITY_CATEGORIES,
  categoryLabel,
  isVisibility,
  type CommunityDetail,
  type CommunityMemberView,
  type CommunitySummary,
  type CommunityVisibility,
  type JoinRequestStatus,
} from './types.js';

/* ------------------------------------------------------------------ helpers --------------------- */

const MAX_NAME = 60;
const MAX_DESCRIPTION = 600;
const MAX_RULES = 3000;
const MAX_TAGS = 8;

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48)
    .replace(/^-|-$/g, '');
  return base || 'community';
}

/** Slugs are the public URL, so they must be unique and stable. */
async function uniqueSlug(name: string, excludeId?: string): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const row = await one<{ id: string }>(
      `SELECT id FROM communities WHERE slug = ? AND id <> ?`,
      [candidate, excludeId ?? ''],
    );
    if (!row) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function cleanTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').slice(0, 24);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function toSummary(
  row: CommunityRow & { member_count?: number | null },
  extras: {
    role: CommunityRole | null;
    status: MemberStatus | null;
    joinRequestStatus: JoinRequestStatus | null;
    unreadCount?: number;
  },
): CommunitySummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    logoUrl: row.logo_url,
    bannerUrl: row.banner_url,
    category: row.category,
    categoryLabel: categoryLabel(row.category),
    tags: tagsOf(row),
    visibility: visibilityOf(row),
    memberCount: row.member_count ?? 0,
    memberLimit: row.member_limit,
    isVerified: bool(row.is_verified),
    accent: row.accent,
    myRole: extras.role,
    myStatus: extras.status,
    joinRequestStatus: extras.joinRequestStatus,
    createdAt: row.created_at,
  };
}

const COUNT_SQL = `(SELECT COUNT(*) FROM community_members m
                      WHERE m.community_id = c.id AND m.status IN ('active', 'muted'))`;

/* ------------------------------------------------------------------ discovery ------------------- */

export interface ListCommunitiesOptions {
  search?: string;
  category?: string;
  tag?: string;
  scope?: 'all' | 'joined' | 'mine' | 'popular' | 'recent';
  limit?: number;
  offset?: number;
}

/**
 * Discovery list. Only `public` communities are ever listed — private and invite-only ones are not
 * discoverable, which is what makes them private. A member also sees their own private communities
 * under `scope: 'joined'`.
 */
export async function listCommunities(
  userId: string,
  options: ListCommunitiesOptions = {},
): Promise<{ communities: CommunitySummary[]; total: number }> {
  const limit = Math.min(Math.max(options.limit ?? 24, 1), 60);
  const offset = Math.max(options.offset ?? 0, 0);
  const scope = options.scope ?? 'all';

  const where: string[] = [`c.status = 'active'`];
  const params: unknown[] = [];

  if (scope === 'joined') {
    where.push(
      `c.id IN (SELECT community_id FROM community_members WHERE user_id = ? AND status IN ('active','muted'))`,
    );
    params.push(userId);
  } else if (scope === 'mine') {
    // "Mine" means "communities I run", so a community handed to me counts exactly like one I made.
    where.push(
      `(c.created_by = ?
        OR c.id IN (SELECT community_id FROM community_members
                     WHERE user_id = ? AND role = 'owner' AND status IN ('active','muted')))`,
    );
    params.push(userId, userId);
  } else {
    // Public-only discovery, plus anything the caller is already inside.
    where.push(
      `(c.visibility = 'public'
        OR c.id IN (SELECT community_id FROM community_members WHERE user_id = ? AND status IN ('active','muted')))`,
    );
    params.push(userId);
  }

  if (options.category && (COMMUNITY_CATEGORIES as readonly string[]).includes(options.category)) {
    where.push('c.category = ?');
    params.push(options.category);
  }

  if (options.tag) {
    // Tags are stored as a JSON array; a LIKE on the quoted token is portable to both engines and
    // is why the tag is normalised on write.
    where.push(`c.tags LIKE ?`);
    params.push(`%"${options.tag}"%`);
  }

  if (options.search) {
    const term = `%${options.search.trim().slice(0, 60).toLowerCase()}%`;
    where.push(`(LOWER(c.name) LIKE ? OR LOWER(c.description) LIKE ? OR LOWER(c.tags) LIKE ?)`);
    params.push(term, term, term);
  }

  const orderBy =
    scope === 'popular'
      ? 'member_count DESC, c.created_at DESC'
      : scope === 'recent'
        ? 'c.created_at DESC'
        : 'member_count DESC, c.created_at DESC';

  const rows = await all<CommunityRow & { member_count: number }>(
    `SELECT c.*, ${COUNT_SQL} AS member_count
       FROM communities c
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const totalRow = await one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM communities c WHERE ${where.join(' AND ')}`,
    params,
  );

  const ids = rows.map((row) => row.id);
  const [memberships, requests] = await Promise.all([
    ids.length ? membershipMap(userId, ids) : Promise.resolve(new Map()),
    ids.length ? pendingRequestMap(userId, ids) : Promise.resolve(new Map()),
  ]);

  return {
    communities: rows.map((row) => {
      const membership = memberships.get(row.id) ?? null;
      return toSummary(row, {
        role: membership?.role ?? null,
        status: membership?.status ?? null,
        joinRequestStatus: requests.get(row.id) ?? null,
      });
    }),
    total: totalRow?.total ?? rows.length,
  };
}

async function membershipMap(userId: string, communityIds: string[]) {
  const placeholders = communityIds.map(() => '?').join(', ');
  const rows = await all<{ community_id: string; role: string; status: string }>(
    `SELECT community_id, role, status FROM community_members
      WHERE user_id = ? AND community_id IN (${placeholders})`,
    [userId, ...communityIds],
  );
  const map = new Map<string, { role: CommunityRole; status: MemberStatus }>();
  for (const row of rows) {
    map.set(row.community_id, {
      role: isCommunityRole(row.role) ? row.role : 'member',
      status: row.status as MemberStatus,
    });
  }
  return map;
}

async function pendingRequestMap(userId: string, communityIds: string[]) {
  const placeholders = communityIds.map(() => '?').join(', ');
  const rows = await all<{ community_id: string; status: string }>(
    `SELECT community_id, status FROM community_join_requests
      WHERE user_id = ? AND community_id IN (${placeholders})`,
    [userId, ...communityIds],
  );
  const map = new Map<string, JoinRequestStatus>();
  for (const row of rows) map.set(row.community_id, row.status as JoinRequestStatus);
  return map;
}

/* ------------------------------------------------------------------ detail ---------------------- */

/**
 * The tabs a community actually shows (§5: "Only show available/enabled features").
 *
 * Home, Chat and Members always exist. The rest appear only when they hold at least one item *or*
 * the caller can create one — which is what stops a brand-new community rendering seven empty tabs.
 */
async function tabsFor(communityId: string, options: { canCreate: boolean }): Promise<string[]> {
  const [counts] = await Promise.all([
    one<{
      doubts: number;
      resources: number;
      challenges: number;
      plans: number;
      events: number;
      competitions: number;
      knowledge: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM community_doubts WHERE community_id = ?) AS doubts,
         (SELECT COUNT(*) FROM community_resources WHERE community_id = ?) AS resources,
         (SELECT COUNT(*) FROM community_challenges WHERE community_id = ?) AS challenges,
         (SELECT COUNT(*) FROM study_plans WHERE community_id = ?) AS plans,
         (SELECT COUNT(*) FROM community_events WHERE community_id = ?) AS events,
         (SELECT COUNT(*) FROM community_competitions WHERE community_id = ?) AS competitions,
         (SELECT COUNT(*) FROM community_knowledge WHERE community_id = ?) AS knowledge`,
      [communityId, communityId, communityId, communityId, communityId, communityId, communityId],
    ),
  ]);

  const tabs = ['home', 'chat', 'doubts', 'resources', 'challenges', 'plans', 'events', 'competitions', 'leaderboard', 'members', 'teams', 'knowledge'];
  const keep = new Set(['home', 'chat', 'members']);
  const gate: Record<string, number> = {
    doubts: counts?.doubts ?? 0,
    resources: counts?.resources ?? 0,
    challenges: counts?.challenges ?? 0,
    plans: counts?.plans ?? 0,
    events: counts?.events ?? 0,
    competitions: counts?.competitions ?? 0,
    knowledge: counts?.knowledge ?? 0,
  };
  for (const [tab, count] of Object.entries(gate)) {
    if (count > 0 || options.canCreate) keep.add(tab);
  }
  // Group study (§22, §29) is always reachable: forming a team is a member verb, not a moderator one.
  keep.add('teams');
  // The leaderboard is an owner-controlled feature flag, not an empty-state question.
  keep.add('leaderboard');
  return tabs.filter((tab) => keep.has(tab));
}

export async function getCommunityDetail(userId: string, communityId: string): Promise<CommunityDetail> {
  const context = await loadForMember(userId, communityId);
  const { community, membership, isMember } = context;
  /*
   * A membership row survives a removal (`status = 'left'` is how somebody leaves or is removed), so
   * reading the role straight off it told a removed member they were still a moderator: the community
   * page rendered the Manage tab and the role controls, and every one of those actions then came back
   * as a 404. Anything derived from the membership — the role, the capability set, the tab list — is
   * therefore gated on the membership being active.
   */
  const role = isMember ? context.role : null;

  const [countRow, owner, unread, capabilities] = await Promise.all([
    one<{ member_count: number }>(
      `SELECT COUNT(*) AS member_count FROM community_members
        WHERE community_id = ? AND status IN ('active','muted')`,
      [community.id],
    ),
    /*
     * The owner is whoever holds the owner role *now*. `created_by` is provenance and does not move on
     * a transfer, so reading the owner from it showed the old owner in the header and in the manage
     * screen after a handover.
     */
    one<{ user_id: string | null; name: string | null }>(
      `SELECT m.user_id, u.name
         FROM community_members m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.community_id = ? AND m.role = 'owner' AND m.status IN ('active','muted')
        ORDER BY m.joined_at LIMIT 1`,
      [community.id],
    ),
    unreadCount(userId, community.id),
    Promise.resolve(capabilitiesOf(role)),
  ]);

  const joinRequest =
    membership || context.visibility === 'public'
      ? null
      : await one<{ status: string }>(
          `SELECT status FROM community_join_requests WHERE community_id = ? AND user_id = ?`,
          [community.id, userId],
        );

  const tabs = await tabsFor(community.id, {
    canCreate:
      capabilities.create_challenge ||
      capabilities.create_resource ||
      capabilities.create_event ||
      capabilities.create_competition,
  });

  return {
    ...toSummary({ ...community, member_count: countRow?.member_count ?? 0 }, {
      role,
      status: membership?.status ?? null,
      joinRequestStatus: (joinRequest?.status as JoinRequestStatus) ?? null,
    }),
    rules: community.rules,
    joinRequirements: community.join_requirements,
    welcomeMessage: community.welcome_message,
    ownerId: owner?.user_id ?? community.created_by,
    ownerName: owner?.name ?? 'A Vroqn student',
    isLeaderboardEnabled: bool(community.is_leaderboard_enabled),
    capabilities,
    tabs,
    unreadCount: unread,
  };
}

async function unreadCount(userId: string, communityId: string): Promise<number> {
  const row = await one<{ count: number }>(
    `SELECT COUNT(*) AS count FROM community_messages
      WHERE community_id = ?
        AND deleted_at IS NULL
        AND user_id <> ?
        AND created_at > COALESCE(
          (SELECT last_read_at FROM community_read_state WHERE community_id = ? AND user_id = ?),
          '1970-01-01T00:00:00.000Z')`,
    [communityId, userId, communityId, userId],
  );
  return row?.count ?? 0;
}

export async function markRead(userId: string, communityId: string): Promise<void> {
  await loadForMember(userId, communityId);
  const now = nowIso();
  const latest = await one<{ id: string }>(
    `SELECT id FROM community_messages WHERE community_id = ? ORDER BY created_at DESC LIMIT 1`,
    [communityId],
  );
  const existing = await one<{ id: string }>(
    `SELECT id FROM community_read_state WHERE community_id = ? AND user_id = ?`,
    [communityId, userId],
  );
  if (existing) {
    await run(
      `UPDATE community_read_state SET last_read_at = ?, last_read_message_id = ?, updated_at = ?
        WHERE community_id = ? AND user_id = ?`,
      [now, latest?.id ?? null, now, communityId, userId],
    );
  } else {
    await run(
      `INSERT INTO community_read_state (id, community_id, user_id, last_read_at, last_read_message_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), communityId, userId, now, latest?.id ?? null, now],
    );
  }
}

/* ------------------------------------------------------------------ create / update ------------- */

export interface CreateCommunityArgs {
  name: string;
  description?: string;
  category: string;
  visibility?: string;
  tags?: unknown;
  rules?: string;
  memberLimit?: number | null;
  joinRequirements?: string;
  welcomeMessage?: string;
  accent?: string;
  logoUrl?: string | null;
  bannerUrl?: string | null;
}

export async function createCommunity(userId: string, args: CreateCommunityArgs): Promise<CommunityDetail> {
  const name = args.name.trim().slice(0, MAX_NAME);
  if (name.length < 3) throw new HttpError(400, 'Give your community a name of at least 3 characters.', 'validation_error');

  if (!(COMMUNITY_CATEGORIES as readonly string[]).includes(args.category)) {
    throw new HttpError(400, 'Choose a category for your community.', 'validation_error');
  }

  const visibility: CommunityVisibility = isVisibility(args.visibility) ? args.visibility : 'public';

  // One person creating hundreds of communities is the failure mode this guards; it is also a cheap
  // brake on spam communities.
  const owned = await one<{ count: number }>(
    `SELECT COUNT(*) AS count FROM communities WHERE created_by = ? AND status = 'active'`,
    [userId],
  );
  if ((owned?.count ?? 0) >= 25) {
    throw new HttpError(429, 'You already own 25 communities. Transfer or delete one first.', 'rate_limited');
  }

  const id = uuid();
  const now = nowIso();
  const slug = await uniqueSlug(name);

  await run(
    `INSERT INTO communities
       (id, name, slug, description, logo_url, banner_url, category, tags, rules, visibility,
        member_limit, join_requirements, welcome_message, accent, is_verified, is_leaderboard_enabled,
        status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'active', ?, ?, ?)`,
    [
      id,
      name,
      slug,
      (args.description ?? '').trim().slice(0, MAX_DESCRIPTION),
      args.logoUrl ?? null,
      args.bannerUrl ?? null,
      args.category,
      JSON.stringify(cleanTags(args.tags)),
      (args.rules ?? '').trim().slice(0, MAX_RULES),
      visibility,
      args.memberLimit && args.memberLimit > 0 ? Math.min(args.memberLimit, 100000) : null,
      (args.joinRequirements ?? '').trim().slice(0, 400),
      (args.welcomeMessage ?? '').trim().slice(0, 1000),
      (args.accent ?? 'cyan').slice(0, 24),
      userId,
      now,
      now,
    ],
  );

  // The creator becomes owner. Without this the community would be unmanageable.
  await run(
    `INSERT INTO community_members
       (id, community_id, user_id, role, status, contribution_points, helpful_answers, joined_at, updated_at)
     VALUES (?, ?, ?, 'owner', 'active', 0, 0, ?, ?)`,
    [uuid(), id, userId, now, now],
  );

  return getCommunityDetail(userId, id);
}

export interface UpdateCommunityArgs {
  name?: string;
  description?: string;
  category?: string;
  visibility?: string;
  tags?: unknown;
  rules?: string;
  memberLimit?: number | null;
  joinRequirements?: string;
  welcomeMessage?: string;
  accent?: string;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  isLeaderboardEnabled?: boolean;
}

export async function updateCommunity(
  userId: string,
  communityId: string,
  patch: UpdateCommunityArgs,
): Promise<CommunityDetail> {
  await loadForMember(userId, communityId, { capability: 'edit_community' });

  const fields: string[] = [];
  const params: unknown[] = [];

  const set = (column: string, value: unknown) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, MAX_NAME);
    if (name.length < 3) throw new HttpError(400, 'The name is too short.', 'validation_error');
    set('name', name);
    // Keep the slug in step with the name only when the name actually changed, so links people
    // already shared keep working for small edits.
    const current = await getCommunityRow(communityId);
    if (current && slugify(current.name) !== slugify(name)) set('slug', await uniqueSlug(name, communityId));
  }
  if (patch.description !== undefined) set('description', patch.description.trim().slice(0, MAX_DESCRIPTION));
  if (patch.rules !== undefined) set('rules', patch.rules.trim().slice(0, MAX_RULES));
  if (patch.welcomeMessage !== undefined) set('welcome_message', patch.welcomeMessage.trim().slice(0, 1000));
  if (patch.joinRequirements !== undefined) set('join_requirements', patch.joinRequirements.trim().slice(0, 400));
  if (patch.tags !== undefined) set('tags', JSON.stringify(cleanTags(patch.tags)));
  if (patch.accent !== undefined) set('accent', patch.accent.slice(0, 24));
  if (patch.logoUrl !== undefined) set('logo_url', patch.logoUrl ? String(patch.logoUrl).slice(0, 500) : null);
  if (patch.bannerUrl !== undefined) set('banner_url', patch.bannerUrl ? String(patch.bannerUrl).slice(0, 500) : null);
  if (patch.isLeaderboardEnabled !== undefined) set('is_leaderboard_enabled', patch.isLeaderboardEnabled ? 1 : 0);

  if (patch.category !== undefined) {
    if (!(COMMUNITY_CATEGORIES as readonly string[]).includes(patch.category)) {
      throw new HttpError(400, 'Unknown category.', 'validation_error');
    }
    set('category', patch.category);
  }

  if (patch.visibility !== undefined) {
    if (!isVisibility(patch.visibility)) throw new HttpError(400, 'Unknown visibility.', 'validation_error');
    set('visibility', patch.visibility);
  }

  if (patch.memberLimit !== undefined) {
    const limit = patch.memberLimit && patch.memberLimit > 0 ? Math.min(patch.memberLimit, 100000) : null;
    if (limit) {
      // Refuse to shrink the limit below the current membership — that would strand members who are
      // already inside, which is worse than rejecting the edit.
      const current = await one<{ count: number }>(
        `SELECT COUNT(*) AS count FROM community_members WHERE community_id = ? AND status IN ('active','muted')`,
        [communityId],
      );
      if ((current?.count ?? 0) > limit) {
        throw new HttpError(
          400,
          `This community already has ${current?.count} members, so the limit cannot be ${limit}.`,
          'validation_error',
        );
      }
    }
    set('member_limit', limit);
  }

  if (!fields.length) return getCommunityDetail(userId, communityId);

  set('updated_at', nowIso());
  params.push(communityId);
  await run(`UPDATE communities SET ${fields.join(', ')} WHERE id = ?`, params);

  // Changing visibility to private/invite-only silently locks out nobody who is already a member,
  // which is the correct behaviour — membership is the source of truth, not visibility.
  return getCommunityDetail(userId, communityId);
}

/** Soft delete: content is hidden and the slug is released, but rows survive for audit (§58). */
export async function deleteCommunity(userId: string, communityId: string): Promise<void> {
  await loadForMember(userId, communityId, { capability: 'delete_community' });
  const now = nowIso();
  await run(`UPDATE communities SET status = 'deleted', updated_at = ? WHERE id = ?`, [now, communityId]);
}

export async function transferOwnership(
  userId: string,
  communityId: string,
  targetUserId: string,
): Promise<void> {
  await loadForMember(userId, communityId, { capability: 'transfer_ownership' });
  if (userId === targetUserId) throw new HttpError(400, 'You are already the owner.', 'validation_error');

  const target = await membershipOf(targetUserId, communityId);
  if (!target || !isActiveMember(target)) {
    throw new HttpError(400, 'That student is not a member of this community.', 'validation_error');
  }

  const now = nowIso();
  await run(`UPDATE community_members SET role = 'admin', updated_at = ? WHERE community_id = ? AND user_id = ?`, [
    now,
    communityId,
    userId,
  ]);
  await run(`UPDATE community_members SET role = 'owner', updated_at = ? WHERE community_id = ? AND user_id = ?`, [
    now,
    communityId,
    targetUserId,
  ]);
}

/* ------------------------------------------------------------------ membership ------------------- */

export interface JoinResult {
  status: 'joined' | 'requested' | 'already_member' | 'invite_required';
  detail: CommunityDetail | null;
}

/**
 * Join, or ask to join.
 *
 * - `public`      → joins immediately (unless full or banned).
 * - `private`     → creates/reuses a pending join request; admins decide.
 * - `invite_only` → requires a valid code; without one the caller is told an invite is needed rather
 *                   than being silently rejected.
 */
export async function joinCommunity(
  userId: string,
  communityId: string,
  options: { inviteCode?: string; reason?: string } = {},
): Promise<JoinResult> {
  const community = await getCommunityRow(communityId);
  if (!community || community.status !== 'active') {
    throw new HttpError(404, 'That community does not exist.', 'not_found');
  }

  const existing = await membershipOf(userId, communityId);
  if (existing && isActiveMember(existing)) {
    return { status: 'already_member', detail: await getCommunityDetail(userId, communityId) };
  }
  if (existing?.status === 'banned') {
    throw new HttpError(403, 'You cannot rejoin this community.', 'banned');
  }

  const visibility = visibilityOf(community);

  if (visibility === 'invite_only') {
    const code = options.inviteCode?.trim();
    if (!code) return { status: 'invite_required', detail: null };
    const invite = await consumeInvite(communityId, code);
    if (!invite) throw new HttpError(400, 'That invite link is no longer valid.', 'invalid_invite');
  }

  // Capacity is checked here as well as at approve time: the join path must not overfill.
  if (community.member_limit) {
    const count = await one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM community_members WHERE community_id = ? AND status IN ('active','muted')`,
      [communityId],
    );
    if ((count?.count ?? 0) >= community.member_limit) {
      throw new HttpError(409, 'This community is full.', 'community_full');
    }
  }

  if (visibility === 'private') {
    const pending = await one<{ id: string; status: string }>(
      `SELECT id, status FROM community_join_requests WHERE community_id = ? AND user_id = ?`,
      [communityId, userId],
    );
    const reason = (options.reason ?? '').trim().slice(0, 500);
    if (pending?.status === 'pending') return { status: 'requested', detail: null };
    if (pending) {
      await run(
        `UPDATE community_join_requests SET status = 'pending', reason = ?, decided_by = NULL, decided_at = NULL, created_at = ?
          WHERE id = ?`,
        [reason, nowIso(), pending.id],
      );
    } else {
      await run(
        `INSERT INTO community_join_requests (id, community_id, user_id, reason, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        [uuid(), communityId, userId, reason, nowIso()],
      );
    }
    await notifyCommunityAdmins(communityId, {
      kind: 'join_request',
      title: 'New join request',
      body: 'Someone asked to join your community.',
      link: `/communities/${communityId}/manage`,
    });
    return { status: 'requested', detail: null };
  }

  await addMember(communityId, userId, 'member');
  return { status: 'joined', detail: await getCommunityDetail(userId, communityId) };
}

export async function addMember(communityId: string, userId: string, role: CommunityRole): Promise<void> {
  const now = nowIso();
  const existing = await membershipOf(userId, communityId);
  if (existing) {
    // Re-joining after leaving reactivates the row and clears any stale mute.
    await run(
      `UPDATE community_members
          SET status = 'active', role = ?, muted_until = NULL, mute_reason = NULL, joined_at = ?, updated_at = ?
        WHERE id = ?`,
      [role, now, now, existing.id],
    );
    return;
  }
  await run(
    `INSERT INTO community_members
       (id, community_id, user_id, role, status, contribution_points, helpful_answers, joined_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 0, 0, ?, ?)`,
    [uuid(), communityId, userId, role, now, now],
  );
}

export async function leaveCommunity(userId: string, communityId: string): Promise<void> {
  const membership = await membershipOf(userId, communityId);
  if (!membership) throw new HttpError(400, 'You are not a member of this community.', 'not_member');

  if (membership.role === 'owner') {
    // An owner leaving would orphan the community: nobody could approve requests, edit settings or
    // delete it. They must hand it over first.
    const others = await all<{ user_id: string }>(
      `SELECT user_id FROM community_members
        WHERE community_id = ? AND user_id <> ? AND status IN ('active','muted')
        ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 WHEN 'mentor' THEN 2 ELSE 3 END, joined_at
        LIMIT 1`,
      [communityId, userId],
    );
    const successor = others[0]?.user_id;
    if (!successor) {
      throw new HttpError(
        400,
        'You are the only member. Delete the community instead of leaving it.',
        'owner_cannot_leave',
      );
    }
    throw new HttpError(
      400,
      'You own this community. Transfer ownership to another member, or delete the community.',
      'owner_cannot_leave',
    );
  }

  await run(`UPDATE community_members SET status = 'left', updated_at = ? WHERE id = ?`, [nowIso(), membership.id]);
}

/* ------------------------------------------------------------------ join requests --------------- */

export async function listJoinRequests(userId: string, communityId: string): Promise<
  { id: string; userId: string; name: string; classLevel: string | null; reason: string; createdAt: string }[]
> {
  await loadForMember(userId, communityId, { capability: 'approve_requests' });
  /* Only the fields an approver actually needs. No email, no keys, no private profile data (§34). */
  const rows = await all<{ id: string; user_id: string; name: string; class_level: string | null; reason: string; created_at: string }>(
    `SELECT r.id, r.user_id, u.name, u.class_level, r.reason, r.created_at
       FROM community_join_requests r JOIN users u ON u.id = r.user_id
      WHERE r.community_id = ? AND r.status = 'pending'
      ORDER BY r.created_at`,
    [communityId],
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    classLevel: row.class_level,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

export async function decideJoinRequest(
  userId: string,
  communityId: string,
  requestId: string,
  approve: boolean,
): Promise<void> {
  const { community } = await loadForMember(userId, communityId, { capability: 'approve_requests' });

  const request = await one<{ id: string; user_id: string; status: string }>(
    `SELECT id, user_id, status FROM community_join_requests WHERE id = ? AND community_id = ?`,
    [requestId, communityId],
  );
  if (!request) throw new HttpError(404, 'That request no longer exists.', 'not_found');
  if (request.status !== 'pending') throw new HttpError(409, 'That request was already handled.', 'already_decided');

  if (approve && community.member_limit) {
    const count = await one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM community_members WHERE community_id = ? AND status IN ('active','muted')`,
      [communityId],
    );
    if ((count?.count ?? 0) >= community.member_limit) {
      throw new HttpError(409, 'This community is full — raise the member limit to approve more.', 'community_full');
    }
  }

  const now = nowIso();
  await run(
    `UPDATE community_join_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
    [approve ? 'approved' : 'rejected', userId, now, requestId],
  );

  if (approve) await addMember(communityId, request.user_id, 'member');

  const { createNotification } = await import('./notifications.js');
  await createNotification({
    userId: request.user_id,
    communityId,
    kind: approve ? 'join_approved' : 'join_rejected',
    title: approve ? `You joined ${community.name}` : `Your request to ${community.name} was declined`,
    body: approve ? 'Say hello in the community chat.' : 'You can ask again later.',
    link: approve ? `/communities/${communityId}` : null,
  });
}

/* ------------------------------------------------------------------ invites --------------------- */

function inviteCode(): string {
  // 24 chars of CSPRNG output, url-safe. Predictable invite ids are explicitly forbidden (§33).
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

export async function createInvite(
  userId: string,
  communityId: string,
  options: { expiresAt?: string | null; maxUses?: number | null } = {},
): Promise<{ id: string; code: string; expiresAt: string | null; maxUses: number | null }> {
  await loadForMember(userId, communityId, { capability: 'create_invites' });
  const id = uuid();
  const code = inviteCode();
  const expiresAt = options.expiresAt ? new Date(options.expiresAt).toISOString() : null;
  const maxUses = options.maxUses && options.maxUses > 0 ? Math.min(options.maxUses, 10000) : null;
  await run(
    `INSERT INTO community_invites (id, community_id, code, created_by, expires_at, max_uses, use_count, is_revoked, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    [id, communityId, code, userId, expiresAt, maxUses, nowIso()],
  );
  return { id, code, expiresAt, maxUses };
}

export async function listInvites(userId: string, communityId: string) {
  await loadForMember(userId, communityId, { capability: 'create_invites' });
  const rows = await all<{ id: string; code: string; expires_at: string | null; max_uses: number | null; use_count: number; is_revoked: number; created_at: string }>(
    `SELECT id, code, expires_at, max_uses, use_count, is_revoked, created_at
       FROM community_invites WHERE community_id = ? ORDER BY created_at DESC LIMIT 50`,
    [communityId],
  );
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    useCount: row.use_count,
    isRevoked: bool(row.is_revoked),
    isExpired: Boolean(row.expires_at && new Date(row.expires_at).getTime() < Date.now()),
    createdAt: row.created_at,
  }));
}

export async function revokeInvite(userId: string, communityId: string, inviteId: string): Promise<void> {
  await loadForMember(userId, communityId, { capability: 'create_invites' });
  await run(`UPDATE community_invites SET is_revoked = 1 WHERE id = ? AND community_id = ?`, [inviteId, communityId]);
}

/** Validates and consumes one use of an invite. Returns null when the code is unusable. */
async function consumeInvite(communityId: string, code: string): Promise<boolean> {
  const invite = await one<{ id: string; expires_at: string | null; max_uses: number | null; use_count: number; is_revoked: number }>(
    `SELECT id, expires_at, max_uses, use_count, is_revoked FROM community_invites
      WHERE community_id = ? AND code = ?`,
    [communityId, code],
  );
  if (!invite) return false;
  if (bool(invite.is_revoked)) return false;
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) return false;
  if (invite.max_uses !== null && invite.use_count >= invite.max_uses) return false;

  await run(`UPDATE community_invites SET use_count = use_count + 1 WHERE id = ?`, [invite.id]);
  return true;
}

/* ------------------------------------------------------------------ member administration ------- */

export async function listMembers(
  userId: string,
  communityId: string,
  options: { search?: string; role?: string; limit?: number; offset?: number } = {},
): Promise<{ members: CommunityMemberView[]; total: number }> {
  await loadForMember(userId, communityId, { requireMembership: true });
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const where = [`m.community_id = ?`, `m.status IN ('active','muted')`];
  const params: unknown[] = [communityId];

  if (options.role && isCommunityRole(options.role)) {
    where.push('m.role = ?');
    params.push(options.role);
  }
  if (options.search) {
    where.push('LOWER(u.name) LIKE ?');
    params.push(`%${options.search.trim().toLowerCase().slice(0, 40)}%`);
  }

  const rows = await all<{
    id: string;
    user_id: string;
    name: string;
    role: string;
    status: string;
    contribution_points: number | null;
    helpful_answers: number | null;
    muted_until: string | null;
    joined_at: string;
  }>(
    `SELECT m.id, m.user_id, u.name, m.role, m.status, m.contribution_points, m.helpful_answers,
            m.muted_until, m.joined_at
       FROM community_members m JOIN users u ON u.id = m.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 WHEN 'mentor' THEN 3 ELSE 4 END,
               m.joined_at
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const total = await one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM community_members m JOIN users u ON u.id = m.user_id
      WHERE ${where.join(' AND ')}`,
    params,
  );

  /*
   * Per-row permissions, decided here rather than guessed by the screen.
   *
   * The Members tab only renders its controls where the server says the action would succeed, and it
   * asks for `canChangeRole` / `canRemove` on each member. Those two fields were never sent, so
   * `undefined` was falsy and the entire action row — role, mute, remove — silently rendered for
   * nobody. A moderator saw a list of names and no way to act on any of them.
   *
   * They are computed from the same helpers the write endpoints call, so a button can never appear
   * where the server would refuse:
   *   - `canChangeRole` — true when the viewer could set this member's role to at least one assignable
   *     role. Ownership is never assignable here (it moves through "Transfer ownership"), which is why
   *     'owner' is left out of the list.
   *   - `canRemove`     — mirrors `removeMember`/`setMemberBan`: somebody strictly below the viewer,
   *     and never yourself.
   */
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  const viewerRole = membership?.role ?? 'member';
  const assignable: CommunityRole[] = ['admin', 'moderator', 'mentor', 'member'];

  return {
    members: rows.map((row) => {
      const role = isCommunityRole(row.role) ? row.role : 'member';
      const isSelf = row.user_id === userId;
      return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        role,
        status: row.status as MemberStatus,
        contributionPoints: row.contribution_points ?? 0,
        helpfulAnswers: row.helpful_answers ?? 0,
        mutedUntil: row.muted_until,
        joinedAt: row.joined_at,
        isSelf,
        // Any one assignable role is enough for the UI to offer the role control.
        canChangeRole: assignable.some(
          (nextRole) => canChangeRole({ actorRole: viewerRole, targetRole: role, nextRole, isSelf }).ok,
        ),
        canRemove: !isSelf && canActOnMember(viewerRole, role),
      };
    }),
    total: total?.total ?? rows.length,
  };
}

export async function changeMemberRole(
  userId: string,
  communityId: string,
  targetUserId: string,
  nextRole: string,
): Promise<void> {
  const { membership } = await loadForMember(userId, communityId, { capability: 'manage_roles' });
  if (!isCommunityRole(nextRole)) throw new HttpError(400, 'Unknown role.', 'validation_error');

  const target = await membershipOf(targetUserId, communityId);
  if (!target) throw new HttpError(404, 'That student is not a member.', 'not_found');

  const decision = canChangeRole({
    actorRole: membership!.role,
    targetRole: target.role,
    nextRole,
    isSelf: userId === targetUserId,
  });
  if (!decision.ok) throw new HttpError(403, decision.reason, 'forbidden');

  await run(`UPDATE community_members SET role = ?, updated_at = ? WHERE id = ?`, [nextRole, nowIso(), target.id]);
  await recordModeration(communityId, userId, 'role_changed', 'member', targetUserId, `Role set to ${nextRole}`, targetUserId);
}

export async function removeMember(userId: string, communityId: string, targetUserId: string): Promise<void> {
  const { membership } = await loadForMember(userId, communityId, { capability: 'manage_members' });
  if (userId === targetUserId) throw new HttpError(400, 'Use Leave instead of removing yourself.', 'validation_error');

  const target = await membershipOf(targetUserId, communityId);
  if (!target) throw new HttpError(404, 'That student is not a member.', 'not_found');
  if (!canActOnMember(membership!.role, target.role)) {
    throw new HttpError(403, 'You cannot remove someone at or above your own role.', 'forbidden');
  }

  await run(`UPDATE community_members SET status = 'left', updated_at = ? WHERE id = ?`, [nowIso(), target.id]);
  await recordModeration(communityId, userId, 'member_removed', 'member', targetUserId, '');
}

export async function setMemberBan(
  userId: string,
  communityId: string,
  targetUserId: string,
  banned: boolean,
  reason = '',
): Promise<void> {
  const { membership } = await loadForMember(userId, communityId, { capability: 'manage_members' });
  if (userId === targetUserId) throw new HttpError(400, 'You cannot ban yourself.', 'validation_error');

  const target = await membershipOf(targetUserId, communityId);
  if (!target) throw new HttpError(404, 'That student is not a member.', 'not_found');
  if (!canActOnMember(membership!.role, target.role)) {
    throw new HttpError(403, 'You cannot ban someone at or above your own role.', 'forbidden');
  }

  await run(`UPDATE community_members SET status = ?, mute_reason = ?, updated_at = ? WHERE id = ?`, [
    banned ? 'banned' : 'active',
    banned ? reason.slice(0, 300) : null,
    nowIso(),
    target.id,
  ]);
  await recordModeration(communityId, userId, banned ? 'member_banned' : 'member_unbanned', 'member', targetUserId, reason.slice(0, 300));
}

/**
 * Mute a member: they keep reading, they lose the ability to post. `minutes = 0` unmutes.
 * A mute is deliberately weaker than a ban so moderators have a middle option (§32).
 */
export async function setMemberMute(
  userId: string,
  communityId: string,
  targetUserId: string,
  minutes: number,
  reason = '',
): Promise<void> {
  const { membership } = await loadForMember(userId, communityId, { capability: 'moderate_messages' });
  if (userId === targetUserId) throw new HttpError(400, 'You cannot mute yourself.', 'validation_error');

  const target = await membershipOf(targetUserId, communityId);
  if (!target) throw new HttpError(404, 'That student is not a member.', 'not_found');
  if (!canActOnMember(membership!.role, target.role)) {
    throw new HttpError(403, 'You cannot mute someone at or above your own role.', 'forbidden');
  }

  const now = nowIso();
  if (minutes <= 0) {
    await run(`UPDATE community_members SET status = 'active', muted_until = NULL, mute_reason = NULL, updated_at = ? WHERE id = ?`, [
      now,
      target.id,
    ]);
    await recordModeration(communityId, userId, 'member_unmuted', 'member', targetUserId, '');
    return;
  }

  const until = new Date(Date.now() + Math.min(minutes, 60 * 24 * 30) * 60_000).toISOString();
  await run(`UPDATE community_members SET status = 'muted', muted_until = ?, mute_reason = ?, updated_at = ? WHERE id = ?`, [
    until,
    reason.slice(0, 300),
    now,
    target.id,
  ]);
  await recordModeration(communityId, userId, 'member_muted', 'member', targetUserId, reason.slice(0, 300));
}

/** True when the caller may post right now. A mute blocks writes but not reads. */
export function canPost(membership: { status: string; mutedUntil: string | null } | null): boolean {
  if (!membership) return false;
  if (membership.status === 'active') return true;
  if (membership.status !== 'muted') return false;
  // A mute always carries an end time, but a missing one means "indefinite" rather than "expired".
  if (!membership.mutedUntil) return false;
  return new Date(membership.mutedUntil).getTime() <= Date.now();
}

export function assertCanPost(membership: Parameters<typeof canPost>[0]): void {
  if (canPost(membership)) return;
  throw new HttpError(403, 'You are muted in this community, so you cannot post right now.', 'muted');
}

/* ------------------------------------------------------------------ home feed ------------------- */

export interface HomeFeed {
  announcements: unknown[];
  competitions: unknown[];
  events: unknown[];
  resources: unknown[];
  challenges: unknown[];
  pinnedDiscussions: { id: string; title: string; kind: 'doubt' | 'message' }[];
  achievements: { badgeKey: string; label: string; emoji: string; earnedAt: string }[];
}

/**
 * The community Home feed (§9) — deliberately ordered by *educational* relevance, not by engagement:
 * announcements, then what is coming up, then what to study. No popularity ranking.
 */
export async function homeFeed(userId: string, communityId: string): Promise<HomeFeed> {
  await loadForMember(userId, communityId, { requireMembership: true });
  const now = nowIso();

  const [announcements, events, resources, challenges, pinnedDoubts, pinnedMessages, badges] = await Promise.all([
    all(
      `SELECT id, title, body, is_pinned, expires_at, created_by, created_at
         FROM community_announcements
        WHERE community_id = ? AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY is_pinned DESC, created_at DESC LIMIT 5`,
      [communityId, now],
    ),
    all(
      `SELECT id, title, description, kind, starts_at, ends_at, host_id, meeting_url, participant_limit
         FROM community_events WHERE community_id = ? AND ends_at >= ?
        ORDER BY starts_at LIMIT 5`,
      [communityId, now],
    ),
    all(
      `SELECT id, title, description, category, kind, url, note_id, subject, created_by, is_pinned, created_at
         FROM community_resources WHERE community_id = ?
        ORDER BY is_pinned DESC, created_at DESC LIMIT 5`,
      [communityId],
    ),
    all(
      `SELECT id, title, description, subject, days, status, starts_at, ends_at, created_by
         FROM community_challenges WHERE community_id = ? AND status = 'active'
        ORDER BY starts_at DESC LIMIT 5`,
      [communityId],
    ),
    all<{ id: string; title: string }>(
      `SELECT id, title FROM community_doubts WHERE community_id = ? AND status = 'open'
        ORDER BY is_pinned DESC, created_at DESC LIMIT 4`,
      [communityId],
    ),
    all<{ id: string }>(
      `SELECT id FROM community_messages WHERE community_id = ? AND is_pinned = 1 AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 4`,
      [communityId],
    ),
    all<{ badge_key: string; label: string; emoji: string; earned_at: string }>(
      `SELECT ub.badge_key, b.label, b.emoji, ub.earned_at
         FROM user_badges ub JOIN community_badges b ON b.badge_key = ub.badge_key
        WHERE ub.user_id = ? AND (ub.community_id = ? OR ub.community_id IS NULL)
        ORDER BY ub.earned_at DESC LIMIT 6`,
      [userId, communityId],
    ),
  ]);

  const competitions = await all(
    `SELECT c.id, c.title, c.starts_at, c.ends_at, c.status, c.duration_min, c.visibility,
            cc.community_id,
            (SELECT COUNT(*) FROM arena_registrations r WHERE r.competition_id = c.id AND r.status = 'registered') AS participant_count
       FROM community_competitions cc JOIN arena_competitions c ON c.id = cc.competition_id
      WHERE cc.community_id = ?
      ORDER BY c.starts_at DESC LIMIT 5`,
    [communityId],
  );

  return {
    announcements,
    competitions,
    events,
    resources,
    challenges,
    pinnedDiscussions: [
      ...pinnedDoubts.map((d) => ({ id: d.id, title: d.title, kind: 'doubt' as const })),
      ...pinnedMessages.map((m) => ({ id: m.id, title: 'Pinned message', kind: 'message' as const })),
    ],
    achievements: badges.map((b) => ({
      badgeKey: b.badge_key,
      label: b.label,
      emoji: b.emoji,
      earnedAt: b.earned_at,
    })),
  };
}

/* ------------------------------------------------------------------ shared internals ----------- */

/** Notify every owner/admin of a community. Used for join requests and reports. */
export async function notifyCommunityAdmins(
  communityId: string,
  payload: { kind: string; title: string; body: string; link: string | null },
): Promise<void> {
  const { createNotification } = await import('./notifications.js');
  const admins = await all<{ user_id: string }>(
    `SELECT user_id FROM community_members
      WHERE community_id = ? AND role IN ('owner','admin') AND status IN ('active','muted')`,
    [communityId],
  );
  for (const admin of admins) {
    await createNotification({ ...payload, userId: admin.user_id, communityId });
  }
}

/** Append-only moderation log. Every privileged action writes here (§7 audit trail). */
export async function recordModeration(
  communityId: string,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  reason: string,
  targetUserId?: string,
): Promise<void> {
  await run(
    `INSERT INTO moderation_actions
       (id, community_id, actor_id, action, target_type, target_id, target_user_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), communityId, actorId, action, targetType, targetId, targetUserId ?? null, reason, nowIso()],
  );
}

export async function moderationLog(userId: string, communityId: string, limit = 60) {
  await loadForMember(userId, communityId, { capability: 'handle_reports' });
  const rows = await all<{ id: string; actor_id: string; actor_name: string; action: string; target_type: string; target_id: string; reason: string; created_at: string }>(
    `SELECT m.id, m.actor_id, u.name AS actor_name, m.action, m.target_type, m.target_id, m.reason, m.created_at
       FROM moderation_actions m LEFT JOIN users u ON u.id = m.actor_id
      WHERE m.community_id = ? ORDER BY m.created_at DESC LIMIT ?`,
    [communityId, Math.min(limit, 200)],
  );
  return rows;
}

/** Contribution points feeding the leaderboard and badges (§36: contribution, not popularity). */
export async function addContribution(
  communityId: string,
  userId: string,
  points: number,
  field: 'points' | 'helpful' = 'points',
): Promise<void> {
  const column = field === 'helpful' ? 'helpful_answers' : 'contribution_points';
  await run(
    `UPDATE community_members SET ${column} = ${column} + ?, updated_at = ?
      WHERE community_id = ? AND user_id = ?`,
    [points, nowIso(), communityId, userId],
  );
}

/** Communities a user belongs to, for the "My Communities" dashboard (§38). */
export async function myCommunities(userId: string): Promise<CommunitySummary[]> {
  const ids = await memberCommunityIds(userId);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await all<CommunityRow & { member_count: number }>(
    `SELECT c.*, ${COUNT_SQL} AS member_count
       FROM communities c
      WHERE c.id IN (${placeholders}) AND c.status = 'active'
      ORDER BY c.name`,
    ids,
  );
  const memberships = await membershipMap(userId, rows.map((r) => r.id));
  return rows.map((row) => {
    const membership = memberships.get(row.id) ?? null;
    return toSummary(row, {
      role: membership?.role ?? null,
      status: membership?.status ?? null,
      joinRequestStatus: null,
    });
  });
}

export { COMMUNITY_ROLES, roleRank };
export type { CommunityRole };
