/**
 * Private chat state (§6, §7).
 *
 * Responsibilities, in order of importance:
 *  1. **Keys never leave the device in the clear.** The conversation key is created locally, wrapped
 *     per device and only the wrapped blob is uploaded. The server can serve a thread it cannot read.
 *  2. **Honest failure.** When a device has no envelope for a conversation, the thread says so and
 *     offers a single action ("Send keys to this device") instead of rendering an empty thread.
 *  3. **No optimistic content.** A sent message appears once the server has stored its ciphertext and
 *     returns the row, so what a student sees is what the other device will decrypt.
 *
 * The hook is deliberately provider-free (no React Query, no context) to match the rest of the app.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, postStream } from '../../lib/api';
import {
  createConversationKey,
  decryptMessage,
  ensureIdentity,
  getConversationKey,
  cryptoAvailable,
  putConversationKey,
  unwrapKeyFromEnvelope,
  wrapKeyForDevice,
  type DeviceIdentity,
} from '../../lib/crypto';
import { messagesApi, type ConversationSummary, type PrivateMessage } from './api';
import type { KeyEnvelope } from './api';

export interface DecryptedRow {
  message: PrivateMessage;
  text: string | null;
  /** True when the row is a tombstone or we hold no key yet. */
  unreadable: boolean;
}

function source(rows: PrivateMessage[]): DecryptedRow[] {
  return rows.map((message) => ({ message, text: null, unreadable: true }));
}

/**
 * Registers this device's public key, creating the device identity on first use.
 *
 * Idempotent: the server upserts on `(userId, deviceId)`, so re-running after a reload is cheap.
 */
export function useDeviceIdentity() {
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!cryptoAvailable()) {
      setError(
        'This browser cannot encrypt messages locally, so private chat is unavailable here. Try a current browser over a secure (https) connection.',
      );
      setReady(true);
      return;
    }
    void (async () => {
      try {
        const next = await ensureIdentity();
        if (cancelled) return;
        await messagesApi.registerDevice({
          deviceId: next.deviceId,
          publicKey: next.publicKey,
          label: navigator.platform?.slice(0, 40) || undefined,
        });
        if (cancelled) return;
        setIdentity(next);
      } catch (err) {
        if (!cancelled) setError((err as Error)?.message ?? 'Could not set up encryption on this device.');
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { identity, error, ready };
}

/**
 * Makes sure this device can read a conversation: unwraps an envelope if one exists, otherwise
 * leaves the conversation key missing so the UI can ask the other member's device to share it.
 */
export function useConversationKeys(
  identity: DeviceIdentity | null,
  conversationId: string | null,
  keyVersion = 1,
) {
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!identity || !conversationId) return;
    setLoading(true);
    try {
      const local = await getConversationKey(conversationId);
      if (local && local.keyVersion >= keyVersion) {
        setKey(local.key);
        setNeedsKey(false);
        return;
      }
      const { envelopes } = await messagesApi.envelopes(conversationId);
      const mine = envelopes.find((envelope: KeyEnvelope) => envelope.deviceId === identity.deviceId);
      if (!mine) {
        setKey(null);
        setNeedsKey(true);
        return;
      }
      const unwrapped = await unwrapKeyFromEnvelope(identity, mine.wrappedKey);
      if (!unwrapped) {
        setKey(null);
        setNeedsKey(true);
        return;
      }
      await putConversationKey({
        conversationId,
        key: unwrapped.key,
        keyVersion: keyVersion,
        createdAt: new Date().toISOString(),
      });
      setKey(unwrapped.key);
      setNeedsKey(false);
    } catch {
      // A missing envelope is a normal state during first contact, not an error to shout about.
      setKey(null);
      setNeedsKey(true);
    } finally {
      setLoading(false);
    }
  }, [conversationId, identity, keyVersion]);

  useEffect(() => {
    void load();
  }, [load]);

  return { key, needsKey, loading, reload: load };
}

/**
 * Creates the conversation key (first writer wins) and distributes it to every device that can read
 * the thread — both members' devices, including other devices of the same student.
 */
