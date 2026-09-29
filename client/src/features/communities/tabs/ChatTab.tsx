/**
 * Community chat (§6, §7).
 *
 * Design decisions worth knowing:
 *  - **Paged both ways.** The newest 40 messages load first; "Load older" walks backwards with the
 *    cursor the server returns and live updates arrive over SSE. A busy community never downloads
 *    thousands of messages to show one screen (§54).
 *  - **Server truth.** Sending returns the stored message, editing returns the canonical row, and a
 *    reaction toggle returns the new tally. Nothing is rendered from an optimistic guess that could
 *    disagree with what other members see.
 *  - **Moderation is visible, not hidden.** A moderator's controls behind a menu, a report option on
 *    every message, and a pinned banner the whole community can see.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BellOff,
  Flag,
  MessageSquare,
  MoreHorizontal,
  Pin,
  Search,
  Smile,
  Trash2,
  VolumeX,
  X,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, Modal, Skeleton, TextInput } from '../../../components/ui';
import { VroqnFilterSelect } from '../../../components/vroqn';
import { useToast } from '../../../hooks/useToast';
import { postStream } from '../../../lib/api';
import { Composer, formatClock } from '../components';
import { communitiesApi, type ChatMessageView, type CommunityDetail, type PollView } from '../api';
import { errorMessage, useAction, useDebounced, useRemote } from '../useCommunities';

const REACTIONS = ['👍', '🎯', '💡', '🔥', '🙏', '😂', '❤️', '✅'];

export function ChatTab({ community }: { community: CommunityDetail }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessageView | null>(null);
  const [editing, setEditing] = useState<ChatMessageView | null>(null);
  const [editValue, setEditValue] = useState('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 350);
  const [threadOpen, setThreadOpen] = useState<ChatMessageView | null>(null);
  const [reportTarget, setReportTarget] = useState<ChatMessageView | null>(null);
  const [reportReason, setReportReason] = useState('spam');
  const [reportDetails, setReportDetails] = useState('');
  const [pollOpen, setPollOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const canPost = community.myStatus === 'active';
  const isMuted = community.myStatus === 'muted';
  const canAnnounce = Boolean(community.capabilities.create_announcement);

  const polls = useRemote<{ polls: PollView[] }>(`/communities/${community.id}/polls`);

  const loadNewest = useCallback(async () => {
    setInitialLoading(true);
    try {
      const page = await communitiesApi.messages(community.id, { limit: 40 });
      setMessages(page.messages);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Could not load the chat.'));
    } finally {
      setInitialLoading(false);
    }
  }, [community.id]);

  useEffect(() => {
    void loadNewest();
  }, [loadNewest]);

  useEffect(() => {
    if (!debouncedSearch.trim()) return;
    if (debouncedSearch.trim().length < 2) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await communitiesApi.messages(community.id, { search: debouncedSearch.trim(), limit: 40 });
        if (!cancelled) {
          setMessages(page.messages);
          setHasMore(false);
          setCursor(null);
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, community.id]);

  const loadOlder = async () => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await communitiesApi.messages(community.id, { before: cursor, limit: 40 });
      setMessages((current) => {
        const seen = new Set(current.map((message) => message.id));
        return [...page.messages.filter((message) => !seen.has(message.id)), ...current];
      });
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (err) {
      toast.push({ tone: 'error', title: 'Could not load older messages', detail: errorMessage(err) });
    } finally {
      setLoadingOlder(false);
    }
  };

  /** Live updates: a stream of events about a community the caller is already a member of. */
  useEffect(() => {
    const stream = postStream(`/communities/${community.id}/stream`, {}, {
      onEvent: (event, data) => {
        if (event !== 'community') return;
        const payload = data as { type?: string };
        if (!payload?.type) return;
        if (['message', 'message_updated', 'message_deleted', 'reaction'].includes(payload.type)) {
          void (async () => {
            try {
              const page = await communitiesApi.messages(community.id, { limit: 40 });
              setMessages((current) => {
                // Keep anything the student already scrolled back to, plus the fresh window.
                const older = current.filter((message) => new Date(message.createdAt) < new Date(page.messages[0]?.createdAt ?? 0));
                const fresh = new Map(page.messages.map((message) => [message.id, message]));
                return [...older, ...fresh.values()].sort(
                  (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
                );
              });
            } catch {
              /* a dropped refresh is harmless; the next event or manual reload catches up */
            }
          })();
        }
        if (payload.type === 'poll') void polls.refresh();
      },
      onError: () => {
        /* Live updates are a bonus: if the stream drops, reading and posting still work. */
      },
    });
    return () => stream.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community.id]);

  const send = async (body: string) => {
    const created = await run(
      () => communitiesApi.sendMessage(community.id, { body, parentId: replyTo?.id ?? null }),
      { failure: 'Your message was not sent' },
    );
    if (created) {
      setMessages((current) => [...current, created]);
      setReplyTo(null);
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const updated = await run(() => communitiesApi.editMessage(community.id, editing.id, editValue), {
      failure: 'Could not save the edit',
    });
    if (updated) {
      setMessages((current) => current.map((message) => (message.id === updated.id ? updated : message)));
      setEditing(null);
      toast.push({ tone: 'success', title: 'Message updated' });
    }
  };

  const remove = async (message: ChatMessageView) => {
    const done = await run(() => communitiesApi.deleteMessage(community.id, message.id), {
      success: 'Message deleted',
      failure: 'Could not delete that message',
    });
    if (done) setMessages((current) => current.filter((entry) => entry.id !== message.id));
  };

  const pin = async (message: ChatMessageView) => {
    const result = await run(() => communitiesApi.pinMessage(community.id, message.id), {
      failure: 'Could not pin that message',
    });
    if (result) {
      setMessages((current) =>
        current.map((entry) => (entry.id === message.id ? { ...entry, isPinned: result.isPinned } : entry)),
      );
      toast.push({ tone: 'success', title: result.isPinned ? 'Pinned for everyone' : 'Unpinned' });
    }
  };

  const react = async (message: ChatMessageView, emoji: string) => {
    const result = await run(() => communitiesApi.react(community.id, message.id, emoji), {
      failure: 'Could not add that reaction',
    });
    if (result) {
      setMessages((current) =>
        current.map((entry) => (entry.id === message.id ? { ...entry, reactions: result.reactions } : entry)),
      );
    }
  };

  const submitReport = async () => {
    if (!reportTarget) return;
    const result = await run(
      () =>
        communitiesApi.report(community.id, {
          targetType: 'message',
          targetId: reportTarget.id,
          reason: reportReason,
          details: reportDetails.trim(),
        }),
      { success: 'Report sent to the moderators', failure: 'Could not send the report' },
    );
    if (result) {
      setReportTarget(null);
      setReportDetails('');
    }
  };

  const vote = async (poll: PollView, optionId: string) => {
    const updated = await run(() => communitiesApi.vote(community.id, poll.id, [optionId]), {
      failure: 'Could not record your vote',
    });
    if (updated) {
      void polls.set({ polls: (polls.data?.polls ?? []).map((entry) => (entry.id === updated.id ? updated : entry)) });
    }
  };

  const pinned = useMemo(() => messages.filter((message) => message.isPinned), [messages]);
  const threadReplies = useMemo(
    () => (threadOpen ? messages.filter((message) => message.parentId === threadOpen.id) : []),
    [messages, threadOpen],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted-dim)]" />
          <label className="sr-only" htmlFor="chat-search">
            Search this community's messages
          </label>
          <TextInput
            id="chat-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search messages…"
            className="pl-9"
          />
        </div>
        {search ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<X size={14} />}
            onClick={() => {
              setSearch('');
              void loadNewest();
            }}
          >
            Clear
          </Button>
        ) : null}
        {canAnnounce ? (
          <Button size="sm" variant="secondary" onClick={() => setPollOpen(true)}>
            New poll
          </Button>
        ) : null}
      </div>

      {pinned.length ? (
        <Card className="space-y-1.5 border-[var(--color-primary)]/30 bg-[var(--color-primary)]/[0.05] p-3">
          {pinned.slice(0, 2).map((message) => (
            <p key={message.id} className="text-[12.5px] text-[var(--color-muted)]">
              <Pin size={12} className="mr-1 inline text-[var(--color-primary)]" />
              <span className="font-medium text-[var(--color-text)]">{message.authorName}:</span> {message.body.slice(0, 160)}
            </p>
          ))}
        </Card>
      ) : null}

      {polls.data?.polls.length ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {polls.data.polls.slice(0, 2).map((poll) => (
            <Card key={poll.id} className="space-y-2 p-3">
              <p className="text-[13px] font-medium text-[var(--color-text)]">{poll.question}</p>
              <div className="space-y-1.5">
                {poll.options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    disabled={poll.isClosed}
                    onClick={() => void vote(poll, option.id)}
                    className={[
                      'w-full rounded-lg border px-2.5 py-2 text-left text-[12.5px] transition-colors',
                      option.mine
                        ? 'border-[var(--color-primary)]/50 bg-[var(--color-primary)]/10 text-[var(--color-text)]'
                        : 'border-[var(--color-border)] text-[var(--color-muted)] hover:bg-white/5',
                      poll.isClosed ? 'cursor-not-allowed opacity-70' : '',
                    ].join(' ')}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span>{option.label}</span>
                      <span className="text-[11.5px]">{option.percent}%</span>
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-[11.5px] text-[var(--color-muted-dim)]">
                {poll.totalVotes} {poll.totalVotes === 1 ? 'vote' : 'votes'}
                {poll.isClosed ? ' · closed' : ''}
                {poll.isAnonymous ? ' · anonymous' : ''}
              </p>
            </Card>
          ))}
        </div>
      ) : null}

      <Card className="flex h-[min(70vh,640px)] flex-col overflow-hidden p-0">
        <div className="flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
          {initialLoading ? (
            <div className="space-y-3">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="flex gap-3">
                  <Skeleton className="h-8 w-8" rounded="full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-4 w-3/4" />
                  </div>
                </div>
              ))}
            </div>
          ) : error ? (
            <ErrorState title="Chat could not load" message={error} onRetry={() => void loadNewest()} />
          ) : messages.length === 0 ? (
            <EmptyState
              icon={<MessageSquare size={22} />}
              title={search ? 'No messages match that search' : 'No messages yet'}
              description={
                search
                  ? 'Try a different word, or clear the search to see the conversation.'
                  : 'Say hello, or post the first question. Messages here are visible to community members only.'
              }
            />
          ) : (
            <>
              {hasMore ? (
                <div className="flex justify-center">
                  <Button size="sm" variant="ghost" loading={loadingOlder} onClick={loadOlder}>
                    Load older messages
                  </Button>
                </div>
              ) : (
                <p className="text-center text-[11.5px] text-[var(--color-muted-dim)]">That is the start of this community's chat.</p>
              )}

              {messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  isModerator={Boolean(community.capabilities.moderate_messages)}
                  onReply={() => setReplyTo(message)}
                  onEdit={() => {
                    setEditing(message);
                    setEditValue(message.body);
                  }}
                  onDelete={() => void remove(message)}
                  onPin={() => void pin(message)}
                  onReact={(emoji) => void react(message, emoji)}
                  onReport={() => {
                    setReportTarget(message);
                    setReportReason('spam');
                  }}
                  onOpenThread={() => setThreadOpen(message)}
                  threadCount={messages.filter((entry) => entry.parentId === message.id).length}
                />
              ))}
              <div ref={bottomRef} />
            </>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] p-3 sm:p-4">
          {!canPost && isMuted ? (
            <div className="flex items-center gap-2 rounded-xl border border-[var(--color-warning)]/35 bg-[var(--color-warning)]/[0.07] p-3 text-[12.5px] text-[#fcd28b]">
              <VolumeX size={15} />
              You are muted in this community. You can still read everything — a moderator will lift the mute.
            </div>
          ) : !canPost ? (
            <div className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[12.5px] text-[var(--color-muted)]">
              <BellOff size={15} /> You are not an active member of this community, so posting is off. Ask a moderator for help.
            </div>
          ) : (
            <>
              {replyTo ? (
                <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5">
                  <p className="min-w-0 truncate text-[11.5px] text-[var(--color-muted)]">
                    Replying to <span className="text-[var(--color-text)]">{replyTo.authorName}</span>: {replyTo.body.slice(0, 80)}
                  </p>
                  <button type="button" onClick={() => setReplyTo(null)} className="vroqn-tap text-[11.5px] text-[var(--color-muted-dim)] hover:text-[var(--color-text)]">
                    Cancel
                  </button>
                </div>
              ) : null}
              <Composer
                placeholder={`Message ${community.name}…`}
                submitLabel="Send"
                busy={busy}
                maxLength={4000}
                onSubmit={send}
              />
            </>
          )}
        </div>
      </Card>

      {/* Editing */}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title="Edit your message"
        description="Everyone in the community sees the edit. The original wording is not kept."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={saveEdit} disabled={!editValue.trim()}>
              Save
            </Button>
          </div>
        }
      >
        <label className="sr-only" htmlFor="edit-message">
          Message
        </label>
        <textarea
          id="edit-message"
          value={editValue}
          rows={4}
          onChange={(event) => setEditValue(event.target.value)}
          className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-[13px] text-[var(--color-text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
        />
      </Modal>

      {/* Thread */}
      <Modal
        open={Boolean(threadOpen)}
        onClose={() => setThreadOpen(null)}
        title={threadOpen ? `Replies to ${threadOpen.authorName}` : 'Replies'}
        description="A two-level thread: replies stay attached to the original message."
      >
        <div className="space-y-3">
          {threadOpen ? (
            <Card className="space-y-1 p-3">
              <p className="text-[12.5px] text-[var(--color-text)]">{threadOpen.body}</p>
              <p className="text-[11.5px] text-[var(--color-muted-dim)]">
                {threadOpen.authorName} · {formatClock(threadOpen.createdAt)}
              </p>
            </Card>
          ) : null}
          {threadReplies.length === 0 ? (
            <p className="text-[12.5px] text-[var(--color-muted)]">No replies yet.</p>
          ) : (
            threadReplies.map((reply) => (
              <MessageRow
                key={reply.id}
                message={reply}
                compact
                isModerator={Boolean(community.capabilities.moderate_messages)}
                onReply={() => setReplyTo(reply)}
                onEdit={() => {
                  setEditing(reply);
                  setEditValue(reply.body);
                }}
                onDelete={() => void remove(reply)}
                onPin={() => void pin(reply)}
                onReact={(emoji) => void react(reply, emoji)}
                onReport={() => setReportTarget(reply)}
                onOpenThread={() => undefined}
                threadCount={0}
              />
            ))
          )}
        </div>
      </Modal>

      {/* Report */}
      <Modal
        open={Boolean(reportTarget)}
        onClose={() => setReportTarget(null)}
        title="Report this message"
        description="Only the community's moderators see reports. The person you report is not told who reported them."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setReportTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={submitReport}
              disabled={!reportReason}
            >
              Send report
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <span className="block text-[12.5px] text-[var(--color-muted)]">What is wrong with it?</span>
          <VroqnFilterSelect
            label="Report reason"
            value={reportReason}
            onChange={setReportReason}
            placeholder="Choose a reason"
            options={[
              { value: 'spam', label: 'Spam or advertising' },
              { value: 'harassment', label: 'Harassment or bullying' },
              { value: 'inappropriate', label: 'Inappropriate content' },
              { value: 'cheating', label: 'Cheating or leaked answers' },
              { value: 'misleading', label: 'Wrong or misleading information' },
              { value: 'privacy', label: "Shares someone's personal information" },
              { value: 'other', label: 'Something else' },
            ]}
          />
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="report-details">
            Anything the moderators should know (optional)
          </label>
          <textarea
            id="report-details"
            value={reportDetails}
            rows={3}
            onChange={(event) => setReportDetails(event.target.value)}
            maxLength={600}
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-[13px] text-[var(--color-text)]"
          />
        </div>
      </Modal>

      {/* Poll */}
      <PollComposer
        open={pollOpen}
        busy={busy}
        onClose={() => setPollOpen(false)}
        onCreate={async (payload) => {
          const created = await run(() => communitiesApi.createPoll(community.id, payload), {
            success: 'Poll posted',
            failure: 'Could not create the poll',
          });
          if (created) {
            setPollOpen(false);
            void polls.refresh();
          }
        }}
      />
    </div>
  );
}

