import { sha256Hex } from './hash.js';

type ProviderRoute = { id: string; baseUrl: string };

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

export function envProviderDestination(baseUrl?: string) {
  return { id: 'env' as const, baseUrl: baseUrl || ANTHROPIC_DEFAULT_BASE_URL };
}

export function providerRouteDestination(provider: ProviderRoute): string {
  const digest = sha256Hex(provider.baseUrl).slice(0, 16);
  return `provider:${provider.id}:${digest}`;
}

export function providerRouteMatches(destination: string, provider: ProviderRoute): boolean {
  return destination === providerRouteDestination(provider);
}
