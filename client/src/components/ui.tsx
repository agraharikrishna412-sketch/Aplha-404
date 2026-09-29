/**
 * UI kit — every screen is built from these primitives so spacing, borders, focus rings and
 * loading states stay identical across the product (spec §32).
 */
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cloneElement, isValidElement, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

/* --------------------------------- Button -------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--color-primary)] text-[#04161b] hover:bg-[#4defff] active:bg-[#00cfe6] shadow-[0_6px_20px_-10px_rgba(0,229,255,0.7)] font-semibold',
  secondary:
    'bg-[var(--color-card)] text-[var(--color-text)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-card-hover)]',
  ghost: 'bg-transparent text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-white/5',
  danger: 'bg-[var(--color-error)]/15 text-[#fca5a5] border border-[var(--color-error)]/40 hover:bg-[var(--color-error)]/25',
  success: 'bg-[var(--color-success)]/15 text-[#86efac] border border-[var(--color-success)]/40 hover:bg-[var(--color-success)]/25',
};

const SIZES: Record<ButtonSize, string> = {
  /*
   * `vroqn-tap` grows the *touch* target to ~40px without changing the drawn size, so a dense toolbar
   * can keep its 32px buttons on desktop and still be comfortably tappable on a phone. See styles.css.
   */
  sm: 'vroqn-tap h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-[10px]',
  lg: 'h-12 px-5 text-[15px] gap-2 rounded-xl',
  icon: 'h-10 w-10 rounded-[10px] justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, iconRight, block, className = '', children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={[
        'inline-flex items-center justify-center whitespace-nowrap select-none',
        // One shared motion curve keeps hover/press feeling related across the whole product.
        'transition-[transform,background-color,border-color,color,box-shadow] duration-150 ease-[var(--ease-out)]',
        'disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.985]',
        // A pressed primary button should feel like it went down, not just dim.
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]',
        VARIANTS[variant],
        SIZES[size],
        block ? 'w-full' : '',
        className,
      ].join(' ')}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 13 : 15} /> : icon}
      {children}
      {iconRight}
    </button>
  );
});

/* --------------------------------- Spinner ------------------------------- */

export function Spinner({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`animate-spin ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.22" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/* ---------------------------------- Card --------------------------------- */

export function Card({
  children,
  className = '',
  interactive,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return (
    <Tag
      className={[
        // `min-w-0` matters: as a grid or flex child a card defaults to min-width:auto, so it will
        // refuse to shrink below the min-content width of its own contents and push the page wider
        // than the screen. Cards hold text, so shrinking is always the right answer.
        'min-w-0 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)]',
        'shadow-[var(--shadow-card)]',
        // Interactive cards lift by 2px and warm their border — a hover you notice without a glow.
        interactive ? 'vroqn-lift hover:bg-[var(--color-card-hover)]' : '',
        className,
      ].join(' ')}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  subtitle,
  icon,
  right,
  className = '',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3 ${className}`}>
      <div className="flex min-w-0 items-start gap-2.5">
        {icon ? <span className="mt-0.5 text-[var(--color-primary)]">{icon}</span> : null}
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-[var(--color-text)]">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-[12.5px] leading-snug text-[var(--color-muted)]">{subtitle}</p> : null}
        </div>
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
    </div>
  );
}

/* --------------------------------- Badge --------------------------------- */

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'error' | 'muted';

const TONES: Record<Tone, string> = {
  neutral: 'bg-white/[0.04] text-[var(--color-text)] border-[var(--color-border)]',
  primary: 'bg-[var(--color-primary)]/10 text-[var(--color-primary)] border-[var(--color-primary)]/35',
  success: 'bg-[var(--color-success)]/12 text-[#7ee2a8] border-[var(--color-success)]/35',
  warning: 'bg-[var(--color-warning)]/12 text-[#fcd28b] border-[var(--color-warning)]/35',
  error: 'bg-[var(--color-error)]/12 text-[#fca5a5] border-[var(--color-error)]/35',
  muted: 'bg-white/[0.03] text-[var(--color-muted)] border-[var(--color-border)]',
};

