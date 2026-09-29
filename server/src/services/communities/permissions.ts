/**
 * Community roles and the capability matrix.
 *
 * Everything here is server-side. The client may *hide* a control, but that is only a courtesy —
 * every route asks this module before it touches data, so a hand-crafted request cannot escalate a
 * role, read a private community, or moderate content the caller has no standing over (§3, §53).
 *
 * The role axis is deliberately separate from the platform axis: a Vroqn `admin` is not automatically
 * an admin of somebody else's community, and a community OWNER gains nothing on the platform.
 */
import { all, one } from '../../db/index.js';
import { HttpError } from '../../middleware/errors.js';

/** Ordered from most to least powerful. `rank` comparisons rely on this order. */
export const COMMUNITY_ROLES = ['owner', 'admin', 'moderator', 'mentor', 'member'] as const;
export type CommunityRole = (typeof COMMUNITY_ROLES)[number];

export function isCommunityRole(value: unknown): value is CommunityRole {
  return typeof value === 'string' && (COMMUNITY_ROLES as readonly string[]).includes(value);
}

export function roleRank(role: CommunityRole): number {
  return COMMUNITY_ROLES.length - COMMUNITY_ROLES.indexOf(role);
}

export function roleLabel(role: CommunityRole): string {
  return {
    owner: 'Owner',
    admin: 'Admin',
    moderator: 'Moderator',
    mentor: 'Mentor',
    member: 'Member',
  }[role];
}

