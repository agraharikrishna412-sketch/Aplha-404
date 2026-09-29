/**
 * Notes service — create, organise, upload (image / PDF / text), AI clean-up and Q&A over notes.
 * Handwriting and scanned pages go through the vision path of the AI router, so any vision-capable
 * provider (or the next available key) can process them.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as db from '../db/index.js';
import { nowIso, uuid } from '../db/index.js';
import { config } from '../config/env.js';
import { complete, completeJson } from './ai/router.js';
import { noteAskSystem, notesSystem, type PromptContext } from './ai/prompts.js';
import { promptContextFor } from './tutor.js';
import { getSettings } from './settings.js';
import { recordActivity } from './activity.js';
import type { Note, UploadRecord } from '../types/domain.js';
import type { ContentPart } from './ai/types.js';

interface NoteRow {
  id: string;
  title: string;
  subject: string | null;
  chapter: string | null;
  content: string;
  tags: string | null;
  source: string;
  source_file: string | null;
  starred: number;
  created_at: string;
  updated_at: string;
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    chapter: row.chapter,
    content: row.content,
    tags: db.json<string[]>(row.tags, []),
    source: row.source as Note['source'],
    sourceFile: row.source_file,
    starred: row.starred === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listNotes(
  userId: string,
  opts: { search?: string; subject?: string; starredOnly?: boolean; limit?: number } = {},
): Promise<Note[]> {
  const clauses = ['user_id = ?'];
  const params: unknown[] = [userId];
  if (opts.subject) {
    clauses.push('subject = ?');
    params.push(opts.subject);
  }
  if (opts.starredOnly) clauses.push('starred = 1');
  if (opts.search?.trim()) {
    clauses.push('(LOWER(title) LIKE ? OR LOWER(content) LIKE ? OR LOWER(COALESCE(subject, \'\')) LIKE ?)');
    const like = `%${opts.search.trim().toLowerCase()}%`;
    params.push(like, like, like);
  }
  params.push(Math.min(opts.limit ?? 100, 200));
  const rows = await db.all<NoteRow>(
    `SELECT * FROM notes WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`,
    params,
  );
  return rows.map(toNote);
}

export async function getNote(userId: string, id: string): Promise<Note | null> {
  const row = await db.one<NoteRow>('SELECT * FROM notes WHERE id = ? AND user_id = ?', [id, userId]);
  return row ? toNote(row) : null;
}

export async function createNote(
  userId: string,
  args: { title: string; content: string; subject?: string; chapter?: string; tags?: string[]; source?: Note['source']; sourceFile?: string },
): Promise<Note> {
  const id = uuid();
  const now = nowIso();
  await db.run(
    `INSERT INTO notes (id, user_id, title, subject, chapter, content, tags, source, source_file, starred, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      id,
      userId,
      args.title.trim().slice(0, 160) || 'Untitled note',
      args.subject?.trim() || null,
      args.chapter?.trim() || null,
      args.content,
      JSON.stringify(args.tags ?? []),
      args.source ?? 'manual',
      args.sourceFile ?? null,
      now,
      now,
    ],
  );
  return (await getNote(userId, id))!;
}

export async function updateNote(
  userId: string,
  id: string,
  patch: Partial<Pick<Note, 'title' | 'content' | 'subject' | 'chapter' | 'tags' | 'starred'>>,
): Promise<Note | null> {
  const existing = await getNote(userId, id);
  if (!existing) return null;
  await db.run(
    `UPDATE notes SET title = ?, content = ?, subject = ?, chapter = ?, tags = ?, starred = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`,
    [
      (patch.title ?? existing.title).slice(0, 160),
      patch.content ?? existing.content,
      patch.subject === undefined ? existing.subject : patch.subject,
      patch.chapter === undefined ? existing.chapter : patch.chapter,
      JSON.stringify(patch.tags ?? existing.tags),
      (patch.starred ?? existing.starred) ? 1 : 0,
      nowIso(),
      id,
      userId,
    ],
  );
  return getNote(userId, id);
}

export async function deleteNote(userId: string, id: string): Promise<void> {
  const note = await getNote(userId, id);
  if (note?.sourceFile) {
    const rel = note.sourceFile;
    const abs = path.isAbsolute(rel) ? rel : path.join(config.uploadDir, path.basename(rel));
    await fs.rm(abs, { force: true }).catch(() => undefined);
  }
  await db.run('DELETE FROM uploads WHERE note_id = ? AND user_id = ?', [id, userId]);
  await db.run('DELETE FROM notes WHERE id = ? AND user_id = ?', [id, userId]);
}

export async function listNoteSubjects(userId: string): Promise<string[]> {
  const rows = await db.all<{ subject: string | null }>(
    "SELECT DISTINCT subject FROM notes WHERE user_id = ? AND subject IS NOT NULL ORDER BY subject ASC",
    [userId],
  );
  return rows.map((r) => r.subject!).filter(Boolean);
}

/* ------------------------------- uploads -------------------------------- */

