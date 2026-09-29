/**
 * Community learning surfaces: doubts, answers, the knowledge base and shared resources.
 *
 * The knowledge base is the point of the whole section (§11): a solved doubt can be promoted by a
 * moderator into a permanent, searchable answer, and the student whose answer was marked helpful is
 * credited. That chain — question → answer → helpful → knowledge — is why contribution is measured
 * on helpful answers rather than on messages sent (§36).
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { all, bool, nowIso, one, run, uuid } from '../../db/index.js';
import { config } from '../../config/env.js';
import type { UploadedFile } from '../notes.js';
import { HttpError } from '../../middleware/errors.js';
import { addContribution, assertCanPost, recordModeration } from './communities.js';
import { loadForMember } from './access.js';
import { publishCommunity } from './bus.js';
import { createNotification } from './notifications.js';
import { assertCan, isCommunityRole, type CommunityRole } from './permissions.js';
import {
  RESOURCE_KINDS,
  type DoubtAnswerView,
  type DoubtView,
  type KnowledgeView,
  type ResourceKind,
  type ResourceView,
} from './types.js';

const MAX_DOUBT_TITLE = 160;
const MAX_BODY = 8000;
const MAX_RESOURCE_TITLE = 140;

/* ------------------------------------------------------------------ doubts ---------------------- */

function doubtView(
  row: {
    id: string;
    community_id: string;
    user_id: string;
    title: string;
    description: string;
    image_url: string | null;
    subject: string | null;
    topic: string | null;
    status: string;
    helpful_answer_id: string | null;
    is_knowledge: number | null;
    is_pinned: number | null;
    answer_count: number | null;
    created_at: string;
    updated_at: string;
    author_name?: string | null;
  },
  userId: string,
): DoubtView {
  return {
    id: row.id,
    communityId: row.community_id,
    userId: row.user_id,
    authorName: row.author_name ?? 'A Vroqn student',
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    subject: row.subject,
    topic: row.topic,
    status: row.status === 'solved' ? 'solved' : 'open',
    answerCount: row.answer_count ?? 0,
    helpfulAnswerId: row.helpful_answer_id,
    isKnowledge: bool(row.is_knowledge),
    isPinned: bool(row.is_pinned),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isMine: row.user_id === userId,
  };
}

export async function listDoubts(
  userId: string,
  communityId: string,
  options: { status?: string; search?: string; limit?: number; offset?: number } = {},
): Promise<{ doubts: DoubtView[]; total: number }> {
  await loadForMember(userId, communityId, { requireMembership: true });
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  const where = ['d.community_id = ?'];
  const params: unknown[] = [communityId];

  if (options.status === 'open' || options.status === 'solved') {
    where.push('d.status = ?');
    params.push(options.status);
  }
  if (options.search?.trim()) {
    const term = `%${options.search.trim().toLowerCase().slice(0, 80)}%`;
    where.push('(LOWER(d.title) LIKE ? OR LOWER(d.description) LIKE ? OR LOWER(COALESCE(d.topic, \'\')) LIKE ?)');
    params.push(term, term, term);
  }

  const rows = await all<Parameters<typeof doubtView>[0]>(
    `SELECT d.*, u.name AS author_name
       FROM community_doubts d JOIN users u ON u.id = d.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.is_pinned DESC, d.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const total = await one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM community_doubts d WHERE ${where.join(' AND ')}`,
    params,
  );

  return { doubts: rows.map((row) => doubtView(row, userId)), total: total?.total ?? rows.length };
}

export async function createDoubt(
  userId: string,
  communityId: string,
  args: {
    title: string;
    description?: string;
    imageUrl?: string | null;
    subject?: string | null;
    topic?: string | null;
  },
): Promise<DoubtView> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCanPost(membership);

  const title = (args.title ?? '').trim().slice(0, MAX_DOUBT_TITLE);
  if (title.length < 5) throw new HttpError(400, 'Describe your doubt in a few more words.', 'validation_error');

  const id = uuid();
  const now = nowIso();
  await run(
    `INSERT INTO community_doubts
       (id, community_id, user_id, title, description, image_url, subject, topic, status,
        helpful_answer_id, is_knowledge, is_pinned, answer_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, 0, 0, 0, ?, ?)`,
    [
      id,
      communityId,
      userId,
      title,
      (args.description ?? '').trim().slice(0, MAX_BODY),
      args.imageUrl ?? null,
      args.subject?.slice(0, 60) ?? null,
      args.topic?.slice(0, 80) ?? null,
      now,
      now,
    ],
  );

  publishCommunity(communityId, { type: 'doubt', communityId, doubtId: id });
  const row = await one<Parameters<typeof doubtView>[0]>(
    `SELECT d.*, u.name AS author_name FROM community_doubts d JOIN users u ON u.id = d.user_id WHERE d.id = ?`,
    [id],
  );
  return doubtView(row!, userId);
}

