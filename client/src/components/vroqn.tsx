/**
 * The `Vroqn*` component set (§2).
 *
 * This is a **facade, not a fork**. Everything that already existed — Button, Card, Field, Switch,
 * Segmented, Modal, EmptyState, Skeleton, ProgressBar — is re-exported under the Vroqn name so pages
 * have one vocabulary and one place to change a radius, a density or a motion tier. Only the pieces
 * the product was missing are implemented here: Avatar, IconButton, Section, Tabs, Sheet,
 * SelectMenu, ChatBubble, MessageComposer and PermissionControl.
 *
 * Rules this file keeps:
 *  - every interactive control is at least 44×44 CSS px on a phone (`vroqn-tap`);
 *  - colour comes from tokens only, never from a literal, so a theme change is one file;
 *  - motion is short, interruptible and disabled for `prefers-reduced-motion`;
 *  - nothing here renders a "giant empty box": empty states always carry an action.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Clock3, Search, Send, X } from 'lucide-react';
import { initials } from '../lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, ProgressBar, Segmented, Skeleton, Spinner, Switch, TextArea, TextInput } from './ui';

export {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  ProgressBar,
  Segmented,
  Skeleton,
  Spinner,
  Switch,
  TextArea,
  TextInput,
};

/* ------------------------------------------------------------------ identity --------------------- */

const AVATAR_SIZES = { xs: 24, sm: 32, md: 40, lg: 56, xl: 88 } as const;
export type VroqnAvatarSize = keyof typeof AVATAR_SIZES;

/**
 * Avatar.
 *
 * Renders the uploaded image when there is one and initials when there is not — never a broken image
 * placeholder, and never a stock photo that would misrepresent a real student.
 */