export function Badge({
  children,
  tone = 'neutral',
  icon,
  className = '',
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] font-medium leading-5 ${TONES[tone]} ${className}`}
    >
      {icon}
      {children}
    </span>
  );
}

/** Status is never communicated by colour alone — a shape + label is always present (spec §24). */
export function StatusDot({ tone = 'muted', label }: { tone?: Tone; label: string }) {
  const colours: Record<Tone, string> = {
    neutral: 'bg-[var(--color-muted)]',
    primary: 'bg-[var(--color-primary)]',
    success: 'bg-[var(--color-success)]',
    warning: 'bg-[var(--color-warning)]',
    error: 'bg-[var(--color-error)]',
    muted: 'bg-[var(--color-muted-dim)]',
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--color-muted)]">
      <span className={`h-2 w-2 shrink-0 rounded-full ${colours[tone]}`} aria-hidden="true" />
      {label}
    </span>
  );
}

/* -------------------------------- Form bits ------------------------------ */

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  optional,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
  optional?: boolean;
}) {
  /*
   * A field label must name its control even when the caller did not pass `htmlFor` (most call sites
   * do not, because the control is a Vroqn picker rather than a plain input). Without that link a
   * screen reader announces "edit text, blank" for a field the sighted user can read perfectly well
   * — the placeholder is not a name, and it disappears the moment anything is typed. The generated
   * label id is handed to the child, which every control in this codebase passes through to the
   * element it renders.
   */
  const generated = useId();
  const labelId = htmlFor ? undefined : `${generated}-label`;
  /*
   * The first real element child is named. A field may legitimately hold more than one child — the
   * Practice chapter field pairs its input with a `<datalist>` of suggestions — and looking only at a
   * single child silently skipped the label in exactly those cases.
   */
  const target = (Array.isArray(children) ? children : [children]).find((child) => isValidElement(child)) as
    | ReactElement<Record<string, unknown>>
    | undefined;
  const control =
    labelId && target
      ? cloneElement(target, {
          'aria-labelledby': (target.props as { 'aria-labelledby'?: string })['aria-labelledby'] ?? labelId,
        })
      : children;

  return (
    <div className="space-y-1.5">
      <label
        id={labelId}
        htmlFor={htmlFor}
        className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--color-muted)]"
      >
        {label}
        {optional ? <span className="text-[11px] text-[var(--color-muted-dim)]">optional</span> : null}
      </label>
      {control}
      {error ? (
        <p className="text-[12px] text-[#fca5a5]">{error}</p>
      ) : hint ? (
        <p className="text-[12px] text-[var(--color-muted-dim)]">{hint}</p>
      ) : null}
    </div>
  );
}

const FIELD_BASE =
  'w-full rounded-[10px] border bg-[var(--color-surface)] px-3 py-2.5 text-[var(--color-text)] placeholder:text-[var(--color-muted-dim)] transition-colors border-[var(--color-border)] focus:border-[var(--color-primary)]/60 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/25';

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className = '', ...rest },
  ref,
) {
  return <input ref={ref} className={`${FIELD_BASE} h-11 ${className}`} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className = '', ...rest },
  ref,
) {
  return <textarea ref={ref} className={`${FIELD_BASE} min-h-[96px] resize-y leading-relaxed ${className}`} {...rest} />;
});

/*
 * There is deliberately no `Select` export here (§2).
 *
 * A native `<select>` looks like the operating system rather than like Vroqn, and it can neither
 * filter nor explain an option. Long lists use `VroqnSelectMenu` (searchable); short lists use
 * `VroqnFilterSelect` (compact, keyboard driven). Both are real listboxes with proper roles, so
 * keyboard and screen-reader users lose nothing — the replacement is listed screen by screen in
 * `docs/NEXUS-TURN7-REPORT.md`.
 */

/** Segmented control for small choice sets — thumb friendly on mobile. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
  label?: string;
  size?: 'sm' | 'md';
}) {
  const groupRef = useRef<HTMLDivElement | null>(null);

  /*
   * Arrow keys move between segments, as they do in a native radio group. Without this a keyboard
   * user has to Tab through every option to reach the one they want, which is exactly the kind of
   * small friction that makes a filter feel broken.
   */
  const move = (from: number, delta: number) => {
    const next = (from + delta + options.length) % options.length;
    onChange(options[next].value);
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('button');
    buttons?.[next]?.focus();
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      className="flex w-full flex-wrap gap-1 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] p-1"
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            // Roving tabindex: the group is a single stop, then arrows move within it.
            tabIndex={active ? 0 : -1}
            title={option.hint}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                move(index, -1);
              }
            }}
            className={[
              'flex-1 rounded-lg text-center transition-colors duration-150 ease-[var(--ease-out)]',
              // 32px tall visually, 40px of touch target — dense rows stay dense.
              size === 'sm' ? 'vroqn-tap px-2.5 py-1.5 text-[12.5px]' : 'vroqn-tap px-3 py-2 text-[13px]',
              active
                ? 'bg-[var(--color-primary)]/15 font-semibold text-[var(--color-primary)] ring-1 ring-inset ring-[var(--color-primary)]/40'
                : 'text-[var(--color-muted)] hover:bg-white/5 hover:text-[var(--color-text)]',
            ].join(' ')}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  id?: string;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={inputId} className="block text-[13.5px] font-medium text-[var(--color-text)]">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-[12px] leading-snug text-[var(--color-muted)]">{description}</p> : null}
      </div>
      <button
        id={inputId}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={[
          'vroqn-tap relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors',
          checked ? 'border-[var(--color-primary)]/60 bg-[var(--color-primary)]/25' : 'border-[var(--color-border)] bg-[var(--color-surface)]',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-[3px] h-4 w-4 rounded-full transition-all',
            checked ? 'left-[26px] bg-[var(--color-primary)]' : 'left-[3px] bg-[var(--color-muted-dim)]',
          ].join(' ')}
        />
        <span className="sr-only">{checked ? 'On' : 'Off'}</span>
      </button>
    </div>
  );
}

/* ------------------------------ States / misc ---------------------------- */

/**
 * Loading placeholder.
 *
 * A spinner says "something is happening"; a skeleton says "a table with four rows is coming", which
 * is the more useful message and stops the page jumping when data lands. Sized by the caller so it
 * matches the real content.
 */
export function Skeleton({ className = '', rounded = 'md' }: { className?: string; rounded?: 'sm' | 'md' | 'lg' | 'full' }) {
  const radius = { sm: 'rounded', md: 'rounded-lg', lg: 'rounded-xl', full: 'rounded-full' }[rounded];
  return <div aria-hidden="true" className={`vroqn-skeleton ${radius} ${className}`} />;
}

/** A skeleton block shaped like a card, for list and dashboard loading states. */
export function SkeletonCard({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <div
      className={`rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-4 ${className}`}
      aria-hidden="true"
    >
      <Skeleton className="h-4 w-2/5" />
      <div className="mt-3 space-y-2">
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton key={index} className={index === lines - 1 ? 'h-3 w-3/5' : 'h-3 w-full'} rounded="sm" />
        ))}
      </div>
    </div>
  );
}

/**
 * Loading message with a spinner.
 *
 * Always says what is being loaded — "Loading your paper…" beats a bare spinner, because the student
 * can tell the difference between slow and stuck.
 */
export function LoadingState({ message, className = '' }: { message: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center justify-center gap-2.5 py-16 text-[13px] text-[var(--color-muted)] ${className}`}
    >
      <Spinner size={16} className="text-[var(--color-primary)]" />
      {message}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center gap-3 px-6 py-12 text-center ${className}`}>
      {icon ? (
        <span className="grid h-11 w-11 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-primary)]">
          {icon}
        </span>
      ) : null}
      <div>
        <h3 className="text-sm font-semibold text-[var(--color-text)]">{title}</h3>
        {description ? <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-[var(--color-muted)]">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  hint,
  onRetry,
  retryLabel = 'Retry',
  compact,
}: {
  title?: string;
  message: string;
  hint?: string;
  onRetry?: () => void;
  retryLabel?: string;
  compact?: boolean;
}) {
  return (
    <div
      role="alert"
      className={[
        'rounded-xl border border-[var(--color-error)]/35 bg-[var(--color-error)]/[0.07] text-left',
        compact ? 'p-3' : 'p-4',
      ].join(' ')}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-error)]/20 text-[12px] font-bold text-[#fca5a5]">
          !
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-[#fecaca]">{title}</p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-[#fca5a5]/90">{message}</p>
          {hint ? <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-muted)]">{hint}</p> : null}
          {onRetry ? (
            <Button size="sm" variant="secondary" className="mt-2.5" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Horizontal progress bar.
 *
 * `value` is a **ratio** (0–1), not a percentage — percentages must be divided by 100 by the caller.
 * `aria-valuenow` reports 0–100 as ARIA requires.
 */
export function ProgressBar({
  value,
  tone = 'primary',
  label,
  className = '',
}: {
  /** Fraction complete, 0–1 (callers pass percent/100). */
  value: number;
  tone?: Tone;
  label?: string;
  className?: string;
}) {
  const colours: Record<Tone, string> = {
    neutral: 'bg-[var(--color-muted)]',
    primary: 'bg-[var(--color-primary)]',
    success: 'bg-[var(--color-success)]',
    warning: 'bg-[var(--color-warning)]',
    error: 'bg-[var(--color-error)]',
    muted: 'bg-[var(--color-muted-dim)]',
  };
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div
      className={`h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06] ${className}`}
      role="progressbar"
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${colours[tone]}`}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
  tone = 'neutral',
  icon,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: Tone;
  icon?: ReactNode;
}) {
  const valueTone: Record<Tone, string> = {
    neutral: 'text-[var(--color-text)]',
    primary: 'text-[var(--color-primary)]',
    success: 'text-[#7ee2a8]',
    warning: 'text-[#fcd28b]',
    error: 'text-[#fca5a5]',
    muted: 'text-[var(--color-muted)]',
  };
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] uppercase tracking-wide text-[var(--color-muted-dim)]">{label}</span>
        {icon ? <span className="text-[var(--color-muted-dim)]">{icon}</span> : null}
      </div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${valueTone[tone]}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[12px] leading-snug text-[var(--color-muted)]">{sub}</div> : null}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;
  /*
   * Rendered into <body> rather than in place. Any ancestor with a transform, filter, backdrop-filter
   * or `contain` becomes the containing block for a fixed-position descendant — and the page wrapper
   * has an entry animation. Without the portal this overlay was positioned against the page, so on a
   * 360x640 phone the sheet opened at y=615 and the student saw a backdrop and a sliver of text.
   */
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <button className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-label="Close dialog" onClick={onClose} />
      <div
        className={[
          'relative z-10 max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-card)] shadow-2xl animate-[rise_0.22s_ease-out]',
          size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg',
          'sm:rounded-2xl',
        ].join(' ')}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-4 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold">{title}</h2>
            {description ? <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">{description}</p> : null}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </Button>
        </div>
        <div className="px-4 py-4">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3.5">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/** Small inline "no AI connected yet" note so demo/fallback output is never mistaken for a real model answer. */
export function SampleNotice({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/[0.08] px-3 py-2 text-[12px] text-[#fcd28b]">
      <span aria-hidden="true">◈</span>
      <span className="min-w-0 flex-1">{text}</span>
      {action}
    </div>
  );
}
