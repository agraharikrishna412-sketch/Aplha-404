/**
 * Vroqn Communities API.
 *
 * Layout rules that matter for correctness:
 *  - Literal paths (`/discover`, `/mine`, `/search`, `/notifications`, ...) are declared **before**
 *    `/:id`, otherwise Express would treat "discover" as a community id.
 *  - Every handler resolves the caller's membership through `loadForMember` or an explicit
 *    capability; nothing here trusts a role or a visibility flag sent by the client (§3, §53).
 *  - Writes that create content go through the `chat` rate-limit bucket; reads are covered by the
 *    general limiter that is already mounted on `/api` (§7 spam/flood protection).
 *  - SSE is used for live chat and notifications. It is a stream of *events about data the caller may
 *    already read*, never a back door: the subscription itself is authorised first, and a private
 *    community is refused before the stream opens (§6, no separate chat server).
 */
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncRoute, HttpError, parseBody } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { limits } from '../middleware/rateLimit.js';
import { canonicalCommunityId } from '../services/communities/access.js';
import { COMMUNITY_ROLES, PERMISSION_GROUPS, permissionMatrix } from '../services/communities/permissions.js';
import { communityChannel, subscribe, userChannel } from '../services/communities/bus.js';
import { config } from '../config/env.js';
import { uuid } from '../db/index.js';
import { classifyUpload, registerUpload, type UploadedFile } from '../services/notes.js';
import {
  createCommunity,
  createInvite,
  changeMemberRole,
  decideJoinRequest,
  deleteCommunity,
  getCommunityDetail,
  homeFeed,
  joinCommunity,
  leaveCommunity,
  listCommunities,
  listInvites,
  listJoinRequests,
  listMembers,
  markRead,
  moderationLog,
  myCommunities,
  removeMember,
  revokeInvite,
  setMemberBan,
  transferOwnership,
  updateCommunity,
} from '../services/communities/communities.js';
import {
  ALLOWED_REACTIONS,
  MAX_MESSAGE_LENGTH,
  deleteMessage,
  editMessage,
  listMessages,
  sendMessage,
  togglePin,
  toggleReaction,
} from '../services/communities/chat.js';
import { createPoll, deletePoll, listPolls, vote } from '../services/communities/polls.js';
import {
  answerDoubt,
  attachUploadResource,
  createDoubt,
  createResource,
  resourceDownload,
  deleteAnswer,
  deleteResource,
  getDoubt,
  listDoubts,
  listKnowledge,
  listResources,
  markHelpful,
  promoteToKnowledge,
  toggleResourcePin,
} from '../services/communities/learning.js';
import {
  createAnnouncement,
  createChallenge,
  createEvent,
  createStudyPlan,
  createStudyRoom,
  deleteAnnouncement,
  deleteChallenge,
  deleteEvent,
  deleteStudyPlan,
  joinStudyRoom,
  listAnnouncements,
  listChallenges,
  listEvents,
  listStudyPlans,
  listStudyRooms,
  setChallengeDay,
  setEventRsvp,
  setStudyPlanTask,
  setStudyRoomChecklist,
} from '../services/communities/programs.js';
import {
  badgesFor,
  blockUser,
  blockedUserIds,
  evaluateBadges,
  learningStreak,
  leaderboard,
  myContribution,
  profileView,
  unblockUser,
  updateProfileSettings,
} from '../services/communities/reputation.js';
import {
  auditTrail,
  kickMember,
  listReports,
  myModerationQueue,
  muteMember,
  reportContent,
  resolveReport,
  unmuteMember,
} from '../services/communities/moderation.js';
import {
  createCommunityCompetition,
  prepareCommunityPaper,
  communityPaperStatus,
  listCommunityCompetitions,
  registerForCommunityCompetition,
  removeCommunityCompetition,
  upcomingForUser,
  withdrawFromCommunityCompetition,
} from '../services/communities/competitions.js';
import {
  inviteToTeam,
  createTeam,
  deleteTeam,
  joinTeam,
  leaveTeam,
  listTeams,
  removeTeamMember,
  teamStandings,
} from '../services/communities/teams.js';
import {
  activityTrend,
  communityAnalytics,
  growth,
  weeklyDigest,
} from '../services/communities/analytics.js';
import { memberSuggestions, search, searchCommunities } from '../services/communities/search.js';
import {
  getPreferences,
  listNotifications,
  markAllRead,
  markRead as markNotificationRead,
  setPreferences,
  unreadCount,
} from '../services/communities/notifications.js';
import { CATEGORY_LABELS, COMMUNITY_CATEGORIES, EVENT_KINDS, RESOURCE_KINDS, VISIBILITIES } from '../services/communities/types.js';

export const communitiesRouter = Router();

/*
 * Resource uploads.
 *
 * The storage rules are the ones already used for note uploads — same directory, same size cap, same
 * MIME allowlist — so a community cannot become a way around them. An unknown file type is refused
 * with 415 before anything is written, and the original name is never used as a path.
 */
const maxUploadBytes = config.maxUploadMb * 1024 * 1024;

const resourceUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(config.uploadDir, 'community');
      require('node:fs').mkdirSync(dir, { recursive: true, mode: 0o700 });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10) || '.bin';
      cb(null, `${uuid()}${ext}`);
    },
  }),
  limits: { fileSize: maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!classifyUpload(file)) {
      cb(new HttpError(415, 'Only images, PDFs, audio and text files can be shared.', 'unsupported_media_type'));
      return;
    }
    cb(null, true);
  },
});

/** Turns multer's own errors into the API's error shape so the client can show a real message. */
function uploadErrors(handler: import('express').RequestHandler): import('express').RequestHandler {
  return (req, res, next) => {
    handler(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError(413, `Files must be under ${config.maxUploadMb} MB.`, 'file_too_large'));
      }
      return next(err);
    });
  };
}

