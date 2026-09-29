/**
 * Exam integrity (anti-cheating) for Arena competitions and personal mock exams.
 *
 * What this file is — and is not.
 *
 * It is **evidence, not a verdict**. A student can lose focus because a parent walked in, because
 * their phone rang or because the electricity failed; that is not cheating. So nothing here blocks,
 * fails or penalises anyone automatically. Every observable event is recorded with a server
 * timestamp, aggregated into a risk score, and shown to the student themselves and (for a hosted
 * competition) to the host. A human decides what it means.
 *
 * Nothing about the paper depends on the browser telling the truth. Timing, question access,
 * submission and scoring are server-authoritative already; a client cannot weaken any of that by
 * lying about these signals, and a suspiciously empty log sits next to the server's own record of
 * when the attempt started and was submitted.
 *
 * Physical cheating cannot be detected by software, and this file does not pretend otherwise. What it
 * does do is remove the *easy* digital routes — a second display, a solver in another tab, a search
 * engine, copy-pasting the paper out — and make the remaining attempts visible after the fact.
 *
 * Two scopes share one mechanism:
 *   - `arena` — a competition attempt (`arena_attempts`, keyed by competition id);
 *   - `exam`  — a personal mock exam (`exams`, keyed by exam id), which only its owner can read.
 */
import { all, nowIso, one, run, uuid } from '../../db/index.js';
import { HttpError } from '../../middleware/errors.js';

/**
 * Every signal a runner may report. The server accepts only these; an unknown kind is dropped rather
 * than stored, so the table cannot be turned into free-form storage by a client.
 */
export const SIGNAL_KINDS = [
  'focus_lost',
  'focus_regained',
  'fullscreen_exit',
  'fullscreen_enter',
  'copy',
  'cut',
  'paste',
  'context_menu',
  'key_blocked',
  'resize',
  'print',
  'devtools_suspect',
  'nav_attempt',
  'extended_display',
  'offline',
  'online',
  'resume',
  'session_start',
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];
export type IntegrityScope = 'arena' | 'exam';

/** Weight per signal, used only to sort papers by how much attention they need. */
const WEIGHTS: Record<SignalKind, number> = {
  focus_lost: 3,
  focus_regained: 0,
  fullscreen_exit: 2,
  fullscreen_enter: 0,
  copy: 4,
  cut: 4,
  paste: 4,
  context_menu: 1,
  key_blocked: 1,
  resize: 1,
  print: 3,
  devtools_suspect: 2,
  nav_attempt: 4,
  extended_display: 5,
  offline: 0,
  online: 0,
  resume: 2,
  session_start: 0,
};

/** Hard cap per paper. A runaway client cannot fill the table, and a truncation is itself recorded. */
const MAX_EVENTS_PER_REF = 400;
const MAX_SIGNALS_PER_REQUEST = 60;

export interface IntegritySignal {
  kind: string;
  detail?: string;
  at?: string;
}

export interface IntegrityReportView {
  scope: IntegrityScope;
  refId: string;
  focusLostCount: number;
  focusLostMs: number;
  fullscreenExits: number;
  copyAttempts: number;
  pasteAttempts: number;
  menuAttempts: number;
  keyBlocks: number;
  resizeCount: number;
  extendedDisplay: boolean;
  resumeCount: number;
  totalEvents: number;
  riskScore: number;
  riskLevel: 'clean' | 'minor' | 'notable' | 'high';
  headline: string;
  updatedAt: string;
}

function levelFor(score: number): IntegrityReportView['riskLevel'] {
  if (score <= 0) return 'clean';
  if (score <= 6) return 'minor';
  if (score <= 18) return 'notable';
  return 'high';
}

function headlineFor(counts: {
  focusLostCount: number;
  fullscreenExits: number;
  copyAttempts: number;
  pasteAttempts: number;
  extendedDisplay: boolean;
  resumeCount: number;
}): string {
  const parts: string[] = [];
  if (counts.focusLostCount > 0) {
    parts.push(`${counts.focusLostCount} time${counts.focusLostCount === 1 ? '' : 's'} the paper lost focus`);
  }
  if (counts.fullscreenExits > 0) parts.push(`${counts.fullscreenExits} full-screen exit${counts.fullscreenExits === 1 ? '' : 's'}`);
  if (counts.copyAttempts > 0) parts.push(`${counts.copyAttempts} copy attempt${counts.copyAttempts === 1 ? '' : 's'}`);
  if (counts.pasteAttempts > 0) parts.push(`${counts.pasteAttempts} paste attempt${counts.pasteAttempts === 1 ? '' : 's'}`);
  if (counts.extendedDisplay) parts.push('a second display was connected');
  if (counts.resumeCount > 1) parts.push(`the paper was reopened ${counts.resumeCount} times`);
  if (!parts.length) return 'Nothing was recorded during this attempt.';
  return `${parts.join(', ')}.`;
}