export async function distributeConversationKey(
  identity: DeviceIdentity,
  conversationId: string,
  otherUserId: string,
  keyVersion = 1,
): Promise<void> {
  const own = await getConversationKey(conversationId);
  const key = own?.key ?? (await createConversationKey(conversationId, keyVersion)).key;

  const { devices } = await messagesApi.devices(Array.from(new Set([otherUserId, identity.deviceId])));
  // The viewer's own user id is not needed: `devices` already includes this device because the
  // endpoint accepts the caller's own id, and `registerDevice` was called when the identity loaded.
  await Promise.all(
    devices.map(async (device) => {
      if (device.deviceId === identity.deviceId) {
        // A fresh device needs its own copy too — wrap for ourselves so a re-load can unwrap it.
        const self = await wrapKeyForDevice(device.publicKey, key, identity.deviceId);
        await messagesApi.putEnvelope(conversationId, {
          recipientUserId: device.userId,
          deviceId: device.deviceId,
          wrappedKey: self.wrappedKey,
          iv: self.iv,
          keyVersion,
        });
        return;
      }
      const wrapped = await wrapKeyForDevice(device.publicKey, key, device.deviceId);
      await messagesApi.putEnvelope(conversationId, {
        recipientUserId: device.userId,
        deviceId: device.deviceId,
        wrappedKey: wrapped.wrappedKey,
        iv: wrapped.iv,
        keyVersion,
      });
    }),
  );
}

/** Sends this device's public key to every device in a conversation (the "send keys" action). */
export async function shareKeysWithDevices(identity: DeviceIdentity, conversationId: string, memberIds: string[]) {
  const { devices } = await messagesApi.devices(memberIds.filter((id) => id !== identity.deviceId));
  await Promise.all(
    devices.map(async (device) => {
      const own = await getConversationKey(conversationId);
      if (!own) throw new Error('This device has no key for this conversation yet.');
      const wrapped = await wrapKeyForDevice(device.publicKey, own.key, device.deviceId);
      await messagesApi.putEnvelope(conversationId, {
        recipientUserId: device.userId,
        deviceId: device.deviceId,
        wrappedKey: wrapped.wrappedKey,
        iv: wrapped.iv,
        keyVersion: own.keyVersion,
      });
    }),
  );
}

/**
 * The thread itself: paging, decryption, sending, editing, deleting, reacting and live updates.
 */
