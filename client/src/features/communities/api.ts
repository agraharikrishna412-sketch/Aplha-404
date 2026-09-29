/**
 * Vroqn Communities — typed client surface.
 *
 * One module owns every `/api/communities` call so the components never build URLs by hand. Types
 * mirror the server's view objects; where the server deliberately omits something (another student's
 * email, a private community's existence, an answer key) the type simply has no field for it.
 */
import { api } from '../../lib/api';

export type CommunityVisibility = 'public' | 'private' | 'invite_only';
export type CommunityRole = 'owner' | 'admin' | 'moderator' | 'mentor' | 'member';

export interface CommunitySummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  category: string;
  categoryLabel: string;
  tags: string[];
  visibility: CommunityVisibility;
  memberCount: number;
  memberLimit: number | null;
  isVerified: boolean;
  accent: string;
  myRole: CommunityRole | null;
  myStatus: string | null;
  joinRequestStatus: 'pending' | 'approved' | 'rejected' | null;
  createdAt: string;
}

export interface CommunityDetail extends CommunitySummary {
  rules: string;
  joinRequirements: string;
  welcomeMessage: string;
  ownerId: string;
  ownerName: string;
  isLeaderboardEnabled: boolean;
  capabilities: Record<string, boolean>;
  tabs: string[];
  unreadCount: number;
}

export interface ChatAttachment {
  kind: 'doubt' | 'resource' | 'competition' | 'note';
  id: string;
  title: string;
}

export interface PollView {
  id: string;
  question: string;
  isMultiple: boolean;
  isAnonymous: boolean;
  expiresAt: string | null;
  isClosed: boolean;
  totalVotes: number;
  options: { id: string; label: string; votes: number; percent: number; mine: boolean }[];
  myVotes: string[];
  createdBy: string;
  canDelete: boolean;
}

export interface ChatMessageView {
  id: string;
  communityId: string;
  userId: string;
  authorName: string;
  authorRole: CommunityRole;
  body: string;
  editedAt: string | null;
  isDeleted: boolean;
  deletedByModerator: boolean;
  isPinned: boolean;
  isAnnouncement: boolean;
  parentId: string | null;
  parentPreview: string | null;
  reactions: { emoji: string; count: number; mine: boolean }[];
  attachment: ChatAttachment | null;
  poll: PollView | null;
  createdAt: string;
  isMine: boolean;
  canDelete: boolean;
}

export interface DoubtView {
  id: string;
  communityId: string;
  userId: string;
  authorName: string;
  authorRole: CommunityRole;
  title: string;
  description: string;
  imageUrl: string | null;
  subject: string | null;
  topic: string | null;
  status: 'open' | 'solved' | 'removed';
  isPinned: boolean;
  answerCount: number;
  helpfulAnswerId: string | null;
  createdAt: string;
  isMine: boolean;
  canModerate: boolean;
}

export interface DoubtAnswerView {
  id: string;
  userId: string;
  authorName: string;
  authorRole: CommunityRole;
  body: string;
  isHelpful: boolean;
  isDeleted: boolean;
  createdAt: string;
  editedAt: string | null;
  isMine: boolean;
  canMarkHelpful: boolean;
  canDelete: boolean;
}

export interface KnowledgeEntry {
  id: string;
  communityId: string;
  doubtId: string | null;
  title: string;
  question: string;
  answer: string;
  aiExplanation: string | null;
  subject: string | null;
  topic: string | null;
  authorName: string;
  createdAt: string;
}

export interface ResourceView {
  id: string;
  communityId: string;
  title: string;
  description: string;
  category: string;
  kind: 'link' | 'file' | 'note' | 'formula_sheet' | 'paper';
  url: string | null;
  noteId: string | null;
  subject: string | null;
  authorName: string;
  isPinned: boolean;
  downloadCount: number;
  createdAt: string;
  isMine: boolean;
  canDelete: boolean;
  uploadId: string | null;
  fileName: string | null;
  fileSize: number | null;
  fileMime: string | null;
}

