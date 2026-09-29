/**
 * AI layer contracts. Providers implement `AIProvider`; the router only ever sees this interface,
 * which is what keeps each provider swappable without touching a page.
 */
import type { ProviderId, TaskKind } from '../../config/models.js';
import type { FailureKind } from './errors.js';

export type Role = 'system' | 'user' | 'assistant';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  mimeType: string;
  /** base64 without data-url prefix */
  data: string;
  name?: string;
}

export interface FilePart {
  type: 'file';
  mimeType: string;
  data: string;
  name: string;
}

export type ContentPart = TextPart | ImagePart | FilePart;

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ProviderCapabilities {
  streaming: boolean;
  vision: boolean;
  pdf: boolean;
  json: boolean;
}

export interface KeyCheckResult {
  ok: boolean;
  message: string;
  failure?: FailureKind;
  models?: string[];
}

export interface AIProvider {
  id: ProviderId;
  label: string;
  capabilities: ProviderCapabilities;
  /** Validates a key and returns the provider's live model ids when available. */
  validateKey(key: string, signal?: AbortSignal): Promise<KeyCheckResult>;
  /** Streams text deltas. Must throw AIError on failure. */
  streamChat(args: { key: string; model: string; request: ChatRequest }): AsyncGenerator<string, void, unknown>;
  /** Non-streaming completion (used for JSON tasks such as question generation). */
  chat(args: { key: string; model: string; request: ChatRequest }): Promise<{ text: string; usage?: TokenUsage }>;
}

/* --------------------------- router contracts --------------------------- */

export interface RoutePlanStep {
  provider: ProviderId;
  providerLabel: string;
  models: string[];
  keyLabels: string[];
}

export interface RoutePlan {
  task: TaskKind;
  steps: RoutePlanStep[];
  /** Why this order was chosen — surfaced in the UI trace, never containing secrets. */
  reason: string;
  demoAllowed: boolean;
}

export type RouterEvent =
  | { type: 'plan'; plan: RoutePlan }
  | {
      type: 'attempt';
      provider: ProviderId;
      providerLabel: string;
      model: string;
      keyLabel: string;
      attempt: number;
      maxAttempts: number;
    }
  | {
      type: 'attempt_failed';
      provider: ProviderId;
      providerLabel: string;
      model: string;
      keyLabel: string;
      failure: FailureKind;
      message: string;
      willRetry: boolean;
      attemptedPartial: boolean;
    }
  | { type: 'restart'; reason: string; attempt: number }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      provider: ProviderId;
      model: string;
      keyLabel: string;
      attempts: number;
      fellBack: boolean;
      demo: boolean;
      usage?: TokenUsage;
      latencyMs: number;
      text: string;
    }
  | { type: 'error'; failure: FailureKind; message: string; attempts: number; hint?: string };

export interface RunOptions {
  userId: string;
  task: TaskKind;
  messages: ChatMessage[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  /** Preferred provider override (used by "retry with provider X"). */
  preferredProvider?: ProviderId;
  /** Preferred model override. */
  preferredModel?: string;
  signal?: AbortSignal;
  /** Set false for internal jobs that must never produce demo output (e.g. uploads analysis). */
  allowDemo?: boolean;
  maxAttempts?: number;
}
