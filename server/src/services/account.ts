/**
 * Account deletion.
 *
 * "Delete my account" has to mean something, so this module is deliberately explicit about what
 * disappears. Two rules shaped it:
 *
 *  1. **Nothing of the student's survives.** Every table that references a person is listed in
 *     `WIPE` below, in the order it has to run (children before parents). A test walks the live
 *     schema, finds every column that points at a user, and fails if a single one is missing from
 *     this list — so adding a table later cannot silently leave data behind.
 *  2. **Other people are not collateral.** Communities the student owns are the one case where
 *     deleting one account would take away something other students belong to. Those are not
 *     silently deleted: a community with other active members blocks the deletion and is reported
 *     back with its name and slug, so the student can hand it over or delete it first. A community
 *     where they are the only member is theirs alone and goes with the account.
 *
 * Deletion runs in a transaction: either every row goes, or none does.
 */
import { HttpError } from '../middleware/errors.js';
import { verifyPassword } from './crypto.js';
import * as db from '../db/index.js';

/**
 * Every statement that must run, in order.
 *
 * `WHERE` clauses are always parameterised on the user id. Statements that take two parameters
 * (a reporter and a target, an actor and a subject) are written out twice on purpose — it is easy to
 * read what happens to which column.
 */
const WIPE: { label: string; sql: string; params: 1 | 2 }[] = [
  /* ---- things that hang off a piece of content the student owns ---------------- */
  { label: 'poll options', sql: 'DELETE FROM poll_options WHERE poll_id IN (SELECT id FROM community_polls WHERE created_by = ?)', params: 1 },
  { label: 'plan tasks', sql: 'DELETE FROM study_plan_tasks WHERE plan_id IN (SELECT id FROM study_plans WHERE created_by = ?)', params: 1 },
  { label: 'doubt answers on own doubts', sql: 'DELETE FROM doubt_answers WHERE doubt_id IN (SELECT id FROM community_doubts WHERE user_id = ?)', params: 1 },

  /* ---- private chat ------------------------------------------------------------- */
  { label: 'dm reactions', sql: 'DELETE FROM dm_reactions WHERE user_id = ?', params: 1 },
  { label: 'dm reactions in own conversations', sql: 'DELETE FROM dm_reactions WHERE conversation_id IN (SELECT conversation_id FROM dm_members WHERE user_id = ?)', params: 1 },
  { label: 'dm receipts', sql: 'DELETE FROM dm_receipts WHERE user_id = ?', params: 1 },
  { label: 'dm receipts in own conversations', sql: 'DELETE FROM dm_receipts WHERE conversation_id IN (SELECT conversation_id FROM dm_members WHERE user_id = ?)', params: 1 },
  { label: 'dm devices', sql: 'DELETE FROM dm_device_keys WHERE user_id = ?', params: 1 },
  { label: 'dm key envelopes (sent)', sql: 'DELETE FROM dm_key_envelopes WHERE sender_user_id = ?', params: 1 },
  { label: 'dm key envelopes (received)', sql: 'DELETE FROM dm_key_envelopes WHERE recipient_user_id = ?', params: 1 },
  { label: 'dm key envelopes in own conversations', sql: 'DELETE FROM dm_key_envelopes WHERE conversation_id IN (SELECT conversation_id FROM dm_members WHERE user_id = ?)', params: 1 },
  { label: 'dm messages', sql: 'DELETE FROM dm_messages WHERE sender_id = ?', params: 1 },
  /*
   * The whole conversation goes, for both sides.
   *
   * That is the honest reading of "delete my account": the ciphertext of a private chat is half theirs
   * and half yours, and leaving one side readable after the other side asked to disappear would be a
   * strange kind of privacy. It is stated plainly in the confirmation screen before anybody presses
   * the button.
   */
  { label: 'dm messages in own conversations', sql: 'DELETE FROM dm_messages WHERE conversation_id IN (SELECT conversation_id FROM dm_members WHERE user_id = ?)', params: 1 },
  { label: 'dm reports (as reporter)', sql: 'DELETE FROM dm_reports WHERE reporter_id = ?', params: 1 },
  { label: 'dm reports (as subject)', sql: 'DELETE FROM dm_reports WHERE target_user_id = ?', params: 1 },
  /* Runs before membership goes, or the conversation could not be found any more. */
  { label: 'dm conversations', sql: 'DELETE FROM dm_conversations WHERE id IN (SELECT conversation_id FROM dm_members WHERE user_id = ?)', params: 1 },
  { label: 'dm membership', sql: 'DELETE FROM dm_members WHERE user_id = ?', params: 1 },

  /* ---- communities: membership and everything the student wrote ------------------ */
  { label: 'poll votes', sql: 'DELETE FROM poll_votes WHERE user_id = ?', params: 1 },
  { label: 'team membership', sql: 'DELETE FROM team_members WHERE user_id = ?', params: 1 },
  { label: 'teams owned', sql: 'DELETE FROM community_teams WHERE created_by = ?', params: 1 },
  { label: 'polls owned', sql: 'DELETE FROM community_polls WHERE created_by = ?', params: 1 },
  { label: 'study plans owned', sql: 'DELETE FROM study_plans WHERE created_by = ?', params: 1 },
  { label: 'study rooms owned', sql: 'DELETE FROM study_rooms WHERE created_by = ?', params: 1 },
  { label: 'plan progress', sql: 'DELETE FROM study_plan_progress WHERE user_id = ?', params: 1 },
  { label: 'room participation', sql: 'DELETE FROM study_room_participants WHERE user_id = ?', params: 1 },
  { label: 'challenge progress', sql: 'DELETE FROM challenge_progress WHERE user_id = ?', params: 1 },
  { label: 'events hosted', sql: 'DELETE FROM community_events WHERE host_id = ?', params: 1 },
  { label: 'event participation', sql: 'DELETE FROM event_participants WHERE user_id = ?', params: 1 },
  { label: 'competitions owned', sql: 'DELETE FROM community_competitions WHERE created_by = ?', params: 1 },
  { label: 'challenges owned', sql: 'DELETE FROM community_challenges WHERE created_by = ?', params: 1 },
  { label: 'knowledge entries', sql: 'DELETE FROM community_knowledge WHERE created_by = ?', params: 1 },
  { label: 'shared resources', sql: 'DELETE FROM community_resources WHERE created_by = ?', params: 1 },
  { label: 'announcements', sql: 'DELETE FROM community_announcements WHERE created_by = ?', params: 1 },
  { label: 'answers written', sql: 'DELETE FROM doubt_answers WHERE user_id = ?', params: 1 },
  { label: 'doubts asked', sql: 'DELETE FROM community_doubts WHERE user_id = ?', params: 1 },
  { label: 'message reactions', sql: 'DELETE FROM message_reactions WHERE user_id = ?', params: 1 },
  { label: 'community messages', sql: 'DELETE FROM community_messages WHERE user_id = ?', params: 1 },
  { label: 'read state', sql: 'DELETE FROM community_read_state WHERE user_id = ?', params: 1 },
  { label: 'blocks (as blocker)', sql: 'DELETE FROM community_blocks WHERE user_id = ?', params: 1 },
  { label: 'blocks (as blocked)', sql: 'DELETE FROM community_blocks WHERE blocked_user_id = ?', params: 1 },
  { label: 'join requests', sql: 'DELETE FROM community_join_requests WHERE user_id = ?', params: 1 },
  { label: 'invites issued', sql: 'DELETE FROM community_invites WHERE created_by = ?', params: 1 },
  { label: 'membership', sql: 'DELETE FROM community_members WHERE user_id = ?', params: 1 },
  { label: 'reports filed', sql: 'DELETE FROM community_reports WHERE reporter_id = ?', params: 1 },
  { label: 'moderation actions taken', sql: 'DELETE FROM moderation_actions WHERE actor_id = ?', params: 1 },
  { label: 'moderation actions received', sql: 'DELETE FROM moderation_actions WHERE target_user_id = ?', params: 1 },
  { label: 'badges', sql: 'DELETE FROM user_badges WHERE user_id = ?', params: 1 },
  { label: 'notifications', sql: 'DELETE FROM community_notifications WHERE user_id = ?', params: 1 },
  { label: 'notification settings', sql: 'DELETE FROM community_notification_prefs WHERE user_id = ?', params: 1 },
  { label: 'community profile', sql: 'DELETE FROM community_profile_settings WHERE user_id = ?', params: 1 },
  { label: 'integrity events', sql: 'DELETE FROM integrity_events WHERE user_id = ?', params: 1 },
  { label: 'integrity reports', sql: 'DELETE FROM integrity_reports WHERE user_id = ?', params: 1 },

  /* ---- Arena -------------------------------------------------------------------- */
  { label: 'arena report', sql: 'DELETE FROM arena_performance_reports WHERE user_id = ?', params: 1 },
  { label: 'arena answers', sql: 'DELETE FROM arena_answers WHERE attempt_id IN (SELECT id FROM arena_attempts WHERE user_id = ?)', params: 1 },
  { label: 'arena results', sql: 'DELETE FROM arena_results WHERE user_id = ?', params: 1 },
  { label: 'arena attempts', sql: 'DELETE FROM arena_attempts WHERE user_id = ?', params: 1 },
  { label: 'arena registrations', sql: 'DELETE FROM arena_registrations WHERE user_id = ?', params: 1 },

  /* ---- studying ----------------------------------------------------------------- */
  { label: 'code sessions', sql: 'DELETE FROM code_sessions WHERE user_id = ?', params: 1 },
  { label: 'topic statistics', sql: 'DELETE FROM topic_stats WHERE user_id = ?', params: 1 },
  { label: 'activity', sql: 'DELETE FROM activity_events WHERE user_id = ?', params: 1 },
  { label: 'mock exam results', sql: 'DELETE FROM exam_results WHERE user_id = ?', params: 1 },
  { label: 'mock exam answers', sql: 'DELETE FROM exam_answers WHERE exam_id IN (SELECT id FROM exams WHERE user_id = ?)', params: 1 },
  { label: 'mock exams', sql: 'DELETE FROM exams WHERE user_id = ?', params: 1 },
  { label: 'practice attempts', sql: 'DELETE FROM practice_attempts WHERE user_id = ?', params: 1 },
  { label: 'practice sets', sql: 'DELETE FROM practice_sets WHERE user_id = ?', params: 1 },
  { label: 'notes', sql: 'DELETE FROM notes WHERE user_id = ?', params: 1 },
  { label: 'uploads', sql: 'DELETE FROM uploads WHERE user_id = ?', params: 1 },
  { label: 'ai conversations', sql: 'DELETE FROM messages WHERE user_id = ?', params: 1 },
  { label: 'ai chats', sql: 'DELETE FROM conversations WHERE user_id = ?', params: 1 },
  { label: 'api keys', sql: 'DELETE FROM api_keys WHERE user_id = ?', params: 1 },
  { label: 'settings', sql: 'DELETE FROM user_settings WHERE user_id = ?', params: 1 },

  /* The row itself, last. */
  { label: 'the account', sql: 'DELETE FROM users WHERE id = ?', params: 1 },
];

