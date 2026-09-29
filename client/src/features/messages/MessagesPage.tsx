/**
 * Private messages (§6–§8).
 *
 * Two panes on a desktop (list beside thread) and two screens on a phone (list, then thread with a
 * back link) — the same route, chosen by CSS so there is no duplicated state to keep in sync.
 *
 * Everything a student sees here is either their own decrypted plaintext or an explicit statement
 * that this device cannot read a row yet. There is no demo data and no mock thread: an empty inbox is
 * shown as empty, with the one action that fixes it (find someone to message).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, BadgeCheck, BellOff, Flag, Lock, MessageSquarePlus, Search, ShieldAlert, UserMinus } from 'lucide-react';
import { PageBody, PageHeader } from '../../components/AppShell';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Skeleton,
  Spinner,
  TextArea,
  VroqnAvatar,
  VroqnChatBubble,
  VroqnIconButton,
  VroqnMessageComposer,
  VroqnSection,
  VroqnSheet,
  VroqnTabs,
} from '../../components/vroqn';
import { Segmented } from '../../components/ui';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../../hooks/useToast';
import { timeAgo } from '../../lib/format';
import { useDebounced } from '../communities/useCommunities';
import { messagesApi, profileApi, type ConversationSummary, type DmPolicy, type DmReport, type PersonCard } from './api';
import {
  distributeConversationKey,
  useConversations,
  useConversationKeys,
  useDeviceIdentity,
  useThread,
} from './usePrivateChat';

type ListTab = 'all' | 'unread' | 'muted' | 'blocked';

export function MessagesPage() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const toast = useToast();
  const { conversations, unread, loading, error, reload } = useConversations();
  const { identity, error: identityError, ready: identityReady } = useDeviceIdentity();
  const [tab, setTab] = useState<ListTab>('all');
  const [search, setSearch] = useState('');
  const [blocked, setBlocked] = useState<{ userId: string; name: string; blockedAt: string }[]>([]);
  const [reports, setReports] = useState<DmReport[]>([]);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  /**
   * `?to=<userId>` — the link the search screen hands over when a student taps "Message" next to a
   * result. Before this existed the button changed the URL and nothing else happened, which is the
   * worst kind of broken: it looked like it worked.
   *
   * The flow is: open (or reuse) the one-to-one conversation, add it to the inbox, then replace the
   * URL with the real thread. `firstContact` marks a conversation this screen created, so the thread
   * can prepare encryption straight away instead of asking the student to press a button first.
   */
  const targetUserId = searchParams.get('to');
  const [deepLink, setDeepLink] = useState<{ state: 'opening' | 'error'; message?: string } | null>(null);
  const location = useLocation();
  const handledDeepLink = useRef<string | null>(null);

  /*
   * `/messages` and `/messages/:conversationId` are two route elements, so moving from the list to a
   * thread unmounts this component and any React state in it is gone. The "we just created this
   * conversation" flag therefore travels in the history entry, not in state — and it is keyed to the
   * conversation id so it can only ever apply to the thread it was set for.
   */
  const firstContact = (location.state as { firstContact?: string } | null)?.firstContact === conversationId;

  useEffect(() => {
    if (!targetUserId || handledDeepLink.current === targetUserId) return;
    handledDeepLink.current = targetUserId;
    setDeepLink({ state: 'opening' });
    let cancelled = false;
    void (async () => {
      try {
        const result = await messagesApi.open(targetUserId);
        if (cancelled) return;
        // Clear `?to=` by replacing the entry, so Back does not re-trigger the open.
        setSearchParams({}, { replace: true });
        setDeepLink(null);
        void reload();
        /*
         * The flag does not depend on `created`: a student who searched for a classmate and tapped
         * Message expects a working composer whether the thread is brand new or was opened earlier
         * and left empty. What keeps it safe is the envelope check inside the thread, not this flag.
         */
        navigate(`/messages/${result.conversationId}`, {
          replace: true,
          state: { firstContact: result.conversationId },
        });
      } catch (err) {
        if (cancelled) return;
        setDeepLink({
          state: 'error',
          message: err instanceof Error ? err.message : 'That conversation could not be opened.',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate, reload, setSearchParams, targetUserId]);

  const active = useMemo(
    () => conversations.find((conversation) => conversation.id === conversationId) ?? null,
    [conversationId, conversations],
  );

  const loadSafety = useCallback(async () => {
    try {
      const [blockList, reportList] = await Promise.all([messagesApi.blocks(), messagesApi.reports()]);
      setBlocked(blockList.blocked);
      setReports(reportList.reports);
    } catch {
      /* the safety panel is secondary; a failure here must not break the inbox */
    }
  }, []);

  useEffect(() => {
    void loadSafety();
  }, [loadSafety]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return conversations.filter((conversation) => {
      if (tab === 'unread' && conversation.unread === 0) return false;
      if (tab === 'muted' && !conversation.isMuted) return false;
      if (tab === 'blocked' && !conversation.blocked) return false;
      if (needle && !(conversation.other?.name ?? '').toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [conversations, search, tab]);

  return (
    <div>
      <PageHeader
        title="Messages"
        description="Private conversations between two students. Messages are encrypted on your device before they are sent, so nobody — including us — can read them in between."
        badge={
          <Badge tone={unread > 0 ? 'primary' : 'muted'}>
            {unread > 0 ? `${unread} unread` : 'No unread messages'}
          </Badge>
        }
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<ShieldAlert size={14} />} onClick={() => setSafetyOpen(true)}>
              Safety
            </Button>
            <Button size="sm" variant="secondary" icon={<MessageSquarePlus size={14} />} onClick={() => setNewChatOpen(true)}>
              New message
            </Button>
          </>
        }
      />

      <PageBody className="pt-4">
        {deepLink?.state === 'opening' ? (
          <Card className="mb-4 border-[var(--color-primary)]/35">
            <div className="flex items-center gap-2.5 p-3.5 text-[12.5px] text-[var(--color-muted)]" role="status" aria-live="polite">
              <Spinner size={14} />
              Opening your conversation…
            </div>
          </Card>
        ) : null}

        {deepLink?.state === 'error' ? (
          <Card className="mb-4 border-[var(--color-warning)]/40">
            <div className="flex flex-wrap items-center gap-3 p-3.5">
              <ShieldAlert size={16} className="shrink-0 text-[var(--color-warning)]" />
              <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{deepLink.message}</p>
              <Button
                size="sm"
                variant="secondary"
                icon={<MessageSquarePlus size={13} />}
                onClick={() => {
                  setDeepLink(null);
                  setSearchParams({}, { replace: true });
                  setNewChatOpen(true);
                }}
              >
                Find someone else
              </Button>
            </div>
          </Card>
        ) : null}

        {identityError ? (
          <Card className="mb-4 border-[var(--color-warning)]/40">
            <div className="flex items-start gap-2.5 p-3.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
              <Lock size={15} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
              <p>{identityError}</p>
            </div>
          </Card>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[350px_minmax(0,1fr)]">
          {/* ---------------------------------- list ---------------------------------- */}
          <aside className={`space-y-3 ${conversationId ? 'hidden lg:block' : ''}`}>
            <div className="flex items-center gap-2 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
              <Search size={15} className="shrink-0 text-[var(--color-muted)]" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search people…"
                aria-label="Search conversations"
                className="min-h-[40px] min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-[var(--color-muted-dim)]"
              />
            </div>

            <VroqnTabs
              label="Conversation filter"
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'all', label: 'All', count: conversations.length },
                { value: 'unread', label: 'Unread', count: conversations.filter((c) => c.unread > 0).length },
                { value: 'muted', label: 'Muted', count: conversations.filter((c) => c.isMuted).length },
                { value: 'blocked', label: 'Blocked', count: conversations.filter((c) => c.blocked).length },
              ]}
            />

            {loading && !conversations.length ? (
              <div className="space-y-2">
                {[0, 1, 2].map((key) => (
                  <Skeleton key={key} className="h-16 w-full" rounded="lg" />
                ))}
              </div>
            ) : error ? (
              <ErrorState message={error} onRetry={() => void reload()} />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={<MessageSquarePlus size={18} />}
                title={conversations.length ? 'Nothing in this filter' : 'No conversations yet'}
                description={
                  conversations.length
                    ? 'Try the All tab, or clear the search box.'
                    : 'Start with someone from your community, or search for a classmate by name.'
                }
                action={
                  <Button size="sm" icon={<Search size={14} />} onClick={() => setNewChatOpen(true)}>
                    Find someone
                  </Button>
                }
              />
            ) : (
              <ul className="space-y-1.5">
                {filtered.map((conversation) => (
                  <ConversationRow
                    key={conversation.id}
                    conversation={conversation}
                    active={conversation.id === conversationId}
                    onOpen={() => navigate(`/messages/${conversation.id}`)}
                  />
                ))}
              </ul>
            )}
          </aside>

          {/* --------------------------------- thread --------------------------------- */}
          <section className={`min-w-0 ${conversationId ? '' : 'hidden lg:block'}`}>
            {conversationId ? (
              <Thread
                conversationId={conversationId}
                conversation={active}
                identity={identity}
                identityReady={identityReady}
                selfUserId={user?.id ?? null}
                firstContact={firstContact}
                onChanged={() => void reload()}
                onBack={() => navigate('/messages')}
                onSafety={loadSafety}
                notify={(tone, title, detail) => toast.push({ tone, title, detail })}
              />
            ) : (
              <Card className="grid h-full min-h-[320px] place-items-center p-6 text-center">
                <div className="max-w-sm space-y-2">
                  <Lock size={20} className="mx-auto text-[var(--color-primary)]" />
                  <p className="text-[13.5px] font-medium">Pick a conversation</p>
                  <p className="text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                    Messages are only readable on a device that has the conversation key. This device's key is created here
                    in your browser and never sent to the server.
                  </p>
                </div>
              </Card>
            )}
          </section>
        </div>
      </PageBody>

      <NewConversationSheet
        open={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        onOpen={(id) => {
          setNewChatOpen(false);
          void reload();
          navigate(`/messages/${id}`);
        }}
      />

      <SafetySheet
        open={safetyOpen}
        onClose={() => setSafetyOpen(false)}
        conversations={conversations}
        blocked={blocked}
        reports={reports}
        onChanged={() => {
          void loadSafety();
          void reload();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ list row --------------------- */

function ConversationRow({
  conversation,
  active,
  onOpen,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onOpen: () => void;
}) {
  const other = conversation.other;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        className={[
          'vroqn-tap flex w-full items-center gap-3 rounded-[12px] border px-3 py-2.5 text-left transition-colors',
          active
            ? 'border-[var(--color-primary)]/40 bg-[var(--color-primary)]/[0.07]'
            : 'border-[var(--color-border)] bg-[var(--color-card)] hover:border-[var(--color-border-strong)]',
        ].join(' ')}
      >
        <VroqnAvatar name={other?.name ?? 'Student'} src={other?.avatarUrl} accent={other?.accent} size="md" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13.5px] font-medium">{other?.name ?? 'Unknown student'}</span>
            {conversation.isMuted ? <BellOff size={12} className="shrink-0 text-[var(--color-muted-dim)]" /> : null}
          </span>
          <span className="mt-0.5 block truncate text-[11.5px] text-[var(--color-muted)]">
            {conversation.lastMessage
              ? conversation.lastMessage.isDeleted
                ? 'Message deleted'
                : conversation.needsKey
                  ? 'Encrypted — open to read'
                  : 'Encrypted message'
              : 'No messages yet'}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[11px] text-[var(--color-muted-dim)]">
            {timeAgo(conversation.lastMessageAt ?? conversation.createdAt)}
          </span>
          {conversation.unread > 0 ? (
            <span className="rounded-full bg-[var(--color-primary)] px-1.5 text-[11px] font-semibold text-black">
              {conversation.unread}
            </span>
          ) : null}
          {conversation.blocked ? <Badge tone="muted">Blocked</Badge> : null}
        </span>
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------ thread ---------------------- */

function Thread({
  conversationId,
  conversation,
  identity,
  identityReady,
  selfUserId,
  onChanged,
  onBack,
  onSafety,
  notify,
  firstContact = false,
}: {
  conversationId: string;
  conversation: ConversationSummary | null;
  identity: ReturnType<typeof useDeviceIdentity>['identity'];
  identityReady: boolean;
  selfUserId: string | null;
  /**
   * True when the student arrived here by choosing someone to message (a search result, a profile).
   * The thread then prepares encryption itself instead of showing a "send keys" step.
   */
  firstContact?: boolean;
  onChanged: () => void;
  onBack: () => void;
  onSafety: () => Promise<void>;
  notify: (tone: 'success' | 'error' | 'info', title: string, detail?: string) => void;
}) {
  const { key, needsKey, loading: keyLoading, reload: reloadKey } = useConversationKeys(
    identity,
    conversationId,
    conversation?.keyVersion ?? 1,
  );
  const thread = useThread(identity, conversation, key, selfUserId);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [replyTo, setReplyTo] = useState<{ id: string; author: string; text: string } | null>(null);
  const [reportTarget, setReportTarget] = useState<{ id: string; label: string } | null>(null);
  const [sharing, setSharing] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void messagesApi.markRead(conversationId).catch(() => undefined);
    onChanged();
    // Marking read is part of opening a thread; re-running on every message would be noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.rows.length, thread.typingPeer]);

  /* First contact: the key owner distributes it so the other side can read their own messages. */
  const ensureKeys = useCallback(async () => {
    if (!identity || !conversation?.other) return;
    setSharing(true);
    try {
      await distributeConversationKey(identity, conversationId, conversation.other.userId, conversation.keyVersion);
      await reloadKey();
      notify('success', 'Encryption ready', 'This device can now read the conversation.');
    } catch (err) {
      notify('error', 'Could not set up encryption', (err as Error).message);
    } finally {
      setSharing(false);
    }
  }, [conversation, conversationId, identity, notify, reloadKey]);

  /*
   * Arriving from a search result: do the key work quietly, once, instead of showing a button that
   * says "set up encryption" to a student who just wanted to say hello. The manual path stays for the
   * normal case (opening an old thread on a new device), where the student should know a key is being
   * shared. Errors here are surfaced by `ensureKeys` itself and never block the composer.
   */
  const autoKeyDone = useRef(false);
  useEffect(() => {
    if (!firstContact || autoKeyDone.current) return;
    if (!identity || keyLoading || !needsKey || !conversation?.other) return;
    autoKeyDone.current = true;
    void (async () => {
      /*
       * The safety check that makes this automatic step safe.
       *
       * Creating a conversation key is only safe while no key has ever reached the other student: if
       * one has, making a second key would fork the conversation, and their messages would be readable
       * only with a key this device no longer holds. So we look at the envelopes and stop if any of
       * them belongs to somebody else.
       *
       * Envelopes addressed to *this user's other devices* are a different case and must not block the
       * flow: a student who signs in on a second phone and messages a classmate from search should get
       * a working composer, not a dead "send keys" step.
       */
      try {
        const { envelopes } = await messagesApi.envelopes(conversationId);
        const sharedWithAnyoneElse = envelopes.some(
          (envelope) => selfUserId && envelope.recipientUserId && envelope.recipientUserId !== selfUserId,
        );
        if (sharedWithAnyoneElse) return;
      } catch {
        return;
      }
      await ensureKeys();
    })();
  }, [conversation?.other, conversationId, ensureKeys, firstContact, identity, keyLoading, needsKey, selfUserId]);

  const send = useCallback(async () => {
    if (!key || !identity || !conversation) return;
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    try {
      const { encryptMessage } = await import('../../lib/crypto');
      const payload = await encryptMessage(key, conversationId, { text, replyToId: replyTo?.id ?? null });
      await messagesApi.send(conversationId, { ...payload, keyVersion: conversation.keyVersion, replyToId: replyTo?.id ?? null });
      setReplyTo(null);
      await thread.refreshNewest();
      onChanged();
    } catch (err) {
      setDraft(text); // never lose what the student typed
      notify('error', 'Message not sent', (err as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation, conversationId, draft, identity, key, notify, replyTo?.id]);

  const saveEdit = useCallback(async () => {
    if (!key || !editing) return;
    try {
      const { encryptMessage } = await import('../../lib/crypto');
      const payload = await encryptMessage(key, conversationId, { text: editing.text.trim() });
      await messagesApi.edit(editing.id, { ciphertext: payload.ciphertext, iv: payload.iv });
      setEditing(null);
      await thread.loadFirstPage();
    } catch (err) {
      notify('error', 'Could not save the edit', (err as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, editing, key, notify]);

  if (!conversation) {
    return (
      <Card className="grid min-h-[280px] place-items-center p-6">
        {identityReady ? <ErrorState message="That conversation could not be found." /> : <Spinner size={18} />}
      </Card>
    );
  }

  const other = conversation.other;

  // Built per render from the thread's own rows so a reaction change is reflected immediately.
  const rowsReactions = new Map(
    thread.rows.map((row) => {
      const counts = new Map<string, { emoji: string; count: number; mine: boolean }>();
      for (const reaction of row.message.reactions) {
        const entry = counts.get(reaction.reaction) ?? { emoji: reaction.reaction, count: 0, mine: false };
        entry.count += 1;
        if (reaction.userId === selfUserId) entry.mine = true;
        counts.set(reaction.reaction, entry);
      }
      return [row.message.id, [...counts.values()]];
    }),
  );
  const reactionsFor = (messageId: string) => rowsReactions.get(messageId) ?? [];

  return (
    <Card className="flex min-h-[70dvh] flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
        <VroqnIconButton label="Back to conversations" className="lg:hidden" onClick={onBack}>
          <ArrowLeft size={17} />
        </VroqnIconButton>
        {other ? (
          <>
            <VroqnAvatar
              name={other.name}
              src={other.avatarUrl}
              accent={other.accent}
              size="sm"
              status={thread.typingPeer ? 'typing' : null}
            />
            <div className="min-w-0 flex-1">
              <Link to={`/profile/${other.userId}`} className="block truncate text-[13.5px] font-semibold hover:text-[var(--color-primary)]">
                {other.name}
              </Link>
              <p className="truncate text-[11px] text-[var(--color-muted)]">
                {thread.typingPeer ? 'typing…' : other.username ? `@${other.username}` : 'Encrypted conversation'}
              </p>
            </div>
          </>
        ) : (
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold">Conversation</p>
          </div>
        )}
        <VroqnIconButton
          label={conversation.isMuted ? 'Unmute conversation' : 'Mute conversation'}
          onClick={async () => {
            await messagesApi.flags(conversationId, { muted: !conversation.isMuted });
            onChanged();
          }}
        >
          <BellOff size={16} className={conversation.isMuted ? 'text-[var(--color-primary)]' : ''} />
        </VroqnIconButton>
        <VroqnIconButton label="Report or block this student" onClick={() => setReportTarget({ id: other?.userId ?? '', label: other?.name ?? 'This student' })}>
          <Flag size={16} />
        </VroqnIconButton>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-4">
        <p className="flex items-center justify-center gap-1.5 text-center text-[11.5px] text-[var(--color-muted-dim)]">
          <Lock size={12} /> Messages are encrypted on your device. Only conversation participants can read them.
        </p>

        {thread.hasMore ? (
          <div className="text-center">
            <Button size="sm" variant="ghost" onClick={() => void thread.loadOlder()} disabled={thread.loadingOlder}>
              {thread.loadingOlder ? 'Loading…' : 'Load older messages'}
            </Button>
          </div>
        ) : null}

        {needsKey && !keyLoading ? (
          <Card className="border-[var(--color-warning)]/40 p-3.5">
            <div className="space-y-2.5">
              <p className="text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                This device does not have the conversation key yet, so older messages cannot be read here. Sharing the key
                lets this device read the thread; it is still never sent to the server as plaintext.
              </p>
              <Button size="sm" variant="secondary" disabled={sharing || !identity} onClick={() => void ensureKeys()}>
                {sharing ? 'Setting up…' : 'Send keys to this device'}
              </Button>
            </div>
          </Card>
        ) : null}

        {thread.error ? <ErrorState message={thread.error} onRetry={() => void thread.loadFirstPage()} /> : null}

        {thread.loading && !thread.rows.length ? (
          <div className="space-y-3">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className={index % 2 ? 'ml-auto h-12 w-2/3' : 'h-12 w-3/5'} rounded="lg" />
            ))}
          </div>
        ) : null}

        {!thread.loading && !thread.rows.length ? (
          <EmptyState
            icon={<Lock size={18} />}
            title="No messages yet"
            description="Say hello. Only the two of you can read this conversation."
          />
        ) : null}

        {thread.rows.map((row) => {
          const message = row.message;
          return (
            <VroqnChatBubble
              key={message.id}
              mine={message.senderId === selfUserId}
              author={other?.name}
              avatar={<VroqnAvatar name={other?.name ?? 'Student'} src={other?.avatarUrl} accent={other?.accent} size="xs" />}
              text={row.text}
              unreadable={row.unreadable}
              state={message.deletedAt ? 'deleted' : message.editedAt ? 'edited' : 'sent'}
              time={new Date(message.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              reactions={reactionsFor(message.id)}
              onReact={
                row.unreadable || message.deletedAt
                  ? undefined
                  : async (emoji) => {
                      await messagesApi.react(message.id, emoji).catch(() => undefined);
                      await thread.refreshNewest();
                    }
              }
              onReply={
                row.unreadable || message.deletedAt
                  ? undefined
                  : () => setReplyTo({ id: message.id, author: message.senderId === selfUserId ? 'You' : (other?.name ?? 'They'), text: row.text ?? '' })
              }
              onEdit={
                message.senderId === selfUserId && !message.deletedAt && !row.unreadable
                  ? () => setEditing({ id: message.id, text: row.text ?? '' })
                  : undefined
              }
              onDelete={
                message.senderId === selfUserId && !message.deletedAt
                  ? async () => {
                      await messagesApi.remove(message.id).catch((err: Error) => notify('error', 'Could not delete', err.message));
                      await thread.loadFirstPage();
                    }
                  : undefined
              }
              onReport={message.senderId === selfUserId ? undefined : () => setReportTarget({ id: message.senderId, label: other?.name ?? 'This student' })}
              onBlock={
                message.senderId === selfUserId
                  ? undefined
                  : async () => {
                      await messagesApi.block(message.senderId).catch(() => undefined);
                      notify('info', 'Blocked', 'They can no longer send you messages. You can unblock from Safety.');
                      onChanged();
                      await onSafety();
                    }
              }
            />
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-[var(--color-border)] px-3 py-3">
        {conversation.canSend ? (
          <VroqnMessageComposer
            value={editing ? editing.text : draft}
            onChange={(value) => (editing ? setEditing({ ...editing, text: value }) : setDraft(value))}
            onSend={() => (editing ? void saveEdit() : void send())}
            onTyping={thread.notifyTyping}
            disabled={!key}
            disabledReason={
              key
                ? editing
                  ? 'Editing — press Enter to save, Escape to cancel'
                  : null
                : identityReady
                  ? 'Setting up encryption for this conversation…'
                  : 'Waiting for your device key…'
            }
            extra={
              editing ? (
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              ) : replyTo ? (
                <Button size="sm" variant="ghost" onClick={() => setReplyTo(null)}>
                  Cancel reply
                </Button>
              ) : null
            }
          />
        ) : (
          <div className="rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-[12.5px] text-[var(--color-muted)]">
            {conversation.canSendReason ?? 'You cannot send messages in this conversation.'}
          </div>
        )}
      </div>

      <ReportSheet
        target={reportTarget}
        conversationId={conversationId}
        onClose={() => setReportTarget(null)}
        onDone={async () => {
          await onSafety();
          notify('success', 'Report sent', 'Our team reviews safety reports. Blocking is immediate.');
        }}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ sheets ---------------------- */

function NewConversationSheet({
  open,
  onClose,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  onOpen: (conversationId: string) => void;
}) {
  const toast = useToast();
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term, 300);
  const [people, setPeople] = useState<PersonCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const result = await profileApi.people(debounced);
        if (!cancelled) {
          setPeople(result.people);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debounced, open]);

  const start = async (person: PersonCard) => {
    setBusy(person.userId);
    try {
      const result = await messagesApi.open(person.userId);
      onOpen(result.conversationId);
    } catch (err) {
      toast.push({ tone: 'error', title: 'Cannot start that conversation', detail: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <VroqnSheet
      open={open}
      onClose={onClose}
      title="New message"
      description="Search by name or @username. You can only message students who have not restricted their inbox."
      size="sm"
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
          <Search size={15} className="shrink-0 text-[var(--color-muted)]" />
          <input
            autoFocus
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Name or @username"
            aria-label="Search students"
            className="min-h-[40px] min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-[var(--color-muted-dim)]"
          />
        </div>

        {error ? <ErrorState message={error} /> : null}
        {loading && !people.length ? <Skeleton className="h-14 w-full" rounded="lg" /> : null}

        {!loading && !people.length ? (
          <p className="px-1 py-6 text-center text-[13px] text-[var(--color-muted)]">
            {term ? 'No student matches that search.' : 'Start typing to find a classmate.'}
          </p>
        ) : null}

        <ul className="space-y-1">
          {people.map((person) => (
            <li key={person.userId}>
              <button
                type="button"
                disabled={busy === person.userId}
                onClick={() => void start(person)}
                className="vroqn-tap flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors hover:bg-white/5 disabled:opacity-60"
              >
                <VroqnAvatar name={person.name} src={person.avatarUrl} accent={person.accent} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{person.name}</span>
                  <span className="block truncate text-[11.5px] text-[var(--color-muted)]">
                    {person.username ? `@${person.username}` : person.classLevel ? `Class ${person.classLevel}` : 'Student'}
                  </span>
                </span>
                {busy === person.userId ? <Spinner size={14} /> : <BadgeCheck size={15} className="text-[var(--color-muted-dim)]" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </VroqnSheet>
  );
}

function ReportSheet({
  target,
  conversationId,
  onClose,
  onDone,
}: {
  target: { id: string; label: string } | null;
  conversationId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('spam');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!target?.id) return;
    setBusy(true);
    try {
      await messagesApi.report({ conversationId, targetUserId: target.id, reason, note: note || undefined });
      setNote('');
      onClose();
      await onDone();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Report failed', detail: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <VroqnSheet
      open={Boolean(target)}
      onClose={onClose}
      title={`Report ${target?.label ?? 'student'}`}
      description="Reports go to the platform safety team, never to community moderators. The conversation itself stays encrypted — we can only see that a report was filed."
      size="sm"
      footer={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Sending…' : 'Submit report'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<UserMinus size={14} />}
            onClick={async () => {
              if (!target?.id) return;
              await messagesApi.block(target.id).catch(() => undefined);
              toast.push({ tone: 'info', title: 'Blocked', detail: 'You can unblock from the Safety panel.' });
              onClose();
              await onDone();
            }}
          >
            Block instead
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Reason">
          <Segmented
            label="Report reason"
            value={reason}
            onChange={setReason}
            options={[
              { value: 'spam', label: 'Spam' },
              { value: 'harassment', label: 'Harassment' },
              { value: 'unsafe', label: 'Unsafe' },
              { value: 'other', label: 'Other' },
            ]}
          />
        </Field>
        <Field label="Anything else (optional)" hint="Written by you — the encrypted messages themselves are not readable by us.">
          <TextArea rows={3} maxLength={400} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
    </VroqnSheet>
  );
}

function SafetySheet({
  open,
  onClose,
  conversations,
  blocked,
  reports,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  conversations: ConversationSummary[];
  blocked: { userId: string; name: string; blockedAt: string }[];
  reports: DmReport[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [policy, setPolicy] = useState<DmPolicy>('communities');
  const [savingPolicy, setSavingPolicy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void profileApi
      .me()
      .then((profile) => setPolicy(profile.visibility.dmPolicy))
      .catch(() => undefined);
  }, [open]);

  const savePolicy = async (next: DmPolicy) => {
    setPolicy(next);
    setSavingPolicy(true);
    try {
      await messagesApi.setPolicy(next);
      toast.push({ tone: 'success', title: 'Who can message you updated' });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Could not save that', detail: (err as Error).message });
    } finally {
      setSavingPolicy(false);
    }
  };

  const muted = conversations.filter((conversation) => conversation.isMuted);

  return (
    <VroqnSheet open={open} onClose={onClose} title="Safety and controls" description="Everything that decides who reaches you, in one place." size="md">
      <div className="space-y-5">
        <VroqnSection title="Who can start a conversation with you" description="Changing this never deletes an existing conversation — it only affects new ones.">
          <Segmented
            label="Direct message policy"
            value={policy}
            onChange={(value) => void savePolicy(value)}
            options={[
              { value: 'everyone', label: 'Everyone', hint: 'Any student you can find' },
              { value: 'communities', label: 'My communities', hint: 'Only students in a community you joined' },
              { value: 'nobody', label: 'Nobody', hint: 'Existing conversations continue' },
            ]}
          />
          {savingPolicy ? <p className="px-1 text-[11.5px] text-[var(--color-muted)]">Saving…</p> : null}
        </VroqnSection>

        <VroqnSection title="Muted conversations" description="Muted threads keep their messages; they just do not interrupt you.">
          {muted.length ? (
            <ul className="space-y-1.5">
              {muted.map((conversation) => (
                <li key={conversation.id} className="flex items-center justify-between gap-3 rounded-[10px] border border-[var(--color-border)] px-3 py-2">
                  <span className="truncate text-[13px]">{conversation.other?.name ?? 'Conversation'}</span>
                  <Button size="sm" variant="ghost" onClick={async () => {
                    await messagesApi.flags(conversation.id, { muted: false });
                    onChanged();
                  }}>
                    Unmute
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-[var(--color-muted)]">No muted conversations.</p>
          )}
        </VroqnSection>

        <VroqnSection title="Blocked students" description="Blocking stops messages in both directions immediately. Your old messages stay where they are.">
          {blocked.length ? (
            <ul className="space-y-1.5">
              {blocked.map((person) => (
                <li key={person.userId} className="flex items-center justify-between gap-3 rounded-[10px] border border-[var(--color-border)] px-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px]">{person.name}</span>
                    <span className="block text-[11px] text-[var(--color-muted-dim)]">Blocked {timeAgo(person.blockedAt)}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await messagesApi.unblock(person.userId);
                      onChanged();
                    }}
                  >
                    Unblock
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-[var(--color-muted)]">You have not blocked anyone.</p>
          )}
        </VroqnSection>

        <VroqnSection title="Reports you filed" description="You can always see what happened to a report you sent.">
          {reports.length ? (
            <ul className="space-y-1.5">
              {reports.map((report) => (
                <li key={report.id} className="rounded-[10px] border border-[var(--color-border)] px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={report.status === 'open' ? 'warning' : report.status === 'dismissed' ? 'muted' : 'success'}>
                      {report.status}
                    </Badge>
                    <span className="text-[12.5px] font-medium capitalize">{report.reason}</span>
                    <span className="text-[11px] text-[var(--color-muted-dim)]">{timeAgo(report.createdAt)}</span>
                  </div>
                  {report.note ? <p className="mt-1 text-[12px] text-[var(--color-muted)]">{report.note}</p> : null}
                  {report.actionTaken ? <p className="mt-1 text-[12px] text-[var(--color-muted)]">Action: {report.actionTaken}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-[var(--color-muted)]">You have not filed any reports.</p>
          )}
        </VroqnSection>

        <VroqnSection title="What the server can see" description="Stated plainly, because a security claim is only worth what it actually delivers.">
          <ul className="space-y-1.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
            <li>· Message text, sent and received, is stored only as ciphertext.</li>
            <li>· The server can see who is in a conversation, when messages were sent and how many there are.</li>
            <li>· Private messages are never used for AI, analytics or search.</li>
            <li>· This is not yet "verified" encryption: there is no safety-number comparison between students, so a compromised device remains a risk.</li>
          </ul>
        </VroqnSection>
      </div>
    </VroqnSheet>
  );
}
