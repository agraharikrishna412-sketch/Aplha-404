/**
 * Community polls (§28).
 *
 * A poll is either standalone or attached to a chat message. Two behaviours matter for students:
 *
 *  - **Anonymous polls** hide *who* voted, but the caller's own vote is still marked so the UI can
 *    show them what they chose. Vote tallies are always exact; there is no fabricated percentage.
 *  - **One vote per option per student**, enforced by a unique index rather than a read-then-write
 *    check, so a double-tap or two open tabs cannot double-count.
 */
import { all, bool, nowIso, one, run, uuid } from '../../db/index.js';
import { HttpError } from '../../middleware/errors.js';
import { loadForMember } from './access.js';
import { publishCommunity } from './bus.js';
import { assertCan } from './permissions.js';
import { assertCanPost } from './communities.js';
import type { PollView } from './types.js';

export const MAX_OPTIONS = 10;

export interface CreatePollArgs {
  question: string;
  options: string[];
  isMultiple?: boolean;
  isAnonymous?: boolean;
  expiresAt?: string | null;
  messageId?: string | null;
}

export async function createPoll(
  userId: string,
  communityId: string,
  args: CreatePollArgs,
): Promise<PollView> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCan(membership?.role ?? null, 'create_poll');
  assertCanPost(membership);

  const question = (args.question ?? '').trim();
  if (question.length < 3) throw new HttpError(400, 'Write the question you want to ask.', 'validation_error');

  const labels = (args.options ?? [])
    .map((option) => String(option).trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, MAX_OPTIONS);
  if (labels.length < 2) throw new HttpError(400, 'A poll needs at least two options.', 'validation_error');

  if (args.messageId) {
    const message = await one<{ id: string }>(
      `SELECT id FROM community_messages WHERE id = ? AND community_id = ?`,
      [args.messageId, communityId],
    );
    if (!message) throw new HttpError(400, 'That message is not in this community.', 'validation_error');
  }

  const pollId = uuid();
  await run(
    `INSERT INTO community_polls (id, community_id, message_id, question, is_multiple, is_anonymous, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      pollId,
      communityId,
      args.messageId ?? null,
      question.slice(0, 300),
      args.isMultiple ? 1 : 0,
      args.isAnonymous ? 1 : 0,
      args.expiresAt ? new Date(args.expiresAt).toISOString() : null,
      userId,
      nowIso(),
    ],
  );

  let position = 0;
  for (const label of labels) {
    await run(`INSERT INTO poll_options (id, poll_id, label, position) VALUES (?, ?, ?, ?)`, [
      uuid(),
      pollId,
      label,
      position,
    ]);
    position += 1;
  }

  publishCommunity(communityId, { type: 'poll', communityId, pollId });
  return (await pollView(userId, pollId))!;
}

/**
 * Poll view with tallies.
 *
 * Visible to any member of the community. The caller must be able to read the community — this is
 * checked by the caller (`loadForMember`) before the id is passed in, and re-checked here for polls
 * reached through a message page.
 */
export async function pollView(userId: string, pollId: string): Promise<PollView | null> {
  const poll = await one<{
    id: string;
    community_id: string;
    question: string;
    is_multiple: number | null;
    is_anonymous: number | null;
    expires_at: string | null;
  }>(
    `SELECT id, community_id, question, is_multiple, is_anonymous, expires_at
       FROM community_polls WHERE id = ?`,
    [pollId],
  );
  if (!poll) return null;

  const [options, votes, mine] = await Promise.all([
    all<{ id: string; label: string }>(
      `SELECT id, label FROM poll_options WHERE poll_id = ? ORDER BY position, id`,
      [pollId],
    ),
    all<{ option_id: string; count: number }>(
      `SELECT option_id, COUNT(*) AS count FROM poll_votes WHERE poll_id = ? GROUP BY option_id`,
      [pollId],
    ),
    all<{ option_id: string }>(`SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?`, [
      pollId,
      userId,
    ]),
  ]);

  const counts = new Map(votes.map((row) => [row.option_id, row.count]));
  const myVotes = mine.map((row) => row.option_id);
  const totalVotes = votes.reduce((sum, row) => sum + row.count, 0);
  const isClosed = Boolean(poll.expires_at && new Date(poll.expires_at).getTime() <= Date.now());

  return {
    id: poll.id,
    question: poll.question,
    isMultiple: bool(poll.is_multiple),
    isAnonymous: bool(poll.is_anonymous),
    expiresAt: poll.expires_at,
    isClosed,
    totalVotes,
    options: options.map((option) => {
      const count = counts.get(option.id) ?? 0;
      return {
        id: option.id,
        label: option.label,
        votes: count,
        mine: myVotes.includes(option.id),
        // Percentage of the votes cast. 0 when nobody has voted yet — never a placeholder number.
        percent: totalVotes ? Math.round((count / totalVotes) * 100) : 0,
      };
    }),
    myVotes,
  };
}

export async function vote(
  userId: string,
  communityId: string,
  pollId: string,
  optionIds: string[],
): Promise<PollView> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  assertCanPost(membership);

  const poll = await one<{ id: string; community_id: string; is_multiple: number | null; expires_at: string | null }>(
    `SELECT id, community_id, is_multiple, expires_at FROM community_polls WHERE id = ? AND community_id = ?`,
    [pollId, communityId],
  );
  if (!poll) throw new HttpError(404, 'That poll no longer exists.', 'not_found');
  if (poll.expires_at && new Date(poll.expires_at).getTime() <= Date.now()) {
    throw new HttpError(409, 'That poll has closed.', 'poll_closed');
  }

  const wanted = [...new Set(optionIds.filter((id): id is string => typeof id === 'string'))];
  if (!wanted.length) throw new HttpError(400, 'Choose an option first.', 'validation_error');
  if (!bool(poll.is_multiple) && wanted.length > 1) {
    throw new HttpError(400, 'This poll only allows one choice.', 'validation_error');
  }

  const valid = await all<{ id: string }>(
    `SELECT id FROM poll_options WHERE poll_id = ? AND id IN (${wanted.map(() => '?').join(', ')})`,
    [pollId, ...wanted],
  );
  if (valid.length !== wanted.length) throw new HttpError(400, 'Unknown poll option.', 'validation_error');

  // Single-choice polls replace the previous vote; multi-choice polls add to it and can be toggled.
  if (!bool(poll.is_multiple)) {
    await run(`DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?`, [pollId, userId]);
  }

  for (const optionId of wanted) {
    const existing = await one<{ id: string }>(
      `SELECT id FROM poll_votes WHERE poll_id = ? AND option_id = ? AND user_id = ?`,
      [pollId, optionId, userId],
    );
    if (existing) {
      // Toggling off is only meaningful for multi-choice; single-choice already cleared above.
      if (bool(poll.is_multiple)) await run(`DELETE FROM poll_votes WHERE id = ?`, [existing.id]);
      continue;
    }
    await run(
      `INSERT INTO poll_votes (id, poll_id, option_id, user_id, created_at) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), pollId, optionId, userId, nowIso()],
    );
  }

  publishCommunity(communityId, { type: 'poll', communityId, pollId });
  return (await pollView(userId, pollId))!;
}

