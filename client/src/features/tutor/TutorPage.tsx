/**
 * AI Tutor (spec §7) — the centre of the product.
 *
 * Text questions, structured educational answers, quick actions (simpler / example / why /
 * test me), stop, regenerate, copy, save to notes, and a visible failover trace. Every answer
 * shows which connection produced it, and every failure offers a retry.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  BookOpen,
  Copy,
  Image as ImageIcon,
  Lightbulb,
  MessageSquarePlus,
  Paperclip,
  RefreshCw,
  ScanSearch,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, SampleNotice, Spinner } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { AnswerMeta, SlowHint, TraceStatus, traceEntryFromEvent, type TraceEntry } from '../../components/AITrace';
import { api, ApiError, postStream } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useSettings } from '../../hooks/useSettings';
import { useToast } from '../../hooks/useToast';
import { useAuth } from '../../hooks/useAuth';
import type { ChatMessageRecord, Conversation, MessageMeta, RouterEvent, VisualSuggestion } from '../../types';

const QUICK_ACTIONS = [
  { id: 'simpler', label: 'Simpler' },
  { id: 'example', label: 'Another example' },
  { id: 'why', label: 'Why does it work?' },
  { id: 'steps', label: 'Step by step' },
  { id: 'testme', label: 'Test me' },
  { id: 'practice', label: 'Make a practice set' },
] as const;

interface Attachment {
  mimeType: string;
  data: string;
  name: string;
}

interface StreamingState {
  text: string;
  trace: TraceEntry[];
  meta: MessageMeta | null;
  error: { message: string; hint?: string } | null;
}

const EMPTY_STREAM: StreamingState = { text: '', trace: [], meta: null, error: null };

export function TutorPage() {
  const { conversationId: routeId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { settings, hasAnyKey } = useSettings();
  const { push } = useToast();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(routeId ?? null);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);

  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [stream, setStream] = useState<StreamingState>(EMPTY_STREAM);
  const [followUps, setFollowUps] = useState<string[]>([]);

  const streamRef = useRef<{ cancel: () => void } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  /* ------------------------------ conversation ---------------------------- */

  const loadConversations = useCallback(async () => {
    try {
      const result = await api.get<{ conversations: Conversation[] }>('/tutor/conversations');
      setConversations(result.conversations);
    } catch {
      /* the thread itself surfaces errors; the list is non-critical */
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (!routeId) {
      setActiveId(null);
      setMessages([]);
      setFollowUps([]);
      return;
    }
    setActiveId(routeId);
    setLoadingThread(true);
    setThreadError(null);
    api
      .get<{ conversation: Conversation; messages: ChatMessageRecord[] }>(`/tutor/conversations/${routeId}`)
      .then((result) => {
        setMessages(result.messages);
        setFollowUps((result.messages[result.messages.length - 1]?.meta?.followUps ?? []) as string[]);
      })
      .catch((err) => setThreadError(err instanceof ApiError ? err.message : 'That conversation could not be loaded.'))
      .finally(() => setLoadingThread(false));
  }, [routeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, stream.text, streaming]);

  /* --------------------------------- sending ------------------------------ */

  const runStream = useCallback(
    (payload: Record<string, unknown>) => {
      setStreaming(true);
      setStream(EMPTY_STREAM);
      setFollowUps([]);

      const handle = postStream('/tutor/stream', payload, {
        onEvent: (event, data) => {
          switch (event) {
            case 'meta': {
              if (data?.conversationId && data.conversationId !== activeId) {
                setActiveId(data.conversationId);
                window.history.replaceState(null, '', `/tutor/${data.conversationId}`);
              }
              break;
            }
            case 'delta': {
              setStream((current) => ({ ...current, text: current.text + (data?.text ?? '') }));
              break;
            }
            case 'restart': {
              setStream((current) => ({ ...current, text: '' }));
              break;
            }
            case 'done': {
              setStream((current) => ({
                ...current,
                text: data?.text || current.text,
                meta: {
                  provider: data?.provider,
                  model: data?.model,
                  keyLabel: data?.keyLabel,
                  attempts: data?.attempts,
                  fellBack: data?.fellBack,
                  demo: data?.demo,
                  latencyMs: data?.latencyMs,
                },
              }));
              break;
            }
            case 'error': {
              setStream((current) => ({
                ...current,
                error: { message: data?.message ?? 'The AI connection failed.', hint: data?.hint },
              }));
              break;
            }
            case 'final': {
              if (data?.error) {
                setStream((current) => ({ ...current, error: { message: data.error.message } }));
                break;
              }
              if (data?.message) {
                setMessages((current) => [...current.filter((m) => !m.id.startsWith('tmp-')), data.message]);
                setFollowUps(Array.isArray(data.followUps) ? data.followUps : []);
              }
              break;
            }
            case 'attempt':
            case 'attempt_failed':
            case 'plan': {
              const entry = traceEntryFromEvent({ type: event, ...(data as object) } as RouterEvent);
              if (entry) setStream((current) => ({ ...current, trace: [...current.trace, entry] }));
              break;
            }
            default:
              break;
          }
        },
        onError: (err) => {
          setStream((current) => ({
            ...current,
            error: { message: err.message, hint: 'Check your connection — your question is saved.' },
          }));
        },
        onClose: () => {
          setStreaming(false);
          streamRef.current = null;
          void loadConversations();
        },
      });

      streamRef.current = handle;
    },
    [activeId, loadConversations],
  );

  const send = useCallback(
    (rawText: string, options: { quickAction?: string; regenerate?: boolean } = {}) => {
      const text = rawText.trim();
      if (!text || streaming) return;

      if (!options.regenerate) {
        const optimistic: ChatMessageRecord = {
          id: `tmp-${Date.now()}`,
          conversationId: activeId ?? 'new',
          role: 'user',
          content: text,
          meta: attachments.length ? { attachments: attachments.map((a) => a.name) } : null,
          createdAt: new Date().toISOString(),
        };
        setMessages((current) => [...current, optimistic]);
      }

      setInput('');
      runStream({
        conversationId: activeId ?? undefined,
        content: text,
        attachments: attachments.length ? attachments : undefined,
        quickAction: options.quickAction,
        subject: settings?.subjectDefaults.subject,
        regenerate: options.regenerate,
      });
      setAttachments([]);
    },
    [activeId, attachments, runStream, settings?.subjectDefaults.subject, streaming],
  );

  const stopGeneration = useCallback(() => {
    streamRef.current?.cancel();
    streamRef.current = null;
    setStreaming(false);
  }, []);

  const regenerate = useCallback(() => {
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    if (!lastUser) return;
    setMessages((current) => {
      const index = current.findIndex((message) => message.id === lastUser.id);
      return index === -1 ? current : current.slice(0, index);
    });
    send(lastUser.content, { regenerate: true });
  }, [messages, send]);

  /* --------------------------------- assets -------------------------------- */

  const attachFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const accepted: Attachment[] = [];
    for (const file of Array.from(files).slice(0, 2)) {
      if (!/^image\/(png|jpe?g|webp)$/.test(file.type) && file.type !== 'application/pdf') {
        push({ tone: 'warning', title: 'Unsupported file', detail: 'Attach a PNG/JPG image or a PDF.' });
        continue;
      }
      if (file.size > 4 * 1024 * 1024) {
        push({ tone: 'warning', title: 'File too large', detail: `${file.name} is over 4 MB. Try a smaller photo.` });
        continue;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('read failed'));
        reader.readAsDataURL(file);
      });
      accepted.push({ mimeType: file.type, data: dataUrl.split(',')[1] ?? '', name: file.name });
    }
    if (accepted.length) setAttachments((current) => [...current, ...accepted].slice(0, 3));
  };

  const saveAnswerToNotes = async (message: ChatMessageRecord) => {
    try {
      const result = await api.post<{ note: { id: string; title: string } }>(`/tutor/messages/${message.id}/save-to-notes`, {
        subject: settings?.subjectDefaults.subject,
      });
      push({
        tone: 'success',
        title: 'Saved to Notes',
        detail: `"${result.note.title}" is now in your Notes.`,
        action: { label: 'Open note', onClick: () => navigate(`/notes/${result.note.id}`) },
      });
    } catch (err) {
      push({
        tone: 'error',
        title: 'Could not save to notes',
        detail: err instanceof ApiError ? err.message : 'Please try again.',
      });
    }
  };

  const startPracticeFromAnswer = async (message: ChatMessageRecord) => {
    try {
      const result = await api.post<{ suggestion: { subject: string; chapter: string } }>('/tutor/practice-from-answer', {
        messageId: message.id,
      });
      const { subject, chapter } = result.suggestion;
      navigate(`/practice?subject=${encodeURIComponent(subject)}&chapter=${encodeURIComponent(chapter)}`);
    } catch {
      navigate('/practice');
    }
  };

  const deleteConversation = async (id: string) => {
    await api.del(`/tutor/conversations/${id}`).catch(() => undefined);
    setConversations((current) => current.filter((conversation) => conversation.id !== id));
    if (id === activeId) {
      setActiveId(null);
      setMessages([]);
      navigate('/tutor');
    }
  };

  const lastAssistant = useMemo(() => [...messages].reverse().find((message) => message.role === 'assistant'), [messages]);

  return (
    <div className="flex min-h-[calc(100dvh-56px)] lg:min-h-[100dvh]">
      {/* ---------------------------- conversation list ---------------------------- */}
      <aside className="hidden w-[268px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] xl:flex">
        <div className="flex items-center justify-between px-3 py-3">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">Chats</span>
          <Button
            size="sm"
            variant="secondary"
            icon={<MessageSquarePlus size={14} />}
            onClick={() => {
              setActiveId(null);
              setMessages([]);
              setFollowUps([]);
              navigate('/tutor');
            }}
          >
            New
          </Button>
        </div>
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          onSelect={(id) => navigate(`/tutor/${id}`)}
          onDelete={deleteConversation}
        />
      </aside>

      {/* --------------------------------- thread -------------------------------- */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5 sm:px-5">
          <Button size="sm" variant="ghost" className="xl:hidden" onClick={() => setHistoryOpen(true)}>
            Chats
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[14.5px] font-semibold">
              {conversations.find((conversation) => conversation.id === activeId)?.title ?? 'AI Tutor'}
            </h1>
            <p className="truncate text-[11.5px] text-[var(--color-muted)]">
              Explanations written at your level
            </p>
          </div>
          {hasAnyKey ? null : <Badge tone="warning">Sample mode</Badge>}
        </header>

        <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-5">
          <div className="mx-auto max-w-3xl space-y-4">
            {threadError ? <ErrorState message={threadError} onRetry={() => navigate(0)} /> : null}

            {loadingThread ? (
              <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--color-muted)]">
                <Spinner size={15} /> Loading conversation…
              </div>
            ) : null}

            {!loadingThread && !messages.length && !streaming ? (
              <EmptyState
                icon={<Sparkles size={18} />}
                title={`Namaste ${user?.name?.split(' ')[0] ?? 'there'} — what should we understand today?`}
                description="Ask a doubt in your own words, or photograph a question from your book. Answers arrive as Concept → Explanation → Example → Practice → Quick check."
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    {['Explain Newton’s third law with an example', 'Why is the sky blue?', 'Solve 3(x-2)=2x+5 step by step'].map((sample) => (
                      <button
                        key={sample}
                        type="button"
                        onClick={() => send(sample)}
                        className="vroqn-tap rounded-full border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-1.5 text-[12px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-primary)]/50 hover:text-[var(--color-text)]"
                      >
                        {sample}
                      </button>
                    ))}
                  </div>
                }
              />
            ) : null}

            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                isLast={message.id === lastAssistant?.id}
                onCopy={() => {
                  void navigator.clipboard?.writeText(message.content);
                  push({ tone: 'success', title: 'Copied', detail: 'Answer copied to clipboard.' });
                }}
                onSave={() => void saveAnswerToNotes(message)}

                onRegenerate={message.id === lastAssistant?.id ? regenerate : undefined}
                onPractice={() => void startPracticeFromAnswer(message)}
              />
            ))}

            {streaming ? (
              <div className="space-y-2.5">
                <TraceStatus entries={stream.trace} />
                {stream.text ? (
                  <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3.5">
                    <Markdown content={stream.text} />
                    <span className="ml-0.5 inline-block h-4 w-[3px] animate-blink bg-[var(--color-primary)] align-middle" />
                    <SlowHint active={streaming} message="Still working — some models take a little longer on long answers." />
                  </div>
                ) : (
                  <div className="flex items-center gap-2.5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3.5 text-[13px] text-[var(--color-muted)]">
                    <Spinner size={15} /> Thinking about your question…
                  </div>
                )}
                <Button size="sm" variant="secondary" icon={<Square size={13} />} onClick={stopGeneration}>
                  Stop
                </Button>
              </div>
            ) : null}

            {stream.error && !streaming ? (
              <div className="space-y-2.5">
                <ErrorState
                  title={stream.error.message.includes('blocked') ? 'Blocked by the provider' : 'All AI connections unavailable'}
                  message={stream.error.message}
                  hint={stream.error.hint}
                  onRetry={() => {
                    setStream(EMPTY_STREAM);
                    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
                    if (lastUser) send(lastUser.content, { regenerate: true });
                  }}
                  retryLabel="Retry now"
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={() => navigate('/settings')}>
                    Check AI connections
                  </Button>
                </div>
              </div>
            ) : null}

            {stream.text && !streaming && stream.meta ? (
              <AnswerMeta
                provider={stream.meta.provider}
                model={stream.meta.model}
                keyLabel={stream.meta.keyLabel}
                attempts={stream.meta.attempts}
                fellBack={stream.meta.fellBack}
                demo={stream.meta.demo}
                latencyMs={stream.meta.latencyMs}
                onRetry={regenerate}
              />
            ) : null}

            {followUps.length && !streaming ? (
              <div className="flex flex-wrap gap-2">
                <span className="py-1 text-[11.5px] text-[var(--color-muted-dim)]">Follow up:</span>
                {followUps.map((text) => (
                  <button
                    key={text}
                    type="button"
                    onClick={() => send(text)}
                    className="vroqn-tap rounded-full border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/[0.07] px-3 py-1.5 text-[12px] text-[var(--color-primary)] transition-colors hover:bg-[var(--color-primary)]/15"
                  >
                    {text}
                  </button>
                ))}
              </div>
            ) : null}

            {lastAssistant?.meta?.visuals?.length && !streaming ? (
              <VisualSuggestions visuals={lastAssistant.meta.visuals} />
            ) : null}

            <div ref={bottomRef} />
          </div>
        </div>

        {/* -------------------------------- composer ------------------------------- */}
        <div className="vroqn-glass sticky bottom-[64px] z-20 border-t border-[var(--color-border)] px-3 py-3 sm:px-5 lg:bottom-0">
          <div className="mx-auto max-w-3xl space-y-2.5">
            {attachments.length ? (
              <div className="flex flex-wrap gap-2">
                {attachments.map((attachment, index) => (
                  <span
                    key={`${attachment.name}-${index}`}
                    className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12px]"
                  >
                    <ImageIcon size={13} className="text-[var(--color-primary-soft)]" />
                    <span className="max-w-[160px] truncate">{attachment.name}</span>
                    <button
                      type="button"
                      onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                      aria-label={`Remove ${attachment.name}`}
                      className="text-[var(--color-muted-dim)] hover:text-[var(--color-error)]"
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}

            <div className="flex items-end gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2 focus-within:border-[var(--color-primary)]/45">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                multiple
                className="sr-only"
                onChange={(event) => void attachFiles(event.target.files)}
                aria-label="Attach a photo of a question"
              />
              <Button
                size="icon"
                variant="ghost"
                onClick={() => fileRef.current?.click()}
                aria-label="Attach a photo or PDF"
                title="Attach a photo of a question"
                disabled={streaming}
              >
                <Paperclip size={17} />
              </Button>
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    send(input);
                  }
                }}
                rows={1}
                placeholder="Ask anything — type your doubt here…"
                className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-1 py-2 text-[14px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-muted-dim)] focus:outline-none"
                aria-label="Your question"
              />
              {streaming ? (
                <Button size="icon" variant="danger" onClick={stopGeneration} aria-label="Stop generating">
                  <Square size={16} />
                </Button>
              ) : (
                <Button
                  size="icon"
                  variant="primary"
                  onClick={() => send(input)}
                  disabled={!input.trim()}
                  aria-label="Send question"
                >
                  <Send size={17} />
                </Button>
              )}
            </div>

            <div className="flex gap-2 overflow-x-auto pb-0.5 no-scrollbar">
              {QUICK_ACTIONS.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  disabled={streaming || (!messages.length && !lastAssistant)}
                  onClick={() => send(lastAssistant?.content || input, { quickAction: action.id })}
                  className="vroqn-tap shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-1.5 text-[12px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-primary)]/45 hover:text-[var(--color-text)] disabled:opacity-40"
                >
                  {action.label}
                </button>
              ))}
            </div>

            {!hasAnyKey ? (
              <SampleNotice
                text="Sample mode: answers come from the built-in library. Add a key in AI Settings for real model answers."
                action={
                  <Button size="sm" variant="secondary" onClick={() => navigate('/settings')}>
                    AI Settings
                  </Button>
                }
              />
            ) : null}
          </div>
        </div>
      </section>

      {/* --------------------------- mobile chat history -------------------------- */}
      {historyOpen ? (
        <div className="fixed inset-0 z-50 flex xl:hidden" role="dialog" aria-modal="true" aria-label="Your chats">
          <button className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-label="Close" onClick={() => setHistoryOpen(false)} />
          <div className="relative ml-auto flex h-full w-[85%] max-w-[340px] flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-3">
              <span className="text-[13px] font-semibold">Your chats</span>
              <Button size="icon" variant="ghost" aria-label="Close" onClick={() => setHistoryOpen(false)}>
                <X size={17} />
              </Button>
            </div>
            <div className="border-b border-[var(--color-border)] p-3">
              <Button
                block
                variant="primary"
                icon={<MessageSquarePlus size={15} />}
                onClick={() => {
                  setActiveId(null);
                  setMessages([]);
                  setHistoryOpen(false);
                  navigate('/tutor');
                }}
              >
                New chat
              </Button>
            </div>
            <ConversationList
              conversations={conversations}
              activeId={activeId}
              onSelect={(id) => {
                navigate(`/tutor/${id}`);
                setHistoryOpen(false);
              }}
              onDelete={deleteConversation}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ sub-components ---------------------------- */

function ConversationList({
  conversations,
  activeId,
  onSelect,
  onDelete,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (!conversations.length) {
    return (
      <p className="px-4 py-6 text-center text-[12.5px] leading-relaxed text-[var(--color-muted)]">
        Your conversations will appear here. Each one keeps its context so follow-up questions make sense.
      </p>
    );
  }
  return (
    <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
      {conversations.map((conversation) => (
        <li key={conversation.id}>
          <div
            className={[
              'group flex items-center gap-2 rounded-[10px] px-2.5 py-2 transition-colors',
              conversation.id === activeId ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]' : 'hover:bg-white/[0.04]',
            ].join(' ')}
          >
            <button type="button" onClick={() => onSelect(conversation.id)} className="vroqn-tap min-w-0 flex-1 text-left">
              <span className="block truncate text-[13px] font-medium">{conversation.title}</span>
              <span className="block truncate text-[11px] text-[var(--color-muted-dim)]">
                {conversation.messageCount ?? 0} messages · {timeAgo(conversation.updatedAt)}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onDelete(conversation.id)}
              aria-label={`Delete ${conversation.title}`}
              className="shrink-0 rounded p-1 text-[var(--color-muted-dim)] opacity-0 transition-opacity hover:text-[var(--color-error)] focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function MessageBubble({
  message,
  isLast,
  onCopy,
  onSave,
  onRegenerate,
  onPractice,
}: {
  message: ChatMessageRecord;
  isLast: boolean;
  onCopy: () => void;
  onSave: () => void;
  onRegenerate?: () => void;
  onPractice: () => void;
}) {
  const isUser = message.role === 'user';
  const meta = message.meta;

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-[var(--color-primary)]/25 bg-[var(--color-primary)]/[0.09] px-4 py-2.5">
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-[var(--color-text)]">{message.content}</p>
          {meta?.attachments?.length ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-[var(--color-primary-soft)]">
              <ImageIcon size={12} /> {meta.attachments.join(', ')}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <article className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)]">
      <div className="px-4 py-3.5">
        <Markdown content={message.content} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--color-border)] px-3 py-2">
        <IconAction label="Copy answer" icon={<Copy size={14} />} onClick={onCopy} />
        <IconAction label="Save to Notes" icon={<BookOpen size={14} />} onClick={onSave} />
        {isLast && onRegenerate ? <IconAction label="Regenerate" icon={<RefreshCw size={14} />} onClick={onRegenerate} /> : null}
        <span className="mx-0.5 h-4 w-px bg-[var(--color-border)]" aria-hidden="true" />
        <Button size="sm" variant="ghost" icon={<Lightbulb size={13} />} onClick={onPractice}>
          Practise this
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {meta?.demo ? <Badge tone="warning">Sample</Badge> : null}
          {meta?.fellBack ? <Badge tone="primary">Failover used</Badge> : null}
          {meta ? (
            <AnswerMeta
              provider={meta.provider}
              model={meta.model}
              keyLabel={meta.keyLabel}
              attempts={meta.attempts}
              fellBack={meta.fellBack}
              demo={meta.demo}
              latencyMs={meta.latencyMs}
              onRetry={isLast ? onRegenerate : undefined}
            />
          ) : null}
        </div>
      </div>
    </article>
  );
}