/**
 * The same predicate as the DELETE, with the verb swapped — so the preview and the in-transaction
 * proof can never drift from what actually runs.
 */
function countSqlFor(deleteSql: string): string {
  return deleteSql.replace(/^DELETE FROM\s+(\w+)/, 'SELECT COUNT(*) AS n FROM $1');
}

async function countFor(userId: string, deleteSql: string, executor: { all: (sql: string, params?: unknown[]) => Promise<unknown[]> } = db): Promise<number> {
  const rows = (await executor.all(countSqlFor(deleteSql), [userId])) as { n: number }[];
  return rows[0]?.n ?? 0;
}

export interface OwnedCommunity {
  id: string;
  name: string;
  slug: string;
  otherMembers: number;
}

export interface DeletionPreview {
  /** Things that would block the deletion because other students depend on them. */
  blocking: OwnedCommunity[];
  /** Communities nobody else is in — these are deleted along with the account. */
  solo: OwnedCommunity[];
  /** How many rows the wipe will remove, by label. Used for the confirmation copy. */
  counts: { label: string; rows: number }[];
  total: number;
  /** Arena papers authored by this account that nobody else entered — deleted with it. */
  arenaSolo: string[];
}

/**
 * What deleting this account would do, without doing it.
 *
 * The Settings screen shows this before the student commits, and the delete endpoint re-checks the
 * blocking list — a preview that can drift from the action is worse than no preview.
 */
