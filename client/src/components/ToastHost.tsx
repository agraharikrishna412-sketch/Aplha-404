/** Renders the toast stack. Placed at the app root so any feature can raise feedback. */
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useToast, type ToastTone } from '../hooks/useToast';

const ICONS: Record<ToastTone, React.ReactNode> = {
  info: <Info size={15} />,
  success: <CheckCircle2 size={15} />,
  warning: <AlertTriangle size={15} />,
  error: <XCircle size={15} />,
};

const BORDERS: Record<ToastTone, string> = {
  info: 'border-[var(--color-border-strong)]',
  success: 'border-[var(--color-success)]/40',
  warning: 'border-[var(--color-warning)]/40',
  error: 'border-[var(--color-error)]/45',
};

const TEXT: Record<ToastTone, string> = {
  info: 'text-[var(--color-primary)]',
  success: 'text-[#7ee2a8]',
  warning: 'text-[#fcd28b]',
  error: 'text-[#fca5a5]',
};

export function ToastHost() {
  const { toasts, dismiss } = useToast();
  if (!toasts.length) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-3 lg:bottom-5 lg:left-auto lg:right-5 lg:items-end lg:px-0"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          aria-live="polite"
          className={`pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border bg-[var(--color-card)]/98 px-3.5 py-2.5 shadow-2xl backdrop-blur animate-[rise_0.22s_ease-out] ${BORDERS[toast.tone]}`}
        >
          <span className={`mt-0.5 shrink-0 ${TEXT[toast.tone]}`} aria-hidden="true">
            {ICONS[toast.tone]}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-[var(--color-text)]">{toast.title}</p>
            {toast.detail ? <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-muted)]">{toast.detail}</p> : null}
            {toast.action ? (
              <button
                type="button"
                onClick={() => {
                  toast.action?.onClick();
                  dismiss(toast.id);
                }}
                className="vroqn-tap mt-1.5 inline-flex items-center text-[12px] font-medium text-[var(--color-primary)] underline decoration-dotted underline-offset-2"
              >
                {toast.action.label}
              </button>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => dismiss(toast.id)}
            className="shrink-0 rounded p-1 text-[var(--color-muted-dim)] transition-colors hover:bg-white/5 hover:text-[var(--color-text)]"
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