function toUploadedFile(file: Express.Multer.File): UploadedFile {
  return {
    path: file.path,
    originalName: file.originalname,
    mime: file.mimetype,
    size: file.size,
    kind: classifyUpload(file) ?? 'text',
  };
}

communitiesRouter.use(requireAuth);

/*
 * Every `:id` in this router accepts a community id or its slug, and is rewritten to the canonical id
 * here, once, before any handler runs — so no service has to remember that a link may carry a slug.
 *
 * This has to be `router.param`, not a `use()` middleware: Express rebuilds `req.params` for each
 * layer, so a rewrite done in middleware is thrown away before the handler sees it. A slug that slipped
 * through used to be written into rows as if it were a community id.
 *
 * A value matching no community is passed through untouched, so the handler still answers 404 in its
 * usual voice. This never decides authorisation, and never turns a miss into an error.
 */
communitiesRouter.param('id', (req, _res, next, value: string) => {
  canonicalCommunityId(value)
    .then((resolved) => {
      req.params.id = resolved;
      next();
    })
    .catch(() => next());
});

/* ------------------------------------------------------------------ helpers --------------------- */

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function int(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function flag(value: unknown): boolean {
  return value === 'true' || value === '1' || value === true;
}

const idParams = (req: { params: Record<string, string> }, key: string): string => {
  const value = req.params[key];
  if (!value) throw new HttpError(400, 'A required id is missing.', 'validation_error');
  return value;
};

/* ------------------------------------------------------------------ taxonomy + discovery ------- */

communitiesRouter.get('/catalog', (_req, res) => {
  res.json({
    categories: COMMUNITY_CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] ?? value })),
    visibilities: VISIBILITIES,
    resourceKinds: RESOURCE_KINDS,
    eventKinds: EVENT_KINDS,
    reactions: ALLOWED_REACTIONS,
    maxMessageLength: MAX_MESSAGE_LENGTH,
  });
});

communitiesRouter.get(
  '/discover',
  asyncRoute(async (req, res) => {
    // `mine=true` narrows discovery to communities the caller is already in, which is what the
    // "My Communities" tab of Explore needs. The service decides visibility either way.
    const scope: 'all' | 'joined' | 'mine' | 'popular' | 'recent' = flag(req.query.mine)
      ? 'joined'
      : req.query.sort === 'recent'
        ? 'recent'
        : req.query.sort === 'popular'
          ? 'popular'
          : 'all';

    const result = await listCommunities(req.user!.id, {
      search: text(req.query.search).slice(0, 80) || undefined,
      category: text(req.query.category) || undefined,
      tag: text(req.query.tag).slice(0, 40) || undefined,
      scope,
      limit: Math.min(Math.max(int(req.query.limit, 24), 1), 60),
      offset: Math.max(int(req.query.offset, 0), 0),
    });
    // `{ communities, total }` — the total is what the Explore page needs for "showing 12 of 40".
    res.json(result);
  }),
);

/** Public name search only — never returns a private community, even as a teaser (§12). */
communitiesRouter.get(
  '/search',
  asyncRoute(async (req, res) => {
    const term = text(req.query.q).trim();
    if (term.length < 2) {
      res.json({ results: [] });
      return;
    }
    const results = await searchCommunities(term, int(req.query.limit, 20));
    res.json({ results });
  }),
);

/** Search inside everything the caller may read: doubts, knowledge, resources, competitions, ... */
communitiesRouter.get(
  '/smart-search',
  asyncRoute(async (req, res) => {
    const term = text(req.query.q).trim();
    const communityId = text(req.query.communityId) || null;
    const result = await search(req.user!.id, term, { communityId });
    res.json(result);
  }),
);

/**
 * Search inside one community. Same engine as `/smart-search`, scoped to a single community, so the
 * "search this community" box and the global search can never disagree about what is findable.
 * Membership is enforced by `search()` itself.
 */
communitiesRouter.get(
  '/:id/search',
  asyncRoute(async (req, res) => {
    const term = text(req.query.q).trim();
    if (term.length < 2) {
      res.json({ query: term, hits: [], scope: [] });
      return;
    }
    const result = await search(req.user!.id, term, { communityId: idParams(req, 'id') });
    res.json(result);
  }),
);

communitiesRouter.get(
  '/mine',
  asyncRoute(async (req, res) => {
    const communities = await myCommunities(req.user!.id);
    res.json({ communities });
  }),
);

/**
 * Compact block for the homepage/dashboard: my communities, what is coming up, and whether anything
 * needs my attention. Deliberately small so the dashboard does not become a wall of cards (§50).
 */
communitiesRouter.get(
  '/dashboard',
  asyncRoute(async (req, res) => {
    const userId = req.user!.id;
    const [mine, notifications, moderation] = await Promise.all([
      myCommunities(userId),
      unreadCount(userId),
      myModerationQueue(userId),
    ]);

    // Time-sensitive items only: a competition or event that has not finished yet, inside a
    // community the caller is actually in.
    const soon = Date.now() + 14 * 86_400_000;
    const upcoming = await upcomingForUser(mine.map((community) => community.id));
    const imminent = upcoming
      .filter((row) => new Date(row.ends_at).getTime() >= Date.now() && new Date(row.starts_at).getTime() <= soon)
      .slice(0, 3);

    res.json({
      communities: mine.slice(0, 6),
      totalCommunities: mine.length,
      upcoming: imminent,
      unreadNotifications: notifications,
      moderationQueue: moderation.total,
    });
  }),
);

/* ------------------------------------------------------------------ notifications --------------- */

communitiesRouter.get(
  '/notifications',
  asyncRoute(async (req, res) => {
    const result = await listNotifications(req.user!.id, {
      limit: Math.min(Math.max(int(req.query.limit, 30), 1), 100),
      offset: Math.max(int(req.query.offset, 0), 0),
      unreadOnly: flag(req.query.unreadOnly),
    });
    res.json(result);
  }),
);