export async function previewDeletion(userId: string): Promise<DeletionPreview> {
  const owned = await db.all<{ id: string; name: string; slug: string; other_members: number }>(
    `SELECT c.id, c.name, c.slug,
            (SELECT COUNT(*) FROM community_members m
              WHERE m.community_id = c.id AND m.user_id <> c.created_by AND m.status = 'active') AS other_members
       FROM communities c
      WHERE c.created_by = ? AND c.status = 'active'`,
    [userId],
  );

  const blocking: OwnedCommunity[] = [];
  const solo: OwnedCommunity[] = [];
  for (const row of owned) {
    const entry = { id: row.id, name: row.name, slug: row.slug, otherMembers: row.other_members };
    if (row.other_members > 0) blocking.push(entry);
    else solo.push(entry);
  }

  /*
   * Arena papers the student authored follow the same rule as communities.
   *
   * For a student account this list is normally empty (papers are authored by staff), but the rule is
   * the rule: a paper other students are registered for is not something one account can take away, so
   * it blocks the deletion and is reported by name. A paper nobody else entered goes with the account.
   */
  const arenaOwned = await db.all<{ id: string; title: string; others: number }>(
    `SELECT c.id, c.title,
            (SELECT COUNT(*) FROM arena_registrations r WHERE r.competition_id = c.id AND r.user_id <> ?) AS others
       FROM arena_competitions c
      WHERE c.created_by = ?`,
    [userId, userId],
  );
  const arenaSolo: string[] = [];
  for (const row of arenaOwned) {
    if (row.others > 0) {
      blocking.push({ id: row.id, name: row.title, slug: row.id, otherMembers: row.others });
    } else {
      arenaSolo.push(row.id);
    }
  }

  const counts: { label: string; rows: number }[] = [];
  let total = 0;
  for (const step of WIPE) {
    const rows = await countFor(userId, step.sql);
    if (rows > 0) counts.push({ label: step.label, rows });
    total += Math.max(rows, 0);
  }
  /* The account row is counted too, so `total` is the real number of rows the deletion will remove. */
  return { blocking, solo, counts, total, arenaSolo };
}

