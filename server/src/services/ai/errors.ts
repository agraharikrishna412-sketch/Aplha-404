/**
 * Failure taxonomy (spec §13) and the retry policy attached to each kind.
 *
 * The policy is what the fallback engine consults, so behaviour is data-driven rather than
 * a pile of if-statements sprinkled across providers.
 */
import type { ProviderId } from '../../config/models.js';

export type FailureKind =
  | 'rate_limit'
  | 'quota_exhausted'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'invalid_key'
  | 'auth'
  | 'model_unavailable'
  | 'provider_unavailable'
  | 'safety'
  | 'bad_request'
  | 'empty_response'
  | 'unsupported'
  | 'no_keys'
  | 'aborted'
  | 'unknown';

export interface RetryPolicy {
  /** Try another key of the same provider (spec: key rotation). */
  otherKeys: boolean;
  /** Same key, same model may be retried once for flaky transport errors. */
  sameKeyRetry: boolean;
  /** Try the next model of the same provider. */
  otherModels: boolean;
  /** Move on to the next provider. */
  otherProviders: boolean;
  /** Park this key (cooldown) and mark it as problematic. */
  parkKey: boolean;
  /** Key is permanently suspicious → surface in AI Settings. */
  markKeyInvalid: boolean;
  /** Safe to show the raw provider message to the student. */
  showUpstream: boolean;
  /** Student-facing explanation. */
  userMessage: string;
}

export const FAILURE_POLICY: Record<FailureKind, RetryPolicy> = {
  rate_limit: {
    otherKeys: true,
    sameKeyRetry: false,
    // Some providers rate-limit per model, so another model may work with the same key.
    otherModels: true,
    otherProviders: true,
    parkKey: true,
    markKeyInvalid: false,
    showUpstream: true,
    userMessage: 'This key hit its rate limit.',
  },
  quota_exhausted: {
    otherKeys: true,
    sameKeyRetry: false,
    otherModels: false,
    otherProviders: true,
    parkKey: true,
    markKeyInvalid: false,
    showUpstream: true,
    userMessage: 'Daily quota for this key looks exhausted.',
  },
  server_error: {
    otherKeys: true,
    sameKeyRetry: false,
    otherModels: true,
    otherProviders: true,
    parkKey: true,
    markKeyInvalid: false,
    showUpstream: false,
    userMessage: 'The provider had a temporary server error.',
  },
  timeout: {
    otherKeys: true,
    sameKeyRetry: false,
    otherModels: true,
    otherProviders: true,
    parkKey: true,
    markKeyInvalid: false,
    showUpstream: false,
    userMessage: 'The request timed out.',
  },
  network: {
    otherKeys: true,
    sameKeyRetry: false,
    otherModels: true,
    otherProviders: true,
    parkKey: false,
    markKeyInvalid: false,
    showUpstream: false,
    userMessage: 'Network problem while reaching the provider.',
  },
  invalid_key: {
    otherKeys: true,
    sameKeyRetry: false,
    otherModels: false,
    otherProviders: true,
    parkKey: true,
    markKeyInvalid: true,
    showUpstream: true,
    userMessage: 'This API key was rejected.',
  },
  auth: {
    otherKeys: true,
    sameKeyRetry: false,
    otherModels: false,
    otherProviders: true,
    parkKey: true,
    markKeyInvalid: true,
    showUpstream: true,
    userMessage: 'Authentication failed for this key.',
  },
  model_unavailable: {
    otherKeys: false,
    sameKeyRetry: false,
    otherModels: true,
    otherProviders: true,
    parkKey: false,
    markKeyInvalid: false,
    showUpstream: true,
    userMessage: 'This model is not available on your account.',
  },
  provider_unavailable: {
    otherKeys: false,
    sameKeyRetry: true,
    otherModels: true,
    otherProviders: true,
    parkKey: false,
    markKeyInvalid: false,
    showUpstream: true,
    userMessage: 'The provider looks unavailable right now.',
  },
  // Content-policy rejections are surfaced, never re-routed to another provider (spec §13).
  safety: {
    otherKeys: false,
    sameKeyRetry: false,
    otherModels: false,
    otherProviders: false,
    parkKey: false,
    markKeyInvalid: false,
    showUpstream: true,
    userMessage: 'The provider blocked this request with its safety filter.',
  },
  bad_request: {
    otherKeys: false,
    sameKeyRetry: false,
    otherModels: false,
    otherProviders: true,
    parkKey: false,
    markKeyInvalid: false,
    showUpstream: true,
    userMessage: 'The provider rejected the request shape.',
  },
  empty_response: {
    otherKeys: true,
    sameKeyRetry: true,
    otherModels: true,
    otherProviders: true,
    parkKey: false,
    markKeyInvalid: false,
    showUpstream: false,
    userMessage: 'The model returned an empty response.',
  },
  unsupported: {
    otherKeys: false,
    sameKeyRetry: false,
    otherModels: true,
    otherProviders: true,
    parkKey: false,
    markKeyInvalid: false,
    showUpstream: true,
    userMessage: 'This provider cannot handle that request type.',
  },
  no_keys: {
    otherKeys: false,
    sameKeyRetry: false,
    otherModels: false,
    otherProviders: true,
    parkKey: false,
    markKeyInvalid: false,
    showUpstream: false,
    userMessage: 'No enabled API key is configured for this provider.',
  },
  aborted: {
    otherKeys: false,
    sameKeyRetry: false,
    otherModels: false,
    otherProviders: false,
    parkKey: false,
    markKeyInvalid: false,
    showUpstream: false,
    userMessage: 'Generation stopped.',
  },
  unknown: {
    otherKeys: true,
    sameKeyRetry: false,
    otherModels: true,
    otherProviders: true,
    parkKey: true,
    markKeyInvalid: false,
    showUpstream: true,
    userMessage: 'Something unexpected happened with this connection.',
  },
};