export type UploadedFile = { path: string; originalName: string; mime: string; size: number; kind: 'image' | 'pdf' | 'text' | 'audio' };

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.rtf']);

export function classifyUpload(file: { mimetype: string; originalname: string }): UploadedFile['kind'] | null {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype.toLowerCase();
  if (mime.startsWith('image/') && /^(image\/(png|jpe?g|webp|gif|heic|heif|bmp))$/.test(mime)) return 'image';
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (mime.startsWith('text/') || TEXT_EXT.has(ext)) return 'text';
  if (mime.startsWith('audio/')) return 'audio';
  return null;
}

export async function registerUpload(userId: string, file: UploadedFile, noteId?: string): Promise<UploadRecord> {
  const id = uuid();
  const createdAt = nowIso();
  await db.run(
    `INSERT INTO uploads (id, user_id, note_id, file_name, mime, size, stored_path, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, noteId ?? null, file.originalName.slice(0, 160), file.mime, file.size, path.basename(file.path), file.kind, createdAt],
  );
  return {
    id,
    noteId: noteId ?? null,
    fileName: file.originalName,
    mime: file.mime,
    size: file.size,
    kind: file.kind,
    createdAt,
  };
}

/** Reads an uploaded file back as a content part the providers understand. */
async function fileToContentPart(file: UploadedFile): Promise<ContentPart> {
  const ext = path.extname(file.originalName).toLowerCase();
  if (file.kind === 'text') {
    const text = await fs.readFile(file.path, 'utf8');
    return { type: 'text', text: text.slice(0, 40_000) };
  }
  const data = (await fs.readFile(file.path)).toString('base64');
  if (file.kind === 'pdf') return { type: 'file', mimeType: 'application/pdf', data, name: file.originalName };
  const mime = /^image\/(png|jpeg|webp|gif)$/.test(file.mime)
    ? file.mime
    : ext === '.png'
      ? 'image/png'
      : 'image/jpeg';
  return { type: 'image', mimeType: mime, data, name: file.originalName };
}

/* --------------------------- AI note structuring ------------------------- */

export interface StructuredNote {
  title: string;
  subject: string;
  chapter: string;
  summary: string;
  keyPoints: string[];
  definitions: { term: string; meaning: string }[];
  formulas: string[];
  quickRevision: string[];
  practiceQuestions: string[];
}

/** Renders the structured JSON into the study-friendly markdown stored on the note. */
export function structuredNoteToMarkdown(s: StructuredNote, meta: { source?: string } = {}): string {
  const lines: string[] = [];
  if (meta.source) lines.push(`> Source: ${meta.source}`, '');
  if (s.summary) lines.push('## Summary', s.summary.trim(), '');
  if (s.keyPoints?.length) lines.push('## Key Concepts', ...s.keyPoints.map((k) => `- ${k.trim()}`), '');
  if (s.definitions?.length) {
    lines.push('## Important Definitions', ...s.definitions.map((d) => `- **${d.term.trim()}** — ${d.meaning.trim()}`), '');
  }
  if (s.formulas?.length) lines.push('## Formulas', ...s.formulas.map((f) => `- ${f.trim()}`), '');
  if (s.quickRevision?.length) lines.push('## Quick Revision', ...s.quickRevision.map((q) => `- ${q.trim()}`), '');
  if (s.practiceQuestions?.length) lines.push('## Practice Questions', ...s.practiceQuestions.map((q, i) => `${i + 1}. ${q.trim()}`), '');
  return lines.join('\n').trim();
}

function normaliseStructured(raw: Record<string, unknown>, fallbackTitle: string): StructuredNote {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 30) : [];
  const defs = Array.isArray(raw.definitions)
    ? (raw.definitions as Record<string, unknown>[])
        .map((d) => ({ term: String(d.term ?? d.name ?? '').trim(), meaning: String(d.meaning ?? d.definition ?? '').trim() }))
        .filter((d) => d.term && d.meaning)
        .slice(0, 24)
    : [];
  return {
    title: String(raw.title ?? fallbackTitle).slice(0, 140) || fallbackTitle,
    subject: String(raw.subject ?? '').slice(0, 60),
    chapter: String(raw.chapter ?? '').slice(0, 80),
    summary: String(raw.summary ?? '').trim(),
    keyPoints: arr(raw.keyPoints),
    definitions: defs,
    formulas: arr(raw.formulas),
    quickRevision: arr(raw.quickRevision),
    practiceQuestions: arr(raw.practiceQuestions),
  };
}

/** Deterministic fallback so an upload never ends in an empty note. */
export function localStructure(text: string, title: string): StructuredNote {
  const clean = text.replace(/\r/g, '');
  const lines = clean
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 2);
  const sentences = clean.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 25);
  const bulletish = lines
    .filter((l) => /^([-•*\d]|\w+:|[A-Z][^.]{6,90}S)/.test(l))
    .map((l) => l.replace(/^[-•*]\s*/, '').replace(/^\d+[.)]\s*/, ''))
    .slice(0, 20);
  const definitions = lines
    .map((l) => /^([A-Z][\w\s-]{2,40})\s*[:\-–]\s*(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ term: m[1].trim(), meaning: m[2].trim() }))
    .slice(0, 15);
  const formulas = lines.filter((l) => /[=]/.test(l) && /[a-zA-Z]/.test(l) && l.length < 80).slice(0, 10);

  return {
    title,
    subject: '',
    chapter: '',
    summary: sentences.slice(0, 4).join(' ') || clean.slice(0, 400),
    keyPoints: bulletish.length ? bulletish : sentences.slice(0, 8),
    definitions,
    formulas,
    quickRevision: sentences.slice(4, 9).map((s) => s.slice(0, 140)),
    practiceQuestions: [],
  };
}

export interface StructureResult {
  note: Note;
  structured: StructuredNote;
  degraded?: string;
  provider?: string;
  model?: string;
  demo?: boolean;
}

/**
 * The core "Clean my notes" pipeline:
 *   file/text → (vision or text) → structured JSON → markdown note.
 */
export async function structureIntoNote(args: {
  userId: string;
  files?: UploadedFile[];
  text?: string;
  title?: string;
  subject?: string;
  chapter?: string;
  handwritten?: boolean;
}): Promise<StructureResult> {
  const ctx: PromptContext = await promptContextFor(args.userId, args.subject, args.chapter);
  const sourceKind: 'handwritten' | 'typed' | 'text' = args.files?.some((f) => f.kind === 'image') || args.handwritten
    ? 'handwritten'
    : args.files?.length
      ? 'typed'
      : 'text';

  const parts: ContentPart[] = [];
  if (args.text?.trim()) parts.push({ type: 'text', text: args.text.slice(0, 40_000) });
  for (const file of args.files ?? []) {
    parts.push(await fileToContentPart(file));
  }
  parts.push({
    type: 'text',
    text: 'Restructure the material above into clean study notes. Return only the JSON object described in your instructions.',
  });

  const fallbackTitle = args.title?.trim() || args.files?.[0]?.originalName?.replace(/\.[a-z0-9]+$/i, '') || 'Uploaded notes';
  let structured: StructuredNote;
  let degraded: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let demo = false;

  try {
    const { data, summary } = await completeJson<Record<string, unknown>>({
      userId: args.userId,
      task: sourceKind === 'handwritten' ? 'vision' : 'notes',
      system: notesSystem(ctx, sourceKind),
      messages: [{ role: 'user', content: parts }],
      temperature: 0.3,
      maxTokens: 3000,
      allowDemo: false,
    });
    structured = normaliseStructured(data, fallbackTitle);
    provider = summary.provider;
    model = summary.model;
    demo = summary.demo;
    if (!structured.keyPoints.length && !structured.summary) throw new Error('empty structure');
  } catch (err) {
    const rawText = args.text?.trim() || (args.files?.length ? '' : '');
    degraded = rawText
      ? 'A model could not be reached, so the notes were organised locally. Add or test a key in AI Settings for full AI clean-up.'
      : 'A model could not be reached to read this upload. The file is saved — retry when a key is available.';
    structured = localStructure(rawText || '(No text extracted yet — retry with an AI connection.)', fallbackTitle);
  }

  const markdown = structuredNoteToMarkdown(structured, {
    source: args.files?.length ? `uploaded file · ${sourceKind}` : 'pasted text',
  });

  const note = await createNote(args.userId, {
    title: structured.title || fallbackTitle,
    subject: args.subject || structured.subject || undefined,
    chapter: args.chapter || structured.chapter || undefined,
    content: markdown,
    source: args.files?.length ? 'upload' : 'ai',
    sourceFile: args.files?.[0]?.originalName,
    tags: [sourceKind, demo ? 'sample' : 'ai-clean'],
  });

  await recordActivity({
    userId: args.userId,
    kind: 'notes',
    subject: note.subject ?? args.subject ?? null,
    topic: note.chapter ?? null,
    label: `Organised notes: ${note.title}`,
    meta: { noteId: note.id, source: sourceKind, provider, model, degraded: Boolean(degraded) },
  });

  return { note, structured, degraded, provider, model, demo };
}

export type NoteAskMode = 'summary' | 'keypoints' | 'definitions' | 'questions' | 'explain';

export async function askAboutNote(args: {
  userId: string;
  noteId: string;
  mode: NoteAskMode;
}): Promise<{ answer: string; provider?: string; model?: string; demo?: boolean; degraded?: string }> {
  const note = await getNote(args.userId, args.noteId);
  if (!note) throw new Error('Note not found');
  const ctx = await promptContextFor(args.userId, note.subject ?? undefined, note.chapter ?? undefined);

  try {
    const summary = await complete({
      userId: args.userId,
      task: 'notes',
      system: noteAskSystem(ctx, args.mode),
      temperature: 0.4,
      maxTokens: 1400,
      messages: [{ role: 'user', content: `# ${note.title}\n\n${note.content.slice(0, 12_000)}` }],
    });
    if (summary.error) throw new Error(summary.error.message);
    return { answer: summary.text, provider: summary.provider, model: summary.model, demo: summary.demo };
  } catch (err) {
    const local = localStructure(note.content, note.title);
    const answers: Record<NoteAskMode, string> = {
      summary: [`## Summary`, local.summary, '', `## Remember`, ...local.quickRevision.slice(0, 3).map((q) => `- ${q}`)].join('\n'),
      keypoints: [`## Key points`, ...local.keyPoints.map((k) => `- ${k}`)].join('\n'),
      definitions: [`## Definitions`, ...local.definitions.map((d) => `- **${d.term}** — ${d.meaning}`)].join('\n'),
      questions: [
        '## Practice questions from these notes',
        ...local.keyPoints.slice(0, 6).map((k, i) => `${i + 1}. Explain: ${k.replace(/\.$/, '')}`),
      ].join('\n'),
      explain: local.summary,
    };
    return {
      answer: answers[args.mode],
      degraded: 'Generated from the note text locally (no AI connection reachable).',
    };
  }
}