export function VroqnAvatar({
  name,
  src,
  size = 'md',
  accent,
  status,
  className = '',
}: {
  name: string;
  src?: string | null;
  size?: VroqnAvatarSize;
  accent?: string | null;
  status?: 'online' | 'typing' | null;
  className?: string;
}) {
  const pixels = AVATAR_SIZES[size];
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;
  return (
    <span className={`relative inline-flex shrink-0 ${className}`} style={{ width: pixels, height: pixels }}>
      {showImage ? (
        <img
          src={src as string}
          alt=""
          width={pixels}
          height={pixels}
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full rounded-full border object-cover"
          style={{ borderColor: accent ? `${accent}55` : 'var(--color-border)' }}
        />
      ) : (
        <span
          aria-hidden="true"
          className="grid h-full w-full place-items-center rounded-full border font-semibold"
          style={{
            fontSize: Math.round(pixels * 0.36),
            borderColor: accent ? `${accent}55` : 'var(--color-border)',
            background: accent ? `${accent}18` : 'var(--color-surface)',
            color: accent ?? 'var(--color-primary)',
          }}
        >
          {initials(name || 'Student')}
        </span>
      )}
      {status === 'online' ? (
        <span
          aria-label="Online now"
          className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[var(--color-card)] bg-[var(--color-success)]"
        />
      ) : null}
      {status === 'typing' ? (
        <span
          aria-label="Typing"
          className="absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full border-2 border-[var(--color-card)] bg-[var(--color-primary)] text-[8px] font-bold text-black"
        >
          …
        </span>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------ controls --------------------- */

/** Square icon button with a real 44px target and a label that screen readers can read. */
export function VroqnIconButton({
  label,
  children,
  variant = 'ghost',
  ...rest
}: { label: string; children: ReactNode; variant?: 'ghost' | 'secondary' | 'danger' } & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label'
>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={[
        'vroqn-tap grid h-11 w-11 shrink-0 place-items-center rounded-[10px] border transition-colors',
        variant === 'danger'
          ? 'border-[var(--color-error)]/35 text-[var(--color-error)] hover:bg-[var(--color-error)]/10'
          : variant === 'secondary'
            ? 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-[var(--color-border-strong)]'
            : 'border-transparent text-[var(--color-muted)] hover:bg-white/5 hover:text-[var(--color-text)]',
      ].join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Labelled group of controls. Replaces the old habit of stacking loose boxes. */
export function VroqnSection({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`space-y-3 ${className}`}>
      {title || action ? (
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            {title ? <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">{description}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * Tabs.
 *
 * A horizontal strip that scrolls on a narrow phone instead of wrapping into two ragged rows, with
 * the full ARIA tab pattern so a keyboard user can arrow between tabs.
 */
export function VroqnTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { value: T; label: string; count?: number; icon?: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      className="vroqn-no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0"
    >
      {tabs.map((tab, index) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.value)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const delta = event.key === 'ArrowRight' ? 1 : -1;
              const next = tabs[(index + delta + tabs.length) % tabs.length];
              onChange(next.value);
              ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[tabs.indexOf(next)]?.focus();
            }}
            className={[
              'vroqn-tap flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-2 text-[12.5px] transition-colors',
              active
                ? 'border-[var(--color-primary)]/40 bg-[var(--color-primary)]/12 font-semibold text-[var(--color-primary)]'
                : 'border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]',
            ].join(' ')}
          >
            {tab.icon}
            {tab.label}
            {typeof tab.count === 'number' && tab.count > 0 ? (
              <span className="rounded-full bg-white/10 px-1.5 text-[11px] tabular-nums">{tab.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Bottom sheet on a phone, centred dialog on a desktop.
 *
 * One implementation so every screen behaves the same way: Escape closes, the page behind cannot
 * scroll, focus returns to whatever opened it, and the panel is a labelled dialog.
 */
export function VroqnSheet({
  open,
  onClose,
  title,
  description,
  footer,
  children,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = (document.activeElement as HTMLElement) ?? null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Focus the panel itself rather than the first control, so a screen reader reads the title first.
    window.setTimeout(() => panelRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus?.();
    };
  }, [onClose, open]);

  if (!open) return null;
  const width = { sm: 'sm:max-w-md', md: 'sm:max-w-xl', lg: 'sm:max-w-3xl' }[size];

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
      <button className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-label="Close" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={[
          'relative flex max-h-[90dvh] w-full flex-col border border-[var(--color-border)] bg-[var(--color-card)]',
          'rounded-t-2xl sm:rounded-2xl animate-[rise_0.2s_ease-out] outline-none',
          width,
        ].join(' ')}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[14.5px] font-semibold">{title}</h2>
            {description ? <p className="mt-0.5 text-[12px] leading-snug text-[var(--color-muted)]">{description}</p> : null}
          </div>
          <VroqnIconButton label="Close" onClick={onClose}>
            <X size={17} />
          </VroqnIconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer ? <footer className="border-t border-[var(--color-border)] px-4 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}

/**
 * Searchable select.
 *
 * Replaces every long native `<select>` in the product: on a phone a native picker with 40 subjects
 * is a scroll-hunt, and this one filters as you type and works with the keyboard alone.
 */
export function VroqnSelectMenu<T extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = 'Choose…',
  searchPlaceholder = 'Search…',
  emptyText = 'Nothing matches that search.',
  disabled,
}: {
  value: T | null;
  options: { value: T; label: string; hint?: string; group?: string }[];
  onChange: (value: T) => void;
  label: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const id = useId();
  const selected = options.find((option) => option.value === value) ?? null;

  const filtered = useMemo(() => {
    const needle = term.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        (option.hint ?? '').toLowerCase().includes(needle) ||
        (option.group ?? '').toLowerCase().includes(needle),
    );
  }, [options, term]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const option of filtered) {
      const key = option.group ?? '';
      map.set(key, [...(map.get(key) ?? []), option]);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <div>
      <button
        type="button"
        id={id}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="vroqn-tap flex w-full items-center justify-between gap-2 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-left text-[13.5px] text-[var(--color-text)] transition-colors hover:border-[var(--color-border-strong)] disabled:opacity-60"
      >
        <span className={selected ? 'truncate' : 'truncate text-[var(--color-muted)]'}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={16} className="shrink-0 text-[var(--color-muted)]" />
      </button>

      <VroqnSheet open={open} onClose={() => setOpen(false)} title={label} size="sm">
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
            <Search size={15} className="shrink-0 text-[var(--color-muted)]" />
            <input
              autoFocus
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="min-h-[40px] min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-[var(--color-muted-dim)]"
            />
            {term ? (
              <button type="button" aria-label="Clear search" onClick={() => setTerm('')} className="text-[var(--color-muted)]">
                <X size={14} />
              </button>
            ) : null}
          </div>

          {filtered.length === 0 ? (
            <p className="px-1 py-6 text-center text-[13px] text-[var(--color-muted)]">{emptyText}</p>
          ) : (
            <ul role="listbox" aria-label={label} className="space-y-1">
              {grouped.map(([group, entries]) => (
                <li key={group || 'all'}>
                  {group ? (
                    <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-dim)]">
                      {group}
                    </p>
                  ) : null}
                  <ul className="space-y-0.5">
                    {entries.map((option) => {
                      const active = option.value === value;
                      return (
                        <li key={option.value}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={active}
                            onClick={() => {
                              onChange(option.value);
                              setOpen(false);
                              setTerm('');
                            }}
                            className={[
                              'vroqn-tap flex w-full items-center justify-between gap-3 rounded-[10px] px-3 py-2.5 text-left text-[13.5px] transition-colors',
                              active
                                ? 'bg-[var(--color-primary)]/12 font-medium text-[var(--color-primary)]'
                                : 'text-[var(--color-text)] hover:bg-white/5',
                            ].join(' ')}
                          >
                            <span className="min-w-0">
                              <span className="block truncate">{option.label}</span>
                              {option.hint ? (
                                <span className="block truncate text-[11.5px] text-[var(--color-muted)]">{option.hint}</span>
                              ) : null}
                            </span>
                            {active ? <Check size={15} className="shrink-0" /> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </VroqnSheet>
    </div>
  );
}

/**
 * Permission toggle for the roles matrix (§10–13).
 *
 * Renders a switch with the permission's plain-language meaning beside it, and shows the inherited
 * state when a child role's value comes from its parent rather than from this row.
 */
export function VroqnPermissionControl({
  label,
  description,
  checked,
  inherited,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  inherited?: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-[var(--color-text)]">{label}</p>
        <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--color-muted)]">{description}</p>
        {inherited ? <Badge tone="muted">From a higher role</Badge> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={[
          'vroqn-tap relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-50',
          checked ? 'border-[var(--color-primary)]/60 bg-[var(--color-primary)]/25' : 'border-[var(--color-border)] bg-[var(--color-card)]',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-[3px] h-4 w-4 rounded-full transition-all',
            checked ? 'left-[26px] bg-[var(--color-primary)]' : 'left-[3px] bg-[var(--color-muted-dim)]',
          ].join(' ')}
        />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ chat ------------------------- */

/**
 * One message bubble.
 *
 * The states a private message can be in are all real: sending, sent, edited, deleted (tombstone),
 * and "we cannot read this on this device yet". The last one is rendered as a plain, calm line —
 * not an error — because it is a normal state while keys arrive.
 */
export function VroqnChatBubble({
  mine,
  author,
  avatar,
  text,
  time,
  state = 'sent',
  reactions,
  onReact,
  onReply,
  onEdit,
  onDelete,
  onReport,
  onBlock,
  replyTo,
  unreadable = false,
  children,
}: {
  mine: boolean;
  author?: string;
  avatar?: ReactNode;
  text: string | null;
  time: string;
  state?: 'sending' | 'sent' | 'edited' | 'deleted';
  reactions?: { emoji: string; count: number; mine: boolean }[];
  onReact?: (emoji: string) => void;
  onReply?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onReport?: () => void;
  onBlock?: () => void;
  replyTo?: { author: string; text: string } | null;
  unreadable?: boolean;
  children?: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const longPress = useRef<number | null>(null);
  const hasMenu = Boolean(onReply || onEdit || onDelete || onReport || onBlock);

  return (
    <div className={`flex w-full gap-2 ${mine ? 'justify-end' : 'justify-start'}`}>
      {!mine && avatar ? <span className="mt-0.5">{avatar}</span> : null}
      <div className={`min-w-0 max-w-[85%] sm:max-w-[70%] ${mine ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
        <div
          role="group"
          aria-label={`${mine ? 'You' : (author ?? 'They')} · ${time}`}
          tabIndex={hasMenu ? 0 : -1}
          onContextMenu={(event) => {
            if (!hasMenu) return;
            event.preventDefault();
            setMenuOpen(true);
          }}
          onTouchStart={() => {
            if (!hasMenu) return;
            longPress.current = window.setTimeout(() => setMenuOpen(true), 450);
          }}
          onTouchEnd={() => {
            if (longPress.current) window.clearTimeout(longPress.current);
          }}
          onKeyDown={(event) => {
            if (hasMenu && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              setMenuOpen(true);
            }
          }}
          className={[
            'rounded-2xl border px-3.5 py-2.5 text-[14px] leading-relaxed',
            mine
              ? 'rounded-br-md border-[var(--color-primary)]/25 bg-[var(--color-primary)]/[0.09]'
              : 'rounded-bl-md border-[var(--color-border)] bg-[var(--color-card)]',
          ].join(' ')}
        >
          {replyTo ? (
            <p className="mb-1.5 border-l-2 border-[var(--color-border-strong)] pl-2 text-[11.5px] text-[var(--color-muted)]">
              <span className="font-medium text-[var(--color-text)]">{replyTo.author}</span> · {replyTo.text.slice(0, 90)}
            </p>
          ) : null}

          {state === 'deleted' ? (
            <p className="text-[13px] italic text-[var(--color-muted-dim)]">This message was deleted.</p>
          ) : unreadable ? (
            <p className="text-[13px] text-[var(--color-muted)]">
              Encrypted message — this device does not have the key for it yet.
            </p>
          ) : text !== null ? (
            <p className="whitespace-pre-wrap break-words">{text}</p>
          ) : (
            <span className="inline-flex gap-1" aria-label="Decrypting">
              <Skeleton className="h-3.5 w-24" />
            </span>
          )}

          {children}
        </div>

        <div className={`flex flex-wrap items-center gap-2 px-1 text-[11px] text-[var(--color-muted-dim)] ${mine ? 'justify-end' : ''}`}>
          <span className="inline-flex items-center gap-1">
            <Clock3 size={11} aria-hidden="true" />
            {time}
          </span>
          {state === 'edited' ? <span>· edited</span> : null}
          {state === 'sending' ? <span>· sending…</span> : null}
          {reactions?.length ? (
            <span className="flex flex-wrap gap-1">
              {reactions.map((reaction) => (
                <button
                  key={reaction.emoji}
                  type="button"
                  onClick={() => onReact?.(reaction.emoji)}
                  aria-label={`${reaction.emoji} ${reaction.count}`}
                  className={[
                    'vroqn-tap rounded-full border px-1.5 py-0.5 text-[11.5px]',
                    reaction.mine
                      ? 'border-[var(--color-primary)]/40 bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
                      : 'border-[var(--color-border)] text-[var(--color-muted)]',
                  ].join(' ')}
                >
                  {reaction.emoji} {reaction.count}
                </button>
              ))}
            </span>
          ) : null}
          {onReact ? (
            <span className="flex gap-0.5">
              {['👍', '💡', '🎯'].map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => onReact(emoji)}
                  aria-label={`React with ${emoji}`}
                  className="vroqn-tap rounded-full px-1 text-[13px] opacity-70 hover:opacity-100"
                >
                  {emoji}
                </button>
              ))}
            </span>
          ) : null}
        </div>
      </div>

      {menuOpen ? (
        <div className="fixed inset-0 z-[70] flex items-end sm:items-center sm:justify-center" role="dialog" aria-label="Message actions">
          <button className="absolute inset-0 bg-black/60" aria-label="Close" onClick={() => setMenuOpen(false)} />
          <div className="relative w-full max-w-sm space-y-1 rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-card)] p-3 sm:rounded-2xl">
            {onReply ? <MenuRow label="Reply" onClick={() => { onReply(); setMenuOpen(false); }} /> : null}
            {reactions?.length || onReact ? (
              <div className="flex items-center gap-1 px-1 py-1">
                {['👍', '💡', '🎯', '🙏', '✅'].map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      onReact?.(emoji);
                      setMenuOpen(false);
                    }}
                    className="vroqn-tap rounded-full px-2 text-[18px]"
                    aria-label={`React with ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            ) : null}
            {onEdit ? <MenuRow label="Edit" onClick={() => { onEdit(); setMenuOpen(false); }} /> : null}
            {onDelete ? <MenuRow label="Delete" danger onClick={() => { onDelete(); setMenuOpen(false); }} /> : null}
            {onReport ? <MenuRow label="Report" onClick={() => { onReport(); setMenuOpen(false); }} /> : null}
            {onBlock ? <MenuRow label="Block" danger onClick={() => { onBlock(); setMenuOpen(false); }} /> : null}
            <MenuRow label="Cancel" onClick={() => setMenuOpen(false)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MenuRow({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'vroqn-tap block w-full rounded-[10px] px-3 py-2.5 text-left text-[13.5px] transition-colors hover:bg-white/5',
        danger ? 'text-[var(--color-error)]' : 'text-[var(--color-text)]',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

/**
 * Composer.
 *
 * Enter sends, Shift+Enter makes a new line, and the send button is disabled with a *reason* rather
 * than silently inert — the difference between a working product and one that feels broken.
 */
export function VroqnMessageComposer({
  value,
  onChange,
  onSend,
  onTyping,
  placeholder = 'Write a message…',
  disabled,
  disabledReason,
  maxLength = 4000,
  extra,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onTyping?: () => void;
  placeholder?: string;
  disabled?: boolean;
  disabledReason?: string | null;
  maxLength?: number;
  extra?: ReactNode;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const remaining = maxLength - value.length;
  const canSend = !disabled && value.trim().length > 0 && remaining >= 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-end gap-2 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 focus-within:border-[var(--color-border-strong)]">
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value);
            onTyping?.();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (canSend) onSend();
            }
          }}
          placeholder={disabled ? (disabledReason ?? 'You cannot send right now.') : placeholder}
          aria-label="Message"
          className="max-h-36 min-h-[40px] flex-1 resize-none bg-transparent px-1 py-2 text-[14px] leading-relaxed outline-none placeholder:text-[var(--color-muted-dim)] disabled:opacity-70"
        />
        {extra}
        <VroqnIconButton label="Send message" variant="secondary" disabled={!canSend} onClick={onSend}>
          <Send size={17} />
        </VroqnIconButton>
      </div>
      <div className="flex items-center justify-between px-1 text-[11px] text-[var(--color-muted-dim)]">
        <span>{disabled && disabledReason ? disabledReason : 'Enter sends · Shift+Enter adds a line'}</span>
        {remaining < 400 ? <span className={remaining < 0 ? 'text-[var(--color-error)]' : ''}>{remaining} left</span> : null}
      </div>
    </div>
  );
}

/** Small labelled input row used by sheet forms. */
export function VroqnInput({
  label,
  hint,
  ...rest
}: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field label={label} hint={hint}>
      <TextInput {...rest} />
    </Field>
  );
}

/**
 * Compact Vroqn filter select — the replacement for a native `<select>` on short lists.
 *
 * Two different reasons to avoid the OS picker, and they need two different controls:
 *  - a long list (40 subjects, 60 chapters) is a scroll-hunt in a native picker, so it gets
 *    `VroqnSelectMenu`, which filters as you type;
 *  - a short list ("All roles", "Unanswered / Answered / All") is quick, but a native picker still
 *    looks like the operating system, not like Vroqn, and it cannot show a hint or a count.
 *
 * This is the second kind. It is a button plus an anchored listbox in a portal, so it never gets
 * clipped by a scrolling tab panel, and it is fully keyboard-driven: Enter or Space opens it, the
 * arrow keys move, Enter picks, Escape closes and returns focus to the button. A pointer user gets
 * the same list in one tap.
 */
export function VroqnFilterSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = 'All',
  size = 'md',
  className = '',
  align = 'start',
}: {
  /**
   * The value union includes '' when a filter has an "all" choice, so a caller can keep its own state
   * type: `'open' | 'solved' | 'all'` stays `'open' | 'solved' | 'all'`, never widened to `string`.
   */
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
  /** Accessible name. Rendered as `aria-label`; also used by the browser suites. */
  label: string;
  placeholder?: string;
  size?: 'sm' | 'md';
  className?: string;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const id = useId();

  const selected = options.find((option) => option.value === value) ?? null;

  const place = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const box = button.getBoundingClientRect();
    const width = Math.min(Math.max(box.width, 190), Math.min(320, window.innerWidth - 16));
    const left = align === 'end' ? Math.min(box.right - width, window.innerWidth - width - 8) : Math.min(box.left, window.innerWidth - width - 8);
    setRect({ top: box.bottom + 6, left: Math.max(8, left), width });
  }, [align]);

  // Keep the panel glued to its button: the list is portalled, so scrolling would otherwise detach it.
  useEffect(() => {
    if (!open) return;
    place();
    const onScroll = () => place();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    /* Focus the list so the arrow keys work immediately, without stealing the page's scroll. */
    const timer = window.setTimeout(() => listRef.current?.focus({ preventScroll: true }), 0);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, options, value]);

  const choose = (next: T) => {
    onChange(next);
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
  };

  const height = size === 'sm' ? 'h-9 text-[12.5px]' : 'h-10 text-[13px]';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        id={id}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
        className={[
          'vroqn-tap inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-2.5 text-[var(--color-text)] transition-colors hover:border-[var(--color-border-strong)]',
          height,
          className,
        ].join(' ')}
      >
        <span className={selected && selected.value !== '' ? 'truncate' : 'truncate text-[var(--color-muted)]'}>
          {selected && selected.value !== '' ? selected.label : placeholder}
        </span>
        <ChevronDown size={14} className="shrink-0 text-[var(--color-muted)]" />
      </button>

      {open && rect
        ? createPortal(
            <ul
              ref={listRef}
              role="listbox"
              tabIndex={-1}
              aria-label={label}
              style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveIndex((current) => {
                    const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
                    return (next + options.length) % options.length;
                  });
                  return;
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  const option = options[activeIndex];
                  if (option) choose(option.value);
                  return;
                }
                if (event.key === 'Home') {
                  event.preventDefault();
                  setActiveIndex(0);
                  return;
                }
                if (event.key === 'End') {
                  event.preventDefault();
                  setActiveIndex(options.length - 1);
                }
              }}
              className="vroqn-scroll-y z-[70] max-h-[280px] overflow-y-auto rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-elevated)] p-1 shadow-[0_18px_40px_-18px_rgba(0,0,0,0.85)] outline-none"
            >
              {options.map((option, index) => {
                const isSelected = option.value === value;
                return (
                  <li
                    key={option.value || '__all'}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => choose(option.value)}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={[
                      'flex cursor-pointer items-center justify-between gap-2 rounded-[7px] px-2.5 py-2 text-[13px]',
                      index === activeIndex ? 'bg-[var(--color-surface)]' : '',
                      isSelected ? 'font-semibold text-[var(--color-primary)]' : 'text-[var(--color-text)]',
                    ].join(' ')}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{option.label}</span>
                      {option.hint ? <span className="block truncate text-[11.5px] text-[var(--color-muted)]">{option.hint}</span> : null}
                    </span>
                    {isSelected ? <Check size={14} className="shrink-0" /> : null}
                  </li>
                );
              })}
            </ul>,
            document.body,
          )
        : null}
    </>
  );
}
