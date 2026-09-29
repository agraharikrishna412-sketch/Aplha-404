/**
 * AI Tutor service — conversations, prompt assembly, answer persistence.
 *
 * The streaming itself lives in the AI layer; this service only knows about learning context,
 * which keeps the router provider-agnostic and the tutor UI thin.
 */
import * as db from '../db/index.js';
import { nowIso, uuid } from '../db/index.js';
import type { TaskKind } from '../config/models.js';
import { complete } from './ai/router.js';
import { followUpSystem, tutorSystem, QUICK_ACTIONS, type PromptContext } from './ai/prompts.js';
import { visualSuggestionsFor } from './visuals.js';
import { recordActivity } from './activity.js';
import { getSettings } from './settings.js';
import type { ChatMessageRecord, Conversation, MessageMeta, VisualSuggestion } from '../types/domain.js';
import type { ChatMessage, ContentPart } from './ai/types.js';

interface ConversationRow {
  id: string;
  user_id: string;
  title: string;
  subject: string | null;
  task_kind: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  meta: string | null;
  created_at: string;
}

export async function listConversations(userId: string, limit = 40): Promise<Conversation[]> {
  const rows = await db.all<ConversationRow>(
    `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
      WHERE c.user_id = ?
      ORDER BY c.updated_at DESC
      LIMIT ?`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    subject: r.subject,
    taskKind: r.task_kind as TaskKind,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: Number(r.message_count ?? 0),
  }));
}

export async function createConversation(userId: string, args: { title?: string; subject?: string; taskKind?: TaskKind } = {}): Promise<Conversation> {
  const id = uuid();
  const now = nowIso();
  await db.run(
    'INSERT INTO conversations (id, user_id, title, subject, task_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, userId, (args.title ?? 'New chat').slice(0, 120), args.subject ?? null, args.taskKind ?? 'general', now, now],
  );
  return { id, title: args.title ?? 'New chat', subject: args.subject ?? null, taskKind: args.taskKind ?? 'general', createdAt: now, updatedAt: now };
}

export async function getConversation(userId: string, id: string): Promise<{ conversation: Conversation; messages: ChatMessageRecord[] } | null> {
  const row = await db.one<ConversationRow>('SELECT * FROM conversations WHERE id = ? AND user_id = ?', [id, userId]);
  if (!row) return null;
  const messages = await db.all<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
    [id],
  );
  return {
    conversation: {
      id: row.id,
      title: row.title,
      subject: row.subject,
      taskKind: row.task_kind as TaskKind,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    messages: messages.map((m) => ({
      id: m.id,
      conversationId: m.conversation_id,
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
      meta: db.json<MessageMeta | null>(m.meta, null),
      createdAt: m.created_at,
    })),
  };
}

export async function renameConversation(userId: string, id: string, title: string): Promise<void> {
  await db.run('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?', [
    title.slice(0, 120),
    nowIso(),
    id,
    userId,
  ]);
}

export async function deleteConversation(userId: string, id: string): Promise<void> {
  await db.run('DELETE FROM messages WHERE conversation_id = ? AND user_id = ?', [id, userId]);
  await db.run('DELETE FROM conversations WHERE id = ? AND user_id = ?', [id, userId]);
}

export async function addMessage(args: {
  userId: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  meta?: MessageMeta | null;
}): Promise<ChatMessageRecord> {
  const id = uuid();
  const now = nowIso();
  await db.run(
    'INSERT INTO messages (id, conversation_id, user_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, args.conversationId, args.userId, args.role, args.content, args.meta ? JSON.stringify(args.meta) : null, now],
  );
  await db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [now, args.conversationId]);
  return {
    id,
    conversationId: args.conversationId,
    role: args.role,
    content: args.content,
    meta: args.meta ?? null,
    createdAt: now,
  };
}

/** Most recent messages, oldest-first, mapped into provider chat format. */
export async function conversationHistory(conversationId: string, limit = 12): Promise<ChatMessage[]> {
  const rows = await db.all<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
    [conversationId, limit],
  );
  return rows
    .reverse()
    .filter((r) => r.role === 'user' || r.role === 'assistant')
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
}

export async function promptContextFor(userId: string, subject?: string, chapter?: string): Promise<PromptContext> {
  const [settings, user] = await Promise.all([
    getSettings(userId),
    db.one<{ name: string; class_level: string | null; board: string | null }>(
      'SELECT name, class_level, board FROM users WHERE id = ?',
      [userId],
    ),
  ]);
  return {
    settings,
    subject,
    chapter,
    className: user?.class_level ?? null,
    board: user?.board ?? null,
  };
}

export interface TutorRequestInput {
  userId: string;
  conversationId?: string;
  content: string;
  attachments?: { mimeType: string; data: string; name?: string }[];
  quickAction?: keyof typeof QUICK_ACTIONS;
  subject?: string;
  regenerate?: boolean;
  preferredProvider?: string;
  preferredModel?: string;
}

export interface PreparedTutorRequest {
  conversationId: string;
  history: ChatMessage[];
  messages: ChatMessage[];
  system: string;
  taskKind: TaskKind;
  userMessageId?: string;
}

/**
 * Builds the exact message array sent to the model. Kept separate from streaming so the
 * regenerate / quick-action paths reuse identical context.
 */