export async function getDoubt(
  userId: string,
  communityId: string,
  doubtId: string,
): Promise<{ doubt: DoubtView; answers: DoubtAnswerView[] }> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });

  const row = await one<Parameters<typeof doubtView>[0]>(
    `SELECT d.*, u.name AS author_name
       FROM community_doubts d JOIN users u ON u.id = d.user_id
      WHERE d.id = ? AND d.community_id = ?`,
    [doubtId, communityId],
  );
  if (!row) throw new HttpError(404, 'That doubt no longer exists.', 'not_found');

  const answers = await all<{
    id: string;
    doubt_id: string;
    user_id: string;
    author_name: string;
    role: string;
    body: string;
    is_helpful: number | null;
    deleted_at: string | null;
    created_at: string;
    edited_at: string | null;
  }>(
    `SELECT a.id, a.doubt_id, a.user_id, u.name AS author_name, COALESCE(m.role,'member') AS role,
            a.body, a.is_helpful, a.deleted_at, a.created_at, a.edited_at
       FROM doubt_answers a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN community_members m ON m.community_id = a.community_id AND m.user_id = a.user_id
      WHERE a.doubt_id = ?
      ORDER BY a.is_helpful DESC, a.created_at`,
    [doubtId],
  );

  const moderator = isModerator(membership!.role);
  const doubt = doubtView(row, userId);

  return {
    doubt,
    answers: answers.map((answer) => ({
      id: answer.id,
      doubtId: answer.doubt_id,
      userId: answer.user_id,
      authorName: answer.author_name,
      authorRole: isCommunityRole(answer.role) ? (answer.role as CommunityRole) : 'member',
      // A deleted answer disappears entirely rather than showing "[deleted]" — there is nothing to
      // preserve in a study context, and the count already reflects the removal.
      body: answer.deleted_at ? '' : answer.body,
      isHelpful: bool(answer.is_helpful),
      isDeleted: Boolean(answer.deleted_at),
      createdAt: answer.created_at,
      editedAt: answer.edited_at,
      isMine: answer.user_id === userId,
      canMarkHelpful: doubt.userId === userId || moderator,
      canDelete: !answer.deleted_at && (answer.user_id === userId || moderator),
    })),
  };
}