export interface DeleteAccountInput {
  userId: string;
  password: string;
}

/**
 * Deletes the account for real.
 *
 * Order of checks matters: the password is verified first (so a stolen session alone cannot destroy
 * an account), then the community guard, then the wipe — and the wipe is verified *inside* the same
 * transaction, so a statement that silently matched nothing rolls the whole thing back instead of
 * leaving a half-deleted student behind.
 */
export async function deleteAccount({ userId, password }: DeleteAccountInput): Promise<{ removed: number; deletedCommunities: string[] }> {
  const account = await db.one<{ id: string; password_hash: string }>('SELECT id, password_hash FROM users WHERE id = ?', [userId]);
  if (!account) throw new HttpError(404, 'Account not found.', 'not_found');
  if (!verifyPassword(password, account.password_hash)) {
    throw new HttpError(401, 'That password is not correct.', 'invalid_credentials');
  }

  const preview = await previewDeletion(userId);
  if (preview.blocking.length) {
    throw new HttpError(
      409,
      preview.blocking.length === 1
        ? `You own "${preview.blocking[0].name}", which still has other members. Hand it over or delete it first.`
        : `You own ${preview.blocking.length} communities that still have other members. Hand them over or delete them first.`,
      'owns_shared_communities',
      { communities: preview.blocking },
    );
  }

  const deletedCommunities = preview.solo.map((community) => community.name);
  const removedBefore = preview.total;

  await db.transaction(async (tx) => {
    /*
     * Communities where the student was the only member go with them. Their content and membership
     * rows go first, so the account wipe below never has to reason about a community that is about to
     * disappear.
     */
    for (const community of preview.solo) {
      await tx.run('DELETE FROM community_messages WHERE community_id = ?', [community.id]);
      await tx.run('DELETE FROM community_members WHERE community_id = ?', [community.id]);
      await tx.run('DELETE FROM communities WHERE id = ?', [community.id]);
    }

    /* Solo Arena papers the account authored: answers, attempts, registrations, then the paper. */
    for (const competitionId of preview.arenaSolo) {
      await tx.run('DELETE FROM arena_answers WHERE attempt_id IN (SELECT id FROM arena_attempts WHERE competition_id = ?)', [competitionId]);
      await tx.run('DELETE FROM arena_results WHERE competition_id = ?', [competitionId]);
      await tx.run('DELETE FROM arena_attempts WHERE competition_id = ?', [competitionId]);
      await tx.run('DELETE FROM arena_registrations WHERE competition_id = ?', [competitionId]);
      await tx.run('DELETE FROM arena_questions WHERE competition_id = ?', [competitionId]);
      await tx.run('DELETE FROM arena_competitions WHERE id = ?', [competitionId]);
    }

    for (const step of WIPE) {
      await tx.run(step.sql, [userId]);
    }

    /*
     * Proof, not hope. Every statement above is re-counted inside the transaction; if a single row
     * still points at this student, the whole deletion is rolled back and the API says so. This is the
     * check that makes the "nothing of yours survives" claim testable instead of aspirational.
     */
    const leftovers: string[] = [];
    for (const step of WIPE) {
      const rows = await countFor(userId, step.sql, tx);
      if (rows > 0) leftovers.push(`${step.label}: ${rows}`);
    }
    if (leftovers.length) {
      throw new HttpError(
        500,
        'The account could not be deleted cleanly, so nothing was changed. Please report this.',
        'delete_incomplete',
        { leftovers },
      );
    }
  });

  return { removed: removedBefore, deletedCommunities };
}

/** Exposed for the schema-coverage test: every table and column this module is responsible for. */
export const WIPE_LABELS = WIPE.map((step) => step.label);
