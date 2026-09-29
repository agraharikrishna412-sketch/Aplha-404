/**
 * Small HTTP helpers shared by every provider adapter.
 * - Composes the caller's abort signal with a per-attempt timeout.
 * - Never logs headers or bodies (they contain API keys).
 */
import { AIError, classifyHttpFailure, classifyTransportFailure } from './errors.js';
import type { ProviderId } from '../../config/models.js';

export function combineSignals(signals: (AbortSignal | undefined)[]): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timers: NodeJS.Timeout[] = [];
  const onAbort = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) onAbort(s.reason);
    else {
      const handler = () => onAbort(s.reason);
      s.addEventListener('abort', handler, { once: true });
      timers.push(
        { unref: () => undefined } as unknown as NodeJS.Timeout, // placeholder kept for symmetry
      );
    }
  }
  return { signal: controller.signal, cleanup: () => timers.forEach((t) => clearTimeout(t)) };
}

export function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  const link = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) link();
    else signal.addEventListener('abort', link, { once: true });
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', link);
    },
  };
}

export interface RequestContext {
  provider: ProviderId;
  model?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** JSON request with provider-aware error classification. */
export async function requestJson<T = unknown>(
  url: string,
  init: RequestInit,
  ctx: RequestContext,
): Promise<T> {
  const { signal, clear } = withTimeout(ctx.signal, ctx.timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) throw classifyHttpFailure(ctx.provider, res.status, parsed, ctx.model);
    return parsed as T;
  } catch (err) {
    throw classifyTransportFailure(ctx.provider, err, ctx.model);
  } finally {
    clear();
  }
}

/**
 * Opens a streaming response and returns an async iterator of raw SSE `data:` payload strings.
 * Falls back to yielding the whole body once if the provider ignores streaming.
 */
export async function* streamSse(
  url: string,
  init: RequestInit,
  ctx: RequestContext,
): AsyncGenerator<string, void, unknown> {
  const { signal, clear } = withTimeout(ctx.signal, ctx.timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (err) {
    clear();
    throw classifyTransportFailure(ctx.provider, err, ctx.model);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    clear();
    let parsed: unknown = body;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* keep raw */
    }
    throw classifyHttpFailure(ctx.provider, response.status, parsed, ctx.model);
  }
  if (!response.body) {
    clear();
    throw new AIError({ kind: 'unsupported', message: 'Provider returned no body', provider: ctx.provider, model: ctx.model });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const contentType = response.headers.get('content-type') ?? '';

  try {
    if (!/text\/event-stream/i.test(contentType)) {
      // Non-streaming provider response: emit once.
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      yield text;
      return;
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim();
        else if (trimmed.startsWith('{')) yield trimmed; // some gateways omit the prefix
      }
    }
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim();
      else if (trimmed.startsWith('{')) yield trimmed;
    }
  } catch (err) {
    throw classifyTransportFailure(ctx.provider, err, ctx.model);
  } finally {
    clear();
    reader.releaseLock?.();
  }
}

export function dataUrlToParts(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/** Wraps raw PCM (16-bit, mono) into a WAV container so browsers can play Gemini TTS audio. */
export function pcmToWav(pcm: Buffer, sampleRate = 24_000, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function base64ToBuffer(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}