export async function answerDoubt(
  userId: string,
  communityId: string,
  doubtId: string,
  body: string,
): Promise<DoubtAnswerView> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCanPost(membership);

  const text = (body ?? '').trim();
  if (text.length < 2) throw new HttpError(400, 'Write your answer first.', 'validation_error');
  if (text.length > MAX_BODY) throw new HttpError(400, 'That answer is too long.', 'validation_error');

  const doubt = await one<{ id: string; user_id: string; title: string }>(
    `SELECT id, user_id, title FROM community_doubts WHERE id = ? AND community_id = ?`,
    [doubtId, communityId],
  );
  if (!doubt) throw new HttpError(404, 'That doubt no longer exists.', 'not_found');

  const id = uuid();
  const now = nowIso();
  await run(
    `INSERT INTO doubt_answers (id, doubt_id, community_id, user_id, body, is_helpful, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    [id, doubtId, communityId, userId, text, now],
  );
  await run(`UPDATE community_doubts SET answer_count = answer_count + 1, updated_at = ? WHERE id = ?`, [
    now,
    doubtId,
  ]);
  await addContribution(communityId, userId, 2);

  publishCommunity(communityId, { type: 'doubt_answer', communityId, doubtId });

  if (doubt.user_id !== userId) {
    await createNotification({
      userId: doubt.user_id,
      communityId,
      kind: 'reply',
      title: 'Someone answered your doubt 💬',
      body: doubt.title.slice(0, 120),
      link: `/communities/${communityId}?tab=doubts&doubt=${doubtId}`,
    });
  }

  return {
    id,
    doubtId,
    userId,
    authorName: 'You',
    authorRole: membership!.role,
    body: text,
    isHelpful: false,
    isDeleted: false,
    createdAt: now,
    editedAt: null,
    isMine: true,
    canMarkHelpful: false,
    canDelete: true,
  };
}

/**
 * Mark one answer as the helpful answer. Only the doubt's author (the person who was stuck) or a
 * moderator may do it, and choosing a new one moves the credit — the previous answer loses its
 * `is_helpful` flag and the points are transferred rather than duplicated.
 */
export async function markHelpful(
  userId: string,
  communityId: string,
  doubtId: string,
  answerId: string,
): Promise<void> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });

  const doubt = await one<{ id: string; user_id: string; title: string; helpful_answer_id: string | null }>(
    `SELECT id, user_id, title, helpful_answer_id FROM community_doubts WHERE id = ? AND community_id = ?`,
    [doubtId, communityId],
  );
  if (!doubt) throw new HttpError(404, 'That doubt no longer exists.', 'not_found');

  if (doubt.user_id !== userId && !isModerator(membership!.role)) {
    throw new HttpError(403, 'Only the student who asked, or a moderator, can mark a helpful answer.', 'forbidden');
  }

  const answer = await one<{ id: string; user_id: string; doubt_id: string; deleted_at: string | null }>(
    `SELECT id, user_id, doubt_id, deleted_at FROM doubt_answers WHERE id = ? AND doubt_id = ?`,
    [answerId, doubtId],
  );
  if (!answer || answer.deleted_at) throw new HttpError(404, 'That answer no longer exists.', 'not_found');

  const now = nowIso();

  if (doubt.helpful_answer_id && doubt.helpful_answer_id !== answerId) {
    const previous = await one<{ user_id: string }>(
      `SELECT user_id FROM doubt_answers WHERE id = ?`,
      [doubt.helpful_answer_id],
    );
    await run(`UPDATE doubt_answers SET is_helpful = 0 WHERE id = ?`, [doubt.helpful_answer_id]);
    if (previous) await addContribution(communityId, previous.user_id, -5, 'helpful');
  }

  await run(`UPDATE doubt_answers SET is_helpful = 1 WHERE id = ?`, [answerId]);
  await run(
    `UPDATE community_doubts SET helpful_answer_id = ?, status = 'solved', updated_at = ? WHERE id = ?`,
    [answerId, now, doubtId],
  );
  await addContribution(communityId, answer.user_id, 5, 'helpful');

  publishCommunity(communityId, { type: 'doubt_answer', communityId, doubtId });

  if (answer.user_id !== userId) {
    await createNotification({
      userId: answer.user_id,
      communityId,
      kind: 'helpful_answer',
      title: 'Your answer was marked helpful 🎯',
      body: `"${doubt.title.slice(0, 100)}" — you earned 5 contribution points.`,
      link: `/communities/${communityId}?tab=doubts&doubt=${doubtId}`,
    });
  }
}

export async function deleteAnswer(
  userId: string,
  communityId: string,
  answerId: string,
): Promise<void> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  const answer = await one<{ id: string; user_id: string; doubt_id: string; is_helpful: number | null }>(
    `SELECT id, user_id, doubt_id, is_helpful FROM doubt_answers WHERE id = ? AND community_id = ?`,
    [answerId, communityId],
  );
  if (!answer) throw new HttpError(404, 'That answer no longer exists.', 'not_found');

  if (answer.user_id !== userId && !isModerator(membership!.role)) {
    throw new HttpError(403, 'You can only delete your own answer.', 'forbidden');
  }

  const now = nowIso();
  await run(`UPDATE doubt_answers SET deleted_at = ? WHERE id = ?`, [now, answerId]);
  await run(`UPDATE community_doubts SET answer_count = MAX(answer_count - 1, 0), updated_at = ? WHERE id = ?`, [
    now,
    answer.doubt_id,
  ]);

  if (bool(answer.is_helpful)) {
    await run(`UPDATE community_doubts SET helpful_answer_id = NULL, status = 'open' WHERE id = ?`, [
      answer.doubt_id,
    ]);
    await addContribution(communityId, answer.user_id, -5, 'helpful');
  }

  if (answer.user_id !== userId) {
    await recordModeration(communityId, userId, 'answer_deleted', 'doubt_answer', answerId, 'Moderator removal', answer.user_id);
  }
  publishCommunity(communityId, { type: 'doubt_answer', communityId, doubtId: answer.doubt_id });
}

/* ------------------------------------------------------------------ knowledge base --------------- */

export async function listKnowledge(
  userId: string,
  communityId: string,
  options: { search?: string; limit?: number; offset?: number } = {},
): Promise<{ items: KnowledgeView[]; total: number }> {
  await loadForMember(userId, communityId, { requireMembership: true });
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  const where = ['community_id = ?'];
  const params: unknown[] = [communityId];
  if (options.search?.trim()) {
    const term = `%${options.search.trim().toLowerCase().slice(0, 80)}%`;
    where.push('(LOWER(title) LIKE ? OR LOWER(question) LIKE ? OR LOWER(answer) LIKE ?)');
    params.push(term, term, term);
  }

  const rows = await all<{
    id: string;
    community_id: string;
    doubt_id: string | null;
    title: string;
    question: string;
    answer: string;
    ai_explanation: string | null;
    subject: string | null;
    topic: string | null;
    created_by: string;
    created_at: string;
  }>(
    `SELECT id, community_id, doubt_id, title, question, answer, ai_explanation, subject, topic, created_by, created_at
       FROM community_knowledge WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const total = await one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM community_knowledge WHERE ${where.join(' AND ')}`,
    params,
  );

  return {
    items: rows.map((row) => ({
      id: row.id,
      communityId: row.community_id,
      doubtId: row.doubt_id,
      title: row.title,
      question: row.question,
      answer: row.answer,
      aiExplanation: row.ai_explanation,
      subject: row.subject,
      topic: row.topic,
      createdBy: row.created_by,
      createdAt: row.created_at,
    })),
    total: total?.total ?? rows.length,
  };
}

/**
 * Promote a solved doubt into the knowledge base (§11).
 *
 * Requires a helpful answer: promoting an unanswered question would put a half-finished discussion
 * into the permanent record, which is worse than leaving it in Doubts.
 */
export async function promoteToKnowledge(
  userId: string,
  communityId: string,
  doubtId: string,
  aiExplanation?: string | null,
): Promise<KnowledgeView> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  if (!isModerator(membership!.role)) {
    throw new HttpError(403, 'Only community moderators can add to the knowledge base.', 'forbidden');
  }

  const doubt = await one<{
    id: string;
    title: string;
    description: string;
    subject: string | null;
    topic: string | null;
    helpful_answer_id: string | null;
  }>(
    `SELECT id, title, description, subject, topic, helpful_answer_id
       FROM community_doubts WHERE id = ? AND community_id = ?`,
    [doubtId, communityId],
  );
  if (!doubt) throw new HttpError(404, 'That doubt no longer exists.', 'not_found');
  if (!doubt.helpful_answer_id) {
    throw new HttpError(400, 'Mark a helpful answer first — the knowledge base only stores solved doubts.', 'not_ready');
  }

  const answer = await one<{ body: string }>(`SELECT body FROM doubt_answers WHERE id = ?`, [
    doubt.helpful_answer_id,
  ]);

  const existing = await one<{ id: string }>(
    `SELECT id FROM community_knowledge WHERE doubt_id = ? AND community_id = ?`,
    [doubtId, communityId],
  );
  const now = nowIso();
  /*
   * The id of the row this call produced. It used to be `existing?.id ?? ''`, so promoting a doubt for
   * the first time answered with an empty id and the client could not link to the entry it had just
   * created.
   */
  const knowledgeId = existing?.id ?? uuid();

  if (existing) {
    await run(
      `UPDATE community_knowledge SET title = ?, question = ?, answer = ?, ai_explanation = ?, updated_at = ?
        WHERE id = ?`,
      [doubt.title, doubt.description || doubt.title, answer?.body ?? '', aiExplanation ?? null, now, existing.id],
    );
  } else {
    await run(
      `INSERT INTO community_knowledge
         (id, community_id, doubt_id, title, question, answer, ai_explanation, subject, topic, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        communityId,
        doubtId,
        doubt.title,
        doubt.description || doubt.title,
        answer?.body ?? '',
        aiExplanation ?? null,
        doubt.subject,
        doubt.topic,
        userId,
        now,
        now,
      ],
    );
  }

  await run(`UPDATE community_doubts SET is_knowledge = 1, updated_at = ? WHERE id = ?`, [now, doubtId]);
  await addContribution(communityId, userId, 1);
  publishCommunity(communityId, { type: 'resource', communityId, resourceId: doubtId });

  return {
    id: knowledgeId,
    communityId,
    doubtId,
    title: doubt.title,
    question: doubt.description || doubt.title,
    answer: answer?.body ?? '',
    aiExplanation: aiExplanation ?? null,
    subject: doubt.subject,
    topic: doubt.topic,
    createdBy: userId,
    createdAt: now,
  };
}

