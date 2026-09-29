/**
 * AI Router — the single entry point the rest of the app talks to (spec §28).
 *
 *   UI → API routes → AI Router → Task Router → Provider Manager → Key Rotation → providers
 *
 * Everything above this file is provider-agnostic: routes only know tasks, never vendor APIs.
 */
import { PROVIDER_CATALOG, PROVIDER_IDS, modelsFor, type ProviderId } from '../../config/models.js';
import { config } from '../../config/env.js';
import { AIError } from './errors.js';
import { runWithFallback } from './fallback.js';
import { getRotationCandidates } from './keyManager.js';
import { getProvider, listProviders } from './providers/index.js';
import { parseJsonLoose } from './json.js';
import type { RouterEvent, RunOptions } from './types.js';

/** Streams router events for a logical request (chat, notes, practice, exam, code help). */
export function stream(opts: RunOptions): AsyncGenerator<RouterEvent, void, unknown> {
  return runWithFallback(opts);
}

export interface RunSummary {
  text: string;
  provider?: ProviderId;
  model?: string;
  keyLabel?: string;
  attempts: number;
  fellBack: boolean;
  demo: boolean;
  latencyMs: number;
  error?: { failure: string; message: string; hint?: string };
  events: RouterEvent[];
}

/** Collects a full response (used by JSON tasks: practice sets, exams, note restructures). */
export async function complete(opts: RunOptions): Promise<RunSummary> {
  const events: RouterEvent[] = [];
  let text = '';
  const summary: RunSummary = { text: '', attempts: 0, fellBack: false, demo: false, latencyMs: 0, events };

  for await (const event of stream(opts)) {
    events.push(event);
    switch (event.type) {
      case 'delta':
        text += event.text;
        break;
      case 'restart':
        text = '';
        break;
      case 'done':
        summary.text = event.text;
        summary.provider = event.provider;
        summary.model = event.model;
        summary.keyLabel = event.keyLabel;
        summary.attempts = event.attempts;
        summary.fellBack = event.fellBack;
        summary.demo = event.demo;
        summary.latencyMs = event.latencyMs;
        break;
      case 'error':
        summary.error = { failure: event.failure, message: event.message, hint: event.hint };
        break;
      default:
        break;
    }
  }
  if (!summary.text) summary.text = text;
  return summary;
}

/** Convenience wrapper for structured tasks; throws a typed AIError when the model output is unusable. */
export async function completeJson<T>(opts: RunOptions): Promise<{ data: T; summary: RunSummary }> {
  const summary = await complete({ ...opts, json: true });
  if (summary.error) {
    throw new AIError({ kind: summary.error.failure as never, message: summary.error.message });
  }
  const data = parseJsonLoose<T>(summary.text);
  if (!data) {
    throw new AIError({
      kind: 'bad_request',
      message: 'The model reply could not be read as structured data.',
    });
  }
  return { data, summary };
}

/* ------------------------------ catalogue ------------------------------ */

export interface ProviderCatalogueEntry {
  id: ProviderId;
  label: string;
  keyUrl: string;
  keyPrefixHint: string;
  docsUrl: string;
  capabilities: ReturnType<typeof getProvider>['capabilities'];
  models: { id: string; label: string; speed: string; vision: boolean; code: boolean; contextK: number; note?: string }[];
}

export function catalogue(): ProviderCatalogueEntry[] {
  return PROVIDER_IDS.map((id) => {
    const spec = PROVIDER_CATALOG[id];
    return {
      id,
      label: spec.label,
      keyUrl: spec.keyUrl,
      keyPrefixHint: spec.keyPrefixHint,
      docsUrl: spec.docsUrl,
      capabilities: getProvider(id).capabilities,
      models: modelsFor(id).map((m) => ({
        id: m.id,
        label: m.label,
        speed: m.speed,
        vision: m.vision,
        code: m.code,
        contextK: m.contextK,
        note: m.note,
      })),
    };
  });
}

/** Refreshes model ids for a provider straight from its /models endpoint (no code changes needed). */
export async function refreshModels(userId: string, provider: ProviderId): Promise<{ ok: boolean; count: number; message: string }> {
  const candidates = await getRotationCandidates(userId, provider);
  if (!candidates.length) return { ok: false, count: 0, message: 'Add a key first to discover models.' };
  const result = await getProvider(provider).validateKey(candidates[0].secret);
  if (!result.ok || !result.models?.length) {
    return { ok: false, count: 0, message: result.message || 'Could not list models.' };
  }
  const { setRuntimeModels } = await import('../../config/models.js');
  setRuntimeModels(provider, [
    ...modelsFor(provider),
    ...result.models
      .filter((id) => !modelsFor(provider).some((m) => m.id === id))
      .slice(0, 60)
      .map((id) => ({
        id,
        label: id,
        speed: 'balanced' as const,
        vision: true,
        code: /code|coder|deepseek|qwen|llama|gemini|gpt-oss/i.test(id),
        contextK: 128,
        note: 'Discovered from your provider account.',
      })),
  ]);
  return { ok: true, count: result.models.length, message: `Found ${result.models.length} models.` };
}

export const aiRuntimeInfo = {
  maxAttempts: config.ai.maxAttempts,
  attemptTimeoutMs: config.ai.attemptTimeoutMs,
  providers: listProviders().map((p) => ({ id: p.id, label: p.label, capabilities: p.capabilities })),
};