/** Membership states. `banned` and `left` both block access but are different histories. */
export const MEMBER_STATUSES = ['active', 'muted', 'banned', 'left'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export interface Membership {
  id: string;
  communityId: string;
  userId: string;
  role: CommunityRole;
  status: MemberStatus;
  mutedUntil: string | null;
  contributionPoints: number;
  joinedAt: string;
}

/**
 * Capabilities, grouped by the thing being acted on. A single flat list keeps the checks readable at
 * the call site (`assertCan(role, 'moderate_messages')`) and makes the matrix auditable in one place.
 */
export type Capability =
  /* community itself */
  | 'edit_community'
  | 'delete_community'
  | 'transfer_ownership'
  | 'manage_roles'
  | 'manage_members'
  | 'approve_requests'
  | 'create_invites'
  /* content */
  | 'create_competition'
  | 'create_challenge'
  | 'create_event'
  | 'create_resource'
  | 'create_study_plan'
  | 'create_announcement'
  | 'create_poll'
  | 'create_team'
  /* safety */
  | 'moderate_messages'
  | 'handle_reports'
  | 'view_analytics';

const MATRIX: Record<Capability, CommunityRole[]> = {
  // Only the owner can delete or hand over. Admins can edit settings but not destroy the community.
  edit_community: ['owner', 'admin'],
  delete_community: ['owner'],
  transfer_ownership: ['owner'],
  manage_roles: ['owner', 'admin'],
  manage_members: ['owner', 'admin'],
  approve_requests: ['owner', 'admin'],
  create_invites: ['owner', 'admin'],

  create_competition: ['owner', 'admin'],
  create_challenge: ['owner', 'admin', 'mentor'],
  create_event: ['owner', 'admin', 'mentor'],
  // §18: sharing notes/links/formula sheets is a member activity, not a staff one. Spam is handled by
  // the write limiter and the moderation queue rather than by locking the feature away from students.
  create_resource: ['owner', 'admin', 'moderator', 'mentor', 'member'],
  create_study_plan: ['owner', 'admin', 'mentor'],
  create_announcement: ['owner', 'admin', 'moderator'],
  create_poll: ['owner', 'admin', 'moderator'],
  // §22: students organise their own study groups; a creator can hold at most a few teams at once.
  create_team: ['owner', 'admin', 'mentor', 'member'],

  moderate_messages: ['owner', 'admin', 'moderator'],
  handle_reports: ['owner', 'admin', 'moderator'],
  view_analytics: ['owner', 'admin'],
};

/**
 * Moderator or above. Used where the question is "may this person act on other people's content"
 * rather than "does this person hold one specific capability".
 */
export function isModerator(role: CommunityRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'moderator';
}

export function can(role: CommunityRole | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  return MATRIX[capability].includes(role);
}

/** Throws a 403 with a readable message rather than returning false, so routes cannot forget to check. */
export function assertCan(role: CommunityRole | null | undefined, capability: Capability): void {
  if (can(role, capability)) return;
  throw new HttpError(403, notAllowedMessage(capability), 'forbidden');
}

function notAllowedMessage(capability: Capability): string {
  const needs = MATRIX[capability];
  const label = needs.length === 1 && needs[0] === 'owner' ? 'the community owner' : `a ${needs.filter((r) => r !== 'owner').map(roleLabel).join(' or ')}`;
  return `Only ${label} can do that in this community.`;
}

/* ------------------------------------------------------------------ membership lookup ---------- */

interface MemberRow {
  id: string;
  community_id: string;
  user_id: string;
  role: string;
  status: string;
  muted_until: string | null;
  contribution_points: number | null;
  joined_at: string;
}

function toMembership(row: MemberRow): Membership {
  return {
    id: row.id,
    communityId: row.community_id,
    userId: row.user_id,
    role: isCommunityRole(row.role) ? row.role : 'member',
    status: (MEMBER_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as MemberStatus)
      : 'active',
    mutedUntil: row.muted_until ?? null,
    contributionPoints: row.contribution_points ?? 0,
    joinedAt: row.joined_at,
  };
}

/** The caller's membership row, or null when they have never joined. */
export async function membershipOf(userId: string, communityId: string): Promise<Membership | null> {
  const columns = `id, community_id, user_id, role, status, muted_until, contribution_points, joined_at`;
  const row = await one<MemberRow>(
    `SELECT ${columns} FROM community_members WHERE community_id = ? AND user_id = ?`,
    [communityId, userId],
  );
  if (row) return toMembership(row);

  /*
   * The path parameter may be a slug rather than an id. Falling back to a slug lookup here — rather
   * than at each of the dozen call sites — means no caller can accidentally look a membership up by a
   * value that is not an id. The extra query only runs when the id lookup already missed.
   */
  const bySlug = await one<MemberRow>(
    `SELECT m.id, m.community_id, m.user_id, m.role, m.status, m.muted_until, m.contribution_points, m.joined_at
       FROM community_members m
       JOIN communities c ON c.id = m.community_id
      WHERE c.slug = ? AND m.user_id = ?`,
    [communityId, userId],
  );
  return bySlug ? toMembership(bySlug) : null;
}

/**
 * True when the membership grants ordinary access. A `muted` member still reads and reacts — muting
 * only stops them posting, which is the point of a mute as opposed to a ban.
 */
export function isActiveMember(membership: Membership | null): boolean {
  return Boolean(membership && (membership.status === 'active' || membership.status === 'muted'));
}

/** A mute that has silently expired should not keep blocking writes. */
export function isMuted(membership: Membership | null): boolean {
  if (!membership || membership.status !== 'muted') return false;
  if (!membership.mutedUntil) return true;
  return new Date(membership.mutedUntil).getTime() > Date.now();
}

/** Memberships for one user across many communities, keyed by community id. */
export async function membershipsFor(
  userId: string,
  communityIds: string[],
): Promise<Map<string, Membership>> {
  const map = new Map<string, Membership>();
  if (!communityIds.length) return map;
  const placeholders = communityIds.map(() => '?').join(', ');
  const rows = await all<MemberRow>(
    `SELECT id, community_id, user_id, role, status, muted_until, contribution_points, joined_at
       FROM community_members WHERE user_id = ? AND community_id IN (${placeholders})`,
    [userId, ...communityIds],
  );
  for (const row of rows) map.set(row.community_id, toMembership(row));
  return map;
}

/** Every community the user is an active (or muted) member of. This is the access allow-list. */
export async function memberCommunityIds(userId: string): Promise<string[]> {
  const rows = await all<{ community_id: string }>(
    `SELECT community_id FROM community_members
      WHERE user_id = ? AND status IN ('active', 'muted')`,
    [userId],
  );
  return rows.map((row) => row.community_id);
}

/* ------------------------------------------------------------------ role-change guardrails ----- */

/**
 * Whether `actor` may set `target`'s role to `next`.
 *
 * Rules that stop the two classic escalation paths:
 *  - You can never grant a role at or above your own (an admin cannot mint another owner, or
 *    promote themselves by promoting a peer and swapping).
 *  - Only the owner can touch the owner's row, and the owner cannot be demoted by anyone else.
 */
export function canChangeRole(args: {
  actorRole: CommunityRole;
  targetRole: CommunityRole;
  nextRole: CommunityRole;
  isSelf: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const { actorRole, targetRole, nextRole, isSelf } = args;
  /*
   * Ownership never moves through a role change.
   *
   * This used to be allowed for the owner, which produced two owners in one community: the original
   * owner kept `communities.created_by` while a second membership also read `owner`, so the "who owns
   * this" answer depended on which row you looked at, and neither owner could be demoted by the other.
   * Handing over is a single, confirmed operation instead (§3).
   */
  if (nextRole === 'owner') {
    return { ok: false, reason: 'Ownership is handed over with "Transfer ownership", not by changing a role.' };
  }
  if (actorRole === 'owner') {
    if (targetRole === 'owner' && !isSelf) {
      return { ok: false, reason: 'There can only be one owner. Transfer ownership instead.' };
    }
    return { ok: true };
  }
  if (targetRole === 'owner') return { ok: false, reason: 'Only the owner can change the owner role.' };
  if (roleRank(nextRole) >= roleRank(actorRole)) {
    return { ok: false, reason: `You cannot grant a role equal to or above your own (${roleLabel(actorRole)}).` };
  }
  if (roleRank(targetRole) >= roleRank(actorRole)) {
    return { ok: false, reason: `You cannot change the role of a ${roleLabel(targetRole)}.` };
  }
  return { ok: true };
}

/** Whether `actor` may remove / ban / mute `target`. You can only act downwards. */
export function canActOnMember(actorRole: CommunityRole, targetRole: CommunityRole): boolean {
  if (actorRole === 'owner') return true;
  return roleRank(targetRole) < roleRank(actorRole);
}

/* ------------------------------------------------------------------ presentation ---------------- */

/**
 * The capability matrix, grouped and described for the Roles screen.
 *
 * The UI renders exactly this: it is generated from the same table the route guards consult, so the
 * documentation cannot drift away from what the server actually permits. There are deliberately no
 * per-community permission overrides — see `docs/COMMUNITIES-REPORT.md` for why the matrix is fixed.
 */
export const PERMISSION_GROUPS: { id: string; label: string; capabilities: { capability: Capability; label: string; description: string }[] }[] = [
  {
    id: 'general',
    label: 'Community and members',
    capabilities: [
      { capability: 'edit_community', label: 'Edit community details', description: 'Name, description, rules, category and visibility.' },
      { capability: 'delete_community', label: 'Delete the community', description: 'Owner only. Removes the group and everything inside it.' },
      { capability: 'transfer_ownership', label: 'Transfer ownership', description: 'Hands the community to one other member, with confirmation.' },
      { capability: 'manage_roles', label: 'Manage roles', description: 'Promote or demote members below your own role.' },
      { capability: 'manage_members', label: 'Remove, mute and ban members', description: 'Always limited to members below your own role.' },
      { capability: 'approve_requests', label: 'Approve join requests', description: 'For invite-only and request-to-join communities.' },
      { capability: 'create_invites', label: 'Create invite links', description: 'Time-limited codes that let someone skip the request queue.' },
    ],
  },
  {
    id: 'content',
    label: 'Content',
    capabilities: [
      { capability: 'create_announcement', label: 'Post announcements', description: 'Pinned, and shown on the community home.' },
      { capability: 'create_resource', label: 'Share resources', description: 'Notes, links and uploaded files.' },
      { capability: 'create_challenge', label: 'Create challenges', description: 'Multi-day study challenges with a checklist.' },
      { capability: 'create_study_plan', label: 'Create study plans', description: 'Shared plans with tasks other members can follow.' },
      { capability: 'create_competition', label: 'Host competitions', description: 'Creates a real Arena paper for this community.' },
      { capability: 'create_event', label: 'Schedule events', description: 'Study sessions with a time, place and reminder.' },
      { capability: 'create_poll', label: 'Create polls', description: 'Quick votes inside community chat.' },
      { capability: 'create_team', label: 'Create teams', description: 'Small study teams inside the community.' },
    ],
  },
  {
    id: 'moderation',
    label: 'Moderation',
    capabilities: [
      { capability: 'moderate_messages', label: 'Moderate chat', description: 'Remove messages, mute members, pin posts.' },
      { capability: 'handle_reports', label: 'Handle reports', description: 'Read the report queue and record an action taken.' },
      { capability: 'view_analytics', label: 'See analytics', description: 'Activity, retention and doubt-resolution numbers.' },
    ],
  },
];

/** Every role's effective permissions, in the shape the Roles screen renders. */
export function permissionMatrix(): Record<CommunityRole, Record<Capability, boolean>> {
  return Object.fromEntries(
    COMMUNITY_ROLES.map((role) => [
      role,
      Object.fromEntries((Object.keys(MATRIX) as Capability[]).map((capability) => [capability, can(role, capability)])),
    ]),
  ) as Record<CommunityRole, Record<Capability, boolean>>;
}

/** Capability flags for the caller, so the UI can hide what the server would refuse anyway. */
export function capabilitiesFor(role: CommunityRole | null) {
  const entries = Object.keys(MATRIX) as Capability[];
  return Object.fromEntries(entries.map((capability) => [capability, can(role, capability)])) as Record<
    Capability,
    boolean
  >;
}