function IconAction({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="vroqn-tap grid h-8 w-8 place-items-center rounded-lg text-[var(--color-muted-dim)] transition-colors hover:bg-white/5 hover:text-[var(--color-text)]"
    >
      {icon}
    </button>
  );
}

function VisualSuggestions({ visuals }: { visuals: VisualSuggestion[] }) {
  return (
    <Card className="border-[var(--color-primary)]/25 bg-[var(--color-primary)]/[0.04] p-3.5">
      <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-primary)]">
        <ScanSearch size={14} /> Would a visual help here?
      </p>
      <ul className="mt-2.5 space-y-2">
        {visuals.map((visual) => (
          <li key={visual.title} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2.5">
            <p className="text-[13px] font-medium">{visual.title}</p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-muted)]">{visual.description}</p>
            <a
              href={`https://commons.wikimedia.org/w/index.php?search=${encodeURIComponent(visual.query)}`}
              target="_blank"
              rel="noreferrer noopener"
              className="vroqn-tap mt-1.5 inline-flex items-center text-[12px] text-[var(--color-primary-soft)] underline decoration-dotted underline-offset-2"
            >
              Find “{visual.query}” →
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-[var(--color-muted-dim)]">
        Images are opened in a new tab rather than embedded, so answers stay fast on slow connections.
      </p>
    </Card>
  );
}

export default TutorPage;