/* ------------------------------------------------------------------ ownership ------------------- */

interface OwnerRow {
  userId: string;
  open: boolean;
}

/**
 * Resolves who owns a paper and whether its record is still open.
 *
 * Ownership is checked here rather than in the route, so every entry point behaves the same: a paper
 * belonging to another student is a 404, exactly as if it did not exist (§16). There is no way to use
 * these endpoints to probe or read someone else's attempt.
 */
async function resolveOwner(scope: IntegrityScope, refId: string): Promise<OwnerRow | null> {
  if (scope === 'arena') {
    const row = await one<{ user_id: string; status: string }>(
      `SELECT user_id, status FROM arena_attempts WHERE id = ?`,
      [refId],
    );
    if (!row) return null;
    return { userId: row.user_id, open: row.status === 'in_progress' };
  }
  const row = await one<{ user_id: string; status: string }>(`SELECT user_id, status FROM exams WHERE id = ?`, [refId]);
  if (!row) return null;
  return { userId: row.user_id, open: row.status !== 'completed' };
}

/** The attempt id for a student's paper on a competition, so the runner can address it directly. */
export async function arenaAttemptId(userId: string, competitionId: string): Promise<string | null> {
  const row = await one<{ id: string }>(`SELECT id FROM arena_attempts WHERE competition_id = ? AND user_id = ?`, [
    competitionId,
    userId,
  ]);
  return row?.id ?? null;
}

/* ------------------------------------------------------------------ recording ------------------- */

/**
 * Records a batch of signals. `refId` is the attempt id for `arena` and the exam id for `exam`.
 * Signals after submission are refused — the record closes when the paper does.
 */
export async function recordSignals(args: {
  userId: string;
  scope: IntegrityScope;
  refId: string;
  signals: IntegritySignal[];
  device?: string;
}): Promise<{ accepted: number; ignored: number; report: IntegrityReportView | null }> {
  const owner = await resolveOwner(args.scope, args.refId);
  if (!owner || owner.userId !== args.userId) {
    throw new HttpError(404, 'That paper was not found.', 'not_found');
  }

  const valid = new Set<string>(SIGNAL_KINDS);
  const incoming = args.signals.filter((signal) => valid.has(signal.kind)).slice(0, MAX_SIGNALS_PER_REQUEST);
  const ignored = args.signals.length - incoming.length;

  if (!owner.open) {
    return { accepted: 0, ignored: ignored + incoming.length, report: await integrityFor(args.userId, args.scope, args.refId) };
  }

  const existing = await one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM integrity_events WHERE scope = ? AND ref_id = ?`,
    [args.scope, args.refId],
  );
  const room = Math.max(0, MAX_EVENTS_PER_REF - (existing?.total ?? 0));
  const accepted = incoming.slice(0, room);

  const now = nowIso();
  for (const signal of accepted) {
    const occurredAt = signal.at && !Number.isNaN(Date.parse(signal.at)) ? new Date(signal.at).toISOString() : now;
    await run(
      `INSERT INTO integrity_events (id, scope, ref_id, user_id, kind, detail, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        args.scope,
        args.refId,
        args.userId,
        signal.kind,
        String(signal.detail ?? '').slice(0, 300),
        occurredAt,
        now,
      ],
    );
  }
  if (room < incoming.length) {
    await run(
      `INSERT INTO integrity_events (id, scope, ref_id, user_id, kind, detail, occurred_at, created_at)
       VALUES (?, ?, ?, ?, 'key_blocked', ?, ?, ?)`,
      [uuid(), args.scope, args.refId, args.userId, 'signal log truncated at the cap', now, now],
    );
  }

  return { accepted: accepted.length, ignored, report: await recomputeReport(args.scope, args.refId, args.device) };
}

/**
 * Rebuilds the aggregate row from the event log.
 *
 * Recomputing rather than incrementing means a partial write can never leave a count that disagrees
 * with the events. Focus-lost time is measured between a `focus_lost` and the next `focus_regained`,
 * which is why both are recorded.
 */