/** Save a tutor answer (or any markdown) straight into Notes — the learn → revise handoff. */
export async function saveToNotes(args: {
  userId: string;
  title: string;
  content: string;
  subject?: string;
  chapter?: string;
  source?: Note['source'];
}): Promise<Note> {
  const note = await createNote(args.userId, {
    title: args.title,
    content: args.content,
    subject: args.subject,
    chapter: args.chapter,
    source: args.source ?? 'tutor',
    tags: ['from-tutor'],
  });
  await recordActivity({
    userId: args.userId,
    kind: 'notes',
    subject: note.subject ?? null,
    topic: note.chapter ?? null,
    label: `Saved AI answer to notes: ${note.title}`,
    meta: { noteId: note.id },
  });
  return note;
}

/** Used by the vision route: "explain this photo" without creating a note. */
export async function explainUpload(args: {
  userId: string;
  file: UploadedFile;
  question?: string;
}): Promise<{ answer: string; provider?: string; model?: string; demo?: boolean }> {
  const ctx = await promptContextFor(args.userId);
  const settings = await getSettings(args.userId);
  const part = await fileToContentPart(args.file);
  const summary = await complete({
    userId: args.userId,
    task: 'vision',
    system: notesSystem(ctx, args.file.kind === 'image' ? 'handwritten' : 'typed'),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              args.question?.trim() ||
              (settings.language === 'hindi'
                ? 'इस सामग्री को साफ़ नोट्स में बदलें।'
                : 'Clean this material into structured study notes.'),
          },
          part,
        ] as ContentPart[],
      },
    ],
    maxTokens: 2200,
    temperature: 0.3,
  });
  if (summary.error) throw new Error(summary.error.message);
  return { answer: summary.text, provider: summary.provider, model: summary.model, demo: summary.demo };
}

/**
 * True when the student has at least one enabled key on a provider that can read images.
 * Drives the "photo of handwritten notes" hint in the Notes uploader.
 */
export async function hasVisionKey(userId: string): Promise<boolean> {
  const rows = await db.all<{ provider: string }>(
    'SELECT DISTINCT provider FROM api_keys WHERE user_id = ? AND enabled = 1',
    [userId],
  );
  const { PROVIDER_CATALOG } = await import('../config/models.js');
  return rows.some((r) =>
    (PROVIDER_CATALOG[r.provider as keyof typeof PROVIDER_CATALOG]?.models ?? []).some((m) => m.vision),
  );
}
