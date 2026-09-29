/**
 * Typed client for the private-messaging API (`/api/messages`) and profile API (`/api/profile`).
 *
 * Nothing here decides who may do what: the server owns authorisation and its refusal messages are
 * surfaced verbatim. Types mirror `server/src/services/dm.ts` so a field rename cannot drift silently.
 */
import { api } from '../../lib/api';

export type DmPolicy = 'everyone' | 'communities' | 'nobody';

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
  needsKey: boolean;
  other: { userId: string; name: string; username: string | null; avatarUrl: string | null; accent: string } | null;
  lastMessage: LastMessagePreview | null;
  blocked: boolean;
  canSend: boolean;
  canSendReason: string | null;
}

export interface PrivateMessage {
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

export interface DeviceKey {
  userId: string;
  deviceId: string;
  publicKey: JsonWebKey;
  createdAt: string;
}

export interface KeyEnvelope {
  conversationId: string;
  deviceId: string;
  recipientUserId: string;
  senderUserId: string;
  wrappedKey: string;
  iv: string;
  createdAt: string;
}

export interface BlockedPerson {
  userId: string;
  name: string;
  blockedAt: string;
}

export interface DmReport {
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
}

export interface PersonCard {
  userId: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  accent: string;
  bio: string;
  classLevel: string | null;
  board: string | null;
  interests: string[];
}

/**
 * The profile payload, mirroring `services/profile.ts` exactly.
 *
 * `visibility` and `viewer` are nested on purpose: what a student may *see* and what they may *do* are
 * separate questions, and the server answers both so the page never has to infer permission from a
 * missing field.
 */
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
  communities?: { id: string; name: string; slug: string; role: string }[];
  /** How many communities the viewer shares with this student (omitted on your own profile). */
  sharedCommunities?: number;
  badges?: { key: string; label: string; awardedAt: string }[];
  stats?: { practiceSets: number; mockExams: number; arenaAttempts: number; notes: number };
  visibility: {
    profile: 'public' | 'members' | 'private';
    activity: boolean;
    communities: boolean;
    achievements: boolean;
    dmPolicy: DmPolicy;
  };
  viewer: {
    isSelf: boolean;
    canMessage: boolean;
    messageBlockedReason: string | null;
    isBlockedByMe: boolean;
    hasBlockedMe: boolean;
    isMessageable: boolean;
  };
}

export interface ProfilePatch {
  name?: string;
  username?: string | null;
  bio?: string;
  interests?: string[];
  accent?: string | null;
  classLevel?: string | null;
  board?: string | null;
  profileVisibility?: 'public' | 'members' | 'private';
  dmPolicy?: DmPolicy;
  activityVisible?: boolean;
  communitiesVisible?: boolean;
  achievementsVisible?: boolean;
}

const base = '/messages';

export const messagesApi = {
  conversations: () => api.get<{ conversations: ConversationSummary[]; unread: number }>(`${base}/conversations`),
  unread: () => api.get<{ unread: number }>(`${base}/unread`),
  open: (userId: string) => api.post<{ conversationId: string; created: boolean }>(`${base}/conversations`, { userId }),
  detail: (conversationId: string) => api.get<ConversationSummary>(`${base}/conversations/${conversationId}`),
  markRead: (conversationId: string) => api.post<{ ok: boolean }>(`${base}/conversations/${conversationId}/read`),
  flags: (conversationId: string, flags: { muted?: boolean; archived?: boolean }) =>
    api.post<ConversationSummary>(`${base}/conversations/${conversationId}/flags`, flags),
  typing: (conversationId: string) => api.post<{ ok: boolean }>(`${base}/conversations/${conversationId}/typing`),

  messages: (conversationId: string, params: { before?: string; after?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    const suffix = query.toString();
    return api.get<{ messages: PrivateMessage[]; hasMore: boolean; nextCursor: string | null }>(
      `${base}/conversations/${conversationId}/messages${suffix ? `?${suffix}` : ''}`,
    );
  },
  send: (
    conversationId: string,
    payload: { ciphertext: string; iv: string; alg?: string; keyVersion?: number; replyToId?: string | null },
  ) => api.post<PrivateMessage>(`${base}/conversations/${conversationId}/messages`, payload),
  edit: (messageId: string, payload: { ciphertext: string; iv: string }) =>
    api.patch<PrivateMessage>(`${base}/messages/${messageId}`, payload),
  remove: (messageId: string) => api.del<{ ok: boolean }>(`${base}/messages/${messageId}`),
  react: (messageId: string, reaction: string) =>
    api.post<PrivateMessage>(`${base}/messages/${messageId}/reactions`, { reaction }),

  registerDevice: (payload: { deviceId: string; publicKey: JsonWebKey; label?: string }) =>
    api.post<{ deviceId: string; alg: string }>(`${base}/devices`, payload),
  devices: (userIds: string[]) =>
    api.get<{ devices: DeviceKey[] }>(`${base}/devices?userIds=${encodeURIComponent(userIds.join(','))}`),
  envelopes: (conversationId: string) => api.get<{ envelopes: KeyEnvelope[] }>(`${base}/conversations/${conversationId}/keys`),
  putEnvelope: (
    conversationId: string,
    payload: { recipientUserId: string; deviceId: string; wrappedKey: string; iv: string; keyVersion?: number },
  ) => api.post<{ ok: boolean }>(`${base}/conversations/${conversationId}/keys`, payload),

  blocks: () => api.get<{ blocked: BlockedPerson[] }>(`${base}/blocks`),
  block: (userId: string) => api.post<{ ok: boolean }>(`${base}/blocks`, { userId }),
  unblock: (userId: string) => api.del<{ ok: boolean }>(`${base}/blocks/${userId}`),
  setPolicy: (dmPolicy: DmPolicy) => api.put<{ dmPolicy: DmPolicy }>(`${base}/prefs`, { dmPolicy }),

  reports: (scope?: 'all') => api.get<{ reports: DmReport[] }>(`${base}/reports${scope ? `?scope=${scope}` : ''}`),
  report: (payload: { conversationId?: string; messageId?: string; targetUserId?: string; reason: string; note?: string }) =>
    api.post<{ ok: boolean; reportId: string }>(`${base}/reports`, payload),
};

export const profileApi = {
  me: () => api.get<ProfileView>('/profile/me'),
  person: (userId: string) => api.get<ProfileView>(`/profile/${userId}`),
  people: (term: string) => api.get<{ people: PersonCard[] }>(`/profile/people?q=${encodeURIComponent(term)}`),
  update: (patch: ProfilePatch) => api.patch<ProfileView>('/profile/me', patch),
  uploadAvatar: (file: File) => {
    const form = new FormData();
    form.append('avatar', file);
    // Multipart, so the JSON content-type must not be set: the browser adds the boundary itself.
    return api.postForm<ProfileView>('/profile/me/avatar', form);
  },
  removeAvatar: () => api.del<ProfileView>('/profile/me/avatar'),
};
