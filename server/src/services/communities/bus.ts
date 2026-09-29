/**
 * In-process pub/sub for community real-time events.
 *
 * §6 allows "the simplest reliable architecture" and explicitly rules out a separate chat server,
 * Redis or microservices. Vroqn deploys as a single Node web service (see `render.yaml`), so an
 * EventEmitter is genuinely sufficient: every SSE connection lives in this process, so a published
 * event reaches every subscriber directly.
 *
 * The honest limitation, stated rather than hidden: **this is single-process only.** Scaling to
 * multiple instances would silently stop real-time delivery (each instance would only see its own
 * events). If that day comes, the two swappable seams are `publish()` and `subscribe()` below —
 * everything else in the codebase talks to those two functions and nothing else. Polling on
 * reconnect and on tab focus is the built-in fallback, so a dropped stream degrades to "slightly
 * stale" rather than "broken".
 */
import { EventEmitter } from 'node:events';

export type CommunityEvent =
  | { type: 'message'; communityId: string; messageId: string; authorId: string }
  | { type: 'message_updated'; communityId: string; messageId: string }
  | { type: 'message_deleted'; communityId: string; messageId: string }
  | { type: 'reaction'; communityId: string; messageId: string }
  | { type: 'doubt'; communityId: string; doubtId: string }
  | { type: 'doubt_answer'; communityId: string; doubtId: string }
  | { type: 'resource'; communityId: string; resourceId: string }
  | { type: 'challenge'; communityId: string; challengeId: string }
  | { type: 'event'; communityId: string; eventId: string }
  | { type: 'announcement'; communityId: string; announcementId: string }
  | { type: 'poll'; communityId: string; pollId: string }
  | { type: 'competition'; communityId: string; competitionId: string }
  | { type: 'notification'; userId: string; notificationId: string }
  /*
   * Private messaging rides the same bus. A private conversation is not a community, so these events
   * carry only ids — never content, which the server does not hold in readable form anyway.
   */
  | { type: 'dm_message'; userId: string; conversationId: string; messageId: string; senderId: string }
  | { type: 'dm_message_updated'; userId: string; conversationId: string; messageId: string }
  | { type: 'dm_message_deleted'; userId: string; conversationId: string; messageId: string }
  | { type: 'dm_conversation'; userId: string; conversationId: string }
  | { type: 'dm_read'; userId: string; conversationId: string }
  | { type: 'dm_typing'; userId: string; conversationId: string; senderId: string }
  | { type: 'dm_key'; userId: string; conversationId: string };

export interface BusMessage {
  /** Channel key: `community:<id>` or `user:<id>`. */
  channel: string;
  event: CommunityEvent;
}

const emitter = new EventEmitter();
// A large community could have many open streams; the default limit of 10 is far too low.
emitter.setMaxListeners(0);

export function communityChannel(communityId: string): string {
  return `community:${communityId}`;
}

export function userChannel(userId: string): string {
  return `user:${userId}`;
}

/**
 * Publish to a community channel. `authorId` rides along so a stream can skip echoing an event back
 * to the tab that caused it (the sender already rendered optimistically).
 */
export function publishCommunity(communityId: string, event: CommunityEvent): void {
  emitter.emit(communityChannel(communityId), event);
}

/** Publish to a single user's channel — used by the notification stream. */
export function publishUser(userId: string, event: CommunityEvent): void {
  emitter.emit(userChannel(userId), event);
}

export function subscribe(channel: string, handler: (event: CommunityEvent) => void): () => void {
  emitter.on(channel, handler);
  return () => {
    emitter.off(channel, handler);
  };
}

/** Live subscriber count, exposed for diagnostics and for tests that assert cleanup. */
export function subscriberCount(channel?: string): number {
  if (channel) return emitter.listenerCount(channel);
  return emitter.eventNames().reduce((total, name) => total + emitter.listenerCount(name), 0);
}