/* ------------------------------------------------------------------ resources ------------------- */

function isModerator(role: CommunityRole | null): boolean {
  return role === 'owner' || role === 'admin' || role === 'moderator';
}

export async function listResources(
  userId: string,
  communityId: string,
  options: { category?: string; search?: string; limit?: number; offset?: number } = {},
): Promise<{ resources: ResourceView[]; total: number }> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  const where = ['r.community_id = ?'];
  const params: unknown[] = [communityId];
  if (options.category?.trim()) {
    where.push('r.category = ?');
    params.push(options.category.trim().slice(0, 40));
  }
  if (options.search?.trim()) {
    const term = `%${options.search.trim().toLowerCase().slice(0, 80)}%`;
    where.push('(LOWER(r.title) LIKE ? OR LOWER(r.description) LIKE ?)');
    params.push(term, term);
  }

  const rows = await all<{
    id: string;
    community_id: string;
    title: string;
    description: string;
    category: string;
    kind: string;
    url: string | null;
    note_id: string | null;
    subject: string | null;
    created_by: string;
    author_name: string;
    file_name?: string | null;
    file_size?: number | null;
    file_mime?: string | null;
    upload_id?: string | null;
    is_pinned: number | null;
    download_count: number | null;
    created_at: string;
  }>(
    `SELECT r.*, u.name AS author_name,
            up.file_name AS file_name, up.size AS file_size, up.mime AS file_mime
       FROM community_resources r
       JOIN users u ON u.id = r.created_by
       LEFT JOIN uploads up ON up.id = r.upload_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.is_pinned DESC, r.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const total = await one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM community_resources r WHERE ${where.join(' AND ')}`,
    params,
  );

  const moderator = isModerator(membership?.role ?? null);

  return {
    resources: rows.map((row) => resourceView(row, userId, moderator)),
    total: total?.total ?? rows.length,
  };
}

