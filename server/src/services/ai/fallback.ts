/**
 * Fallback Engine (spec §12–§13) — the reason a single bad key can never break the app.
 *
 *   request → task plan → provider → model → key
 *           ↘ key fails      → next key
 *           ↘ keys exhausted → next model → next provider
 *           ↘ everything fails → labelled, actionable error (never a blank screen)
 *
 * Safety rejections are surfaced, never re-routed (spec §13). Every attempt is reported as an
 * event so the UI can narrate "Gemini is unavailable, trying your next AI connection…".
 */
import { config } from '../../config/env.js';
import { PROVIDER_CATALOG, PROVIDER_IDS, type ProviderId } from '../../config/models.js';
import { redactSecrets } from '../crypto.js';
import { getSettings } from '../settings.js';
import { streamDemo } from './demo.js';
import { AIError, FAILURE_LABEL, FAILURE_POLICY, classifyTransportFailure, type FailureKind } from './errors.js';
import { getRotationCandidates, markKeyFailure, markKeySuccess, markKeyUsed } from './keyManager.js';
import { getProvider } from './providers/index.js';
import { messagesNeedVision, planFor } from './taskRouter.js';
import type { RoutePlan, RouterEvent, RunOptions } from './types.js';

interface AttemptFailure {
  provider: ProviderId;
  model: string;
  keyLabel: string;
  failure: FailureKind;
  message: string;
}

type Candidate = Awaited<ReturnType<typeof getRotationCandidates>>[number];

function safeMessage(raw: string): string {
  return redactSecrets(raw).slice(0, 300);
}

function modelHasVision(provider: ProviderId, modelId: string): boolean {
  return Boolean(PROVIDER_CATALOG[provider].models.find((m) => m.id === modelId)?.vision);
}

function exhaustedEvent(failures: AttemptFailure[], attempts: number): RouterEvent {
  const counts = {
    invalid: failures.filter((f) => f.failure === 'invalid_key' || f.failure === 'auth').length,
    quota: failures.filter((f) => f.failure === 'rate_limit' || f.failure === 'quota_exhausted').length,
    network: failures.filter((f) => ['network', 'provider_unavailable', 'timeout'].includes(f.failure)).length,
  };
  const unique = [...new Set(failures.map((f) => `${PROVIDER_CATALOG[f.provider].label}: ${FAILURE_LABEL[f.failure]}`))];
  const hints: string[] = [...unique];
  if (counts.invalid) hints.push(`${counts.invalid} key${counts.invalid > 1 ? 's were' : ' was'} rejected — review them in AI Settings`);
  if (counts.quota) hints.push(`${counts.quota} attempt${counts.quota > 1 ? 's' : ''} hit a rate limit or daily quota`);
  if (counts.network) hints.push(`${counts.network} attempt${counts.network > 1 ? 's' : ''} failed on the network`);
  if (!failures.length) hints.push('No enabled key was available for the providers we tried.');

  return {
    type: 'error',
    failure: failures[0]?.failure ?? 'unknown',
    message: 'All configured AI connections are currently unavailable. Your question is saved — retry in a moment.',
    attempts,
    hint: hints.join(' · '),
  };
}

