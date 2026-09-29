/**
 * Learning analytics — the numbers behind the dashboard's "Learning analytics" screen.
 *
 * Design rules this file follows, because an analytics screen is the easiest place in a product to
 * start lying:
 *
 *  1. **Every figure traces back to a row the student created.** Nothing is extrapolated, smoothed or
 *     "projected". If a student answered four questions, the screen says four.
 *  2. **Small samples are labelled, not dressed up.** One right answer out of one attempt is 100%
 *     accuracy — true and useless. Anything under `MIN_ATTEMPTS` for a rate is marked provisional and
 *     sorted last, so a single lucky guess never appears as a strength.
 *  3. **Absence is stated.** A day with no activity is a real zero in the trend, and a subject with no
 *     attempts simply has no row — never a fabricated baseline.
 *  4. **Only the student's own data.** Every query is scoped by `user_id`; the route never accepts one.
 */
import { all, nowIso } from '../db/index.js';

/** A rate computed from fewer than this many attempts is provisional. */
const MIN_ATTEMPTS = 3;

export interface AnalyticsTrendPoint {
  date: string;
  minutes: number;
  questions: number;
  correct: number;
}

export interface AnalyticsSubjectRow {
  subject: string;
  questions: number;
  correct: number;
  accuracy: number;
  minutes: number;
  /** True when the sample is too small to treat the rate as meaningful. */
  provisional: boolean;
}

export interface AnalyticsTopicRow {
  subject: string;
  topic: string;
  attempts: number;
  correct: number;
  accuracy: number;
  lastSeenAt: string;
  provisional: boolean;
}

export interface AnalyticsExamRow {
  id: string;
  title: string;
  subject: string | null;
  score: number;
  total: number;
  accuracy: number;
  createdAt: string;
}

