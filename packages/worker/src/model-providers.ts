import {
  decryptSecrets,
  envProviderDestination,
  providerRouteDestination,
  providerRouteMatches,
} from '@agentport/core';
import { assertServerEndpoint } from '@agentport/core/net-guard';
import { type Database, repo } from '@agentport/db';
import type { Config } from './config.js';
import type { ProviderResolution } from './model-proxy.js';

export async function resolveProviderUpstreams(
  db: Database,
  config: Pick<Config, 'APP_SECRET_KEY' | 'NODE_ENV' | 'MODEL_PROVIDER_PRIVATE_HOST_ALLOWLIST'>,
  model: string | undefined,
  runId: string,
  envBaseUrl: string,
): Promise<ProviderResolution> {
  const conversationId = await repo.runs.getRunConversationId(db, runId);
  if (conversationId === null) return { routed: true, blocked: true };
  const [approval, conversation, history] = await Promise.all([
    repo.security.getApprovedPolicyApprovalForRun(db, runId),
    repo.security.getApprovedPolicyApprovalForConversation(db, conversationId),
    repo.modelProviders.listHistoricalProviderDestinations(db, conversationId, runId),
  ]);
  const destination = (conversation ?? approval ?? history[0])?.destination;
  if (
    destination === null ||
    (approval !== null && approval.destination !== destination) ||
    history.some((row) => row.destination !== destination)
  ) {
    return { routed: true, blocked: true };
  }
  if (
    destination === 'env' ||
    destination === providerRouteDestination(envProviderDestination(envBaseUrl))
  ) {
    return { routed: false };
  }
  const providers = (await repo.modelProviders.listEnabledModelProviders(db)).filter(
    (provider) =>
      (model === undefined || provider.models.includes(model)) &&
      (destination === undefined || providerRouteMatches(destination, provider)),
  );
  if (providers.length === 0) {
    return destination === undefined ? { routed: false } : { routed: true, blocked: true };
  }

  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const candidates = await Promise.all(
    providers.map(async (provider) => {
      if (provider.monthlyBudgetUsd !== null) {
        const usage = await repo.modelProviders.providerUsageForModel(db, provider.id, month);
        if (usage.costUsd >= Number(provider.monthlyBudgetUsd)) return null;
      }
      try {
        await assertServerEndpoint(provider.baseUrl, {
          nodeEnv: config.NODE_ENV,
          allowlist: config.MODEL_PROVIDER_PRIVATE_HOST_ALLOWLIST,
        });
        const baseUrl = new URL(provider.baseUrl);
        if (
          (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
          baseUrl.username ||
          baseUrl.password
        )
          return null;
        const credential = decryptSecrets(
          provider.credentialEncrypted,
          config.APP_SECRET_KEY,
        ).credential;
        return credential ? { providerId: provider.id, baseUrl, credential } : null;
      } catch {
        return null;
      }
    }),
  );
  const [first, ...rest] = candidates.filter((candidate) => candidate !== null);
  return first === undefined
    ? { routed: true, blocked: true }
    : { routed: true, blocked: false, providers: [first, ...rest] };
}
