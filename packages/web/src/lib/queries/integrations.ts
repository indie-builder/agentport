import type { ApiTokenCreateInput, WebhookEndpointCreateInput } from '@agentport/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { useCursorList } from './shared.js';

const INTEGRATIONS_PAGE_SIZE = 50;

const integrationsKeys = {
  tokens: ['integrations', 'tokens'] as const,
  webhooks: ['integrations', 'webhooks'] as const,
};

export function useApiTokens() {
  return useCursorList({
    queryKey: integrationsKeys.tokens,
    queryFn: (cursor, signal) =>
      api.apiTokens(
        {
          limit: INTEGRATIONS_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
    staleTime: 0,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function useWebhookEndpoints() {
  return useCursorList({
    queryKey: integrationsKeys.webhooks,
    queryFn: (cursor, signal) =>
      api.webhookEndpoints(
        {
          limit: INTEGRATIONS_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
    staleTime: 0,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function useCreateApiToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ApiTokenCreateInput) => api.createApiToken(input),
    gcTime: 0,
    onSuccess: () => void client.invalidateQueries({ queryKey: integrationsKeys.tokens }),
  });
}

export function useRevokeApiToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeApiToken(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: integrationsKeys.tokens }),
  });
}

export function useCreateWebhookEndpoint() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: WebhookEndpointCreateInput) => api.createWebhookEndpoint(input),
    gcTime: 0,
    onSuccess: () => void client.invalidateQueries({ queryKey: integrationsKeys.webhooks }),
  });
}

export function useRemoveWebhookEndpoint() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.removeWebhookEndpoint(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: integrationsKeys.webhooks }),
  });
}