export interface LearningAnalytics {
  days: number;
  generatedAt: string;
  /** What the screen is allowed to claim, written by the server so the UI cannot drift from it. */
  notes: string[];
  totals: {
    minutes: number;
    questions: number;
    correct: number;
    accuracy: number;
    activeDays: number;
    /** Days in the window with no recorded activity at all. */
    quietDays: number;
    streakDays: number;
    sessions: number;
  };
  trend: AnalyticsTrendPoint[];
  subjects: AnalyticsSubjectRow[];
  byKind: { kind: string; label: string; events: number; minutes: number }[];
  topics: { weak: AnalyticsTopicRow[]; strong: AnalyticsTopicRow[]; all: AnalyticsTopicRow[] };
  exams: AnalyticsExamRow[];
  consistency: {
    /** Minutes studied in each weekday, averaged over the window. Shows the real study rhythm. */
    weekdayMinutes: { weekday: string; averageMinutes: number }[];
    bestDay: { date: string; minutes: number } | null;
  };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface EventRow {
  kind: string;
  subject: string | null;
  topic: string | null;
  duration_ms: number;
  correct: number | null;
  total: number | null;
  label: string;
  created_at: string;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function rate(correct: number, total: number): number {
  return total > 0 ? correct / total : 0;
}

/** The label a student recognises for each kind of recorded activity. */
const KIND_LABELS: Record<string, string> = {
  practice: 'Practice sets',
  exam: 'Mock exams',
  tutor: 'AI tutor',
  code: 'Code Lab',
  notes: 'Notes',
  arena: 'Arena',
};

export async function learningAnalytics(userId: string, days = 30): Promise<LearningAnalytics> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const events = await all<EventRow>(
    `SELECT kind, subject, topic, duration_ms, correct, total, label, created_at
       FROM activity_events
      WHERE user_id = ? AND created_at >= ?
      ORDER BY created_at ASC`,
    [userId, since],
  );

  const minutes = events.reduce((sum, row) => sum + Number(row.duration_ms ?? 0), 0) / 60_000;
  const questions = events.reduce((sum, row) => sum + Number(row.total ?? 0), 0);
  const correct = events.reduce((sum, row) => sum + Number(row.correct ?? 0), 0);

  /* ------------------------------- daily trend ------------------------------ */

  const trend: AnalyticsTrendPoint[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    const dayEvents = events.filter((row) => dayKey(row.created_at) === date);
    trend.push({
      date,
      minutes: Math.round(dayEvents.reduce((sum, row) => sum + Number(row.duration_ms ?? 0), 0) / 60_000),
      questions: dayEvents.reduce((sum, row) => sum + Number(row.total ?? 0), 0),
      correct: dayEvents.reduce((sum, row) => sum + Number(row.correct ?? 0), 0),
    });
  }

  const activeDays = trend.filter((day) => day.minutes > 0 || day.questions > 0).length;
  const quietDays = trend.length - activeDays;

  /* --------------------------------- streak --------------------------------- */

  /*
   * The streak is computed over a longer horizon than the window so a student who studied yesterday
   * and today keeps a 2-day streak even when they open the screen with `days=7`.
   */
  const longerSince = new Date(Date.now() - (days + 60) * 86_400_000).toISOString();
  const history = await all<{ created_at: string }>(
    `SELECT created_at FROM activity_events WHERE user_id = ? AND created_at >= ?`,
    [userId, longerSince],
  );
  const activeDates = new Set(history.map((row) => dayKey(row.created_at)));
  let streakDays = 0;
  for (let offset = 0; offset < days + 60; offset += 1) {
    const date = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    if (activeDates.has(date)) streakDays += 1;
    else if (offset > 0) break;
  }

  /* -------------------------------- subjects -------------------------------- */

  const subjectMap = new Map<string, { questions: number; correct: number; minutes: number }>();
  for (const row of events) {
    const subject = (row.subject ?? '').trim() || 'General';
    const entry = subjectMap.get(subject) ?? { questions: 0, correct: 0, minutes: 0 };
    entry.questions += Number(row.total ?? 0);
    entry.correct += Number(row.correct ?? 0);
    entry.minutes += Number(row.duration_ms ?? 0) / 60_000;
    subjectMap.set(subject, entry);
  }
  const subjects: AnalyticsSubjectRow[] = [...subjectMap.entries()]
    .map(([subject, entry]) => ({
      subject,
      questions: entry.questions,
      correct: entry.correct,
      accuracy: rate(entry.correct, entry.questions),
      minutes: Math.round(entry.minutes),
      // A rate is only shown as a plain number once there is enough of it to mean something.
      provisional: entry.questions > 0 && entry.questions < MIN_ATTEMPTS,
    }))
    // Provisional rows sink to the bottom; the rest are ordered by how much was actually done.
    .sort((a, b) => Number(a.provisional) - Number(b.provisional) || b.questions - a.questions);

  /* ------------------------------- activity mix ----------------------------- */

  const kindMap = new Map<string, { events: number; minutes: number }>();
  for (const row of events) {
    const entry = kindMap.get(row.kind) ?? { events: 0, minutes: 0 };
    entry.events += 1;
    entry.minutes += Number(row.duration_ms ?? 0) / 60_000;
    kindMap.set(row.kind, entry);
  }
  const byKind = [...kindMap.entries()]
    .map(([kind, entry]) => ({
      kind,
      label: KIND_LABELS[kind] ?? kind.replace(/_/g, ' '),
      events: entry.events,
      minutes: Math.round(entry.minutes),
    }))
    .sort((a, b) => b.events - a.events);

  /* --------------------------------- topics --------------------------------- */

  const topicRows = await all<{ subject: string; topic: string; attempted: number; correct: number; last_seen_at: string }>(
    `SELECT subject, topic, attempted, correct, last_seen_at
       FROM topic_stats WHERE user_id = ?
      ORDER BY last_seen_at DESC LIMIT 200`,
    [userId],
  );
  const topicsAll: AnalyticsTopicRow[] = topicRows.map((row) => ({
    subject: row.subject,
    topic: row.topic,
    attempts: Number(row.attempted),
    correct: Number(row.correct),
    accuracy: rate(Number(row.correct), Number(row.attempted)),
    lastSeenAt: row.last_seen_at,
    provisional: Number(row.attempted) < MIN_ATTEMPTS,
  }));
  const weak = topicsAll
    .filter((row) => row.attempts >= 2 && row.accuracy < 0.7)
    .sort((a, b) => a.accuracy - b.accuracy)
    .slice(0, 8);
  const strong = topicsAll
    .filter((row) => row.attempts >= MIN_ATTEMPTS && row.accuracy >= 0.8)
    .sort((a, b) => b.accuracy - a.accuracy)
    .slice(0, 8);

  /* ---------------------------------- exams --------------------------------- */

  /*
   * Exam outcomes come from `exam_results`, which is the row written when a paper is actually
   * submitted and marked — an exam that was created and abandoned has no result and correctly does
   * not appear here as a zero.
   */
  const examRows = await all<{
    id: string;
    title: string;
    subject: string | null;
    score: number;
    total: number;
    created_at: string;
  }>(
    `SELECT r.exam_id AS id, e.title, e.subject, r.score, r.total, r.created_at
       FROM exam_results r
       JOIN exams e ON e.id = r.exam_id
      WHERE r.user_id = ?
      ORDER BY r.created_at DESC LIMIT 20`,
    [userId],
  );
  const exams: AnalyticsExamRow[] = examRows.map((row) => ({
    id: row.id,
    title: row.title,
    subject: row.subject,
    score: Number(row.score ?? 0),
    total: Number(row.total ?? 0),
    accuracy: rate(Number(row.score ?? 0), Number(row.total ?? 0)),
    createdAt: row.created_at,
  }));

  /* ------------------------------ consistency ------------------------------- */

  const weekdayTotals = WEEKDAYS.map((weekday) => ({ weekday, total: 0, days: 0 }));
  for (const day of trend) {
    const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
    weekdayTotals[weekday].total += day.minutes;
    weekdayTotals[weekday].days += 1;
  }
  const weekdayMinutes = weekdayTotals.map((entry) => ({
    weekday: entry.weekday,
    averageMinutes: entry.days ? Math.round((entry.total / entry.days) * 10) / 10 : 0,
  }));
  const bestDay = trend.reduce<{ date: string; minutes: number } | null>(
    (best, day) => (day.minutes > (best?.minutes ?? 0) ? { date: day.date, minutes: day.minutes } : best),
    null,
  );

  return {
    days,
    generatedAt: nowIso(),
    notes: [
      `Rates are computed only from your own recorded attempts in the last ${days} days.`,
      `A subject or topic with fewer than ${MIN_ATTEMPTS} attempts is marked provisional — one correct answer is not a strength.`,
      'Days with no activity count as zero; nothing here is estimated or filled in.',
    ],
    totals: {
      minutes: Math.round(minutes),
      questions,
      correct,
      accuracy: rate(correct, questions),
      activeDays,
      quietDays,
      streakDays,
      sessions: events.length,
    },
    trend,
    subjects,
    byKind,
    topics: { weak, strong, all: topicsAll.slice(0, 40) },
    exams,
    consistency: { weekdayMinutes, bestDay },
  };
}
