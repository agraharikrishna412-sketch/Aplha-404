/**
 * API client.
 * - Always same-origin (`/api/...`): cookies work, CSP stays strict, no CORS in production.
 * - Every failure becomes an ApiError with a student-readable message, so the UI can always
 *   render an error state instead of a blank screen (spec §25).
 */

export class ApiError extends Error {
  status: number;
  code: string;
  hint?: string;
  details?: unknown;

  constructor(args: { message: string; status: number; code?: string; hint?: string; details?: unknown }) {
    super(args.message);
    this.name = 'ApiError';
    this.status = args.status;
    this.code = args.code ?? 'error';
    this.hint = args.hint;
    this.details = args.details;
  }

  get isOffline(): boolean {
    return this.status === 0;
  }
}

const BASE = '/api';

/**
 * Session-expiry signal.
 *
 * When the server answers `401` the session is gone (cookie expired, or the account signed out in
 * another tab). Without this the UI stayed on the "signed in" screens while every request failed with
 * a message the student could do nothing about. `AuthProvider` registers a handler here, clears the
 * session and lets the router send the student back to the sign-in screen.
 */
type UnauthorizedHandler = () => void;
const unauthorizedHandlers = new Set<UnauthorizedHandler>();

export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorizedHandlers.add(handler);
  return () => unauthorizedHandlers.delete(handler);
}

function signalUnauthorized(path: string): void {
  // Sign-in/sign-up failures are ordinary form errors, not an expired session.
  if (path.startsWith('/auth/login') || path.startsWith('/auth/signup')) return;
  for (const handler of unauthorizedHandlers) handler();
}

async function parseError(response: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* non-JSON error body */
  }
  const error = (body as { error?: { message?: string; code?: string; hint?: string; details?: unknown } } | null)?.error;
  return new ApiError({
    status: response.status,
    message: error?.message ?? `Request failed (${response.status}).`,
    code: error?.code,
    hint: error?.hint,
    details: error?.details,
  });
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      headers: init.body instanceof FormData ? undefined : { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      ...init,
    });
  } catch (err) {
    throw new ApiError({
      status: 0,
      code: 'network',
      message: 'You appear to be offline. Check your connection and try again.',
      details: err,
    });
  }
  if (!response.ok) {
    if (response.status === 401) signalUnauthorized(path);
    throw await parseError(response);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * Downloads a protected file.
 *
 * Files are not on a public path: the request carries the session cookie and the server checks
 * membership before it reads anything from disk, so a guessed URL is worth nothing (§16, §53).
 * The filename comes back from `Content-Disposition` when the server supplies one.
 */
export async function downloadFile(path: string): Promise<{ blob: Blob; filename: string | null }> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { credentials: 'include' });
  } catch (err) {
    throw new ApiError({ status: 0, code: 'network', message: 'You appear to be offline. Check your connection and try again.', details: err });
  }
  if (!response.ok) {
    if (response.status === 401) signalUnauthorized(path);
    throw await parseError(response);
  }
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  return { blob: await response.blob(), filename: match?.[1] ? decodeURIComponent(match[1]) : null };
}

export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>(path, { method: 'GET', ...init }),
  post: <T>(path: string, body?: unknown, init?: RequestInit) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), ...init }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  postForm: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
  download: (path: string) => downloadFile(path),
};

/* ------------------------------ SSE over POST ----------------------------- */

export interface StreamHandlers {
  onEvent: (event: string, data: any) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

/**
 * Streams Server-Sent Events from a POST endpoint (EventSource cannot POST).
 * Returns a `cancel()` function so the UI can offer a real Stop button (spec §7).
 */
export function postStream(path: string, body: unknown, handlers: StreamHandlers): { cancel: () => void; done: Promise<void> } {
  const controller = new AbortController();

  const done = (async () => {
    try {
      const response = await fetch(`${BASE}${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw await parseError(response);
      }
      if (!response.body) {
        throw new ApiError({ status: 500, message: 'Streaming is not supported by this browser.' });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const flush = (chunk: string) => {
        const lines = chunk.split('\n');
        let event = 'message';
        const dataLines: string[] = [];
        for (const raw of lines) {
          const line = raw.replace(/\r$/, '');
          if (!line || line.startsWith(':')) continue;
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
            continue;
          }
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) return;
        const payload = dataLines.join('\n');
        let parsed: unknown = payload;
        try {
          parsed = JSON.parse(payload);
        } catch {
          /* keep raw string */
        }
        handlers.onEvent(event, parsed);
      };

      while (true) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        const boundary = buffer.lastIndexOf('\n\n');
        if (boundary === -1) continue;
        const ready = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        flush(ready);
      }
      if (buffer.trim()) flush(buffer);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      handlers.onError?.(err instanceof Error ? err : new Error('Stream failed'));
    } finally {
      handlers.onClose?.();
    }
  })();

  return {
    cancel: () => controller.abort(),
    done,
  };
}
