/**
 * Learning Activity (spec §21).
 *
 * Purpose: help the student see their own progress. Everything here is derived from actions the
 * student took inside the app, is visible to them, and can be cleared from AI Settings.
 * There is no covert tracking: listActivity() returns exactly the same rows that power the UI.
 */
import * as db from '../db/index.js';
import { nowIso, uuid } from '../db/index.js';
import type { ActivityEvent, ActivityKind, LearningSummary, TopicStat } from '../types/domain.js';

interface ActivityRow {
  id: string;
  kind: string;
  subject: string | null;
  topic: string | null;
  duration_ms: number;
  correct: number | null;
  total: number | null;
  label: string;
  meta: string | null;
  created_at: string;
}

function toEvent(row: ActivityRow): ActivityEvent {
  return {
    id: row.id,
    kind: row.kind as ActivityKind,
    subject: row.subject,
    topic: row.topic,
    durationMs: Number(row.duration_ms ?? 0),
    correct: row.correct === null ? null : Number(row.correct),
    total: row.total === null ? null : Number(row.total),
    label: row.label,
    meta: db.json<Record<string, unknown> | null>(row.meta, null),
    createdAt: row.created_at,
  };
}

export async function recordActivity(args: {
  userId: string;
  kind: ActivityKind;
  label: string;
  subject?: string | null;
  topic?: string | null;
  durationMs?: number;
  correct?: number | null;
  total?: number | null;
  meta?: Record<string, unknown> | null;
}): Promise<ActivityEvent> {
  const id = uuid();
  const createdAt = nowIso();
  await db.run(
    `INSERT INTO activity_events (id, user_id, kind, subject, topic, duration_ms, correct, total, label, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      args.userId,
      args.kind,
      args.subject ?? null,
      args.topic ?? null,
      Math.max(0, Math.round(args.durationMs ?? 0)),
      args.correct ?? null,
      args.total ?? null,
      args.label.slice(0, 180),
      args.meta ? JSON.stringify(args.meta) : null,
      createdAt,
    ],
  );
  return {
    id,
    kind: args.kind,
    subject: args.subject ?? null,
    topic: args.topic ?? null,
    durationMs: Math.round(args.durationMs ?? 0),
    correct: args.correct ?? null,
    total: args.total ?? null,
    label: args.label,
    meta: args.meta ?? null,
    createdAt,
  };
}

export async function listActivity(userId: string, limit = 50): Promise<ActivityEvent[]> {
  const rows = await db.all<ActivityRow>(
    'SELECT * FROM activity_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [userId, limit],
  );
  return rows.map(toEvent);
}

export async function clearActivity(userId: string): Promise<void> {
  await db.run('DELETE FROM activity_events WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM topic_stats WHERE user_id = ?', [userId]);
}

/** Topic mastery tracking — powers "weak areas", practice suggestions and revision plans. */
export async function recordTopicResult(args: {
  userId: string;
  subject: string;
  topic: string;
  isCorrect: boolean;
}): Promise<void> {
  const existing = await db.one<{ id: string; attempted: number; correct: number }>(
    'SELECT id, attempted, correct FROM topic_stats WHERE user_id = ? AND subject = ? AND topic = ?',
    [args.userId, args.subject, args.topic],
  );
  if (existing) {
    await db.run('UPDATE topic_stats SET attempted = ?, correct = ?, last_seen_at = ? WHERE id = ?', [
      Number(existing.attempted) + 1,
      Number(existing.correct) + (args.isCorrect ? 1 : 0),
      nowIso(),
      existing.id,
    ]);
  } else {
    await db.run(
      'INSERT INTO topic_stats (id, user_id, subject, topic, attempted, correct, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuid(), args.userId, args.subject, args.topic, 1, args.isCorrect ? 1 : 0, nowIso()],
    );
  }
}

export async function listTopicStats(userId: string, limit = 40): Promise<TopicStat[]> {
  const rows = await db.all<{ subject: string; topic: string; attempted: number; correct: number; last_seen_at: string }>(
    'SELECT subject, topic, attempted, correct, last_seen_at FROM topic_stats WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT ?',
    [userId, limit],
  );
  return rows.map((r) => ({
    subject: r.subject,
    topic: r.topic,
    attempted: Number(r.attempted),
    correct: Number(r.correct),
    lastSeenAt: r.last_seen_at,
  }));
}

/** Weak = accuracy < 70% with at least 2 attempts; strong = accuracy >= 80% with at least 3. */
export function classifyTopics(stats: TopicStat[]): {
  weak: { subject: string; topic: string; accuracy: number; attempted: number }[];
  strong: { subject: string; topic: string; accuracy: number; attempted: number }[];
} {
  const scored = stats.map((s) => ({
    subject: s.subject,
    topic: s.topic,
    attempted: s.attempted,
    accuracy: s.attempted ? s.correct / s.attempted : 0,
  }));
  return {
    weak: scored
      .filter((s) => s.attempted >= 2 && s.accuracy < 0.7)
      .sort((a, b) => a.accuracy - b.accuracy)
      .slice(0, 6),
    strong: scored
      .filter((s) => s.attempted >= 3 && s.accuracy >= 0.8)
      .sort((a, b) => b.accuracy - a.accuracy)
      .slice(0, 6),
  };
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export async function learningSummary(userId: string, days = 7): Promise<LearningSummary> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await db.all<ActivityRow>(
    'SELECT * FROM activity_events WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC',
    [userId, since],
  );
  const today = new Date().toISOString().slice(0, 10);
  const todays = rows.filter((r) => dayKey(r.created_at) === today);

  const sum = (list: ActivityRow[], field: 'duration_ms') => list.reduce((acc, r) => acc + Number(r[field] ?? 0), 0);
  const attempted = rows.reduce((acc, r) => acc + Number(r.total ?? 0), 0);
  const correct = rows.reduce((acc, r) => acc + Number(r.correct ?? 0), 0);

  const bySubjectMap = new Map<string, { minutes: number; attempted: number; correct: number }>();
  for (const row of rows) {
    const subject = row.subject ?? 'General';
    const entry = bySubjectMap.get(subject) ?? { minutes: 0, attempted: 0, correct: 0 };
    entry.minutes += Number(row.duration_ms ?? 0) / 60_000;
    entry.attempted += Number(row.total ?? 0);
    entry.correct += Number(row.correct ?? 0);
    bySubjectMap.set(subject, entry);
  }

  const timeline: { day: string; minutes: number; questions: number }[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const dayRows = rows.filter((r) => dayKey(r.created_at) === date);
    timeline.push({
      day: date,
      minutes: Math.round(sum(dayRows, 'duration_ms') / 60_000),
      questions: dayRows.reduce((acc, r) => acc + Number(r.total ?? 0), 0),
    });
  }

  // Streak: consecutive days ending today with at least one recorded event.
  const activeDays = new Set(rows.map((r) => dayKey(r.created_at)));
  let streakDays = 0;
  for (let i = 0; i < days + 30; i += 1) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    if (activeDays.has(date)) streakDays += 1;
    else if (i > 0) break;
  }

  const examRows = todays.filter((r) => r.kind === 'exam' && r.total);
  const bestExam = examRows.length
    ? examRows.reduce(
        (best, r) =>
          Number(r.correct ?? 0) / Number(r.total ?? 1) > Number(best.correct ?? 0) / Number(best.total ?? 1) ? r : best,
        examRows[0],
      )
    : rows.find((r) => r.kind === 'exam' && r.total && dayKey(r.created_at) === today && dayKey(r.created_at)) ?? null;

  const topicStats = await listTopicStats(userId);
  const { weak, strong } = classifyTopics(topicStats);

  return {
    date: today,
    minutes: Math.round(sum(todays, 'duration_ms') / 60_000),
    questionsAttempted: todays.reduce((acc, r) => acc + Number(r.total ?? 0), 0),
    questionsCorrect: todays.reduce((acc, r) => acc + Number(r.correct ?? 0), 0),
    accuracy: attempted ? Math.round((correct / attempted) * 100) / 100 : 0,
    notesOrganized: todays.filter((r) => r.kind === 'notes').length,
    codeMinutes: Math.round(todays.filter((r) => r.kind === 'code').reduce((a, r) => a + Number(r.duration_ms ?? 0), 0) / 60_000),
    tutorMinutes: Math.round(
      todays.filter((r) => r.kind === 'tutor').reduce((a, r) => a + Number(r.duration_ms ?? 0), 0) / 60_000,
    ),
    examsTaken: todays.filter((r) => r.kind === 'exam').length,
    bestExam: bestExam
      ? { score: Number(bestExam.correct ?? 0), total: Number(bestExam.total ?? 0), subject: bestExam.subject ?? 'Mixed' }
      : null,
    weakTopics: weak,
    strongTopics: strong,
    streakDays,
    bySubject: [...bySubjectMap.entries()]
      .map(([subject, v]) => ({
        subject,
        minutes: Math.round(v.minutes),
        attempted: v.attempted,
        correct: v.correct,
      }))
      .sort((a, b) => b.minutes - a.minutes),
    timeline,
  };
}
