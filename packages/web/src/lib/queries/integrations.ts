import type { ApiTokenCreateInput, WebhookEndpointCreateInput } from '@agentport/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../orpc.js';
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
      rpc.integrations.tokens.list(
        {
          query: {
            limit: INTEGRATIONS_PAGE_SIZE,
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
        { signal },
      ),
    staleTime: 0,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function useWebhookEndpoints() {
  return useCursorList({
    queryKey: integrationsKeys.webhooks,
    queryFn: (cursor, signal) =>
      rpc.integrations.webhooks.list(
        {
          query: {
            limit: INTEGRATIONS_PAGE_SIZE,
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
        { signal },
      ),
    staleTime: 0,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function useCreateApiToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ApiTokenCreateInput) => rpc.integrations.tokens.create({ body: input }),
    gcTime: 0,
    onSuccess: () => void client.invalidateQueries({ queryKey: integrationsKeys.tokens }),
  });
}

export function useRevokeApiToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => rpc.integrations.tokens.revoke({ params: { id } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: integrationsKeys.tokens }),
  });
}

export function useCreateWebhookEndpoint() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: WebhookEndpointCreateInput) =>
      rpc.integrations.webhooks.create({ body: input }),
    gcTime: 0,
    onSuccess: () => void client.invalidateQueries({ queryKey: integrationsKeys.webhooks }),
  });
}

export function useRemoveWebhookEndpoint() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => rpc.integrations.webhooks.remove({ params: { id } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: integrationsKeys.webhooks }),
  });
}
