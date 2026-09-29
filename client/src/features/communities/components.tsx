/**
 * Shared pieces of the Communities UI.
 *
 * Everything visual here is built from the existing kit (`components/ui`) and the existing tokens in
 * `styles.css` — no new palette, no new shadow language, no animation that fights the rest of Vroqn
 * (§48). Controls are real buttons and real links: a keyboard user can do everything a mouse user can,
 * and nothing is hidden behind a hover-only affordance (§52).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Globe, Lock, Link2, Shield, Star, Crown, GraduationCap, Users, Pin } from 'lucide-react';
import { Badge, Button, Card } from '../../components/ui';
import type { CommunityRole, CommunitySummary, CommunityVisibility } from './api';

/* ------------------------------------------------------------------ small atoms ----------------- */

const VISIBILITY_META: Record<CommunityVisibility, { label: string; icon: ReactNode; hint: string }> = {
  public: {
    label: 'Public',
    icon: <Globe size={12} />,
    hint: 'Anyone can join instantly.',
  },
  private: {
    label: 'Private',
    icon: <Lock size={12} />,
    hint: 'Students ask to join and an admin approves.',
  },
  invite_only: {
    label: 'Invite only',
    icon: <Link2 size={12} />,
    hint: 'You need an invite code to get in.',
  },
};

export function VisibilityBadge({ visibility }: { visibility: CommunityVisibility }) {
  const meta = VISIBILITY_META[visibility] ?? VISIBILITY_META.public;
  return (
    <span
      title={meta.hint}
      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1 text-[11px] text-[var(--color-muted)]"
    >
      {meta.icon}
      {meta.label}
    </span>
  );
}

const ROLE_META: Record<CommunityRole, { label: string; tone: 'primary' | 'success' | 'warning' | 'muted'; icon?: ReactNode }> = {
  owner: { label: 'Owner', tone: 'primary', icon: <Crown size={11} /> },
  admin: { label: 'Admin', tone: 'primary', icon: <Shield size={11} /> },
  moderator: { label: 'Moderator', tone: 'success', icon: <Shield size={11} /> },
  mentor: { label: 'Mentor', tone: 'warning', icon: <GraduationCap size={11} /> },
  member: { label: 'Member', tone: 'muted' },
};

export function RoleBadge({ role }: { role: CommunityRole }) {
  const meta = ROLE_META[role] ?? ROLE_META.member;
  return (
    <Badge tone={meta.tone}>
      <span className="inline-flex items-center gap-1">
        {meta.icon}
        {meta.label}
      </span>
    </Badge>
  );
}

function accentClass(accent: string): string {
  switch (accent) {
    case 'violet':
      return 'from-[#7c6cff]/25 to-transparent';
    case 'emerald':
      return 'from-[#3ddc97]/25 to-transparent';
    case 'amber':
      return 'from-[#f5b955]/25 to-transparent';
    case 'rose':
      return 'from-[#ff7a90]/25 to-transparent';
    default:
      return 'from-[var(--color-primary)]/25 to-transparent';
  }
}

/**
 * Community avatar. Uses the uploaded logo when the owner set one, otherwise the initials — never a
 * generated placeholder image, so nothing on screen implies data that does not exist.
 */
