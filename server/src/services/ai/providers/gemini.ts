/**
 * Google Gemini adapter (native `generateContent` / `streamGenerateContent` dialect).
 * Also provides vision (images + PDF pages).
 */
import { PROVIDER_CATALOG, type ProviderId } from '../../../config/models.js';
import { AIError, classifyTransportFailure } from '../errors.js';
import { requestJson, streamSse } from '../http.js';
import type {
  AIProvider,
  ChatMessage,
  ContentPart,
  KeyCheckResult,
  ProviderCapabilities,
} from '../types.js';

const spec = PROVIDER_CATALOG.gemini;
const TIMEOUT_MS = Number(process.env.AI_ATTEMPT_TIMEOUT_MS ?? 45_000);

function toGeminiPart(part: ContentPart): Record<string, unknown> {
  switch (part.type) {
    case 'text':
      return { text: part.text };
    case 'image':
      return { inlineData: { mimeType: part.mimeType, data: part.data } };
    case 'file':
      return { inlineData: { mimeType: part.mimeType, data: part.data } };
  }
}

function toGeminiContents(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content.map(toGeminiPart),
    }));
}

interface GeminiCandidate {
  content?: { parts?: { text?: string }[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: unknown;
}

function extractText(res: GeminiResponse): string {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('');
}

function assertNotBlocked(res: GeminiResponse, model: string): void {
  const block = res.promptFeedback?.blockReason;
  const finish = res.candidates?.[0]?.finishReason;
  if (block && block !== 'BLOCK_REASON_UNSPECIFIED') {
    throw new AIError({
      kind: 'safety',
      message: `Gemini blocked this request (${block}).`,
      provider: 'gemini',
      model,
    });
  }
  if (finish && ['SAFETY', 'PROHIBITED_CONTENT', 'RECITATION', 'BLOCKLIST'].includes(finish)) {
    throw new AIError({
      kind: 'safety',
      message: `Gemini stopped the answer for safety reasons (${finish}).`,
      provider: 'gemini',
      model,
    });
  }
}


export const geminiProvider: AIProvider = {
  id: 'gemini' as ProviderId,
  label: spec.label,
  capabilities: {
    streaming: true,
    vision: true,
    pdf: true,
    json: true,
  } satisfies ProviderCapabilities,

  async validateKey(key, signal) {
    try {
      const data = await requestJson<{ models?: { name?: string; supportedGenerationMethods?: string[] }[] }>(
        `${spec.apiBase}/models?key=${encodeURIComponent(key)}&pageSize=200`,
        { method: 'GET' },
        { provider: 'gemini', timeoutMs: 20_000, signal },
      );
      const models = (data.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => (m.name ?? '').replace(/^models\//, ''))
        .filter(Boolean);
      return { ok: true, message: 'Connected', models } satisfies KeyCheckResult;
    } catch (err) {
      const e = err instanceof AIError ? err : classifyTransportFailure('gemini', err);
      return { ok: false, message: e.message, failure: e.kind } satisfies KeyCheckResult;
    }
  },

  async *streamChat({ key, model, request }) {
    const body = {
      contents: toGeminiContents(request.messages),
      ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
      generationConfig: {
        temperature: request.temperature ?? 0.6,
        maxOutputTokens: request.maxTokens ?? 2048,
        ...(request.json ? { responseMimeType: 'application/json' } : {}),
      },
    };

    const url = `${spec.apiBase}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
    let sawAny = false;

    for await (const payload of streamSse(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      { provider: 'gemini', model, timeoutMs: TIMEOUT_MS, signal: request.signal },
    )) {
      if (payload === '[DONE]') continue;
      let parsed: GeminiResponse;
      try {
        parsed = JSON.parse(payload) as GeminiResponse;
      } catch {
        continue;
      }
      assertNotBlocked(parsed, model);
      const text = extractText(parsed);
      if (text) {
        sawAny = true;
        yield text;
      }
    }

    if (!sawAny) {
      throw new AIError({
        kind: 'empty_response',
        message: 'Gemini returned an empty response.',
        provider: 'gemini',
        model,
      });
    }
  },

  async chat({ key, model, request }) {
    const body = {
      contents: toGeminiContents(request.messages),
      ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
      generationConfig: {
        temperature: request.temperature ?? 0.6,
        maxOutputTokens: request.maxTokens ?? 2048,
        ...(request.json ? { responseMimeType: 'application/json' } : {}),
      },
    };
    const data = await requestJson<GeminiResponse>(
      `${spec.apiBase}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      { provider: 'gemini', model, timeoutMs: TIMEOUT_MS, signal: request.signal },
    );
    assertNotBlocked(data, model);
    const text = extractText(data);
    if (!text.trim()) {
      throw new AIError({ kind: 'empty_response', message: 'Gemini returned an empty response.', provider: 'gemini', model });
    }
    return {
      text,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
      },
    };
  },
};