function resourceView(
  row: {
    id: string;
    community_id: string;
    title: string;
    description: string;
    category: string;
    kind: string;
    url: string | null;
    note_id: string | null;
    subject: string | null;
    created_by: string;
    author_name?: string;
    file_name?: string | null;
    file_size?: number | null;
    file_mime?: string | null;
    upload_id?: string | null;
    is_pinned: number | null;
    download_count: number | null;
    created_at: string;
  },
  userId: string,
  moderator: boolean,
): ResourceView {
  return {
    id: row.id,
    communityId: row.community_id,
    title: row.title,
    description: row.description,
    category: row.category,
    kind: (RESOURCE_KINDS as readonly string[]).includes(row.kind) ? (row.kind as ResourceKind) : 'link',
    url: row.url,
    noteId: row.note_id,
    subject: row.subject,
    createdBy: row.created_by,
    authorName: row.author_name ?? 'A Vroqn student',
    isPinned: bool(row.is_pinned),
    downloadCount: row.download_count ?? 0,
    createdAt: row.created_at,
    isMine: row.created_by === userId,
    canDelete: row.created_by === userId || moderator,
    uploadId: row.upload_id ?? null,
    fileName: row.file_name ?? null,
    fileSize: row.file_size ?? null,
    fileMime: row.file_mime ?? null,
  };
}