export async function recomputeReport(
  scope: IntegrityScope,
  refId: string,
  device = '',
): Promise<IntegrityReportView | null> {
  const owner = await resolveOwner(scope, refId);
  if (!owner) return null;

  const events = await all<{ kind: string; occurred_at: string }>(
    `SELECT kind, occurred_at FROM integrity_events WHERE scope = ? AND ref_id = ? ORDER BY occurred_at`,
    [scope, refId],
  );
  const count = (kind: string) => events.filter((event) => event.kind === kind).length;

  let focusLostMs = 0;
  let openedAt: number | null = null;
  for (const event of events) {
    const at = Date.parse(event.occurred_at);
    if (event.kind === 'focus_lost' && openedAt === null) openedAt = at;
    else if (event.kind === 'focus_regained' && openedAt !== null) {
      focusLostMs += Math.max(0, at - openedAt);
      openedAt = null;
    }
  }
  if (openedAt !== null) focusLostMs += Math.max(0, Date.now() - openedAt);

  const focusLostCount = count('focus_lost');
  const fullscreenExits = count('fullscreen_exit');
  const copyAttempts = count('copy') + count('cut');
  const pasteAttempts = count('paste');
  const extendedDisplay = count('extended_display') > 0;
  const resumeCount = count('session_start') + count('resume');

  const riskScore =
    focusLostCount * WEIGHTS.focus_lost +
    fullscreenExits * WEIGHTS.fullscreen_exit +
    copyAttempts * WEIGHTS.copy +
    pasteAttempts * WEIGHTS.paste +
    count('context_menu') * WEIGHTS.context_menu +
    count('key_blocked') * WEIGHTS.key_blocked +
    count('resize') * WEIGHTS.resize +
    (extendedDisplay ? WEIGHTS.extended_display : 0) +
    count('nav_attempt') * WEIGHTS.nav_attempt +
    count('print') * WEIGHTS.print +
    count('devtools_suspect') * WEIGHTS.devtools_suspect +
    Math.max(0, resumeCount - 1) * WEIGHTS.resume;

  const now = nowIso();
  const view: IntegrityReportView = {
    scope,
    refId,
    focusLostCount,
    focusLostMs,
    fullscreenExits,
    copyAttempts,
    pasteAttempts,
    menuAttempts: count('context_menu'),
    keyBlocks: count('key_blocked'),
    resizeCount: count('resize'),
    extendedDisplay,
    resumeCount,
    totalEvents: events.length,
    riskScore,
    riskLevel: levelFor(riskScore),
    headline: headlineFor({ focusLostCount, fullscreenExits, copyAttempts, pasteAttempts, extendedDisplay, resumeCount }),
    updatedAt: now,
  };

  const existing = await one<{ id: string }>(`SELECT id FROM integrity_reports WHERE scope = ? AND ref_id = ?`, [scope, refId]);
  const columns = [
    view.focusLostCount,
    Math.round(view.focusLostMs),
    view.fullscreenExits,
    view.copyAttempts,
    view.pasteAttempts,
    view.menuAttempts,
    view.keyBlocks,
    view.resizeCount,
    view.extendedDisplay ? 1 : 0,
    view.resumeCount,
    view.totalEvents,
    view.riskScore,
    view.riskLevel,
    (device || '').slice(0, 200),
    now,
  ];

  if (existing) {
    await run(
      `UPDATE integrity_reports SET
         focus_lost_count = ?, focus_lost_ms = ?, fullscreen_exits = ?, copy_attempts = ?, paste_attempts = ?,
         menu_attempts = ?, key_blocks = ?, resize_count = ?, extended_display = ?, resume_count = ?,
         total_events = ?, risk_score = ?, risk_level = ?, device = ?, updated_at = ?
       WHERE scope = ? AND ref_id = ?`,
      [...columns, scope, refId],
    );
  } else {
    await run(
      `INSERT INTO integrity_reports
         (id, scope, ref_id, user_id, focus_lost_count, focus_lost_ms, fullscreen_exits, copy_attempts, paste_attempts,
          menu_attempts, key_blocks, resize_count, extended_display, resume_count, total_events, risk_score, risk_level,
          device, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      // 20 placeholders: id, scope, ref, owner, the 14 measured values + device, then created_at and
      // updated_at. Missing the last one made the very first report for a paper fail to write.
      [uuid(), scope, refId, owner.userId, ...columns, now],
    );
  }

  return view;
}

/* ------------------------------------------------------------------ reading --------------------- */

interface ReportRow {
  scope: string;
  ref_id: string;
  focus_lost_count: number;
  focus_lost_ms: number;
  fullscreen_exits: number;
  copy_attempts: number;
  paste_attempts: number;
  menu_attempts: number;
  key_blocks: number;
  resize_count: number;
  extended_display: number;
  resume_count: number;
  total_events: number;
  risk_score: number;
  risk_level: string;
  updated_at: string;
}

function toView(row: ReportRow): IntegrityReportView {
  return {
    scope: row.scope === 'exam' ? 'exam' : 'arena',
    refId: row.ref_id,
    focusLostCount: row.focus_lost_count,
    focusLostMs: row.focus_lost_ms,
    fullscreenExits: row.fullscreen_exits,
    copyAttempts: row.copy_attempts,
    pasteAttempts: row.paste_attempts,
    menuAttempts: row.menu_attempts,
    keyBlocks: row.key_blocks,
    resizeCount: row.resize_count,
    extendedDisplay: row.extended_display === 1,
    resumeCount: row.resume_count,
    totalEvents: row.total_events,
    riskScore: row.risk_score,
    riskLevel: (['clean', 'minor', 'notable', 'high'] as const).includes(row.risk_level as IntegrityReportView['riskLevel'])
      ? (row.risk_level as IntegrityReportView['riskLevel'])
      : 'clean',
    headline: headlineFor({
      focusLostCount: row.focus_lost_count,
      fullscreenExits: row.fullscreen_exits,
      copyAttempts: row.copy_attempts,
      pasteAttempts: row.paste_attempts,
      extendedDisplay: row.extended_display === 1,
      resumeCount: row.resume_count,
    }),
    updatedAt: row.updated_at,
  };
}

function emptyReport(scope: IntegrityScope, refId: string): IntegrityReportView {
  return {
    scope,
    refId,
    focusLostCount: 0,
    focusLostMs: 0,
    fullscreenExits: 0,
    copyAttempts: 0,
    pasteAttempts: 0,
    menuAttempts: 0,
    keyBlocks: 0,
    resizeCount: 0,
    extendedDisplay: false,
    resumeCount: 0,
    totalEvents: 0,
    riskScore: 0,
    riskLevel: 'clean',
    headline: 'Nothing was recorded during this attempt.',
    updatedAt: nowIso(),
  };
}

/** A student's own record for their own paper. Someone else's paper is a 404. */
export async function integrityFor(
  userId: string,
  scope: IntegrityScope,
  refId: string,
): Promise<IntegrityReportView> {
  const owner = await resolveOwner(scope, refId);
  if (!owner || owner.userId !== userId) throw new HttpError(404, 'That paper was not found.', 'not_found');

  const row = await one<ReportRow>(`SELECT * FROM integrity_reports WHERE scope = ? AND ref_id = ?`, [scope, refId]);
  return row ? toView(row) : emptyReport(scope, refId);
}

export interface HostIntegrityRow extends IntegrityReportView {
  userId: string;
  name: string;
  submitted: boolean;
  submittedAt: string | null;
}

/**
 * Integrity overview for the person who owns a hosted competition (or an admin).
 *
 * Authorisation is the caller's, never a flag in the request: only `created_by` on the competition or
 * a site admin gets this, and anyone else gets 404. Personal mock exams have no host view at all —
 * they are the student's own practice, and nobody else reads them.
 */
export async function competitionIntegrity(args: {
  userId: string;
  competitionId: string;
  isAdmin: boolean;
}): Promise<{ rows: HostIntegrityRow[]; flagged: number; participants: number; policy: string }> {
  const competition = await one<{ id: string; created_by: string | null }>(
    `SELECT id, created_by FROM arena_competitions WHERE id = ?`,
    [args.competitionId],
  );
  if (!competition) throw new HttpError(404, 'That competition was not found.', 'not_found');
  if (!args.isAdmin && competition.created_by !== args.userId) {
    throw new HttpError(404, 'That competition was not found.', 'not_found');
  }

  const attempts = await all<
    Partial<ReportRow> & { attempt_id: string; user_id: string; name: string | null; status: string; submitted_at: string | null }
  >(
    `SELECT a.id AS attempt_id, a.user_id, a.status, a.submitted_at, u.name, r.*
       FROM arena_attempts a
       LEFT JOIN integrity_reports r ON r.scope = 'arena' AND r.ref_id = a.id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.competition_id = ?
      ORDER BY COALESCE(r.risk_score, 0) DESC, a.created_at`,
    [args.competitionId],
  );

  const rows: HostIntegrityRow[] = attempts.map((row) => ({
    ...(row.ref_id
      ? toView(row as ReportRow)
      : {
          ...emptyReport('arena', row.attempt_id),
          headline:
            'No signals recorded — the runner never reported for this device. That is not itself suspicious (an old browser or a blocked script looks the same), but it is worth noting.',
        }),
    userId: row.user_id,
    name: row.name ?? 'A Vroqn student',
    submitted: row.status === 'submitted',
    submittedAt: row.submitted_at,
  }));

  const flagged = rows.filter((row) => row.riskLevel === 'notable' || row.riskLevel === 'high').length;
  return {
    rows,
    flagged,
    participants: rows.length,
    policy:
      'Signals are recorded for every Arena paper. Nothing is failed automatically: the host reads the row and decides. ' +
      'Timing, question access, submission and scoring are enforced by the server independently of these signals.',
  };
}
