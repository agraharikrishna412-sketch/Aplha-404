/*
 * When a competition happens.
 *
 * A school thinks in dates ("registration closes Friday, exam Saturday 10 am"), not in "starts in 48
 * hours". Both are supported here and both end in the same four ISO instants the server validates, so
 * there is exactly one clock in the product — the host simply chooses how to describe it.
 *
 * The server's own rules (server/src/services/arena/competitions.ts, assertSchedule) are mirrored
 * locally so the host sees what is wrong before pressing Create, instead of reading a 400:
 *   · registration must close after it opens
 *   · the competition cannot start before registration closes
 *   · the competition must end after it starts
 */

export interface ScheduleWindow {
  opens: string;
  closes: string;
  starts: string;
  ends: string;
}

const HOUR = 3_600_000;

/** Quick mode: a start N hours from now, open for M hours. Registration opens immediately. */
export function hoursToWindow(startsInHours: number, windowHours: number): ScheduleWindow {
  const opens = new Date(Date.now() - 60_000);
  const starts = new Date(opens.getTime() + startsInHours * HOUR);
  const ends = new Date(starts.getTime() + windowHours * HOUR);
  const closes = new Date(starts.getTime() - 60_000);
  return { opens: opens.toISOString(), closes: closes.toISOString(), starts: starts.toISOString(), ends: ends.toISOString() };
}

/** `2026-10-02T10:00` — the value shape a `datetime-local` input wants, in the browser's own zone. */
export function toLocalInput(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface DateFields {
  opens: string;
  closes: string;
  starts: string;
  ends: string;
}

/** Exact-date mode, seeded from the quick values so switching modes never loses the schedule. */
export function defaultDates(startsInHours: number, windowHours: number): DateFields {
  const window = hoursToWindow(startsInHours, windowHours);
  return {
    opens: toLocalInput(window.opens),
    closes: toLocalInput(window.closes),
    starts: toLocalInput(window.starts),
    ends: toLocalInput(window.ends),
  };
}

/** Turns the four fields into the instants the API takes. Empty/unreadable fields become Invalid Date. */
export function datesToWindow(fields: DateFields): ScheduleWindow {
  const asIso = (value: string) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
  };
  return {
    opens: asIso(fields.opens),
    closes: asIso(fields.closes),
    starts: asIso(fields.starts),
    ends: asIso(fields.ends),
  };
}

export function parseInstant(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/** The same three rules the server enforces, in the host's words. Returns null when the schedule is fine. */
export function scheduleProblem(window: ScheduleWindow): string | null {
  const opens = parseInstant(window.opens);
  const closes = parseInstant(window.closes);
  const starts = parseInstant(window.starts);
  const ends = parseInstant(window.ends);
  if ([opens, closes, starts, ends].some((v) => Number.isNaN(v))) {
    return 'Fill in all four dates.';
  }
  if (closes <= opens) return 'Registration must close after it opens.';
  if (starts < closes) return 'The exam cannot start before registration closes.';
  if (ends <= starts) return 'The exam must end after it starts.';
  return null;
}

/** "Fri 2 Oct, 10:00 am" — short enough for a summary line, unambiguous about the day. */
export function describeInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** How long the exam window is, in the host's terms. */
export function describeLength(window: ScheduleWindow): string {
  const ms = parseInstant(window.ends) - parseInstant(window.starts);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const hours = Math.round((ms / HOUR) * 10) / 10;
  return hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${Math.round(ms / 60_000)} minutes`;
}