export async function createResource(
  userId: string,
  communityId: string,
  args: {
    title: string;
    description?: string;
    category?: string;
    kind?: string;
    url?: string | null;
    noteId?: string | null;
    subject?: string | null;
  },
): Promise<ResourceView> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCan(membership?.role ?? null, 'create_resource');
  assertCanPost(membership);

  const title = (args.title ?? '').trim().slice(0, MAX_RESOURCE_TITLE);
  if (title.length < 3) throw new HttpError(400, 'Give the resource a title.', 'validation_error');

  const kind: ResourceKind = (RESOURCE_KINDS as readonly string[]).includes(args.kind ?? '')
    ? (args.kind as ResourceKind)
    : 'link';

  let url: string | null = null;
  if (args.url?.trim()) {
    const candidate = args.url.trim().slice(0, 800);
    // Only http(s). A `javascript:` URL shared into a community chat would be a stored-XSS vector
    // from a student's own share action (§4: do not permit unsafe content).
    if (!/^https?:\/\//i.test(candidate)) {
      throw new HttpError(400, 'Links must start with http:// or https://', 'validation_error');
    }
    url = candidate;
  }

  let noteId: string | null = null;
  if (args.noteId) {
    // A shared note must belong to the sharer — otherwise it would expose another student's note.
    const note = await one<{ id: string }>(`SELECT id FROM notes WHERE id = ? AND user_id = ?`, [
      args.noteId,
      userId,
    ]);
    if (!note) throw new HttpError(403, 'You can only share notes that are yours.', 'forbidden');
    noteId = note.id;
  }

  if (!url && !noteId) {
    throw new HttpError(400, 'Add a link, or attach one of your Vroqn notes.', 'validation_error');
  }

  const id = uuid();
  const now = nowIso();
  await run(
    `INSERT INTO community_resources
       (id, community_id, title, description, category, kind, url, note_id, subject, created_by,
        visibility, is_pinned, download_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'members', 0, 0, ?, ?)`,
    [
      id,
      communityId,
      title,
      (args.description ?? '').trim().slice(0, 1200),
      (args.category ?? 'notes').trim().slice(0, 40),
      kind,
      url,
      noteId,
      args.subject?.slice(0, 60) ?? null,
      userId,
      now,
      now,
    ],
  );

  await addContribution(communityId, userId, 3);
  publishCommunity(communityId, { type: 'resource', communityId, resourceId: id });

  const row = await one<Parameters<typeof resourceView>[0]>(
    `SELECT r.*, u.name AS author_name FROM community_resources r JOIN users u ON u.id = r.created_by WHERE r.id = ?`,
    [id],
  );
  return resourceView(row!, userId, true);
}

export async function deleteResource(
  userId: string,
  communityId: string,
  resourceId: string,
): Promise<void> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  const resource = await one<{ id: string; created_by: string }>(
    `SELECT id, created_by FROM community_resources WHERE id = ? AND community_id = ?`,
    [resourceId, communityId],
  );
  if (!resource) throw new HttpError(404, 'That resource no longer exists.', 'not_found');

  if (resource.created_by !== userId && !isModerator(membership!.role)) {
    throw new HttpError(403, 'You can only delete resources you added.', 'forbidden');
  }

  await run(`DELETE FROM community_resources WHERE id = ?`, [resourceId]);
  if (resource.created_by !== userId) {
    await recordModeration(communityId, userId, 'resource_deleted', 'resource', resourceId, 'Moderator removal', resource.created_by);
  }
  publishCommunity(communityId, { type: 'resource', communityId, resourceId });
}

/** Toggle a pin on a resource (moderators only). */
export async function toggleResourcePin(
  userId: string,
  communityId: string,
  resourceId: string,
): Promise<{ isPinned: boolean }> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCan(membership?.role ?? null, 'moderate_messages');

  const resource = await one<{ id: string; is_pinned: number | null }>(
    `SELECT id, is_pinned FROM community_resources WHERE id = ? AND community_id = ?`,
    [resourceId, communityId],
  );
  if (!resource) throw new HttpError(404, 'That resource no longer exists.', 'not_found');

  const next = bool(resource.is_pinned) ? 0 : 1;
  await run(`UPDATE community_resources SET is_pinned = ?, updated_at = ? WHERE id = ?`, [
    next,
    nowIso(),
    resourceId,
  ]);
  return { isPinned: Boolean(next) };
}

