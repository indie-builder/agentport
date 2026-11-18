import type {
  ApiToken,
  ApiTokenCreateInput,
  WebhookEndpoint,
  WebhookEndpointCreateInput,
} from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../orpc.js';

const integrationsKeys = {
  tokens: ['integrations', 'tokens'] as const,
  webhooks: ['integrations', 'webhooks'] as const,
};

const apiTokensQuery = queryOptions<ApiToken[]>({
  queryKey: integrationsKeys.tokens,
  queryFn: () => rpc.integrations.tokens.list(),
  staleTime: 0,
});

const webhookEndpointsQuery = queryOptions<WebhookEndpoint[]>({
  queryKey: integrationsKeys.webhooks,
  queryFn: () => rpc.integrations.webhooks.list(),
  staleTime: 0,
});

export function useApiTokens() {
  return useQuery(apiTokensQuery);
}

export function useWebhookEndpoints() {
  return useQuery(webhookEndpointsQuery);
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
