/**
 * Arena shared components.
 *
 * One card component drives every competition list so a student sees the same information shape
 * whether they are on the Arena home, the catalog or "my competitions".
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, ClipboardList, Lock, Trophy, Users } from 'lucide-react';
import { Badge, Card, ProgressBar } from '../../components/ui';
import { formatClock, formatDateTime, stateMeta } from '../../lib/arena';
import type { ArenaCompetitionSummary, ArenaDifficulty } from '../../types';

export function StateBadge({ state }: { state: ArenaCompetitionSummary['state'] }) {
  const meta = stateMeta(state);
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function CountdownPill({ iso, label }: { iso: string; label: string }) {
  const remaining = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
  if (remaining <= 0) return null;
  const days = Math.floor(remaining / 86400);
  const text = days >= 1 ? `${label} in ${days}d` : `${label} in ${formatClock(remaining)}`;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-muted)]">
      <CalendarClock size={12} aria-hidden="true" /> {text}
    </span>
  );
}

export function DifficultyMix({ mix }: { mix: Record<ArenaDifficulty, number> }) {
  const parts: { key: ArenaDifficulty; tone: 'success' | 'warning' | 'error' }[] = [
    { key: 'easy', tone: 'success' },
    { key: 'medium', tone: 'warning' },
    { key: 'hard', tone: 'error' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-muted)]">
      {parts
        .filter((part) => mix?.[part.key])
        .map((part) => (
          <span key={part.key} className="inline-flex items-center gap-1.5 capitalize">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                part.tone === 'success'
                  ? 'bg-[var(--color-success)]'
                  : part.tone === 'warning'
                    ? 'bg-[var(--color-warning)]'
                    : 'bg-[var(--color-error)]'
              }`}
              aria-hidden="true"
            />
            {part.key} {mix[part.key]}%
          </span>
        ))}
    </div>
  );
}

export function CompetitionCard({
  competition,
  actions,
  footer,
}: {
  competition: ArenaCompetitionSummary;
  actions?: ReactNode;
  footer?: ReactNode;
}) {
  const meta = stateMeta(competition.state);
  const registered = competition.registration?.status === 'registered';

  return (
    <Card as="li" className="flex flex-col gap-3 p-4" interactive>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StateBadge state={competition.state} />
            <Badge tone="neutral">{competition.categoryLabel}</Badge>
            {competition.isDemo ? <Badge tone="muted">Demo</Badge> : null}
            {competition.visibility === 'private' ? (
              <Badge tone="warning" icon={<Lock size={11} />}>
                Invite only
              </Badge>
            ) : null}
            {registered ? <Badge tone="success">Registered</Badge> : null}
          </div>
          <Link
            to={`/arena/${competition.id}`}
            className="vroqn-tap mt-2 block text-[15px] font-semibold leading-snug text-[var(--color-text)] hover:text-[var(--color-primary)]"
          >
            {competition.title}
          </Link>
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
            {competition.description}
          </p>
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <p className="text-[11px] uppercase tracking-wide text-[var(--color-muted-dim)]">Max score</p>
          <p className="text-[17px] font-semibold">{competition.maxScore}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[12px] text-[var(--color-muted)] sm:grid-cols-4">
        <span className="inline-flex items-center gap-1.5">
          <ClipboardList size={13} aria-hidden="true" /> {competition.questionCount} questions
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CalendarClock size={13} aria-hidden="true" /> {competition.durationMin} min
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Users size={13} aria-hidden="true" /> {competition.participantCount} participating
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Trophy size={13} aria-hidden="true" /> +{competition.marksPerQuestion} / −{competition.negativeMarks}
        </span>
      </div>

      <DifficultyMix mix={competition.difficultyMix} />

      <p className="text-[12px] text-[var(--color-muted)]">
        <span className="text-[var(--color-muted-dim)]">{meta.short} · </span>
        {competition.state === 'REGISTRATION_OPEN'
          ? `Starts ${formatDateTime(competition.startsAt)}`
          : competition.state === 'LIVE'
            ? `Ends ${formatDateTime(competition.endsAt)}`
            : `Held ${formatDateTime(competition.startsAt)}`}
        <span className="mx-1.5 text-[var(--color-border-strong)]">|</span>
        {competition.subjects.join(' · ')}
      </p>

      {footer ? <div className="mt-1">{footer}</div> : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
        {actions ?? (
          <Link
            to={`/arena/${competition.id}`}
            className="inline-flex h-10 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 text-[13px] font-medium transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-card-hover)]"
          >
            View details
          </Link>
        )}
      </div>
    </Card>
  );
}

export function SectionTitle({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h2 className="text-[15px] font-semibold tracking-tight">{children}</h2>
      {note ? <p className="text-[12px] text-[var(--color-muted)]">{note}</p> : null}
    </div>
  );
}

export function AccuracyBar({ value, label }: { value: number; label?: string }) {
  const tone = value >= 75 ? 'success' : value >= 45 ? 'warning' : 'error';
  return <ProgressBar value={value} tone={tone} label={label} />;
}