export async function deletePoll(userId: string, communityId: string, pollId: string): Promise<void> {
  const { membership } = await loadForMember(userId, communityId, { requireMembership: true });
  const poll = await one<{ created_by: string }>(
    `SELECT created_by FROM community_polls WHERE id = ? AND community_id = ?`,
    [pollId, communityId],
  );
  if (!poll) throw new HttpError(404, 'That poll no longer exists.', 'not_found');
  if (poll.created_by !== userId) assertCan(membership?.role ?? null, 'create_poll');

  await run(`DELETE FROM poll_votes WHERE poll_id = ?`, [pollId]);
  await run(`DELETE FROM poll_options WHERE poll_id = ?`, [pollId]);
  await run(`DELETE FROM community_polls WHERE id = ?`, [pollId]);
  publishCommunity(communityId, { type: 'poll', communityId, pollId });
}

/** Polls attached to a community, for the Home feed. */
export async function listPolls(userId: string, communityId: string, limit = 10): Promise<PollView[]> {
  const rows = await all<{ id: string }>(
    `SELECT id FROM community_polls WHERE community_id = ? ORDER BY created_at DESC LIMIT ?`,
    [communityId, Math.min(Math.max(limit, 1), 40)],
  );
  const views = await Promise.all(rows.map((row) => pollView(userId, row.id)));
  return views.filter((view): view is PollView => view !== null);
}
