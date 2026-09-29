/**
 * Provider + model catalogue.
 *
 * Nothing else in the codebase hardcodes a model id: routers, prompts and the UI all read
 * from here, and every entry can be overridden with an environment variable
 * (e.g. VROQN_MODEL_GEMINI_BALANCED=gemini-3-flash) or refreshed at runtime from the
 * provider's own /models endpoint (see routes/providerModels.ts).
 */
export type ProviderId = 'gemini' | 'groq' | 'openrouter';
export const PROVIDER_IDS: ProviderId[] = ['gemini', 'groq', 'openrouter'];

export type TaskKind =
  | 'general'
  | 'coding'
  | 'notes'
  | 'exam'
  | 'practice'
  | 'vision'
  | 'grading'
  | 'fallback';

export type Speed = 'fast' | 'balanced' | 'deep';

export interface ModelSpec {
  id: string;
  label: string;
  speed: Speed;
  /** Can accept images / PDF pages as input. */
  vision: boolean;
  /** Good at code, used to bias task routing. */
  code: boolean;
  contextK: number;
  note?: string;
}

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  /** Where the student creates a key — shown in AI Settings. */
  keyUrl: string;
  keyPrefixHint: string;
  docsUrl: string;
  /** REST base used by the provider adapter. */
  apiBase: string;
  /** Chat-completions dialect implemented by the adapter. */
  dialect: 'gemini' | 'openai-compatible';
  models: ModelSpec[];
  /** Auth header style for the "test key" + "list models" calls. */
  auth: 'query' | 'bearer';
}

function envModel(key: string, fallback: string): string {
  const v = process.env[`VROQN_MODEL_${key}`];
  return v && v.trim() ? v.trim() : fallback;
}

export const PROVIDER_CATALOG: Record<ProviderId, ProviderSpec> = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyPrefixHint: 'Starts with AIza…',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    apiBase: 'https://generativelanguage.googleapis.com/v1beta',
    dialect: 'gemini',
    auth: 'query',
    models: [
      {
        id: envModel('GEMINI_BALANCED', 'gemini-2.5-flash'),
        label: 'Gemini Flash',
        speed: 'balanced',
        vision: true,
        code: true,
        contextK: 1000,
        note: 'Best default: fast, strong at explanations and diagrams.',
      },
      {
        id: envModel('GEMINI_FAST', 'gemini-2.5-flash-lite'),
        label: 'Gemini Flash Lite',
        speed: 'fast',
        vision: true,
        code: false,
        contextK: 1000,
        note: 'Cheapest/fastest — good for quick checks and short answers.',
      },
      {
        id: envModel('GEMINI_DEEP', 'gemini-2.5-pro'),
        label: 'Gemini Pro',
        speed: 'deep',
        vision: true,
        code: true,
        contextK: 1000,
        note: 'Slower, best for long multi-step physics/maths reasoning.',
      },
    ],
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    keyUrl: 'https://console.groq.com/keys',
    keyPrefixHint: 'Starts with gsk_…',
    docsUrl: 'https://console.groq.com/docs',
    apiBase: 'https://api.groq.com/openai/v1',
    dialect: 'openai-compatible',
    auth: 'bearer',
    models: [
      {
        id: envModel('GROQ_BALANCED', 'llama-3.3-70b-versatile'),
        label: 'Llama 3.3 70B',
        speed: 'balanced',
        vision: false,
        code: true,
        contextK: 128,
        note: 'Very low latency — the default coding provider.',
      },
      {
        id: envModel('GROQ_FAST', 'llama-3.1-8b-instant'),
        label: 'Llama 3.1 8B Instant',
        speed: 'fast',
        vision: false,
        code: false,
        contextK: 128,
        note: 'Fastest responses, use for tiny tasks.',
      },
      {
        id: envModel('GROQ_VISION', 'meta-llama/llama-4-scout-17b-16e-instruct'),
        label: 'Llama 4 Scout (vision)',
        speed: 'balanced',
        vision: true,
        code: false,
        contextK: 128,
        note: 'Can read photos of notes.',
      },
      {
        id: envModel('GROQ_DEEP', 'qwen/qwen3-32b'),
        label: 'Qwen3 32B',
        speed: 'deep',
        vision: false,
        code: true,
        contextK: 128,
      },
    ],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/keys',
    keyPrefixHint: 'Starts with sk-or-v1-…',
    docsUrl: 'https://openrouter.ai/docs',
    apiBase: 'https://openrouter.ai/api/v1',
    dialect: 'openai-compatible',
    auth: 'bearer',
    models: [
      {
        id: envModel('OPENROUTER_BALANCED', 'google/gemini-2.5-flash'),
        label: 'Gemini 2.5 Flash (routed)',
        speed: 'balanced',
        vision: true,
        code: true,
        contextK: 1000,
      },
      {
        id: envModel('OPENROUTER_FAST', 'meta-llama/llama-3.3-70b-instruct:free'),
        label: 'Llama 3.3 70B (:free tier)',
        speed: 'fast',
        vision: false,
        code: true,
        contextK: 128,
        note: 'Free tier — subject to OpenRouter rate limits.',
      },
      {
        id: envModel('OPENROUTER_DEEP', 'deepseek/deepseek-chat-v3.1'),
        label: 'DeepSeek V3.1',
        speed: 'deep',
        vision: false,
        code: true,
        contextK: 128,
      },
    ],
  },
};

export interface PublicModelInfo extends ModelSpec {
  provider: ProviderId;
  providerLabel: string;
}

export function allModels(): PublicModelInfo[] {
  return PROVIDER_IDS.flatMap((p) =>
    PROVIDER_CATALOG[p].models.map((m) => ({ ...m, provider: p, providerLabel: PROVIDER_CATALOG[p].label })),
  );
}

/** Runtime overrides set from AI Settings ("refresh models from provider"). */
const overrides = new Map<ProviderId, ModelSpec[]>();

export function setRuntimeModels(provider: ProviderId, models: ModelSpec[]): void {
  if (models.length) overrides.set(provider, models);
}

export function clearRuntimeModels(provider?: ProviderId): void {
  if (provider) overrides.delete(provider);
  else overrides.clear();
}

export function modelsFor(provider: ProviderId): ModelSpec[] {
  return overrides.get(provider) ?? PROVIDER_CATALOG[provider].models;
}

export function findModel(provider: ProviderId, modelId: string): ModelSpec | undefined {
  return modelsFor(provider).find((m) => m.id === modelId);
}

/**
 * Ordered candidate list for a task on a provider: preferred speed bucket first,
 * then the rest, with vision requirements respected.
 */
export function rankModels(provider: ProviderId, opts: { preferSpeed?: Speed; needsVision?: boolean; preferCode?: boolean }): ModelSpec[] {
  const models = modelsFor(provider).filter((m) => (opts.needsVision ? m.vision : true));
  if (!models.length) return modelsFor(provider);
  const score = (m: ModelSpec) => {
    let s = 0;
    if (opts.preferSpeed && m.speed === opts.preferSpeed) s -= 10;
    if (opts.preferCode && m.code) s -= 3;
    if (m.speed === 'balanced') s -= 2;
    if (opts.needsVision && m.vision) s -= 4;
    return s;
  };
  return [...models].sort((a, b) => score(a) - score(b));
}
