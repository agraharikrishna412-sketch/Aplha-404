/**
 * AI connection trace — makes the failover engine visible instead of mysterious (spec §12, §25).
 * Students see which connection answered, and — when something fails — that the app is retrying
 * on their next key automatically rather than hanging.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, RotateCcw, Zap } from 'lucide-react';
import { Badge, Button } from './ui';
import type { RouterEvent } from '../types';

export interface TraceEntry {
  kind: 'plan' | 'attempt' | 'failed' | 'restart' | 'done' | 'error';
  providerLabel: string;
  model?: string;
  keyLabel?: string;
  failure?: string;
  message?: string;
  willRetry?: boolean;
  attempt?: number;
  maxAttempts?: number;
}

export function traceEntryFromEvent(event: RouterEvent): TraceEntry | null {
  switch (event.type) {
    case 'plan':
      return { kind: 'plan', providerLabel: event.plan.reason };
    case 'attempt':
      return {
        kind: 'attempt',
        providerLabel: event.providerLabel,
        model: event.model,
        keyLabel: event.keyLabel,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
      };
    case 'attempt_failed':
      return {
        kind: 'failed',
        providerLabel: event.providerLabel,
        model: event.model,
        keyLabel: event.keyLabel,
        failure: event.failure,
        message: event.message,
        willRetry: event.willRetry,
      };
    case 'restart':
      return { kind: 'restart', providerLabel: event.reason };
    case 'done':
      return {
        kind: 'done',
        providerLabel: event.demo ? 'Sample engine' : event.provider,
        model: event.model,
        keyLabel: event.keyLabel,
        attempt: event.attempts,
      };
    case 'error':
      return { kind: 'error', providerLabel: event.message, failure: event.failure, message: event.hint };
    default:
      return null;
  }
}

const FAILURE_LABELS: Record<string, string> = {
  rate_limit: 'rate limited',
  quota_exhausted: 'daily quota reached',
  server_error: 'provider server error',
  timeout: 'timed out',
  network: 'network problem',
  invalid_key: 'key rejected',
  auth: 'authentication failed',
  model_unavailable: 'model unavailable',
  provider_unavailable: 'provider unavailable',
  safety: 'blocked by safety filter',
  bad_request: 'request rejected',
  empty_response: 'empty response',
  unsupported: 'not supported',
  no_keys: 'no key configured',
  aborted: 'stopped',
  unknown: 'unexpected error',
};

/** Compact single-line status shown while streaming. */
export function TraceStatus({ entries, onRetry }: { entries: TraceEntry[]; onRetry?: () => void }) {
  const last = entries[entries.length - 1];
  if (!last) return null;

  if (last.kind === 'error') {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-error)]/35 bg-[var(--color-error)]/[0.08] px-3 py-2 text-[12.5px] text-[#fca5a5]">
        <AlertTriangle size={14} aria-hidden="true" />
        <span className="min-w-0 flex-1">{last.providerLabel}</span>
        {onRetry ? (
          <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  }

  if (last.kind === 'done') return null;

  const message =
    last.kind === 'failed'
      ? `${last.providerLabel} is unavailable (${FAILURE_LABELS[last.failure ?? ''] ?? last.failure}). ${
          last.willRetry ? 'Trying your next available AI connection…' : ''
        }`
      : last.kind === 'restart'
        ? last.providerLabel
        : `Asking ${last.providerLabel}${last.model ? ` · ${last.model}` : ''}…`;

  return (
    <div
      className={[
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px]',
        last.kind === 'failed'
          ? 'border-[var(--color-warning)]/35 bg-[var(--color-warning)]/[0.07] text-[#fcd28b]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)]',
      ].join(' ')}
      role="status"
      aria-live="polite"
    >
      {last.kind === 'failed' ? <RotateCcw size={14} className="animate-spin-slow" aria-hidden="true" /> : <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{message}</span>
      {last.attempt && last.maxAttempts && last.kind === 'attempt' ? (
        <span className="shrink-0 text-[11px] text-[var(--color-muted-dim)]">
          try {last.attempt}/{last.maxAttempts}
        </span>
      ) : null}
    </div>
  );
}

/** "Served by" footer under a finished answer, with an expandable trace. */
export function AnswerMeta({
  provider,
  model,
  keyLabel,
  attempts,
  fellBack,
  demo,
  latencyMs,
  onRetry,
  onKeepAliveNote,
}: {
  provider?: string;
  model?: string;
  keyLabel?: string;
  attempts?: number;
  fellBack?: boolean;
  demo?: boolean;
  latencyMs?: number;
  onRetry?: () => void;
  onKeepAliveNote?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!provider && !demo) return null;

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--color-muted-dim)]">
      {demo ? (
        <Badge tone="warning" icon={<Zap size={11} />}>
          Sample answer — no AI key connected
        </Badge>
      ) : (
        <Badge tone={fellBack ? 'warning' : 'primary'} icon={fellBack ? <RotateCcw size={11} /> : <Check size={11} />}>
          {fellBack ? `Answered after failover · ${provider}` : `Answered by ${provider}`}
        </Badge>
      )}
      {model && !demo ? <span className="font-mono text-[11px]"> {model}</span> : null}
      {latencyMs ? <span>· {(latencyMs / 1000).toFixed(1)}s</span> : null}
      {attempts && attempts > 1 ? <span>· {attempts} attempts</span> : null}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="vroqn-tap inline-flex items-center text-[11.5px] text-[var(--color-muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-text)]"
        aria-expanded={open}
      >
        {open ? 'Hide details' : 'Details'}
      </button>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="vroqn-tap inline-flex items-center text-[11.5px] text-[var(--color-muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-text)]"
        >
          Regenerate
        </button>
      ) : null}
      {open ? (
        <dl className="mt-1 w-full space-y-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-[var(--color-muted-dim)]">Provider</dt>
            <dd className="min-w-0 break-all text-[var(--color-muted)]">{demo ? 'Built-in sample engine' : provider}</dd>
          </div>
          {model ? (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-[var(--color-muted-dim)]">Model</dt>
              <dd className="min-w-0 break-all font-mono text-[var(--color-muted)]">{model}</dd>
            </div>
          ) : null}
          {keyLabel ? (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-[var(--color-muted-dim)]">Key used</dt>
              <dd className="min-w-0 break-all text-[var(--color-muted)]">{keyLabel}</dd>
            </div>
          ) : null}
          {attempts ? (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-[var(--color-muted-dim)]">Attempts</dt>
              <dd className="text-[var(--color-muted)]">
                {attempts}
                {fellBack ? ' (failover used)' : ''}
              </dd>
            </div>
          ) : null}
          {onKeepAliveNote ? (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-[var(--color-muted-dim)]">Note</dt>
              <dd className="text-[var(--color-muted)]">{onKeepAliveNote}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

/** Delayed "still working" hint so slow answers never look frozen (spec §8). */
export function SlowHint({ active, seconds = 8, message }: { active: boolean; seconds?: number; message: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), seconds * 1000);
    return () => window.clearTimeout(timer);
  }, [active, seconds]);
  if (!visible) return null;
  return <p className="mt-2 text-[12px] text-[var(--color-muted-dim)]">{message}</p>;
}
