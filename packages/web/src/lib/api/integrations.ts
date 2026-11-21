import type {
  ApiToken,
  ApiTokenCreateInput,
  ApiTokenCreateResult,
  CursorPage,
  WebhookEndpoint,
  WebhookEndpointCreateInput,
  WebhookEndpointCreateResult,
} from '@agentport/shared';
import { rpc } from '../orpc.js';
import { clientOptions } from './shared.js';

export default {
  apiTokens: (
    options: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<CursorPage<ApiToken>> =>
    rpc.integrations.tokens.list({ query: options }, clientOptions(signal)),
  createApiToken: (input: ApiTokenCreateInput): Promise<ApiTokenCreateResult> =>
    rpc.integrations.tokens.create({ body: input }),
  revokeApiToken: (id: string): Promise<void> => rpc.integrations.tokens.revoke({ params: { id } }),
  webhookEndpoints: (
    options: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<CursorPage<WebhookEndpoint>> =>
    rpc.integrations.webhooks.list({ query: options }, clientOptions(signal)),
  createWebhookEndpoint: (
    input: WebhookEndpointCreateInput,
  ): Promise<WebhookEndpointCreateResult> => rpc.integrations.webhooks.create({ body: input }),
  removeWebhookEndpoint: (id: string): Promise<void> =>
    rpc.integrations.webhooks.remove({ params: { id } }),
};