communitiesRouter.get(
  '/notifications/preferences',
  asyncRoute(async (req, res) => {
    res.json(await getPreferences(req.user!.id));
  }),
);

communitiesRouter.put(
  '/notifications/preferences',
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ mutedKinds: z.array(z.string().max(40)).max(40) }), req.body);
    res.json(await setPreferences(req.user!.id, body.mutedKinds));
  }),
);

communitiesRouter.post(
  '/notifications/read-all',
  asyncRoute(async (req, res) => {
    res.json({ updated: await markAllRead(req.user!.id) });
  }),
);

communitiesRouter.post(
  '/notifications/:notificationId/read',
  asyncRoute(async (req, res) => {
    await markNotificationRead(req.user!.id, idParams(req, 'notificationId'));
    res.json({ ok: true, unread: await unreadCount(req.user!.id) });
  }),
);

/* ------------------------------------------------------------------ profile + privacy ---------- */

communitiesRouter.get(
  '/badges',
  asyncRoute(async (req, res) => {
    await evaluateBadges(req.user!.id);
    res.json({ badges: await badgesFor(req.user!.id), streakDays: await learningStreak(req.user!.id) });
  }),
);

communitiesRouter.get(
  '/profile/me',
  asyncRoute(async (req, res) => {
    res.json(await profileView(req.user!.id, req.user!.id));
  }),
);

communitiesRouter.put(
  '/profile/me',
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        bio: z.string().max(400).optional(),
        interests: z.array(z.string().max(40)).max(12).optional(),
        isProfilePublic: z.boolean().optional(),
        isActivityVisible: z.boolean().optional(),
        isCommunitiesVisible: z.boolean().optional(),
      }),
      req.body,
    );
    await updateProfileSettings(req.user!.id, body);
    res.json(await profileView(req.user!.id, req.user!.id));
  }),
);

communitiesRouter.get(
  '/profile/blocks',
  asyncRoute(async (req, res) => {
    res.json({ blocked: await blockedUserIds(req.user!.id) });
  }),
);

communitiesRouter.post(
  '/profile/blocks',
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ userId: z.string().min(1).max(60) }), req.body);
    await blockUser(req.user!.id, body.userId);
    res.json({ blocked: await blockedUserIds(req.user!.id) });
  }),
);

communitiesRouter.delete(
  '/profile/blocks/:userId',
  asyncRoute(async (req, res) => {
    await unblockUser(req.user!.id, idParams(req, 'userId'));
    res.json({ blocked: await blockedUserIds(req.user!.id) });
  }),
);

communitiesRouter.get(
  '/profile/:userId',
  asyncRoute(async (req, res) => {
    /*
     * `me` is accepted here as a synonym for the caller.
     *
     * The client links to `/communities/profile/me` (it is the natural URL for "my community profile"),
     * and the literal string used to be handed to the database as a user id — which returned
     * "That community does not exist" on a student's own profile. The dedicated `/profile/me` route
     * above is still the one the SPA prefers; this keeps the alias honest for anyone typing the URL or
     * following a link from an older build.
     */
    const requested = idParams(req, 'userId');
    res.json(await profileView(req.user!.id, requested === 'me' ? req.user!.id : requested));
  }),
);

/* ------------------------------------------------------------------ create --------------------- */

const createSchema = z.object({
  name: z.string().min(3).max(80),
  description: z.string().max(600).optional(),
  category: z.string().min(2).max(40),
  tags: z.array(z.string().max(30)).max(8).optional(),
  rules: z.string().max(4000).optional(),
  visibility: z.enum(['public', 'private', 'invite_only']).optional(),
  memberLimit: z.number().int().min(2).max(100000).nullable().optional(),
  joinRequirements: z.string().max(600).optional(),
  welcomeMessage: z.string().max(1000).optional(),
  accent: z.string().max(20).optional(),
  logoUrl: z.string().max(400).nullable().optional(),
  bannerUrl: z.string().max(400).nullable().optional(),
  isLeaderboardEnabled: z.boolean().optional(),
});

communitiesRouter.post(
  '/',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(createSchema, req.body);
    const community = await createCommunity(req.user!.id, body);
    res.status(201).json(community);
  }),
);

/* ------------------------------------------------------------------ one community ------------- */

communitiesRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const community = await getCommunityDetail(req.user!.id, idParams(req, 'id'));
    // Reading a community marks its announcements as seen so the unread badge stays honest.
    await markRead(req.user!.id, community.id);
    res.json(community);
  }),
);

communitiesRouter.patch(
  '/:id',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(createSchema.partial(), req.body);
    res.json(await updateCommunity(req.user!.id, idParams(req, 'id'), body));
  }),
);

communitiesRouter.delete(
  '/:id',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await deleteCommunity(req.user!.id, idParams(req, 'id'));
    res.json({ ok: true });
  }),
);

communitiesRouter.post(
  '/:id/transfer',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({ userId: z.string().min(1).max(60), confirm: z.literal(true) }),
      req.body,
    );
    await transferOwnership(req.user!.id, idParams(req, 'id'), body.userId);
    res.json({ ok: true });
  }),
);

communitiesRouter.post(
  '/:id/join',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({ inviteCode: z.string().max(40).optional(), reason: z.string().max(400).optional() }),
      req.body ?? {},
    );
    res.json(await joinCommunity(req.user!.id, idParams(req, 'id'), body));
  }),
);

communitiesRouter.post(
  '/:id/leave',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await leaveCommunity(req.user!.id, idParams(req, 'id'));
    res.json({ ok: true });
  }),
);

communitiesRouter.post(
  '/:id/read',
  asyncRoute(async (req, res) => {
    await markRead(req.user!.id, idParams(req, 'id'));
    res.json({ ok: true });
  }),
);