export async function prepareTutorRequest(input: TutorRequestInput): Promise<PreparedTutorRequest> {
  const subject = input.subject;

  let conversationId = input.conversationId ?? '';
  if (!conversationId) {
    const created = await createConversation(input.userId, {
      title: firstLineTitle(input.content),
      subject,
      taskKind: 'general',
    });
    conversationId = created.id;
  }

  const history = input.regenerate
    ? (await conversationHistory(conversationId, 13)).slice(0, -1)
    : await conversationHistory(conversationId, 12);

  const ctx = await promptContextFor(input.userId, subject);

  const parts: ContentPart[] = [];
  const text = input.quickAction
    ? `${QUICK_ACTIONS[input.quickAction]}\n\n(Original question: ${input.content})`
    : input.content;
  parts.push({ type: 'text', text });
  const firstText = text;
  for (const attachment of input.attachments ?? []) {
    if (attachment.mimeType === 'application/pdf') {
      parts.push({ type: 'file', mimeType: attachment.mimeType, data: attachment.data, name: attachment.name ?? 'document.pdf' });
    } else {
      parts.push({ type: 'image', mimeType: attachment.mimeType, data: attachment.data, name: attachment.name ?? 'image.jpg' });
    }
  }

  let userMessageId: string | undefined;
  if (!input.regenerate) {
    const saved = await addMessage({
      userId: input.userId,
      conversationId,
      role: 'user',
      content: input.content,
      meta: input.attachments?.length ? { attachments: input.attachments.map((a) => a.name ?? a.mimeType) } : null,
    });
    userMessageId = saved.id;
  }

  return {
    conversationId,
    history,
    messages: [...history, { role: 'user', content: parts.length === 1 ? firstText : parts }],
    system: tutorSystem(ctx, { wantsVisuals: true }),
    taskKind: input.attachments?.length ? 'vision' : 'general',
    userMessageId,
  };
}

/** Persists the finished answer and returns the metadata the UI should show. */
export async function finaliseTutorAnswer(args: {
  userId: string;
  conversationId: string;
  text: string;
  meta: MessageMeta;
  durationMs: number;
  subject?: string;
}): Promise<{ message: ChatMessageRecord; visuals: VisualSuggestion[]; followUps: string[] }> {
  const { cleanText, visuals } = extractVisuals(args.text);
  const meta: MessageMeta = { ...args.meta, visuals };
  const message = await addMessage({
    userId: args.userId,
    conversationId: args.conversationId,
    role: 'assistant',
    content: cleanText,
    meta,
  });

  await recordActivity({
    userId: args.userId,
    kind: 'tutor',
    subject: args.subject ?? null,
    topic: firstLineTitle(args.subject ?? cleanText, 60),
    durationMs: args.durationMs,
    label: `Asked: ${firstLineTitle(args.text, 60)}`,
  });

  let followUps: string[] = [];
  try {
    followUps = await suggestFollowUps(args.userId, args.conversationId, cleanText, args.meta.demo ?? false);
    if (followUps.length) {
      const withFollowUps = await db.one<MessageRow>('SELECT * FROM messages WHERE id = ?', [message.id]);
      const merged: MessageMeta = { ...(db.json<MessageMeta>(withFollowUps?.meta ?? null, {}) as MessageMeta), followUps };
      await db.run('UPDATE messages SET meta = ? WHERE id = ?', [JSON.stringify(merged), message.id]);
      message.meta = merged;
    }
  } catch {
    followUps = [];
  }

  return { message, visuals, followUps };
}

async function suggestFollowUps(userId: string, _conversationId: string, answer: string, demo: boolean): Promise<string[]> {
  if (demo) {
    return ['Show me a step-by-step example', 'Why does this happen?', 'Test me with 3 questions'];
  }
  const ctx = await promptContextFor(userId);
  const summary = await complete({
    userId,
    task: 'grading',
    system: followUpSystem(ctx),
    json: true,
    maxTokens: 200,
    temperature: 0.4,
    messages: [
      {
        role: 'user',
        content: `The student just received this explanation:\n\n${answer.slice(0, 1500)}\n\nGenerate 3 follow-up questions.`,
      },
    ],
  });
  if (summary.error) return [];
  const parsed = db.json<{ followUps?: string[] }>(summary.text.replace(/```json|```/g, '').trim(), {});
  const list = parsed.followUps;
  if (!Array.isArray(list)) return [];
  return list.filter((s) => typeof s === 'string' && s.trim().length > 3).slice(0, 3).map((s) => s.trim().slice(0, 80));
}

/** Splits the `VISUALS: [...]` hint the model may emit out of the answer body. */
export function extractVisuals(text: string): { cleanText: string; visuals: VisualSuggestion[] } {
  const match = /^\s*VISUALS:\s*(\[[\s\S]*?\])\s*$/im.exec(text);
  let visuals: VisualSuggestion[] = [];
  let cleanText = text;
  if (match) {
    try {
      const parsed = JSON.parse(match[1]) as VisualSuggestion[];
      if (Array.isArray(parsed)) {
        visuals = parsed
          .filter((v) => v && typeof v.title === 'string' && typeof v.query === 'string')
          .slice(0, 2)
          .map((v) => ({
            title: v.title.slice(0, 90),
            kind: (['diagram', 'illustration', 'map', 'chart', 'photo'] as const).includes(v.kind as never)
              ? v.kind
              : 'diagram',
            description: String(v.description ?? '').slice(0, 160),
            query: v.query.slice(0, 120),
          }));
      }
    } catch {
      /* model emitted malformed JSON — fall back to heuristics */
    }
    cleanText = text.replace(match[0], '').trimEnd();
  }
  if (!visuals.length) visuals = visualSuggestionsFor(cleanText);
  return { cleanText, visuals };
}

function firstLineTitle(text: string, max = 48): string {
  const line = text.replace(/[#*`>]/g, '').split('\n').find((l) => l.trim().length) ?? 'New chat';
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}
