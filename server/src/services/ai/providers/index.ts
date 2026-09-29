/** Provider registry — the only place that maps a ProviderId onto an adapter. */
import type { ProviderId } from '../../../config/models.js';
import { PROVIDER_IDS } from '../../../config/models.js';
import type { AIProvider } from '../types.js';
import { geminiProvider } from './gemini.js';
import { groqProvider, openRouterProvider } from './openaiCompatible.js';

export const providers: Record<ProviderId, AIProvider> = {
  gemini: geminiProvider,
  groq: groqProvider,
  openrouter: openRouterProvider,
};

export function getProvider(id: ProviderId): AIProvider {
  const provider = providers[id];
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

export function listProviders(): AIProvider[] {
  return PROVIDER_IDS.map((id) => providers[id]);
}