communitiesRouter.get(
  '/:id/home',
  asyncRoute(async (req, res) => {
    res.json(await homeFeed(req.user!.id, idParams(req, 'id')));
  }),
);

communitiesRouter.get(
  '/:id/mentions',
  asyncRoute(async (req, res) => {
    res.json({
      members: await memberSuggestions(req.user!.id, idParams(req, 'id'), text(req.query.q).slice(0, 40)),
    });
  }),
);

/* ------------------------------------------------------------------ joins + invites ------------- */

communitiesRouter.get(
  '/:id/join-requests',
  asyncRoute(async (req, res) => {
    res.json({ requests: await listJoinRequests(req.user!.id, idParams(req, 'id')) });
  }),
);

communitiesRouter.post(
  '/:id/join-requests/:requestId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ approve: z.boolean() }), req.body);
    res.json(await decideJoinRequest(req.user!.id, idParams(req, 'id'), idParams(req, 'requestId'), body.approve));
  }),
);

communitiesRouter.get(
  '/:id/invites',
  asyncRoute(async (req, res) => {
    res.json({ invites: await listInvites(req.user!.id, idParams(req, 'id')) });
  }),
);

communitiesRouter.post(
  '/:id/invites',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        expiresAt: z.string().datetime().nullable().optional(),
        maxUses: z.number().int().min(1).max(1000).nullable().optional(),
      }),
      req.body ?? {},
    );
    res.status(201).json(await createInvite(req.user!.id, idParams(req, 'id'), body));
  }),
);

communitiesRouter.delete(
  '/:id/invites/:inviteId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await revokeInvite(req.user!.id, idParams(req, 'id'), idParams(req, 'inviteId'));
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ members -------------------- */

communitiesRouter.get(
  '/:id/members',
  asyncRoute(async (req, res) => {
    res.json(
      await listMembers(req.user!.id, idParams(req, 'id'), {
        search: text(req.query.search).slice(0, 60) || undefined,
        role: text(req.query.role) || undefined,
        limit: Math.min(Math.max(int(req.query.limit, 50), 1), 200),
        offset: Math.max(int(req.query.offset, 0), 0),
      }),
    );
  }),
);

communitiesRouter.get(
  '/:id/contribution',
  asyncRoute(async (req, res) => {
    res.json(await myContribution(req.user!.id, idParams(req, 'id')));
  }),
);

communitiesRouter.post(
  '/:id/members/:userId/role',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ role: z.enum(['owner', 'admin', 'moderator', 'mentor', 'member']) }), req.body);
    await changeMemberRole(req.user!.id, idParams(req, 'id'), idParams(req, 'userId'), body.role);
    res.json({ ok: true });
  }),
);

communitiesRouter.delete(
  '/:id/members/:userId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await removeMember(req.user!.id, idParams(req, 'id'), idParams(req, 'userId'));
    res.json({ ok: true });
  }),
);

communitiesRouter.post(
  '/:id/members/:userId/kick',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ reason: z.string().max(300).optional() }), req.body ?? {});
    await kickMember(req.user!.id, idParams(req, 'id'), idParams(req, 'userId'), body.reason ?? '');
    res.json({ ok: true });
  }),
);

communitiesRouter.post(
  '/:id/members/:userId/ban',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({ banned: z.boolean(), reason: z.string().max(300).optional() }),
      req.body,
    );
    await setMemberBan(req.user!.id, idParams(req, 'id'), idParams(req, 'userId'), body.banned, body.reason ?? '');
    res.json({ ok: true });
  }),
);

communitiesRouter.post(
  '/:id/members/:userId/mute',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({ hours: z.number().int().min(1).max(720), reason: z.string().max(300).optional() }),
      req.body,
    );
    await muteMember(req.user!.id, idParams(req, 'id'), idParams(req, 'userId'), body.hours, body.reason ?? '');
    res.json({ ok: true });
  }),
);

communitiesRouter.delete(
  '/:id/members/:userId/mute',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await unmuteMember(req.user!.id, idParams(req, 'id'), idParams(req, 'userId'));
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ chat ----------------------- */

communitiesRouter.get(
  '/:id/messages',
  asyncRoute(async (req, res) => {
    const result = await listMessages(req.user!.id, idParams(req, 'id'), {
      before: text(req.query.before) || undefined,
      after: text(req.query.after) || undefined,
      threadId: text(req.query.threadId) || undefined,
      search: text(req.query.search).slice(0, 80) || undefined,
      limit: Math.min(Math.max(int(req.query.limit, 40), 1), 80),
    });
    res.json(result);
  }),
);

communitiesRouter.post(
  '/:id/messages',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        body: z.string().min(1).max(MAX_MESSAGE_LENGTH),
        parentId: z.string().max(60).nullable().optional(),
        attachment: z
          .object({
            kind: z.enum(['doubt', 'resource', 'note', 'competition']),
            id: z.string().min(1).max(60),
            title: z.string().max(200),
          })
          .nullable()
          .optional(),
        announced: z.boolean().optional(),
      }),
      req.body,
    );
    const message = await sendMessage(req.user!.id, idParams(req, 'id'), body);
    res.status(201).json(message);
  }),
);

communitiesRouter.patch(
  '/:id/messages/:messageId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ body: z.string().min(1).max(MAX_MESSAGE_LENGTH) }), req.body);
    res.json(await editMessage(req.user!.id, idParams(req, 'id'), idParams(req, 'messageId'), body.body));
  }),
);

communitiesRouter.delete(
  '/:id/messages/:messageId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await deleteMessage(req.user!.id, idParams(req, 'id'), idParams(req, 'messageId'));
    res.json({ ok: true });
  }),
);

communitiesRouter.post(
  '/:id/messages/:messageId/pin',
  limits.chat(),
  asyncRoute(async (req, res) => {
    res.json(await togglePin(req.user!.id, idParams(req, 'id'), idParams(req, 'messageId')));
  }),
);

