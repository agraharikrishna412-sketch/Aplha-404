/**
 * Shared OpenAI-compatible chat-completions adapter.
 * Groq and OpenRouter both speak this dialect; only the base URL, headers and any extra headers differ.
 */
import { PROVIDER_CATALOG, type ProviderId } from '../../../config/models.js';
import { AIError, classifyHttpFailure, classifyTransportFailure } from '../errors.js';
import { requestJson, streamSse } from '../http.js';
import type {
  AIProvider,
  ChatMessage,
  ContentPart,
  KeyCheckResult,
  ProviderCapabilities,
} from '../types.js';

const TIMEOUT_MS = Number(process.env.AI_ATTEMPT_TIMEOUT_MS ?? 45_000);

export interface OpenAICompatibleOptions {
  id: ProviderId;
  /** Extra headers (e.g. OpenRouter attribution headers). */
  extraHeaders?: Record<string, string>;
  capabilities?: Partial<ProviderCapabilities>;
  /** Native audio transcription (Groq Whisper). */
  /** Some models reject `temperature` — clamp instead of failing. */
  clampTemperature?: (t: number) => number;
}

function toOpenAiContent(content: string | ContentPart[]): string | Record<string, unknown>[] {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    // Images are sent as data URLs; providers that lack vision will reject with a clear error.
    return {
      type: 'image_url',
      image_url: { url: `data:${part.mimeType};base64,${part.data}`, detail: 'auto' },
    };
  });
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): AIProvider {
  const spec = PROVIDER_CATALOG[options.id];
  const id = options.id;

  const headers = (key: string): Record<string, string> => ({
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
    ...(options.extraHeaders ?? {}),
  });

  const provider: AIProvider = {
    id,
    label: spec.label,
    capabilities: {
      streaming: true,
      vision: false,
      pdf: false,
      json: true,
      // No speech path: Vroqn does not transcribe or synthesise audio.
      ...options.capabilities,
    },

    async validateKey(key, signal) {
      try {
        const data = await requestJson<{ data?: { id?: string }[] }>(
          `${spec.apiBase}/models`,
          { method: 'GET', headers: headers(key) },
          { provider: id, timeoutMs: 20_000, signal },
        );
        const models = (data.data ?? []).map((m) => m.id).filter((m): m is string => Boolean(m));
        return { ok: true, message: `Connected · ${models.length} models`, models } satisfies KeyCheckResult;
      } catch (err) {
        const e = err instanceof AIError ? err : classifyTransportFailure(id, err);
        return { ok: false, message: e.message, failure: e.kind } satisfies KeyCheckResult;
      }
    },

    async *streamChat({ key, model, request }) {
      const messages: Record<string, unknown>[] = [];
      if (request.system) messages.push({ role: 'system', content: request.system });
      for (const m of request.messages as ChatMessage[]) {
        messages.push({ role: m.role, content: toOpenAiContent(m.content) });
      }

      const temperature = options.clampTemperature
        ? options.clampTemperature(request.temperature ?? 0.6)
        : (request.temperature ?? 0.6);

      const body: Record<string, unknown> = {
        model,
        messages,
        temperature,
        max_tokens: request.maxTokens ?? 2048,
        stream: true,
        ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      };

      let sawAny = false;
      for await (const payload of streamSse(
        `${spec.apiBase}/chat/completions`,
        { method: 'POST', headers: headers(key), body: JSON.stringify(body) },
        { provider: id, model, timeoutMs: TIMEOUT_MS, signal: request.signal },
      )) {
        if (payload === '[DONE]') continue;
        let parsed: any;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        if (parsed?.error) throw classifyHttpFailure(id, parsed.error?.code ?? 400, parsed, model);

        const choice = parsed?.choices?.[0];
        const delta = choice?.delta ?? choice?.message ?? {};
        // Reasoning models emit `reasoning`/`reasoning_content`; only the answer is shown to students.
        const text: string = delta?.content ?? '';
        if (text) {
          sawAny = true;
          yield text;
        }
        const finish = choice?.finish_reason;
        if (finish === 'content_filter') {
          throw new AIError({
            kind: 'safety',
            message: `${spec.label} blocked this answer with its safety filter.`,
            provider: id,
            model,
          });
        }
      }

      if (!sawAny) {
        throw new AIError({
          kind: 'empty_response',
          message: `${spec.label} returned an empty response.`,
          provider: id,
          model,
        });
      }
    },

    async chat({ key, model, request }) {
      const messages: Record<string, unknown>[] = [];
      if (request.system) messages.push({ role: 'system', content: request.system });
      for (const m of request.messages as ChatMessage[]) messages.push({ role: m.role, content: toOpenAiContent(m.content) });

      const temperature = options.clampTemperature
        ? options.clampTemperature(request.temperature ?? 0.6)
        : (request.temperature ?? 0.6);

      const data = await requestJson<any>(
        `${spec.apiBase}/chat/completions`,
        {
          method: 'POST',
          headers: headers(key),
          body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens: request.maxTokens ?? 2048,
            ...(request.json ? { response_format: { type: 'json_object' } } : {}),
          }),
        },
        { provider: id, model, timeoutMs: TIMEOUT_MS, signal: request.signal },
      );

      const choice = data?.choices?.[0];
      const text: string = choice?.message?.content ?? '';
      if (choice?.finish_reason === 'content_filter') {
        throw new AIError({
          kind: 'safety',
          message: `${spec.label} blocked this answer with its safety filter.`,
          provider: id,
          model,
        });
      }
      if (!text.trim()) {
        throw new AIError({ kind: 'empty_response', message: `${spec.label} returned an empty response.`, provider: id, model });
      }
      return {
        text,
        usage: { inputTokens: data?.usage?.prompt_tokens, outputTokens: data?.usage?.completion_tokens },
      };
    },
  };

  return provider;
}

export const groqProvider = createOpenAICompatibleProvider({
  id: 'groq',
  capabilities: { vision: true },
});

export const openRouterProvider = createOpenAICompatibleProvider({
  id: 'openrouter',
  capabilities: { vision: true },
  // OpenRouter asks for attribution headers; the values are public and contain no secrets.
  extraHeaders: {
    'HTTP-Referer': process.env.PUBLIC_APP_URL ?? 'https://vroqn.nexus',
    'X-Title': 'Vroqn Nexus',
  },
});
