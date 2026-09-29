/**
 * Community visibility and the single authorisation gate.
 *
 * Every read of community content goes through `loadForMember` or `assertCanViewCommunity`. That is
 * deliberate: the fastest way to leak a private community is to add a new endpoint that forgets to
 * check, so instead of repeating the rule the rule lives in one function and the helpers below are
 * the only sanctioned way in.
 *
 * A community that the caller may not see returns **404, not 403** — a 403 would confirm that a
 * private community with that id exists, which is exactly the information §43 asks us not to leak.
 */
import { all, one } from '../../db/index.js';
import { HttpError } from '../../middleware/errors.js';
import {
  assertCan,
  capabilitiesFor,
  isActiveMember,
  membershipOf,
  type Capability,
  type CommunityRole,
  type Membership,
} from './permissions.js';
import { categoryLabel, isVisibility, type CommunityVisibility } from './types.js';

export interface CommunityRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  logo_url: string | null;
  banner_url: string | null;
  category: string;
  tags: string | null;
  rules: string;
  visibility: string;
  member_limit: number | null;
  join_requirements: string;
  welcome_message: string;
  accent: string;
  is_verified: number | null;
  is_leaderboard_enabled: number | null;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CommunityContext {
  community: CommunityRow;
  membership: Membership | null;
  role: CommunityRole | null;
  visibility: CommunityVisibility;
  /** True for owners/admins/mods/mentors/members with an active or muted membership. */
  isMember: boolean;
}

export function visibilityOf(row: Pick<CommunityRow, 'visibility'>): CommunityVisibility {
  return isVisibility(row.visibility) ? row.visibility : 'public';
}

export function tagsOf(row: Pick<CommunityRow, 'tags'>): string[] {
  if (!row.tags) return [];
  try {
    const parsed = JSON.parse(row.tags);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string').slice(0, 12) : [];
  } catch {
    return [];
  }
}

/**
 * Can this viewer read the community's content?
 *
 * - `public`      — anyone signed in (discovery is a signed-in surface, matching the rest of Vroqn).
 * - `private`     — active members only; everyone else must request to join.
 * - `invite_only` — active members only; entry is by invite code.
 */
export function canViewCommunity(visibility: CommunityVisibility, membership: Membership | null): boolean {
  if (visibility === 'public') return true;
  return isActiveMember(membership);
}

/**
 * The gate for content endpoints. Returns the community and the caller's membership, or throws.
 *
 * `capability` is optional; when supplied the caller's role must also allow it, which keeps the
 * common "load it and check permission" pair in one call instead of two steps that can drift apart.
 */
/**
 * Resolves an id **or** a slug to the canonical community id.
 *
 * Community links carry the slug, because that is what a student can read and share. Services,
 * however, address rows by id — and a slug used in a `WHERE community_id = ?` silently matches
 * nothing, which is how a community owner once saw their own community as "0 members · Join".
 * Route handlers canonicalise the path parameter once, through this function, so every service below
 * receives a real id.
 */
export async function canonicalCommunityId(idOrSlug: string): Promise<string> {
  const row = await getCommunityRow(idOrSlug);
  return row?.id ?? idOrSlug;
}

export async function loadForMember(
  userId: string,
  communityId: string,
  options: { requireMembership?: boolean; capability?: Capability } = {},
): Promise<CommunityContext> {
  const community = await getCommunityRow(communityId);
  if (!community || community.status === 'deleted') {
    throw new HttpError(404, 'That community does not exist.', 'not_found');
  }

  /*
   * `communityId` may be a slug (that is what the URL carries), so the membership lookup uses the
   * resolved row's own id. Looking a membership up by slug silently returns nothing, which made an
   * owner see their own community as a stranger's — the exact class of bug that hides until a link is
   * shared.
   */
  const membership = await membershipOf(userId, community.id);
  const visibility = visibilityOf(community);
  const isMember = isActiveMember(membership);

  if (!isMember) {
    if (visibility !== 'public' || options.requireMembership) {
      // 404 rather than 403 on purpose: do not confirm that a private community exists.
      throw new HttpError(
        404,
        visibility === 'public'
          ? 'Join this community to see its content.'
          : 'That community does not exist.',
        'not_found',
      );
    }
  }

  if (membership?.status === 'banned') {
    throw new HttpError(403, 'You are banned from this community.', 'banned');
  }

  if (options.capability) assertCan(membership?.role ?? null, options.capability);

  return { community, membership, role: membership?.role ?? null, visibility, isMember };
}

const COMMUNITY_COLUMNS = `id, name, slug, description, logo_url, banner_url, category, tags, rules,
       visibility, member_limit, join_requirements, welcome_message, accent, is_verified,
       is_leaderboard_enabled, status, created_by, created_at, updated_at`;

/**
 * Looks a community up by id, then by slug.
 *
 * Shared links use the readable slug (`/communities/jee-physics-warriors`), so both forms have to
 * resolve. Visibility is *not* decided here - the caller still goes through `loadForMember`, which
 * returns a 404 for a private community to anyone who may not read it. Supporting slugs therefore
 * adds convenience without adding a way to discover a hidden community's contents.
 */
export async function getCommunityRow(idOrSlug: string): Promise<CommunityRow | null> {
  const byId = await one<CommunityRow>(
    `SELECT ${COMMUNITY_COLUMNS} FROM communities WHERE id = ?`,
    [idOrSlug],
  );
  if (byId) return byId;
  return one<CommunityRow>(`SELECT ${COMMUNITY_COLUMNS} FROM communities WHERE slug = ?`, [idOrSlug]);
}

/**
 * Throws unless the caller may view the community. Used by the SSE stream and by search, where the
 * caller needs the guard without the full context object.
 */
export async function assertCanViewCommunity(userId: string, communityId: string): Promise<CommunityContext> {
  return loadForMember(userId, communityId);
}

/** Capability flags for the UI. The server still re-checks every write. */
export function capabilitiesOf(role: CommunityRole | null): Record<string, boolean> {
  return capabilitiesFor(role);
}

/**
 * Community ids the caller is allowed to read at all.
 *
 * Public communities are readable by any signed-in user; private and invite-only ones only by their
 * members. Every list endpoint (search, feed, discovery) filters through this.
 */
export async function readableCommunityIds(userId: string): Promise<string[]> {
  const [publics, joined] = await Promise.all([
    all<{ id: string }>(`SELECT id FROM communities WHERE visibility = 'public' AND status = 'active'`),
    all<{ id: string }>(
      `SELECT community_id AS id FROM community_members WHERE user_id = ? AND status IN ('active', 'muted')`,
      [userId],
    ),
  ]);
  return [...new Set([...publics.map((r) => r.id), ...joined.map((r) => r.id)])];
}

/** Human-readable label for a visibility, used in the UI and in notifications. */
export function visibilityLabel(visibility: CommunityVisibility): string {
  return { public: 'Public', private: 'Private', invite_only: 'Invite only' }[visibility];
}

export { categoryLabel };