/* ------------------------------------------------------------------ resource files ------------- */

/**
 * Shares an uploaded file as a community resource.
 *
 * The bytes were already written to the shared upload directory by the notes upload pipeline, and
 * recorded in `uploads`; this only links that row to the community. Keeping one storage location means
 * one place to clean up, one size limit and one MIME allowlist for the whole app.
 */
export async function attachUploadResource(
  userId: string,
  communityId: string,
  args: {
    title: string;
    description?: string;
    category?: string;
    subject?: string | null;
    upload: UploadedFile;
    uploadId: string;
  },
): Promise<ResourceView> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCan(membership?.role ?? null, 'create_resource');
  assertCanPost(membership);

  const title = (args.title ?? '').trim().slice(0, MAX_RESOURCE_TITLE);
  if (title.length < 3) throw new HttpError(400, 'Give the resource a title.', 'validation_error');

  const id = uuid();
  const now = nowIso();
  await run(
    `INSERT INTO community_resources
       (id, community_id, title, description, category, kind, url, note_id, subject, created_by, visibility, is_pinned, download_count, created_at, updated_at, upload_id)
     VALUES (?, ?, ?, ?, ?, 'file', NULL, NULL, ?, ?, 'members', 0, 0, ?, ?, ?)`,
    [
      id,
      communityId,
      title,
      (args.description ?? '').trim().slice(0, 2000),
      (args.category ?? 'notes').trim().slice(0, 40) || 'notes',
      args.subject?.trim().slice(0, 60) ?? null,
      userId,
      now,
      now,
      args.uploadId,
    ],
  );

  const row = await one<{ id: string }>(`SELECT id FROM community_resources WHERE id = ?`, [id]);
  if (!row) throw new HttpError(500, 'The resource could not be saved.', 'server_error');

  const [created] = await all<Parameters<typeof resourceView>[0]>(
    `SELECT r.*, u.name AS author_name,
            up.file_name AS file_name, up.size AS file_size, up.mime AS file_mime
       FROM community_resources r
       JOIN users u ON u.id = r.created_by
       LEFT JOIN uploads up ON up.id = r.upload_id
      WHERE r.id = ?`,
    [id],
  );
  return resourceView(created!, userId, isModerator(membership?.role ?? null));
}

export interface ResourceFile {
  storedPath: string;
  fileName: string;
  mime: string;
  size: number;
}

/**
 * Resolves a resource file for download.
 *
 * Authorisation happens here, before the route touches the disk: a signed-in student who is not a
 * member of a private community gets a 404, exactly as if the resource did not exist (§16, §53).
 * The stored path is reduced to a basename so a tampered row can never walk out of the upload dir.
 */
export async function resourceDownload(userId: string, communityId: string, resourceId: string): Promise<ResourceFile> {
  await loadForMember(userId, communityId, { requireMembership: true });

  const row = await one<{
    id: string;
    upload_id: string | null;
    file_name: string | null;
    mime: string | null;
    size: number | null;
    stored_path: string | null;
    title: string;
  }>(
    `SELECT r.id, r.upload_id, r.title, up.file_name, up.mime, up.size, up.stored_path
       FROM community_resources r
       LEFT JOIN uploads up ON up.id = r.upload_id
      WHERE r.id = ? AND r.community_id = ?`,
    [resourceId, communityId],
  );
  if (!row || !row.stored_path) throw new HttpError(404, 'That file is not available.', 'not_found');

  const stored = path.basename(row.stored_path);
  const absolute = path.join(config.uploadDir, stored);
  try {
    await fs.access(absolute);
  } catch {
    throw new HttpError(404, 'That file is not available.', 'not_found');
  }

  await run(`UPDATE community_resources SET download_count = download_count + 1 WHERE id = ?`, [resourceId]);

  return {
    storedPath: absolute,
    fileName: (row.file_name || row.title || 'resource').slice(0, 160),
    mime: row.mime ?? 'application/octet-stream',
    size: row.size ?? 0,
  };
}