export function CommunityAvatar({
  community,
  size = 44,
}: {
  community: Pick<CommunitySummary, 'name' | 'logoUrl' | 'accent'>;
  size?: number;
}) {
  const initials = community.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('');

  if (community.logoUrl) {
    return (
      <img
        src={community.logoUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        className="shrink-0 rounded-xl border border-[var(--color-border)] object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-xl border border-[var(--color-border)] bg-gradient-to-br ${accentClass(
        community.accent,
      )} text-[13px] font-semibold text-[var(--color-text)]`}
      style={{ width: size, height: size }}
    >
      {initials || 'VC'}
    </span>
  );
}

export function VerifiedMark({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      title="Verified by Vroqn: an educator or organisation we have checked."
      className="inline-flex items-center gap-1 rounded-full border border-[var(--color-primary)]/40 bg-[var(--color-primary)]/10 px-2 py-0.5 text-[11px] text-[var(--color-primary)]"
    >
      <Star size={10} /> Verified
    </span>
  );
}

export function MemberCount({ count, limit }: { count: number; limit: number | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
      <Users size={12} />
      {count} {count === 1 ? 'member' : 'members'}
      {limit ? ` / ${limit}` : ''}
    </span>
  );
}

/* ------------------------------------------------------------------ community card ------------- */

export function CommunityCard({
  community,
  onJoin,
  joining,
  footer,
}: {
  community: CommunitySummary;
  onJoin?: (community: CommunitySummary) => void;
  joining?: boolean;
  footer?: ReactNode;
}) {
  const canJoin = !community.myRole && community.joinRequestStatus !== 'pending';

  return (
    <Card className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <CommunityAvatar community={community} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={`/communities/${community.slug}`}
              className="truncate text-[14.5px] font-semibold text-[var(--color-text)] hover:text-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/60"
            >
              {community.name}
            </Link>
            <VerifiedMark show={community.isVerified} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge tone="muted">{community.categoryLabel}</Badge>
            <MemberCount count={community.memberCount} limit={community.memberLimit} />
            <VisibilityBadge visibility={community.visibility} />
            {community.myRole ? <RoleBadge role={community.myRole} /> : null}
          </div>
        </div>
      </div>

      <p className="line-clamp-2 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
        {community.description || 'No description yet.'}
      </p>

      {community.tags.length ? (
        <div className="flex flex-wrap gap-1.5">
          {community.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="rounded-full bg-[var(--color-card)] px-2 py-0.5 text-[11px] text-[var(--color-muted-dim)]">
              #{tag}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-2">
        <Link to={`/communities/${community.slug}`} className="flex-1">
          <Button variant="secondary" className="w-full">
            {community.myRole ? 'Open' : 'View'}
          </Button>
        </Link>
        {community.joinRequestStatus === 'pending' ? (
          <Badge tone="warning">Request pending</Badge>
        ) : canJoin && onJoin ? (
          <Button onClick={() => onJoin(community)} loading={joining} className="flex-1">
            {community.visibility === 'public' ? 'Join' : community.visibility === 'private' ? 'Ask to join' : 'Have a code?'}
          </Button>
        ) : null}
        {footer}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ section shell --------------- */

export function CommunitySection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--color-text)]">{title}</h2>
          {description ? <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ composer -------------------- */

export function Composer({
  placeholder,
  submitLabel = 'Post',
  onSubmit,
  maxLength = 4000,
  minRows = 2,
  busy,
  extra,
}: {
  placeholder: string;
  submitLabel?: string;
  onSubmit: (value: string) => Promise<void> | void;
  maxLength?: number;
  minRows?: number;
  busy?: boolean;
  extra?: (value: string) => ReactNode;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = async () => {
    const text = value.trim();
    if (!text) {
      setError('Write something first.');
      return;
    }
    if (text.length > maxLength) {
      setError(`Keep it under ${maxLength} characters.`);
      return;
    }
    setError(null);
    await onSubmit(text);
    setValue('');
  };

  return (
    <div className="space-y-2">
      <label className="sr-only" htmlFor="community-composer">
        {placeholder}
      </label>
      <textarea
        id="community-composer"
        ref={ref}
        value={value}
        rows={minRows}
        maxLength={maxLength + 200}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        onChange={(event) => {
          setValue(event.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        className="w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2.5 text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-muted-dim)] focus:border-[var(--color-primary)]/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {extra ? extra(value) : null}
          {error ? (
            <span role="alert" className="text-[11.5px] text-[var(--color-error)]">
              {error}
            </span>
          ) : (
            <span className="hidden text-[11px] text-[var(--color-muted-dim)] sm:inline">
              {value.length}/{maxLength} · Ctrl+Enter to post
            </span>
          )}
        </div>
        <Button onClick={submit} loading={busy} disabled={!value.trim()} size="sm">
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pinned banner --------------- */

export function PinnedNote({ children, onDismiss }: { children: ReactNode; onDismiss?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-[12.5px] text-[var(--color-muted)]">
      <Pin size={13} className="mt-0.5 shrink-0 text-[var(--color-primary)]" />
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} className="text-[11px] text-[var(--color-muted-dim)] hover:text-[var(--color-text)]">
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ modal shell ----------------- */

/**
 * A thin wrapper over the kit's `Modal` that adds the dialog title/description ids and restores focus
 * to the element that opened it. The kit already portals to `document.body`, which is what keeps a
 * dialog reachable inside the animated page wrapper (turn-5 fix).
 */
export function useRestoreFocus(open: boolean) {
  const lastFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      lastFocused.current = document.activeElement as HTMLElement | null;
    } else {
      lastFocused.current?.focus?.();
    }
  }, [open]);
}

/* ------------------------------------------------------------------ chat message ---------------- */

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