communitiesRouter.post(
  '/:id/messages/:messageId/reactions',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({ emoji: z.string().min(1).max(8) }),
      req.body,
    );
    res.json(await toggleReaction(req.user!.id, idParams(req, 'id'), idParams(req, 'messageId'), body.emoji));
  }),
);

/**
 * Live chat + community events over SSE.
 *
 * The subscription is authorised before the stream opens: a non-member of a private community gets a
 * 404 from `loadForMember` and never receives a single byte of community activity.
 */
communitiesRouter.post(
  '/:id/stream',
  asyncRoute(async (req, res) => {
    const communityId = idParams(req, 'id');
    const context = await getCommunityDetail(req.user!.id, communityId);

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

    send('ready', { communityId, name: context.name });

    const unsubscribe = subscribe(communityChannel(communityId), (event) => send('community', event));
    const unsubscribeUser = subscribe(userChannel(req.user!.id), (event) => send('user', event));
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 20_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribeUser();
      res.end();
    });
  }),
);

/** Personal stream (notifications across every community) for the bell in the app shell. */
communitiesRouter.post(
  '/stream/user',
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

    send('ready', { unread: await unreadCount(req.user!.id) });
    const unsubscribe = subscribe(userChannel(req.user!.id), (event) => send('user', event));
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

/* ------------------------------------------------------------------ polls ---------------------- */

communitiesRouter.get(
  '/:id/polls',
  asyncRoute(async (req, res) => {
    res.json({ polls: await listPolls(req.user!.id, idParams(req, 'id'), int(req.query.limit, 10)) });
  }),
);

communitiesRouter.post(
  '/:id/polls',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        question: z.string().min(3).max(300),
        options: z.array(z.string().min(1).max(120)).min(2).max(10),
        multiple: z.boolean().optional(),
        anonymous: z.boolean().optional(),
        expiresAt: z.string().datetime().nullable().optional(),
      }),
      req.body,
    );
    res.status(201).json(await createPoll(req.user!.id, idParams(req, 'id'), body));
  }),
);

communitiesRouter.post(
  '/:id/polls/:pollId/vote',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ optionIds: z.array(z.string().max(60)).min(1).max(10) }), req.body);
    res.json(await vote(req.user!.id, idParams(req, 'id'), idParams(req, 'pollId'), body.optionIds));
  }),
);

communitiesRouter.delete(
  '/:id/polls/:pollId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await deletePoll(req.user!.id, idParams(req, 'id'), idParams(req, 'pollId'));
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ doubts + knowledge --------- */

communitiesRouter.get(
  '/:id/doubts',
  asyncRoute(async (req, res) => {
    res.json(
      await listDoubts(req.user!.id, idParams(req, 'id'), {
        status: text(req.query.status) || undefined,
        search: text(req.query.search).slice(0, 80) || undefined,
        limit: Math.min(Math.max(int(req.query.limit, 20), 1), 60),
        offset: Math.max(int(req.query.offset, 0), 0),
      }),
    );
  }),
);

communitiesRouter.post(
  '/:id/doubts',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        title: z.string().min(5).max(200),
        description: z.string().max(4000).optional(),
        imageUrl: z.string().max(400).nullable().optional(),
        subject: z.string().max(60).nullable().optional(),
        topic: z.string().max(80).nullable().optional(),
      }),
      req.body,
    );
    res.status(201).json(await createDoubt(req.user!.id, idParams(req, 'id'), body));
  }),
);

communitiesRouter.get(
  '/:id/doubts/:doubtId',
  asyncRoute(async (req, res) => {
    res.json(await getDoubt(req.user!.id, idParams(req, 'id'), idParams(req, 'doubtId')));
  }),
);

communitiesRouter.post(
  '/:id/doubts/:doubtId/answers',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ body: z.string().min(2).max(6000) }), req.body);
    res
      .status(201)
      .json(await answerDoubt(req.user!.id, idParams(req, 'id'), idParams(req, 'doubtId'), body.body));
  }),
);

communitiesRouter.post(
  '/:id/doubts/:doubtId/helpful',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ answerId: z.string().min(1).max(60) }), req.body);
    await markHelpful(req.user!.id, idParams(req, 'id'), idParams(req, 'doubtId'), body.answerId);
    res.json({ ok: true });
  }),
);

communitiesRouter.post(
  '/:id/doubts/:doubtId/knowledge',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ aiExplanation: z.string().max(8000).nullable().optional() }), req.body ?? {});
    res
      .status(201)
      .json(await promoteToKnowledge(req.user!.id, idParams(req, 'id'), idParams(req, 'doubtId'), body.aiExplanation ?? null));
  }),
);

communitiesRouter.delete(
  '/:id/answers/:answerId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await deleteAnswer(req.user!.id, idParams(req, 'id'), idParams(req, 'answerId'));
    res.json({ ok: true });
  }),
);

communitiesRouter.get(
  '/:id/knowledge',
  asyncRoute(async (req, res) => {
    res.json(
      await listKnowledge(req.user!.id, idParams(req, 'id'), {
        search: text(req.query.search).slice(0, 80) || undefined,
        limit: Math.min(Math.max(int(req.query.limit, 20), 1), 60),
        offset: Math.max(int(req.query.offset, 0), 0),
      }),
    );
  }),
);

/* ------------------------------------------------------------------ resources ------------------ */

communitiesRouter.get(
  '/:id/resources',
  asyncRoute(async (req, res) => {
    res.json(
      await listResources(req.user!.id, idParams(req, 'id'), {
        category: text(req.query.category) || undefined,
        search: text(req.query.search).slice(0, 80) || undefined,
        limit: Math.min(Math.max(int(req.query.limit, 20), 1), 60),
        offset: Math.max(int(req.query.offset, 0), 0),
      }),
    );
  }),
);

