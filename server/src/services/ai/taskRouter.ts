/**
 * Task Router (spec §15) — decides the provider/model order for a logical request.
 *
 * Order rules:
 *   1. The provider the student (or the caller) picked for this task.
 *   2. The configured fallback provider.
 *   3. Every remaining provider, so a run only fails when all three are exhausted.
 * Models inside a provider are ranked by the task profile (speed / code / vision).
 */
import { config } from '../../config/env.js';
import { PROVIDER_IDS, PROVIDER_CATALOG, findModel, modelsFor, rankModels, type ProviderId, type Speed, type TaskKind } from '../../config/models.js';
import type { ChatMessage, RoutePlan, RoutePlanStep } from './types.js';
import type { UserSettings } from '../../types/domain.js';

interface TaskProfile {
  preferSpeed: Speed;
  preferCode: boolean;
  needsDeepReasoning: boolean;
  label: string;
}

const TASK_PROFILES: Record<TaskKind, TaskProfile> = {
  general: { preferSpeed: 'balanced', preferCode: false, needsDeepReasoning: false, label: 'General study' },
  coding: { preferSpeed: 'balanced', preferCode: true, needsDeepReasoning: false, label: 'Coding help' },
  notes: { preferSpeed: 'deep', preferCode: false, needsDeepReasoning: true, label: 'Note restructuring' },
  exam: { preferSpeed: 'deep', preferCode: false, needsDeepReasoning: true, label: 'Mock exam' },
  practice: { preferSpeed: 'balanced', preferCode: false, needsDeepReasoning: true, label: 'Practice questions' },
  vision: { preferSpeed: 'balanced', preferCode: false, needsDeepReasoning: false, label: 'Image understanding' },
  grading: { preferSpeed: 'fast', preferCode: false, needsDeepReasoning: false, label: 'Answer checking' },
  fallback: { preferSpeed: 'balanced', preferCode: false, needsDeepReasoning: false, label: 'Fallback' },
};

export function messagesNeedVision(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image' || p.type === 'file'),
  );
}

export function planFor(args: {
  task: TaskKind;
  settings: UserSettings;
  needsVision?: boolean;
  preferredProvider?: ProviderId;
  preferredModel?: string;
  /** Providers that actually have at least one enabled key. */
  providersWithKeys: ProviderId[];
}): RoutePlan {
  const profile = TASK_PROFILES[args.task];
  const needsVision = Boolean(args.needsVision);

  const primary = args.preferredProvider ?? args.settings.routing[args.task] ?? args.settings.routing.general;
  const fallback = args.settings.routing.fallback;

  const order: ProviderId[] = [];
  const push = (p: ProviderId | undefined) => {
    if (p && !order.includes(p)) order.push(p);
  };
  push(primary);
  push(fallback);
  // Providers with keys float ahead of providers with none, then stable provider order.
  const remaining = PROVIDER_IDS.filter((p) => !order.includes(p)).sort((a, b) => {
    const aHas = args.providersWithKeys.includes(a) ? 0 : 1;
    const bHas = args.providersWithKeys.includes(b) ? 0 : 1;
    return aHas - bHas;
  });
  remaining.forEach(push);

  const steps: RoutePlanStep[] = order.map((provider) => {
    const available = modelsFor(provider);
    const visionCapable = available.some((m) => m.vision);
    const useVision = needsVision && visionCapable;
    const ranked = rankModels(provider, {
      preferSpeed: profile.preferSpeed,
      preferCode: profile.preferCode,
      needsVision: useVision,
    });

    const pinned = args.settings.modelPrefs?.[provider];
    const pinnedModel = pinned && findModel(provider, pinned) ? pinned : '';
    const models = Array.from(new Set([pinnedModel, args.preferredModel && provider === primary ? args.preferredModel : '', ...ranked.map((m) => m.id)].filter(Boolean)));

    return {
      provider,
      providerLabel: PROVIDER_CATALOG[provider].label,
      models,
      keyLabels: [],
    };
  });

  const reasonParts = [
    `${profile.label} → ${PROVIDER_CATALOG[primary].label} first`,
    fallback !== primary ? `then ${PROVIDER_CATALOG[fallback].label}` : '',
    needsVision ? 'image-capable models prioritised' : '',
    `up to ${steps.length} providers`,
  ].filter(Boolean);

  return {
    task: args.task,
    steps,
    reason: reasonParts.join(' · '),
    // The per-user setting *and* the server-level cap both have to allow it: `DEMO_MODE=off` (or
    // production, where it is off by default) means the sample library is never used.
    demoAllowed: args.settings.demoMode && config.demoModeDefault,
  };
}

export function taskProfile(task: TaskKind): TaskProfile {
  return TASK_PROFILES[task];
}