export class AIError extends Error {
  kind: FailureKind;
  provider?: ProviderId;
  model?: string;
  status?: number;
  /** Any text already streamed before the failure — used to decide restart vs resume. */
  partialText?: string;
  upstream?: string;

  constructor(args: {
    kind: FailureKind;
    message: string;
    provider?: ProviderId;
    model?: string;
    status?: number;
    partialText?: string;
    upstream?: string;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = 'AIError';
    this.kind = args.kind;
    this.provider = args.provider;
    this.model = args.model;
    this.status = args.status;
    this.partialText = args.partialText;
    this.upstream = args.upstream;
    if (args.cause) (this as { cause?: unknown }).cause = args.cause;
  }

  get policy(): RetryPolicy {
    return FAILURE_POLICY[this.kind];
  }

  get retryable(): boolean {
    const p = this.policy;
    return p.otherKeys || p.otherModels || p.otherProviders || p.sameKeyRetry;
  }
}

/** Maps an HTTP status + provider error body onto the failure taxonomy. */
export function classifyHttpFailure(
  provider: ProviderId,
  status: number,
  body: unknown,
  model?: string,
): AIError {
  const upstream = extractUpstreamMessage(body);
  const haystack = `${upstream} ${safeStringify(body)}`.toLowerCase();
  const message = upstream || `HTTP ${status}`;
  const make = (kind: FailureKind) =>
    new AIError({ kind, message, provider, model, status, upstream, cause: body });

  if (status === 401 || status === 403) {
    if (/quota|billing|permission denied for key|api key not valid|invalid api key|unauthorized/.test(haystack)) {
      return make(/quota|billing/.test(haystack) ? 'quota_exhausted' : 'invalid_key');
    }
    return make('auth');
  }
  if (status === 404) return make('model_unavailable');
  if (status === 408 || status === 504) return make('timeout');
  if (status === 429) {
    if (/quota|per day|daily|exceeded your current quota|insufficient_quota/.test(haystack)) {
      return make('quota_exhausted');
    }
    return make('rate_limit');
  }
  if (status === 400 || status === 422) {
    if (/api key not valid|invalid api key/.test(haystack)) return make('invalid_key');
    if (/safety|blocked|content policy|prohibited|moderation|harmful/.test(haystack)) return make('safety');
    if (/context length|too many tokens|maximum context/.test(haystack)) return make('bad_request');
    if (/model|does not exist|not found/.test(haystack)) return make('model_unavailable');
    return make('bad_request');
  }
  if (status === 503 || status === 502 || status === 500) {
    if (/overloaded|unavailable|capacity|maintenance/.test(haystack)) return make('provider_unavailable');
    return make('server_error');
  }
  if (status >= 500) return make('server_error');
  return make('unknown');
}

export function classifyTransportFailure(provider: ProviderId, err: unknown, model?: string): AIError {
  if (err instanceof AIError) return err;
  const anyErr = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  const name = anyErr?.name ?? '';
  const code = anyErr?.code ?? anyErr?.cause?.code ?? '';
  const message = anyErr?.message ?? 'Unknown error';

  if (name === 'AbortError' || /aborted/i.test(name + message)) {
    return new AIError({ kind: 'aborted', message: 'Request was cancelled.', provider, model, cause: err });
  }
  if (name === 'TimeoutError' || code === 'ETIMEDOUT' || /timed? ?out/i.test(message)) {
    return new AIError({ kind: 'timeout', message, provider, model, cause: err });
  }
  if (
    ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'EPIPE'].includes(
      code,
    ) ||
    /fetch failed|network|socket hang up|other side closed/i.test(message)
  ) {
    return new AIError({ kind: 'network', message, provider, model, cause: err });
  }
  return new AIError({ kind: 'unknown', message, provider, model, cause: err });
}

/** Error body shapes differ per provider; pull out the human-readable part. */
export function extractUpstreamMessage(body: unknown): string {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 400);
  const b = body as Record<string, any>;
  const candidates = [
    b?.error?.message,
    b?.error?.status,
    b?.error?.[0]?.message,
    b?.message,
    b?.detail,
    b?.errors?.[0]?.message,
  ];
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.slice(0, 400);
  return '';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 800);
  } catch {
    return '';
  }
}

/** Friendly, student-facing failure labels (used in the UI and in error toasts). */
export const FAILURE_LABEL: Record<FailureKind, string> = {
  rate_limit: 'Rate limited',
  quota_exhausted: 'Daily quota exhausted',
  server_error: 'Temporary server error',
  timeout: 'Timed out',
  network: 'Network failure',
  invalid_key: 'Invalid API key',
  auth: 'Authentication failed',
  model_unavailable: 'Model unavailable',
  provider_unavailable: 'Provider unavailable',
  safety: 'Blocked by safety filter',
  bad_request: 'Request rejected',
  empty_response: 'Empty response',
  unsupported: 'Not supported',
  no_keys: 'No key configured',
  aborted: 'Stopped',
  unknown: 'Unknown error',
};