communitiesRouter.post(
  '/:id/resources/upload',
  limits.upload(),
  uploadErrors(resourceUpload.single('file')),
  asyncRoute(async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'Choose a file to share.', 'validation_error');
    const body = parseBody(
      z.object({
        title: z.string().min(3).max(200),
        description: z.string().max(2000).optional(),
        category: z.string().max(40).optional(),
        subject: z.string().max(60).nullable().optional(),
      }),
      req.body,
    );
    const uploaded = toUploadedFile(file);
    const record = await registerUpload(req.user!.id, uploaded);
    res.status(201).json(
      await attachUploadResource(req.user!.id, idParams(req, 'id'), {
        title: body.title,
        description: body.description,
        category: body.category,
        subject: body.subject,
        upload: uploaded,
        uploadId: record.id,
      }),
    );
  }),
);

communitiesRouter.post(
  '/:id/resources',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        title: z.string().min(3).max(200),
        description: z.string().max(2000).optional(),
        category: z.string().max(60).optional(),
        kind: z.enum(['link', 'file', 'note', 'formula_sheet', 'paper']).optional(),
        url: z.string().max(500).nullable().optional(),
        noteId: z.string().max(60).nullable().optional(),
        subject: z.string().max(60).nullable().optional(),
      }),
      req.body,
    );
    res.status(201).json(await createResource(req.user!.id, idParams(req, 'id'), body));
  }),
);

communitiesRouter.get(
  '/:id/resources/:resourceId/download',
  asyncRoute(async (req, res) => {
    const file = await resourceDownload(req.user!.id, idParams(req, 'id'), idParams(req, 'resourceId'));
    /*
     * Served as an attachment with `nosniff`: a shared HTML or SVG file must never execute in the
     * app's origin when another member opens it (§4).
     */
    res.setHeader('Content-Type', file.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Length', String(file.size));
    res.download(file.storedPath, file.fileName, (err) => {
      if (err && !res.headersSent) res.status(500).json({ error: { message: 'The download failed.', code: 'server_error' } });
    });
  }),
);

communitiesRouter.delete(
  '/:id/resources/:resourceId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await deleteResource(req.user!.id, idParams(req, 'id'), idParams(req, 'resourceId'));
    res.json({ ok: true });
  }),
);

communitiesRouter.post(
  '/:id/resources/:resourceId/pin',
  limits.chat(),
  asyncRoute(async (req, res) => {
    res.json(await toggleResourcePin(req.user!.id, idParams(req, 'id'), idParams(req, 'resourceId')));
  }),
);

/* ------------------------------------------------------------------ announcements --------------- */

communitiesRouter.get(
  '/:id/announcements',
  asyncRoute(async (req, res) => {
    res.json({ announcements: await listAnnouncements(req.user!.id, idParams(req, 'id'), int(req.query.limit, 30)) });
  }),
);

communitiesRouter.post(
  '/:id/announcements',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        title: z.string().min(3).max(200),
        body: z.string().min(3).max(4000),
        isPinned: z.boolean().optional(),
        expiresAt: z.string().datetime().nullable().optional(),
      }),
      req.body,
    );
    res.status(201).json(await createAnnouncement(req.user!.id, idParams(req, 'id'), body));
  }),
);

communitiesRouter.delete(
  '/:id/announcements/:announcementId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await deleteAnnouncement(req.user!.id, idParams(req, 'id'), idParams(req, 'announcementId'));
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ challenges ------------------ */

communitiesRouter.get(
  '/:id/challenges',
  asyncRoute(async (req, res) => {
    res.json({ challenges: await listChallenges(req.user!.id, idParams(req, 'id')) });
  }),
);

communitiesRouter.post(
  '/:id/challenges',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        title: z.string().min(3).max(160),
        description: z.string().max(2000).optional(),
        subject: z.string().max(60).nullable().optional(),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
        days: z
          .array(z.object({ title: z.string().min(1).max(160), description: z.string().max(600).optional() }))
          .min(1)
          .max(90),
      }),
      req.body,
    );
    res.status(201).json(await createChallenge(req.user!.id, idParams(req, 'id'), body));
  }),
);

communitiesRouter.post(
  '/:id/challenges/:challengeId/days/:dayIndex',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ done: z.boolean(), note: z.string().max(400).optional() }), req.body);
    res.json(
      await setChallengeDay(
        req.user!.id,
        idParams(req, 'id'),
        idParams(req, 'challengeId'),
        int(idParams(req, 'dayIndex'), 0),
        body.done,
        body.note ?? '',
      ),
    );
  }),
);

communitiesRouter.delete(
  '/:id/challenges/:challengeId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await deleteChallenge(req.user!.id, idParams(req, 'id'), idParams(req, 'challengeId'));
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ study plans ----------------- */

communitiesRouter.get(
  '/:id/plans',
  asyncRoute(async (req, res) => {
    res.json({ plans: await listStudyPlans(req.user!.id, idParams(req, 'id')) });
  }),
);

communitiesRouter.post(
  '/:id/plans',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        title: z.string().min(3).max(160),
        description: z.string().max(2000).optional(),
        subject: z.string().max(60).nullable().optional(),
        tasks: z
          .array(
            z.object({
              dayIndex: z.number().int().min(0).max(365),
              title: z.string().min(1).max(160),
              description: z.string().max(600).optional(),
            }),
          )
          .min(1)
          .max(200),
      }),
      req.body,
    );
    res.status(201).json(await createStudyPlan(req.user!.id, idParams(req, 'id'), body));
  }),
);

communitiesRouter.post(
  '/:id/plans/:planId/tasks/:taskId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ done: z.boolean() }), req.body);
    res.json(
      await setStudyPlanTask(req.user!.id, idParams(req, 'id'), idParams(req, 'planId'), idParams(req, 'taskId'), body.done),
    );
  }),
);

