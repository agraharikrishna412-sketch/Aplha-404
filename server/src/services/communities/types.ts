/**
 * Shared shapes for Vroqn Communities.
 *
 * The API deliberately returns *views*, not raw rows: a member never receives another member's
 * private fields, and a message never carries its moderation history. Keeping the views here means
 * the client type and the server response are defined once.
 */
import type { CommunityRole, MemberStatus } from './permissions.js';

export type CommunityVisibility = 'public' | 'private' | 'invite_only';
export type JoinRequestStatus = 'pending' | 'approved' | 'rejected';
export type ResourceKind = 'link' | 'file' | 'note' | 'formula_sheet' | 'paper';
export type EventKind =
  | 'study_session'
  | 'doubt_session'
  | 'competition'
  | 'revision_session'
  | 'mock_exam'
  | 'project_session';
export type ChallengeStatus = 'draft' | 'active' | 'ended';
export type ReportEntity = 'message' | 'user' | 'resource' | 'community' | 'competition' | 'profile' | 'doubt';
export type ReportStatus = 'open' | 'reviewing' | 'resolved' | 'dismissed';

export const VISIBILITIES: CommunityVisibility[] = ['public', 'private', 'invite_only'];
export const RESOURCE_KINDS: ResourceKind[] = ['link', 'file', 'note', 'formula_sheet', 'paper'];
export const EVENT_KINDS: EventKind[] = [
  'study_session',
  'doubt_session',
  'competition',
  'revision_session',
  'mock_exam',
  'project_session',
];
export const REPORT_REASONS = [
  'spam',
  'harassment',
  'inappropriate',
  'cheating',
  'misleading',
  'privacy',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export function isVisibility(value: unknown): value is CommunityVisibility {
  return typeof value === 'string' && (VISIBILITIES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ category taxonomy ----------- */

/** §8 asks for a fixed educational taxonomy rather than free-form categories. */
export const COMMUNITY_CATEGORIES = [
  'ai',
  'coding',
  'jee',
  'neet',
  'mathematics',
  'physics',
  'chemistry',
  'biology',
  'school',
  'class-9',
  'class-10',
  'class-11',
  'class-12',
  'competitive-exams',
  'projects',
  'programming',
] as const;
export type CommunityCategory = (typeof COMMUNITY_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<string, string> = {
  ai: 'AI',
  coding: 'Coding',
  jee: 'JEE',
  neet: 'NEET',
  mathematics: 'Mathematics',
  physics: 'Physics',
  chemistry: 'Chemistry',
  biology: 'Biology',
  school: 'School',
  'class-9': 'Class 9',
  'class-10': 'Class 10',
  'class-11': 'Class 11',
  'class-12': 'Class 12',
  'competitive-exams': 'Competitive exams',
  projects: 'Projects',
  programming: 'Programming',
};

export function categoryLabel(id: string): string {
  return CATEGORY_LABELS[id] ?? id;
}

/* ------------------------------------------------------------------ views ----------------------- */

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
  /** Null when the caller is not signed in or has never joined. */
  myRole: CommunityRole | null;
  myStatus: MemberStatus | null;
  /** Set when the caller has a pending join request, so the UI can say so instead of showing Join. */
  joinRequestStatus: JoinRequestStatus | null;
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
  /** Names of the tabs that actually have content or an enabled feature (§5). */
  tabs: string[];
  unreadCount: number;
}

export interface CommunityMemberView {
  id: string;
  userId: string;
  name: string;
  role: CommunityRole;
  status: MemberStatus;
  contributionPoints: number;
  helpfulAnswers: number;
  mutedUntil: string | null;
  joinedAt: string;
  isSelf: boolean;
  /**
   * What the *viewer* may do to this member, decided by the server on every list response.
   *
   * These are the flags the Members tab renders its controls from. They must always be present: the
   * UI gates its whole action row on them, and an undefined flag used to hide every moderation
   * control in the community.
   */
  canChangeRole: boolean;
  canRemove: boolean;
}

export interface ChatMessageView {
  id: string;
  communityId: string;
  userId: string;
  authorName: string;
  authorRole: CommunityRole;
  body: string;
  /** Present after an edit so the UI can mark it. */
  editedAt: string | null;
  isDeleted: boolean;
  deletedByModerator: boolean;
  isPinned: boolean;
  isAnnouncement: boolean;
  parentId: string | null;
  parentPreview: string | null;
  reactions: { emoji: string; count: number; mine: boolean }[];
  /** Shared Vroqn content attached to the message, if any. */
  attachment: { kind: 'doubt' | 'resource' | 'competition' | 'note'; id: string; title: string } | null;
  poll: PollView | null;
  createdAt: string;
  isMine: boolean;
  canDelete: boolean;
}

export interface PollView {
  id: string;
  question: string;
  isMultiple: boolean;
  isAnonymous: boolean;
  expiresAt: string | null;
  isClosed: boolean;
  totalVotes: number;
  options: { id: string; label: string; votes: number; mine: boolean; percent: number }[];
  myVotes: string[];
}

export interface DoubtView {
  id: string;
  communityId: string;
  userId: string;
  authorName: string;
  title: string;
  description: string;
  imageUrl: string | null;
  subject: string | null;
  topic: string | null;
  status: 'open' | 'solved';
  answerCount: number;
  helpfulAnswerId: string | null;
  isKnowledge: boolean;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
  isMine: boolean;
}

export interface DoubtAnswerView {
  id: string;
  doubtId: string;
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

export interface KnowledgeView {
  id: string;
  communityId: string;
  doubtId: string | null;
  title: string;
  question: string;
  answer: string;
  aiExplanation: string | null;
  subject: string | null;
  topic: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ResourceView {
  id: string;
  communityId: string;
  title: string;
  description: string;
  category: string;
  kind: ResourceKind;
  url: string | null;
  noteId: string | null;
  subject: string | null;
  createdBy: string;
  authorName: string;
  isPinned: boolean;
  downloadCount: number;
  createdAt: string;
  isMine: boolean;
  canDelete: boolean;
  /** Present only for uploaded files: the stored file's display name and size. */
  uploadId: string | null;
  fileName: string | null;
  fileSize: number | null;
  fileMime: string | null;
}

export interface EventView {
  id: string;
  communityId: string;
  title: string;
  description: string;
  kind: EventKind;
  startsAt: string;
  endsAt: string;
  hostId: string;
  hostName: string;
  meetingUrl: string | null;
  participantLimit: number | null;
  participantCount: number;
  isGoing: boolean;
  isPast: boolean;
  isMine: boolean;
  canDelete: boolean;
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
  status: ChallengeStatus;
  startsAt: string;
  endsAt: string;
  createdBy: string;
  createdAt: string;
  participantCount: number;
  /** This member's own progress — never anyone else's. */
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
  done: boolean;
}

export interface StudyPlanView {
  id: string;
  communityId: string;
  title: string;
  description: string;
  subject: string | null;
  createdBy: string;
  /** Display name of the planner, so the list can say who is running it without a second request. */
  authorName: string;
  createdAt: string;
  tasks: StudyPlanTaskView[];
  doneCount: number;
  totalCount: number;
  percent: number;
  isMine: boolean;
  canDelete: boolean;
}

export interface StudyRoomView {
  id: string;
  communityId: string;
  title: string;
  topic: string;
  goal: string;
  startsAt: string;
  endsAt: string;
  createdBy: string;
  participantCount: number;
  isJoined: boolean;
  checklist: { id: string; label: string; done: boolean }[];
}

export interface AnnouncementView {
  id: string;
  communityId: string;
  title: string;
  body: string;
  isPinned: boolean;
  expiresAt: string | null;
  createdBy: string;
  authorName: string;
  createdAt: string;
  isExpired: boolean;
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

export const NOTIFICATION_KINDS = [
  'join_request',
  'join_approved',
  'join_rejected',
  'announcement',
  'competition_start',
  'competition_end',
  'result',
  'mention',
  'reply',
  'event',
  'challenge',
  'study_plan',
  'helpful_answer',
  'badge',
  'moderation',
  'moderation_warning',
  'moderation_action',
  'report_received',
  'poll',
  'team_invite',
  'team_update',
  'room',
  'resource',
  'doubt',
] as const;

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
  /** `null` while unearned — badges are never manually claimable (§26). */
  communityId: string | null;
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

export interface CommunityAnalytics {
  totalMembers: number;
  newMembers7d: number;
  activeMembers: number;
  competitionParticipation: number;
  /** `null` until at least one challenge has a participant. */
  challengeCompletionPercent: number | null;
  resourceCount: number;
  doubtCount: number;
  helpfulAnswerCount: number;
  eventParticipation: number;
  messages7d: number;
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
  /** Plain-text excerpt of the reported content, moderators only. */
  preview: string | null;
}

export interface ModerationActionView {
  id: string;
  action: string;
  reason: string;
  targetType: string;
  targetId: string;
  createdAt: string;
  actorName: string;
  targetName: string | null;
}

export interface SearchHit {
  type: 'community' | 'doubt' | 'knowledge' | 'resource' | 'competition' | 'event' | 'challenge' | 'study_plan' | 'member';
  id: string;
  title: string;
  snippet: string;
  communityId: string | null;
  communityName: string | null;
  url: string;
  meta: Record<string, string | number | null>;
}