export interface ChallengeDay {
  index: number;
  title: string;
  description: string;
}

export interface ChallengeView {
  id: string;
  communityId: string;
  title: string;
  description: string;
  subject: string | null;
  days: ChallengeDay[];
  status: 'draft' | 'active' | 'ended';
  startsAt: string;
  endsAt: string;
  createdBy: string;
  createdAt: string;
  participantCount: number;
  completedDays: number[];
  progressPercent: number;
  isJoined: boolean;
  isMine: boolean;
  canDelete: boolean;
}

export interface StudyPlanTaskView {
  id: string;
  dayIndex: number;
  title: string;
  description: string;
  position: number;
  /** Ticked by *this* student. Progress is per student, not shared. */
  done: boolean;
}

export interface StudyPlanView {
  id: string;
  communityId: string;
  title: string;
  description: string;
  subject: string | null;
  createdBy: string;
  authorName: string;
  tasks: StudyPlanTaskView[];
  doneCount: number;
  totalCount: number;
  percent: number;
  isMine: boolean;
  canDelete: boolean;
  createdAt: string;
}

export interface EventView {
  id: string;
  communityId: string;
  title: string;
  description: string;
  kind: string;
  startsAt: string;
  endsAt: string;
  hostName: string;
  meetingUrl: string | null;
  participantLimit: number | null;
  participantCount: number;
  isGoing: boolean;
  hasEnded: boolean;
  isFull: boolean;
  canCancel: boolean;
}

export interface StudyRoomView {
  id: string;
  communityId: string;
  title: string;
  topic: string;
  goal: string;
  startsAt: string;
  endsAt: string;
  hostName: string;
  participantCount: number;
  isJoined: boolean;
  checklist: { id: string; label: string; done: boolean }[];
  hasEnded: boolean;
}

export interface AnnouncementView {
  id: string;
  communityId: string;
  title: string;
  body: string;
  isPinned: boolean;
  expiresAt: string | null;
  authorName: string;
  createdAt: string;
  isExpired: boolean;
}

export interface CommunityPaperOutcome {
  mode: 'ai' | 'upload';
  accepted: number;
  rejected: number;
  skipped: number;
  method: 'ai' | 'bank' | 'deterministic';
  ready: boolean;
  required: number;
  note: string;
}

export interface CommunityPaperStatus {
  total: number;
  approved: number;
  pending: number;
  flagged: number;
  ready: boolean;
  required: number;
}

export interface CommunityCompetitionView {
  id: string;
  title: string;
  description: string;
  state: 'UPCOMING' | 'LIVE' | 'ENDED' | 'RESULTS_PUBLISHED';
  visibility: string;
  category: string;
  difficulty: string;
  durationMin: number;
  questionCount: number;
  startsAt: string;
  endsAt: string;
  participantCount: number;
  isRegistered: boolean;
  resultId: string | null;
  attemptState: string | null;
  isDemo: boolean;
}

export interface LeaderboardEntry {
  userId: string;
  name: string;
  role: CommunityRole;
  contributionPoints: number;
  helpfulAnswers: number;
  challengesCompleted: number;
  competitionsParticipated: number;
  resourcesContributed: number;
  rank: number;
  isSelf: boolean;
}

export interface BadgeView {
  key: string;
  label: string;
  emoji: string;
  description: string;
  criteria: string;
  earnedAt: string | null;
  communityId: string | null;
}

export interface CommunityMemberView {
  userId: string;
  name: string;
  role: CommunityRole;
  status: string;
  contributionPoints: number;
  helpfulAnswers: number;
  joinedAt: string;
  isSelf: boolean;
  canChangeRole: boolean;
  canRemove: boolean;
  mutedUntil: string | null;
}