export async function* runWithFallback(opts: RunOptions): AsyncGenerator<RouterEvent, void, unknown> {
  const settings = await getSettings(opts.userId);
  const needsVision = messagesNeedVision(opts.messages);

  const candidatesByProvider = new Map<ProviderId, Candidate[]>();
  for (const provider of PROVIDER_IDS) {
    candidatesByProvider.set(provider, await getRotationCandidates(opts.userId, provider));
  }
  const providersWithKeys = PROVIDER_IDS.filter((p) => (candidatesByProvider.get(p)?.length ?? 0) > 0);

  const basePlan = planFor({
    task: opts.task,
    settings,
    needsVision,
    preferredProvider: opts.preferredProvider,
    preferredModel: opts.preferredModel,
    providersWithKeys,
  });

  const willUseDemo = providersWithKeys.length === 0 && (opts.allowDemo ?? true) && settings.demoMode;
  const plan: RoutePlan = willUseDemo
    ? {
        ...basePlan,
        reason:
          'No API key connected yet — answering from the built-in sample library. Add a key in AI Settings for real model answers.',
      }
    : basePlan;

  yield { type: 'plan', plan };

  // ------------------------------ demo path ------------------------------
  if (willUseDemo) {
    yield {
      type: 'attempt',
      provider: 'gemini',
      providerLabel: 'Sample engine',
      model: 'vroqn-sample',
      keyLabel: 'built-in',
      attempt: 1,
      maxAttempts: 1,
    };
    let demoText = '';
    for await (const chunk of streamDemo(opts)) {
      if (opts.signal?.aborted) {
        yield { type: 'error', failure: 'aborted', message: 'Generation stopped.', attempts: 1 };
        return;
      }
      demoText += chunk;
      yield { type: 'delta', text: chunk };
    }
    yield {
      type: 'done',
      provider: 'gemini',
      model: 'vroqn-sample',
      keyLabel: 'built-in sample library',
      attempts: 1,
      fellBack: false,
      demo: true,
      latencyMs: 0,
      text: demoText,
    };
    return;
  }

  // --------------------------- real provider path -------------------------
  const maxAttempts = Math.min(opts.maxAttempts ?? config.ai.maxAttempts, config.ai.maxAttempts);
  const failures: AttemptFailure[] = [];
  const triedKeys = new Set<string>();
  const startedAt = Date.now();
  let attempts = 0;
  let streamedText = '';
  let stopAll = false;

  for (const step of plan.steps) {
    if (stopAll) break;
    const adapter = getProvider(step.provider);

    if (!(candidatesByProvider.get(step.provider) ?? []).length) {
      failures.push({
        provider: step.provider,
        model: step.models[0] ?? '—',
        keyLabel: '—',
        failure: 'no_keys',
        message: (candidatesByProvider.get(step.provider)?.length ?? 0)
          ? 'Every enabled key for this provider was already tried.'
          : 'No API key connected for this provider.',
      });
      continue;
    }

    for (const model of step.models) {
      if (stopAll) break;
      const supportsVision = adapter.capabilities.vision || modelHasVision(step.provider, model);
      if (needsVision && !supportsVision) {
        failures.push({
          provider: step.provider,
          model,
          keyLabel: '—',
          failure: 'unsupported',
          message: `${model} cannot read images.`,
        });
        continue; // next model — no attempt burned
      }

      // Re-read rotation state for each model: keys tried here are skipped, and keys that entered
      // a cooldown meanwhile are deprioritised (but still used if nothing else is left).
      const fresh = (await getRotationCandidates(opts.userId, step.provider)).filter((c) => !triedKeys.has(c.id));
      const ready = fresh.filter((c) => !c.coolingDown);
      const pool = ready.length ? ready : fresh;
      if (!pool.length) break; // every key for this provider is spent → next provider

      for (const candidate of pool) {
        if (opts.signal?.aborted) {
          yield { type: 'error', failure: 'aborted', message: 'Generation stopped.', attempts };
          return;
        }
        if (attempts >= maxAttempts) {
          stopAll = true;
          break;
        }

        attempts += 1;
        streamedText = '';
        await markKeyUsed(opts.userId, candidate.id);

        yield {
          type: 'attempt',
          provider: step.provider,
          providerLabel: PROVIDER_CATALOG[step.provider].label,
          model,
          keyLabel: candidate.label,
          attempt: attempts,
          maxAttempts,
        };

        try {
          for await (const delta of adapter.streamChat({
            key: candidate.secret,
            model,
            request: {
              messages: opts.messages,
              system: opts.system,
              temperature: opts.temperature ?? 0.55,
              maxTokens: opts.maxTokens ?? 2048,
              json: opts.json,
              signal: opts.signal,
            },
          })) {
            streamedText += delta;
            yield { type: 'delta', text: delta };
          }

          if (!streamedText.trim()) {
            throw new AIError({
              kind: 'empty_response',
              message: `${PROVIDER_CATALOG[step.provider].label} returned an empty response.`,
              provider: step.provider,
              model,
            });
          }

          triedKeys.add(candidate.id);
          await markKeySuccess(opts.userId, candidate.id, step.provider);
          yield {
            type: 'done',
            provider: step.provider,
            model,
            keyLabel: candidate.label,
            attempts,
            fellBack: attempts > 1,
            demo: false,
            latencyMs: Date.now() - startedAt,
            text: streamedText,
          };
          return;
        } catch (err) {
          if (opts.signal?.aborted) {
            yield { type: 'error', failure: 'aborted', message: 'Generation stopped.', attempts };
            return;
          }
          if (err instanceof AIError && err.kind === 'aborted') {
            yield { type: 'error', failure: 'aborted', message: 'Generation stopped.', attempts };
            return;
          }

          const failure = err instanceof AIError ? err : classifyTransportFailure(step.provider, err, model);
          const kind = failure.kind;
          const message = safeMessage(failure.message);

          triedKeys.add(candidate.id);
          await markKeyFailure(opts.userId, candidate.id, step.provider, kind, message);

          failures.push({ provider: step.provider, model, keyLabel: candidate.label, failure: kind, message });

          // The policy says which directions are allowed; the loops above decide what is left to try,
          // so a request only stops early when the policy forbids continuing (or the budget runs out).
          const policy = FAILURE_POLICY[kind];
          const canContinue = policy.otherKeys || policy.otherModels || policy.otherProviders || policy.sameKeyRetry;
          const willRetry = attempts < maxAttempts && canContinue;

          yield {
            type: 'attempt_failed',
            provider: step.provider,
            providerLabel: PROVIDER_CATALOG[step.provider].label,
            model,
            keyLabel: candidate.label,
            failure: kind,
            message,
            willRetry,
            attemptedPartial: streamedText.length > 0,
          };

          if (streamedText.length > 0) {
            yield {
              type: 'restart',
              reason: `${PROVIDER_CATALOG[step.provider].label} stopped mid-answer — restarting so you get one clean response.`,
              attempt: attempts,
            };
          }

          // Content-policy refusal: surfaced to the student, never shopped to another provider.
          if (kind === 'safety') {
            yield {
              type: 'error',
              failure: 'safety',
              message: message || 'This request was blocked by the provider safety system.',
              attempts,
              hint: 'Try rephrasing the question or ask about the underlying concept instead.',
            };
            return;
          }

          if (!willRetry) {
            stopAll = true;
            break;
          }
          if (config.ai.betweenAttemptsMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, config.ai.betweenAttemptsMs));
          }
        }
      }
    }
  }

  yield exhaustedEvent(failures, attempts);
}