function MessageRow({
  message,
  isModerator,
  onReply,
  onEdit,
  onDelete,
  onPin,
  onReact,
  onReport,
  onOpenThread,
  threadCount,
  compact,
}: {
  message: ChatMessageView;
  isModerator: boolean;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPin: () => void;
  onReact: (emoji: string) => void;
  onReport: () => void;
  onOpenThread: () => void;
  threadCount: number;
  compact?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  if (message.isDeleted) {
    return (
      <p className="px-1 text-[12px] italic text-[var(--color-muted-dim)]">
        {message.deletedByModerator ? 'A moderator removed a message here.' : 'This message was deleted.'}
      </p>
    );
  }

  return (
    <article
      className={[
        'group rounded-xl border border-transparent px-2 py-1.5 transition-colors hover:border-[var(--color-border)] hover:bg-white/[0.02]',
        message.isPinned ? 'border-[var(--color-primary)]/25 bg-[var(--color-primary)]/[0.04]' : '',
        compact ? 'text-[12.5px]' : '',
      ].join(' ')}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[11.5px] font-medium text-[var(--color-muted)]"
        >
          {message.authorName.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] font-semibold text-[var(--color-text)]">{message.authorName}</span>
            {message.authorRole !== 'member' ? <Badge tone="muted">{message.authorRole}</Badge> : null}
            <time className="text-[11px] text-[var(--color-muted-dim)]" dateTime={message.createdAt}>
              {formatClock(message.createdAt)}
            </time>
            {message.editedAt ? <span className="text-[11px] text-[var(--color-muted-dim)]">· edited</span> : null}
            {message.isPinned ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-primary)]">
                <Pin size={10} /> pinned
              </span>
            ) : null}
          </div>

          {message.parentPreview ? (
            <p className="mt-1 border-l-2 border-[var(--color-border)] pl-2 text-[11.5px] text-[var(--color-muted-dim)]">
              {message.parentPreview}
            </p>
          ) : null}

          <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--color-text)]">
            {message.body}
          </p>

          {message.attachment ? (
            <div className="mt-1.5">
              <Badge tone="primary">
                {message.attachment.kind === 'doubt'
                  ? '❓ Doubt'
                  : message.attachment.kind === 'resource'
                    ? '📎 Resource'
                    : message.attachment.kind === 'competition'
                      ? '🏆 Competition'
                      : '📝 Note'}
                : {message.attachment.title}
              </Badge>
            </div>
          ) : null}

          {message.reactions.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {message.reactions.map((reaction) => (
                <button
                  key={reaction.emoji}
                  type="button"
                  onClick={() => onReact(reaction.emoji)}
                  aria-pressed={reaction.mine}
                  className={[
                    'vroqn-tap rounded-full border px-2 py-0.5 text-[11.5px]',
                    reaction.mine
                      ? 'border-[var(--color-primary)]/45 bg-[var(--color-primary)]/10 text-[var(--color-text)]'
                      : 'border-[var(--color-border)] text-[var(--color-muted)] hover:bg-white/5',
                  ].join(' ')}
                >
                  {reaction.emoji} {reaction.count}
                </button>
              ))}
            </div>
          ) : null}

          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--color-muted-dim)]">
            <button type="button" onClick={onReply} className="vroqn-tap hover:text-[var(--color-text)]">
              Reply
            </button>
            {threadCount > 0 ? (
              <button type="button" onClick={onOpenThread} className="vroqn-tap text-[var(--color-primary)] hover:underline">
                {threadCount} {threadCount === 1 ? 'reply' : 'replies'}
              </button>
            ) : null}
            <div className="relative">
              <button
                type="button"
                onClick={() => setPickerOpen((current) => !current)}
                aria-expanded={pickerOpen}
                aria-label="Add a reaction"
                className="vroqn-tap inline-flex items-center hover:text-[var(--color-text)]"
              >
                <Smile size={13} />
              </button>
              {pickerOpen ? (
                <div className="absolute left-0 top-6 z-20 flex gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-1.5 shadow-[var(--shadow-card)]">
                  {REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => {
                        onReact(emoji);
                        setPickerOpen(false);
                      }}
                      className="vroqn-tap rounded-lg px-1.5 py-1 text-[14px] hover:bg-white/5"
                      aria-label={`React ${emoji}`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {message.isMine ? (
              <button type="button" onClick={onEdit} className="vroqn-tap hover:text-[var(--color-text)]">
                Edit
              </button>
            ) : null}
            {message.canDelete ? (
              <button
                type="button"
                onClick={onDelete}
                className="vroqn-tap inline-flex items-center gap-1 hover:text-[var(--color-error)]"
              >
                <Trash2 size={12} /> Delete
              </button>
            ) : null}
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((current) => !current)}
                aria-expanded={menuOpen}
                aria-label="More options"
                className="vroqn-tap inline-flex items-center hover:text-[var(--color-text)]"
              >
                <MoreHorizontal size={13} />
              </button>
              {menuOpen ? (
                <div className="absolute left-0 top-6 z-20 w-44 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-1 shadow-[var(--shadow-card)]">
                  <button
                    type="button"
                    onClick={() => {
                      onReport();
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-[var(--color-muted)] hover:bg-white/5 hover:text-[var(--color-text)]"
                  >
                    <Flag size={13} /> Report
                  </button>
                  {isModerator ? (
                    <button
                      type="button"
                      onClick={() => {
                        onPin();
                        setMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-[var(--color-muted)] hover:bg-white/5 hover:text-[var(--color-text)]"
                    >
                      <Pin size={13} /> {message.isPinned ? 'Unpin' : 'Pin for everyone'}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function PollComposer({
  open,
  busy,
  onClose,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (payload: { question: string; options: string[]; multiple?: boolean; anonymous?: boolean }) => Promise<void>;
}) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuestion('');
      setOptions(['', '']);
      setMultiple(false);
      setAnonymous(false);
    }
  }, [open]);

  const valid = question.trim().length >= 3 && options.filter((option) => option.trim()).length >= 2;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Post a poll"
      description="Polls are for decisions the community needs to make together — the best time for a session, which topic to revise next."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid}
            onClick={() => void onCreate({ question: question.trim(), options: options.map((o) => o.trim()).filter(Boolean), multiple, anonymous })}
          >
            Post poll
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-[12.5px] text-[var(--color-muted)]" htmlFor="poll-question">
            Question
          </label>
          <TextInput id="poll-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Which topic should we revise on Sunday?" />
        </div>
        <div className="space-y-2">
          <p className="text-[12.5px] text-[var(--color-muted)]">Options (2–10)</p>
          {options.map((option, index) => (
            <div key={index} className="flex gap-2">
              <label className="sr-only" htmlFor={`poll-option-${index}`}>
                Option {index + 1}
              </label>
              <TextInput
                id={`poll-option-${index}`}
                value={option}
                onChange={(event) => setOptions((current) => current.map((value, i) => (i === index ? event.target.value : value)))}
                placeholder={`Option ${index + 1}`}
              />
              {options.length > 2 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOptions((current) => current.filter((_, i) => i !== index))}
                  aria-label={`Remove option ${index + 1}`}
                >
                  <X size={14} />
                </Button>
              ) : null}
            </div>
          ))}
          {options.length < 10 ? (
            <Button size="sm" variant="ghost" onClick={() => setOptions((current) => [...current, ''])}>
              Add option
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
            <input type="checkbox" checked={multiple} onChange={(event) => setMultiple(event.target.checked)} /> Allow multiple
            answers
          </label>
          <label className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
            <input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} /> Hide who voted
          </label>
        </div>
      </div>
    </Modal>
  );
}