communitiesRouter.delete(
  '/:id/plans/:planId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await deleteStudyPlan(req.user!.id, idParams(req, 'id'), idParams(req, 'planId'));
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ events --------------------- */

communitiesRouter.get(
  '/:id/events',
  asyncRoute(async (req, res) => {
    res.json({
      events: await listEvents(req.user!.id, idParams(req, 'id'), {
        includePast: flag(req.query.includePast),
        limit: Math.min(Math.max(int(req.query.limit, 20), 1), 60),
      }),
    });
  }),
);

communitiesRouter.post(
  '/:id/events',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        title: z.string().min(3).max(160),
        description: z.string().max(2000).optional(),
        kind: z.enum(['study_session', 'doubt_session', 'competition', 'revision', 'orientation']).optional(),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
        meetingUrl: z.string().max(400).nullable().optional(),
        participantLimit: z.number().int().min(1).max(10000).nullable().optional(),
      }),
      req.body,
    );
    res.status(201).json(await createEvent(req.user!.id, idParams(req, 'id'), body));
  }),
);

communitiesRouter.post(
  '/:id/events/:eventId/rsvp',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ going: z.boolean() }), req.body);
    res.json(await setEventRsvp(req.user!.id, idParams(req, 'id'), idParams(req, 'eventId'), body.going));
  }),
);

communitiesRouter.delete(
  '/:id/events/:eventId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await deleteEvent(req.user!.id, idParams(req, 'id'), idParams(req, 'eventId'));
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ study rooms ----------------- */

communitiesRouter.get(
  '/:id/rooms',
  asyncRoute(async (req, res) => {
    res.json({ rooms: await listStudyRooms(req.user!.id, idParams(req, 'id')) });
  }),
);

communitiesRouter.post(
  '/:id/rooms',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        title: z.string().min(3).max(160),
        topic: z.string().max(200).optional(),
        goal: z.string().max(400).optional(),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
        checklist: z.array(z.string().max(160)).max(20).optional(),
      }),
      req.body,
    );
    res.status(201).json(await createStudyRoom(req.user!.id, idParams(req, 'id'), body));
  }),
);

communitiesRouter.post(
  '/:id/rooms/:roomId/join',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ joined: z.boolean() }), req.body);
    res.json(await joinStudyRoom(req.user!.id, idParams(req, 'id'), idParams(req, 'roomId'), body.joined));
  }),
);

communitiesRouter.patch(
  '/:id/rooms/:roomId/checklist',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({ itemId: z.string().min(1).max(60), done: z.boolean() }),
      req.body,
    );
    res.json(
      await setStudyRoomChecklist(req.user!.id, idParams(req, 'id'), idParams(req, 'roomId'), body.itemId, body.done),
    );
  }),
);

/* ------------------------------------------------------------------ leaderboard ----------------- */

communitiesRouter.get(
  '/:id/leaderboard',
  asyncRoute(async (req, res) => {
    const metric = req.query.metric === 'helpful' ? 'helpful' : 'contribution';
    res.json(await leaderboard(req.user!.id, idParams(req, 'id'), { metric, limit: int(req.query.limit, 25) }));
  }),
);

/* ------------------------------------------------------------------ teams ---------------------- */

communitiesRouter.get(
  '/:id/teams',
  asyncRoute(async (req, res) => {
    res.json({ teams: await listTeams(req.user!.id, idParams(req, 'id')) });
  }),
);

communitiesRouter.post(
  '/:id/teams',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().min(3).max(60),
        description: z.string().max(400).optional(),
        goal: z.string().max(200).optional(),
        memberLimit: z.number().int().min(2).max(20).optional(),
      }),
      req.body,
    );
    res.status(201).json(await createTeam(req.user!.id, idParams(req, 'id'), body));
  }),
);

communitiesRouter.delete(
  '/:id/teams/:teamId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await deleteTeam(req.user!.id, idParams(req, 'id'), idParams(req, 'teamId'));
    res.json({ ok: true });
  }),
);

communitiesRouter.post(
  '/:id/teams/:teamId/join',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await joinTeam(req.user!.id, idParams(req, 'teamId'));
    res.json({ ok: true });
  }),
);

communitiesRouter.post(
  '/:id/teams/:teamId/leave',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await leaveTeam(req.user!.id, idParams(req, 'teamId'));
    res.json({ ok: true });
  }),
);

communitiesRouter.post(
  '/:id/teams/:teamId/invite',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ userIds: z.array(z.string().max(60)).min(1).max(25) }), req.body);
    res.json(await inviteToTeam(req.user!.id, idParams(req, 'teamId'), body.userIds));
  }),
);

communitiesRouter.delete(
  '/:id/teams/:teamId/members/:userId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await removeTeamMember(req.user!.id, idParams(req, 'teamId'), idParams(req, 'userId'));
    res.json({ ok: true });
  }),
);

communitiesRouter.get(
  '/:id/teams/standings',
  asyncRoute(async (req, res) => {
    const competitionId = text(req.query.competitionId);
    if (!competitionId) throw new HttpError(400, 'Pick a competition to compare.', 'validation_error');
    res.json(await teamStandings(req.user!.id, idParams(req, 'id'), competitionId));
  }),
);

/* ------------------------------------------------------------------ competitions ----------------- */

communitiesRouter.get(
  '/:id/competitions',
  asyncRoute(async (req, res) => {
    res.json({ competitions: await listCommunityCompetitions(req.user!.id, idParams(req, 'id')) });
  }),
);

communitiesRouter.post(
  '/:id/competitions',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        title: z.string().min(4).max(140),
        description: z.string().max(1200).optional(),
        category: z.string().min(2).max(60),
        difficulty: z.enum(['easy', 'medium', 'hard', 'mixed']).optional(),
        visibility: z.enum(['public', 'private', 'invite_only']).optional(),
        blueprint: z.record(z.unknown()),
        registrationOpensAt: z.string().datetime(),
        registrationClosesAt: z.string().datetime(),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
        rules: z.array(z.string().max(300)).max(20).optional(),
        instructions: z.array(z.string().max(300)).max(20).optional(),
        integrity: z
          .object({
            shuffleQuestions: z.boolean().optional(),
            shuffleOptions: z.boolean().optional(),
            logSuspiciousActivity: z.boolean().optional(),
          })
          .optional(),
      }),
      req.body,
    );
    res.status(201).json(await createCommunityCompetition(req.user!.id, idParams(req, 'id'), body));
  }),
);

