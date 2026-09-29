/**
 * Confirmation for destructive actions.
 *
 * Every destructive control in the product previously called `window.confirm`: deleting a note,
 * removing an API key, erasing learning activity, discarding an attempt. That works — it does ask
 * before acting — but it is the one piece of the interface we do not control. It renders in the OS
 * chrome rather than the product, cannot say *which* note is about to be deleted in a styled way,
 * cannot offer a safe default, and on some mobile browsers can be suppressed entirely, in which case
 * `confirm()` returns false and the button silently does nothing.
 *
 * This provider gives those five call sites a dialog that matches the product, always names the
 * object being destroyed, defaults focus to the safe choice, and returns a promise so the call sites
 * read the same way they did before:
 *
 *     if (!(await confirm({ title: 'Delete note?', … }))) return;
 *
 * Accessibility: it is a real `role="dialog"` with `aria-modal`, focus is moved into it on open and
 * restored on close, Escape cancels, and Tab is trapped so a keyboard user cannot wander onto the
 * page behind it.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { Button } from './ui';

export interface ConfirmOptions {
  title: string;
  /** What will happen, in plain language. Say what is kept, not only what is lost. */
  description?: string;
  /** Names the exact thing being acted on — a note title, a key label. */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` for deletion, `primary` for "are you sure?" steps that are not destructive. */
  tone?: 'danger' | 'primary';
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusTo = useRef<Element | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      returnFocusTo.current = typeof document === 'undefined' ? null : document.activeElement;
      setPending({ ...options, resolve });
    });
  }, []);

  const settle = useCallback(
    (value: boolean) => {
      setPending((current) => {
        current?.resolve(value);
        return null;
      });
    },
    [],
  );

  /* Escape cancels; Tab stays inside the dialog. */
  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        settle(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [pending, settle]);

  useEffect(() => {
    if (!pending) return;
    // Focus the confirming action: a keyboard user should not have to hunt for the button they met
    // the dialog to press. Escape is the documented way out, and the label says what it does.
    const timer = window.setTimeout(() => confirmButtonRef.current?.focus(), 30);
    return () => {
      window.clearTimeout(timer);
      const target = returnFocusTo.current;
      if (target instanceof HTMLElement) target.focus();
    };
  }, [pending]);

  const value = useMemo(() => confirm, [confirm]);

  if (!pending) return <ConfirmContext.Provider value={value}>{children}</ConfirmContext.Provider>;

  const danger = (pending.tone ?? 'danger') === 'danger';

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {/* Portalled for the same reason as Modal: an ancestor transform would otherwise become this
          fixed overlay's containing block and push the dialog off-screen. */}
      {createPortal(
      <div
        className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vroqn-confirm-title"
        aria-describedby={pending.description ? 'vroqn-confirm-body' : undefined}
      >
        <button
          type="button"
          className="absolute inset-0 bg-black/72 backdrop-blur-sm"
          aria-label="Cancel and close"
          onClick={() => settle(false)}
        />

        <div
          ref={panelRef}
          className="vroqn-glass relative z-10 w-full max-h-[92dvh] overflow-y-auto rounded-t-2xl border border-[var(--color-border)] p-5 shadow-[var(--shadow-float)] animate-[rise_0.22s_var(--ease-out)] sm:max-w-md sm:rounded-2xl"
        >
          <div className="flex items-start gap-3.5">
            <span
              aria-hidden="true"
              className={[
                'mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-full border',
                danger
                  ? 'border-[var(--color-error)]/40 bg-[var(--color-error)]/12 text-[#fca5a5]'
                  : 'border-[var(--color-primary)]/40 bg-[var(--color-primary)]/12 text-[var(--color-primary)]',
              ].join(' ')}
            >
              <AlertTriangle size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="vroqn-confirm-title" className="text-[15.5px] font-semibold leading-snug text-[var(--color-text)]">
                {pending.title}
              </h2>
              {pending.description ? (
                <p id="vroqn-confirm-body" className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-muted)]">
                  {pending.description}
                </p>
              ) : null}
              {pending.detail ? (
                <p className="mt-2.5 truncate rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-text)]">
                  {pending.detail}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => settle(false)} className="sm:w-auto" block>
              {pending.cancelLabel ?? 'Cancel'}
            </Button>
            <Button
              ref={confirmButtonRef}
              variant={danger ? 'danger' : 'primary'}
              onClick={() => settle(true)}
              block
              className="sm:w-auto"
            >
              {pending.confirmLabel ?? 'Yes, continue'}
            </Button>
          </div>
        </div>
      </div>,
      document.body,
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const context = useContext(ConfirmContext);
  if (!context) throw new Error('useConfirm must be used inside ConfirmProvider');
  return context;
}