export interface NotificationView {
  id: string;
  communityId: string | null;
  communityName: string | null;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

export interface ReportView {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  details: string;
  status: 'open' | 'reviewing' | 'resolved' | 'dismissed';
  createdAt: string;
  reporterName: string;
  resolvedAt: string | null;
  resolution: string | null;
  preview: string | null;
}

export interface TeamView {
  id: string;
  name: string;
  description: string;
  goal: string;
  memberLimit: number;
  memberCount: number;
  isMember: boolean;
  isLead: boolean;
  canManage: boolean;
  leadName: string;
}

export interface CommunityAnalytics {
  summary: {
    totalMembers: number;
    newMembers7d: number;
    activeMembers: number;
    competitionParticipation: number;
    challengeCompletionPercent: number | null;
    resourceCount: number;
    doubtCount: number;
    helpfulAnswerCount: number;
    eventParticipation: number;
    messages7d: number;
  };
  trend: Array<{ day: string; messages: number; doubts: number; answers: number; resources: number; challengeDays: number }>;
  digest: {
    topContributors: { name: string; contributionPoints: number; helpfulAnswers: number }[];
    newMembers: { name: string; joined_at: string; role: string }[];
    upcoming: { kind: string; title: string; at: string }[];
  };
  growth: {
    series: Array<{ day: string; joined: number }>;
    joins30d: number;
    leaves30d: number;
    total: number;
    active: number;
    muted: number;
    banned: number;
    memberLimit: number | null;
    isLeaderboardEnabled: boolean;
  };
}

export interface SearchHit {
  type: string;
  id: string;
  title: string;
  snippet: string;
  communityId: string | null;
  communityName: string | null;
  url: string;
  meta: Record<string, string | number | null>;
}

export interface ProfileView {
  userId: string;
  name: string;
  bio: string;
  interests: string[];
  classLevel: string | null;
  isProfilePublic: boolean;
  isActivityVisible: boolean;
  isCommunitiesVisible: boolean;
  isSelf: boolean;
  joinedCommunities: { id: string; name: string; slug: string; role: CommunityRole }[];
  createdCommunities: { id: string; name: string; slug: string; memberCount: number }[];
  competitions: { participated: number; completed: number };
  badges: BadgeView[];
  streakDays: number;
}

export interface CommunityCatalog {
  categories: { value: string; label: string }[];
  visibilities: CommunityVisibility[];
  resourceKinds: string[];
  eventKinds: string[];
  reactions: string[];
  maxMessageLength: number;
}

/** One place for the "this is what the community is for" copy used under the hero (§49). */
export const COMMUNITIES_TAGLINE = 'Learn Together. Compete Together. Improve Together.';
export const COMMUNITIES_SUBLINE =
  'Join communities, discuss concepts, compete in challenges and turn your preparation into measurable progress.';

const base = '/communities';

export const communitiesApi = {
  catalog: () => api.get<CommunityCatalog>(`${base}/catalog`),

  discover: (params: Record<string, string | number | boolean | undefined> = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '' && value !== false) query.set(key, String(value));
    }
    const suffix = query.toString();
    return api.get<{ communities: CommunitySummary[]; total: number }>(`${base}/discover${suffix ? `?${suffix}` : ''}`);
  },

  searchCommunities: (term: string) =>
    api.get<{ results: { id: string; name: string; slug: string; description: string; category: string; member_count: number }[] }>(
      `${base}/search?q=${encodeURIComponent(term)}`,
    ),

  smartSearch: (term: string, communityId?: string) =>
    api.get<{ query: string; hits: SearchHit[]; scope: string[] }>(
      `${base}/smart-search?q=${encodeURIComponent(term)}${communityId ? `&communityId=${encodeURIComponent(communityId)}` : ''}`,
    ),

  mine: () => api.get<{ communities: CommunitySummary[] }>(`${base}/mine`),

  dashboard: () =>
    api.get<{
      communities: CommunitySummary[];
      totalCommunities: number;
      upcoming: { id: string; title: string; community_id: string; community_name: string; starts_at: string }[];
      unreadNotifications: number;
      moderationQueue: number;
    }>(`${base}/dashboard`),

  detail: (idOrSlug: string) => api.get<CommunityDetail>(`${base}/${encodeURIComponent(idOrSlug)}`),

  /**
   * The effective permission matrix, generated on the server from the table the route guards read.
   * Manager-only — the Roles screen only asks for it when the caller can manage roles.
   */
  permissions: (id: string) =>
    api.get<{
      groups: { id: string; label: string; capabilities: { capability: string; label: string; description: string }[] }[];
      roles: CommunityRole[];
      matrix: Record<string, Record<string, boolean>>;
      mine: { role: CommunityRole; capabilities: Record<string, boolean> };
    }>(`${base}/${id}/permissions`),

  create: (payload: Record<string, unknown>) => api.post<CommunityDetail>(base, payload),

  update: (id: string, payload: Record<string, unknown>) => api.patch<CommunityDetail>(`${base}/${id}`, payload),

  remove: (id: string) => api.del<{ ok: boolean }>(`${base}/${id}`),

  transfer: (id: string, userId: string) =>
    api.post<{ ok: boolean }>(`${base}/${id}/transfer`, { userId, confirm: true }),

  join: (id: string, payload: { inviteCode?: string; reason?: string } = {}) =>
    api.post<{ status: 'joined' | 'requested' | 'already_member' | 'invite_required'; detail: CommunityDetail | null }>(
      `${base}/${id}/join`,
      payload,
    ),

  leave: (id: string) => api.post<{ ok: boolean }>(`${base}/${id}/leave`),

  markRead: (id: string) => api.post<{ ok: boolean }>(`${base}/${id}/read`),

  home: (id: string) =>
    api.get<{
      announcements: AnnouncementView[];
      competitions: CommunityCompetitionView[];
      events: EventView[];
      resources: ResourceView[];
      challenges: ChallengeView[];
      pinnedDiscussions: { id: string; title: string; kind: 'doubt' | 'message' }[];
      achievements: { badgeKey: string; label: string; emoji: string; earnedAt: string }[];
    }>(`${base}/${id}/home`),

  mentions: (id: string, term: string) =>
    api.get<{ members: { id: string; name: string; role: CommunityRole }[] }>(
      `${base}/${id}/mentions?q=${encodeURIComponent(term)}`,
    ),

  messages: (
    id: string,
    params: { before?: string; after?: string; threadId?: string; search?: string; limit?: number } = {},
  ) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '' && value !== null) query.set(key, String(value));
    }
    const suffix = query.toString();
    return api.get<{ messages: ChatMessageView[]; hasMore: boolean; nextCursor: string | null; poll?: PollView[] }>(
      `${base}/${id}/messages${suffix ? `?${suffix}` : ''}`,
    );
  },

  sendMessage: (
    id: string,
    payload: { body: string; parentId?: string | null; attachment?: ChatAttachment | null; announced?: boolean },
  ) => api.post<ChatMessageView>(`${base}/${id}/messages`, payload),

  editMessage: (id: string, messageId: string, body: string) =>
    api.patch<ChatMessageView>(`${base}/${id}/messages/${messageId}`, { body }),

  deleteMessage: (id: string, messageId: string) => api.del<{ ok: boolean }>(`${base}/${id}/messages/${messageId}`),

  pinMessage: (id: string, messageId: string) =>
    api.post<{ isPinned: boolean }>(`${base}/${id}/messages/${messageId}/pin`),

  react: (id: string, messageId: string, emoji: string) =>
    api.post<{ reactions: { emoji: string; count: number; mine: boolean }[] }>(
      `${base}/${id}/messages/${messageId}/reactions`,
      { emoji },
    ),

  polls: (id: string) => api.get<{ polls: PollView[] }>(`${base}/${id}/polls`),

  createPoll: (
    id: string,
    payload: { question: string; options: string[]; multiple?: boolean; anonymous?: boolean; expiresAt?: string | null },
  ) => api.post<PollView>(`${base}/${id}/polls`, payload),

  vote: (id: string, pollId: string, optionIds: string[]) =>
    api.post<PollView>(`${base}/${id}/polls/${pollId}/vote`, { optionIds }),

  deletePoll: (id: string, pollId: string) => api.del<{ ok: boolean }>(`${base}/${id}/polls/${pollId}`),

  doubts: (id: string, params: { status?: string; search?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '' && value !== null) query.set(key, String(value));
    }
    const suffix = query.toString();
    return api.get<{ doubts: DoubtView[]; total: number }>(`${base}/${id}/doubts${suffix ? `?${suffix}` : ''}`);
  },

  createDoubt: (
    id: string,
    payload: { title: string; description?: string; subject?: string | null; topic?: string | null; imageUrl?: string | null },
  ) => api.post<DoubtView>(`${base}/${id}/doubts`, payload),

  doubt: (id: string, doubtId: string) =>
    api.get<{ doubt: DoubtView; answers: DoubtAnswerView[] }>(`${base}/${id}/doubts/${doubtId}`),

  answerDoubt: (id: string, doubtId: string, body: string) =>
    api.post<DoubtAnswerView>(`${base}/${id}/doubts/${doubtId}/answers`, { body }),

  markHelpful: (id: string, doubtId: string, answerId: string) =>
    api.post<{ ok: boolean }>(`${base}/${id}/doubts/${doubtId}/helpful`, { answerId }),

  deleteAnswer: (id: string, answerId: string) => api.del<{ ok: boolean }>(`${base}/${id}/answers/${answerId}`),

  promoteToKnowledge: (id: string, doubtId: string, aiExplanation?: string | null) =>
    api.post<KnowledgeEntry>(`${base}/${id}/doubts/${doubtId}/knowledge`, { aiExplanation: aiExplanation ?? null }),

  knowledge: (id: string, params: { search?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '' && value !== null) query.set(key, String(value));
    }
    const suffix = query.toString();
    return api.get<{ items: KnowledgeEntry[]; total: number }>(`${base}/${id}/knowledge${suffix ? `?${suffix}` : ''}`);
  },

  resources: (id: string, params: { category?: string; search?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '' && value !== null) query.set(key, String(value));
    }
    const suffix = query.toString();
    return api.get<{ resources: ResourceView[]; total: number }>(`${base}/${id}/resources${suffix ? `?${suffix}` : ''}`);
  },

  createResource: (
    id: string,
    payload: {
      title: string;
      description?: string;
      category?: string;
      kind?: string;
      url?: string | null;
      noteId?: string | null;
      subject?: string | null;
    },
  ) => api.post<ResourceView>(`${base}/${id}/resources`, payload),

  /** Uploads a file and shares it. The bytes go through the same allowlist as note uploads (§4). */
  uploadResource: (id: string, payload: { title: string; description?: string; category?: string; subject?: string | null; file: File }) => {
    const form = new FormData();
    form.append('file', payload.file);
    form.append('title', payload.title);
    if (payload.description) form.append('description', payload.description);
    if (payload.category) form.append('category', payload.category);
    if (payload.subject) form.append('subject', payload.subject);
    return api.postForm<ResourceView>(`${base}/${id}/resources/upload`, form);
  },

  deleteResource: (id: string, resourceId: string) => api.del<{ ok: boolean }>(`${base}/${id}/resources/${resourceId}`),

  pinResource: (id: string, resourceId: string) =>
    api.post<{ isPinned: boolean }>(`${base}/${id}/resources/${resourceId}/pin`),

  announcements: (id: string) => api.get<{ announcements: AnnouncementView[] }>(`${base}/${id}/announcements`),

  createAnnouncement: (
    id: string,
    payload: { title: string; body: string; isPinned?: boolean; expiresAt?: string | null },
  ) => api.post<AnnouncementView>(`${base}/${id}/announcements`, payload),

  deleteAnnouncement: (id: string, announcementId: string) =>
    api.del<{ ok: boolean }>(`${base}/${id}/announcements/${announcementId}`),

  challenges: (id: string) => api.get<{ challenges: ChallengeView[] }>(`${base}/${id}/challenges`),

  createChallenge: (
    id: string,
    payload: {
      title: string;
      description?: string;
      subject?: string | null;
      startsAt: string;
      endsAt: string;
      days: { title: string; description?: string }[];
    },
  ) => api.post<ChallengeView>(`${base}/${id}/challenges`, payload),

  setChallengeDay: (id: string, challengeId: string, dayIndex: number, done: boolean, note = '') =>
    api.post<ChallengeView>(`${base}/${id}/challenges/${challengeId}/days/${dayIndex}`, { done, note }),

  deleteChallenge: (id: string, challengeId: string) =>
    api.del<{ ok: boolean }>(`${base}/${id}/challenges/${challengeId}`),

  plans: (id: string) => api.get<{ plans: StudyPlanView[] }>(`${base}/${id}/plans`),

  createPlan: (
    id: string,
    payload: {
      title: string;
      description?: string;
      subject?: string | null;
      tasks: { dayIndex: number; title: string; description?: string }[];
    },
  ) => api.post<StudyPlanView>(`${base}/${id}/plans`, payload),

  setPlanTask: (id: string, planId: string, taskId: string, done: boolean) =>
    api.post<StudyPlanView>(`${base}/${id}/plans/${planId}/tasks/${taskId}`, { done }),

  deletePlan: (id: string, planId: string) => api.del<{ ok: boolean }>(`${base}/${id}/plans/${planId}`),

  events: (id: string, includePast = false) =>
    api.get<{ events: EventView[] }>(`${base}/${id}/events${includePast ? '?includePast=true' : ''}`),

  createEvent: (
    id: string,
    payload: {
      title: string;
      description?: string;
      kind?: string;
      startsAt: string;
      endsAt: string;
      meetingUrl?: string | null;
      participantLimit?: number | null;
    },
  ) => api.post<EventView>(`${base}/${id}/events`, payload),

  rsvp: (id: string, eventId: string, going: boolean) =>
    api.post<EventView>(`${base}/${id}/events/${eventId}/rsvp`, { going }),

  deleteEvent: (id: string, eventId: string) => api.del<{ ok: boolean }>(`${base}/${id}/events/${eventId}`),

  rooms: (id: string) => api.get<{ rooms: StudyRoomView[] }>(`${base}/${id}/rooms`),

  createRoom: (
    id: string,
    payload: {
      title: string;
      topic?: string;
      goal?: string;
      startsAt: string;
      endsAt: string;
      checklist?: string[];
    },
  ) => api.post<StudyRoomView>(`${base}/${id}/rooms`, payload),

  joinRoom: (id: string, roomId: string, joined: boolean) =>
    api.post<StudyRoomView>(`${base}/${id}/rooms/${roomId}/join`, { joined }),

  setRoomChecklist: (id: string, roomId: string, itemId: string, done: boolean) =>
    api.patch<StudyRoomView>(`${base}/${id}/rooms/${roomId}/checklist`, { itemId, done }),

  leaderboard: (id: string, metric: 'contribution' | 'helpful' = 'contribution') =>
    api.get<{ entries: LeaderboardEntry[]; enabled: boolean }>(`${base}/${id}/leaderboard?metric=${metric}`),

  contribution: (id: string) =>
    api.get<{ contributionPoints: number; helpfulAnswers: number; role: CommunityRole; rank: number | null }>(
      `${base}/${id}/contribution`,
    ),

  members: (id: string, params: { search?: string; role?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '' && value !== null) query.set(key, String(value));
    }
    const suffix = query.toString();
    return api.get<{ members: CommunityMemberView[]; total: number }>(
      `${base}/${id}/members${suffix ? `?${suffix}` : ''}`,
    );
  },

  changeRole: (id: string, userId: string, role: CommunityRole) =>
    api.post<{ ok: boolean }>(`${base}/${id}/members/${userId}/role`, { role }),

  removeMember: (id: string, userId: string) => api.del<{ ok: boolean }>(`${base}/${id}/members/${userId}`),

  kickMember: (id: string, userId: string, reason = '') =>
    api.post<{ ok: boolean }>(`${base}/${id}/members/${userId}/kick`, { reason }),

  banMember: (id: string, userId: string, banned: boolean, reason = '') =>
    api.post<{ ok: boolean }>(`${base}/${id}/members/${userId}/ban`, { banned, reason }),

  muteMember: (id: string, userId: string, hours: number, reason = '') =>
    api.post<{ ok: boolean }>(`${base}/${id}/members/${userId}/mute`, { hours, reason }),

  unmuteMember: (id: string, userId: string) => api.del<{ ok: boolean }>(`${base}/${id}/members/${userId}/mute`),

  joinRequests: (id: string) =>
    api.get<{ requests: { id: string; userId: string; name: string; classLevel: string | null; reason: string; createdAt: string }[] }>(
      `${base}/${id}/join-requests`,
    ),

  decideRequest: (id: string, requestId: string, approve: boolean) =>
    api.post<{ ok: boolean }>(`${base}/${id}/join-requests/${requestId}`, { approve }),

  invites: (id: string) =>
    api.get<{
      invites: {
        id: string;
        code: string;
        expiresAt: string | null;
        maxUses: number | null;
        useCount: number;
        isRevoked: boolean;
        isExpired: boolean;
        createdAt: string;
      }[];
    }>(`${base}/${id}/invites`),

  createInvite: (id: string, payload: { expiresAt?: string | null; maxUses?: number | null } = {}) =>
    api.post<{ id: string; code: string; expiresAt: string | null; maxUses: number | null }>(`${base}/${id}/invites`, payload),

  revokeInvite: (id: string, inviteId: string) => api.del<{ ok: boolean }>(`${base}/${id}/invites/${inviteId}`),

  teams: (id: string) => api.get<{ teams: TeamView[] }>(`${base}/${id}/teams`),

  createTeam: (
    id: string,
    payload: { name: string; description?: string; goal?: string; memberLimit?: number },
  ) => api.post<{ id: string }>(`${base}/${id}/teams`, payload),

  joinTeam: (id: string, teamId: string) => api.post<{ ok: boolean }>(`${base}/${id}/teams/${teamId}/join`),

  leaveTeam: (id: string, teamId: string) => api.post<{ ok: boolean }>(`${base}/${id}/teams/${teamId}/leave`),

  removeTeam: (id: string, teamId: string) => api.del<{ ok: boolean }>(`${base}/${id}/teams/${teamId}`),

  inviteToTeam: (id: string, teamId: string, userIds: string[]) =>
    api.post<{ invited: number; skipped: number }>(`${base}/${id}/teams/${teamId}/invite`, { userIds }),

  teamStandings: (id: string, competitionId: string) =>
    api.get<{
      competitionTitle: string;
      teams: { teamId: string; name: string; participants: number; averageScore: number | null; averageAccuracy: number | null; bestScore: number | null }[];
    }>(`${base}/${id}/teams/standings?competitionId=${encodeURIComponent(competitionId)}`),

  competitions: (id: string) => api.get<{ competitions: CommunityCompetitionView[] }>(`${base}/${id}/competitions`),

  createCompetition: (id: string, payload: Record<string, unknown>) =>
    api.post<{ id: string; communityId: string; visibility: string }>(`${base}/${id}/competitions`, payload),

  registerCompetition: (id: string, competitionId: string, inviteCode?: string) =>
    api.post<{ state: string }>(`${base}/${id}/competitions/${competitionId}/register`, { inviteCode }),

  withdrawCompetition: (id: string, competitionId: string) =>
    api.post<{ withdrawn: boolean }>(`${base}/${id}/competitions/${competitionId}/withdraw`),

  removeCompetition: (id: string, competitionId: string) =>
    api.del<{ ok: boolean }>(`${base}/${id}/competitions/${competitionId}`),

  /**
   * Filling a hosted competition's paper. `mode: 'ai'` lets the generator write it; `mode: 'upload'`
   * takes pasted text and has the server rewrite every question before it runs. The response is counts
   * only — the paper itself never comes back to a browser, which is what keeps it private.
   */
  preparePaper: (
    id: string,
    competitionId: string,
    payload: { mode: 'ai' | 'upload'; text?: string; subject?: string; blueprint?: Record<string, unknown> },
  ) => api.post<CommunityPaperOutcome>(`${base}/${id}/competitions/${competitionId}/paper`, payload),

  paperStatus: (id: string, competitionId: string) =>
    api.get<CommunityPaperStatus>(`${base}/${id}/competitions/${competitionId}/paper`),

  report: (
    id: string,
    payload: { targetType: string; targetId: string; reason: string; details?: string },
  ) => api.post<{ id: string; duplicate: boolean }>(`${base}/${id}/reports`, payload),

  reports: (id: string, status = 'open') =>
    api.get<{ reports: ReportView[] }>(`${base}/${id}/reports?status=${status}`),

  resolveReport: (
    id: string,
    reportId: string,
    payload: { action: 'dismiss' | 'remove_content' | 'warn' | 'mute' | 'remove_member'; note?: string; muteHours?: number },
  ) => api.post<{ status: string; action: string }>(`${base}/${id}/reports/${reportId}/resolve`, payload),

  moderationLog: (id: string) =>
    api.get<{
      actions: { id: string; action: string; reason: string; targetType: string; targetId: string; createdAt: string; actorName: string; targetName: string | null }[];
      log: unknown[];
    }>(`${base}/${id}/moderation`),

  analytics: (id: string) => api.get<CommunityAnalytics>(`${base}/${id}/analytics`),

  notifications: (params: { limit?: number; unreadOnly?: boolean } = {}) => {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.unreadOnly) query.set('unreadOnly', 'true');
    const suffix = query.toString();
    return api.get<{ notifications: NotificationView[]; unread: number }>(
      `${base}/notifications${suffix ? `?${suffix}` : ''}`,
    );
  },

  notificationPreferences: () =>
    api.get<{ mutedKinds: string[]; allKinds: string[] }>(`${base}/notifications/preferences`),

  saveNotificationPreferences: (mutedKinds: string[]) =>
    api.put<{ mutedKinds: string[] }>(`${base}/notifications/preferences`, { mutedKinds }),

  markNotificationRead: (notificationId: string) =>
    api.post<{ ok: boolean; unread: number }>(`${base}/notifications/${notificationId}/read`),

  markAllNotificationsRead: () => api.post<{ updated: number }>(`${base}/notifications/read-all`),

  badges: () => api.get<{ badges: BadgeView[]; streakDays: number }>(`${base}/badges`),

  myProfile: () => api.get<ProfileView>(`${base}/profile/me`),

  saveProfile: (payload: {
    bio?: string;
    interests?: string[];
    isProfilePublic?: boolean;
    isActivityVisible?: boolean;
    isCommunitiesVisible?: boolean;
  }) => api.put<ProfileView>(`${base}/profile/me`, payload),

  profile: (userId: string) => api.get<ProfileView>(`${base}/profile/${userId}`),

  blocks: () => api.get<{ blocked: string[] }>(`${base}/profile/blocks`),

  block: (userId: string) => api.post<{ blocked: string[] }>(`${base}/profile/blocks`, { userId }),

  unblock: (userId: string) => api.del<{ blocked: string[] }>(`${base}/profile/blocks/${userId}`),
};