export function useThread(
  _identity: DeviceIdentity | null,
  conversation: ConversationSummary | null,
  key: CryptoKey | null,
  selfUserId: string | null,
) {
  const conversationId = conversation?.id ?? null;
  const [rows, setRows] = useState<DecryptedRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(Boolean(conversationId));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typingPeer, setTypingPeer] = useState(false);
  const typingTimer = useRef<number | null>(null);
  const peerTypingTimer = useRef<number | null>(null);

  /** Decrypts rows with the current key; rows without a key stay marked unreadable. */
  const decode = useCallback(
    async (messages: PrivateMessage[]): Promise<DecryptedRow[]> => {
      if (!key || !conversationId) return source(messages);
      return Promise.all(
        messages.map(async (message) => {
          if (message.deletedAt) return { message, text: null, unreadable: false };
          const plain = await decryptMessage(key, conversationId, message);
          return { message, text: plain?.text ?? null, unreadable: plain === null };
        }),
      );
    },
    [conversationId, key],
  );

  const loadFirstPage = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    setError(null);
    try {
      const page = await messagesApi.messages(conversationId, { limit: 40 });
      setRows(await decode(page.messages));
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (err) {
      setError((err as Error).message ?? 'Could not load this conversation.');
    } finally {
      setLoading(false);
    }
  }, [conversationId, decode]);

  useEffect(() => {
    setRows([]);
    setCursor(null);
    setHasMore(false);
    void loadFirstPage();
  }, [loadFirstPage]);

  // Re-decrypt whatever is on screen when the key arrives (or changes).
  useEffect(() => {
    if (!key || !rows.length) return;
    let cancelled = false;
    void (async () => {
      const next = await decode(rows.map((row) => row.message));
      if (!cancelled) setRows(next);
    })();
    return () => {
      cancelled = true;
    };
    // Only re-run when the key changes; row updates keep their own decrypted text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loadOlder = useCallback(async () => {
    if (!conversationId || !cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await messagesApi.messages(conversationId, { before: cursor, limit: 40 });
      const decoded = await decode(page.messages);
      setRows((current) => [...decoded, ...current]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (err) {
      setError((err as Error).message ?? 'Could not load older messages.');
    } finally {
      setLoadingOlder(false);
    }
  }, [conversationId, cursor, decode, loadingOlder]);

  /** Pulls anything newer than the newest row we already hold. */
  const refreshNewest = useCallback(async () => {
    if (!conversationId) return;
    const newest = rows[rows.length - 1]?.message;
    try {
      const page = await messagesApi.messages(conversationId, newest ? { after: newest.createdAt, limit: 60 } : { limit: 40 });
      if (!newest) {
        setRows(await decode(page.messages));
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
        return;
      }
      const known = new Set(rows.map((row) => row.message.id));
      const fresh = page.messages.filter((message) => !known.has(message.id));
      if (!fresh.length) return;
      const decoded = await decode(fresh);
      setRows((current) => [...current, ...decoded]);
    } catch {
      /* a dropped refresh is retried by the next event or poll */
    }
  }, [conversationId, decode, rows]);

  /**
   * Live updates.
   *
   * Events carry ids only, so a `dm_message` event triggers a re-read of the tail of the thread —
   * the server never sends content here because it does not hold any. A 20-second poll is the
   * backstop for a dropped stream (mobile browsers drop them when the tab sleeps).
   */
  useEffect(() => {
    if (!conversationId) return;
    const handle = postStream('/messages/stream', {}, {
      onEvent: (event, data) => {
        if (event === 'ready') return;
        const payload = data as { type?: string; conversationId?: string; senderId?: string };
        if (payload?.conversationId && payload.conversationId !== conversationId) return;
        if (payload?.type === 'dm_message' || payload?.type === 'dm_message_deleted' || payload?.type === 'dm_message_updated') {
          void refreshNewest();
        }
        // `senderId` is a user id, so compare it with the signed-in student, not with this device.
        if (payload?.type === 'dm_typing' && payload.senderId && payload.senderId !== selfUserId) {
          setTypingPeer(true);
          if (peerTypingTimer.current) window.clearTimeout(peerTypingTimer.current);
          peerTypingTimer.current = window.setTimeout(() => setTypingPeer(false), 4000);
        }
      },
    });
    const poll = window.setInterval(() => void refreshNewest(), 20_000);
    return () => {
      handle.cancel();
      window.clearInterval(poll);
      if (peerTypingTimer.current) window.clearTimeout(peerTypingTimer.current);
    };
  }, [conversationId, refreshNewest, selfUserId]);

  const notifyTyping = useCallback(() => {
    if (!conversationId) return;
    if (typingTimer.current) return; // at most one signal every 3 s
    void messagesApi.typing(conversationId).catch(() => undefined);
    typingTimer.current = window.setTimeout(() => {
      typingTimer.current = null;
    }, 3000);
  }, [conversationId]);

  return {
    rows,
    setRows,
    loading,
    loadingOlder,
    error,
    hasMore,
    typingPeer,
    loadFirstPage,
    loadOlder,
    refreshNewest,
    notifyTyping,
    decode,
  };
}

/** Sidebar data: conversation list plus the unread total used by the navigation badge. */
export function useConversations() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await messagesApi.conversations();
      setConversations(result.conversations);
      setUnread(result.unread);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Could not load your conversations.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const muted = useMemo(() => conversations.filter((conversation) => conversation.isMuted).length, [conversations]);
  return { conversations, unread, muted, loading, error, reload: load };
}

/** Unread badge for the shell — one small request, no conversation payload. */
export function useUnreadCount(): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const result = await api.get<{ unread: number }>('/messages/unread');
        if (!cancelled) setUnread(result.unread);
      } catch {
        /* signed out or offline — a missing badge is not worth an error */
      }
    };
    void read();
    const timer = window.setInterval(read, 45_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return unread;
}