/*
 * Filling the paper. Two options, both server-side, both leak-proof.
 *
 *   POST { mode: 'ai' }                        → the generator writes it (AI, bank fallback)
 *   POST { mode: 'upload', text: '<paper>' }   → the uploaded questions are rewritten before they run
 *
 * The response is counts only. A host cannot read the paper they just uploaded — that is the point of
 * "leak 0": there is no route anywhere that returns a community paper's questions to a browser before
 * the competition closes.
 */
communitiesRouter.post(
  '/:id/competitions/:competitionId/paper',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        mode: z.enum(['ai', 'upload']),
        text: z.string().max(120_000).optional(),
        subject: z.string().max(60).optional(),
        blueprint: z.record(z.unknown()).optional(),
      }),
      req.body,
    );
    res.status(201).json(
      await prepareCommunityPaper({
        userId: req.user!.id,
        communityId: idParams(req, 'id'),
        competitionId: idParams(req, 'competitionId'),
        mode: body.mode,
        text: body.text,
        subject: body.subject,
        blueprint: (body.blueprint ?? undefined) as never,
      }),
    );
  }),
);

communitiesRouter.get(
  '/:id/competitions/:competitionId/paper',
  asyncRoute(async (req, res) => {
    res.json(await communityPaperStatus(req.user!.id, idParams(req, 'id'), idParams(req, 'competitionId')));
  }),
);

communitiesRouter.post(
  '/:id/competitions/:competitionId/register',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(z.object({ inviteCode: z.string().max(40).optional() }), req.body ?? {});
    res.json(
      await registerForCommunityCompetition(
        req.user!.id,
        idParams(req, 'id'),
        idParams(req, 'competitionId'),
        body.inviteCode,
      ),
    );
  }),
);

communitiesRouter.post(
  '/:id/competitions/:competitionId/withdraw',
  limits.chat(),
  asyncRoute(async (req, res) => {
    res.json({
      withdrawn: await withdrawFromCommunityCompetition(
        req.user!.id,
        idParams(req, 'id'),
        idParams(req, 'competitionId'),
      ),
    });
  }),
);

communitiesRouter.delete(
  '/:id/competitions/:competitionId',
  limits.chat(),
  asyncRoute(async (req, res) => {
    await removeCommunityCompetition(req.user!.id, idParams(req, 'id'), idParams(req, 'competitionId'));
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ moderation ------------------ */

communitiesRouter.post(
  '/:id/reports',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        targetType: z.enum(['message', 'doubt', 'answer', 'resource', 'member', 'competition', 'event']),
        targetId: z.string().min(1).max(60),
        reason: z.string().min(2).max(40),
        details: z.string().max(600).optional(),
      }),
      req.body,
    );
    const result = await reportContent(req.user!.id, idParams(req, 'id'), body);
    res.status(201).json(result);
  }),
);

communitiesRouter.get(
  '/:id/reports',
  asyncRoute(async (req, res) => {
    const status = ['open', 'resolved', 'dismissed', 'all'].includes(text(req.query.status))
      ? (text(req.query.status) as 'open' | 'resolved' | 'dismissed' | 'all')
      : 'open';
    res.json({ reports: await listReports(req.user!.id, idParams(req, 'id'), status) });
  }),
);

communitiesRouter.post(
  '/:id/reports/:reportId/resolve',
  limits.chat(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        action: z.enum(['dismiss', 'remove_content', 'warn', 'mute', 'remove_member']),
        note: z.string().max(400).optional(),
        muteHours: z.number().int().min(1).max(720).optional(),
      }),
      req.body,
    );
    res.json(await resolveReport(req.user!.id, idParams(req, 'id'), idParams(req, 'reportId'), body));
  }),
);

/**
 * The effective permission matrix for this community.
 *
 * Generated from the same table the route guards use, so the Roles screen cannot document a permission
 * the server does not actually enforce. Manager-only: it exposes nothing secret, but a student has no
 * reason to enumerate another community's role table.
 */
communitiesRouter.get(
  '/:id/permissions',
  asyncRoute(async (req, res) => {
    const community = await getCommunityDetail(req.user!.id, idParams(req, 'id'));
    if (!community.capabilities.manage_roles) {
      throw new HttpError(403, 'Only owners and admins can view the role table.', 'forbidden');
    }
    res.json({
      groups: PERMISSION_GROUPS,
      roles: COMMUNITY_ROLES,
      matrix: permissionMatrix(),
      mine: { role: community.myRole, capabilities: community.capabilities },
    });
  }),
);

communitiesRouter.get(
  '/:id/moderation',
  asyncRoute(async (req, res) => {
    res.json({
      actions: await auditTrail(req.user!.id, idParams(req, 'id'), int(req.query.limit, 100)),
      log: await moderationLog(req.user!.id, idParams(req, 'id'), int(req.query.limit, 60)),
    });
  }),
);

/* ------------------------------------------------------------------ analytics ------------------- */

communitiesRouter.get(
  '/:id/analytics',
  asyncRoute(async (req, res) => {
    const [summary, trend, digest, growthSeries] = await Promise.all([
      communityAnalytics(req.user!.id, idParams(req, 'id')),
      activityTrend(req.user!.id, idParams(req, 'id')),
      weeklyDigest(req.user!.id, idParams(req, 'id')),
      growth(req.user!.id, idParams(req, 'id')),
    ]);
    res.json({ summary, trend, digest, growth: growthSeries });
  }),
);
