import { randomBytes } from 'node:crypto';
import { integrationsContract } from '@agentport/contract';
import { encryptSecrets, fail, sha256Hex } from '@agentport/core';
import { assertServerEndpoint } from '@agentport/core/net-guard';
import { repo } from '@agentport/db';
import type { ApiToken, WebhookEndpoint } from '@agentport/shared';
import { implement } from '@orpc/server';
import { actorOf, authorizeObject, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { cursorOption, requireCursorPage } from '../../http/pagination.js';

const os = implement(integrationsContract).$context<RequestContext>();

type ApiTokenRow = NonNullable<
  Awaited<ReturnType<typeof repo.integrations.listApiTokens>>
>['items'][number];
type WebhookEndpointRow = NonNullable<
  Awaited<ReturnType<typeof repo.integrations.listWebhookEndpoints>>
>['items'][number];

function toApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: row.scopes,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toWebhookEndpoint(row: WebhookEndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    name: row.name,
    direction: row.direction,
    agentId: row.agentId,
    agentName: row.agentName,
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const integrationsRouter = os.router({
  tokens: {
    list: os.tokens.list.handler(async ({ input, context }) => {
      const businessId = requireUser(context).businessId;
      const page = requireCursorPage(
        await repo.integrations.listApiTokens(context.db, {
          businessId,
          ...cursorOption(input.query.cursor),
          limit: input.query.limit,
        }),
      );
      return { items: page.items.map(toApiToken), nextCursor: page.nextCursor };
    }),
    create: os.tokens.create.handler(async ({ input, context }) => {
      const actor = requireUser(context);
      const token = `atk_${randomBytes(32).toString('base64url')}`;
      const row = await repo.integrations.createApiToken(context.db, {
        name: input.body.name,
        tokenHash: sha256Hex(token),
        tokenPrefix: token.slice(0, 8),
        scopes: input.body.scopes,
        authUserId: actor.authUserId,
        ownerBusinessId: actor.businessId,
        expiresAt: input.body.expiresAt === undefined ? null : new Date(input.body.expiresAt),
      });
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'integration.token.created',
        target: row.id,
        input: { name: row.name, scopes: row.scopes },
        status: 'ok',
        requestId: context.requestId,
      });
      return { ...toApiToken(row), token };
    }),
    revoke: os.tokens.revoke.handler(async ({ input, context }) => {
      const businessId = requireUser(context).businessId;
      const revoked = await repo.integrations.revokeApiToken(
        context.db,
        businessId,
        input.params.id,
      );
      if (revoked) {
        await repo.audit.writeAudit(context.db, context.log, {
          actor: actorOf(context),
          action: 'integration.token.revoked',
          target: input.params.id,
          status: 'ok',
          requestId: context.requestId,
        });
      }
      return undefined;
    }),
  },
  webhooks: {
    list: os.webhooks.list.handler(async ({ input, context }) => {
      const businessId = requireUser(context).businessId;
      const page = requireCursorPage(
        await repo.integrations.listWebhookEndpoints(context.db, {
          businessId,
          ...cursorOption(input.query.cursor),
          limit: input.query.limit,
        }),
      );
      return { items: page.items.map(toWebhookEndpoint), nextCursor: page.nextCursor };
    }),
    create: os.webhooks.create.handler(async ({ input, context }) => {
      const actor = requireUser(context);
      const { name, direction, agentId, url, events } = input.body;
      if (direction === 'inbound') {
        if (agentId === undefined) fail('INVALID_INPUT', '入站端点必须选择专家');
        await authorizeObject(
          context,
          'agents.use',
          { agentId },
          '智能体不存在，可能已被删除；请刷新后重新选择',
        );
      } else if (direction === 'outbound' && url) {
        await assertServerEndpoint(url, {
          nodeEnv: context.config.NODE_ENV,
          allowlist: context.config.WEBHOOK_PRIVATE_HOST_ALLOWLIST,
          allowDevLocal: false,
        });
      }
      const secret = `whsec_${randomBytes(32).toString('base64url')}`;
      const row = await repo.integrations.createWebhookEndpoint(context.db, {
        name,
        direction,
        agentId: direction === 'inbound' ? (agentId ?? null) : null,
        url: direction === 'outbound' ? (url ?? null) : null,
        events: direction === 'outbound' ? (events ?? []) : [],
        secretEncrypted: encryptSecrets({ secret }, context.config.APP_SECRET_KEY),
        authUserId: actor.authUserId,
        ownerBusinessId: actor.businessId,
      });
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'integration.webhook.created',
        target: row.id,
        input: {
          name: row.name,
          direction: row.direction,
          agentId: row.agentId,
          events: row.events,
        },
        status: 'ok',
        requestId: context.requestId,
      });
      return { ...toWebhookEndpoint(row), secret };
    }),
    remove: os.webhooks.remove.handler(async ({ input, context }) => {
      const businessId = requireUser(context).businessId;
      const removed = await repo.integrations.deleteWebhookEndpoint(
        context.db,
        businessId,
        input.params.id,
      );
      if (removed) {
        await repo.audit.writeAudit(context.db, context.log, {
          actor: actorOf(context),
          action: 'integration.webhook.deleted',
          target: input.params.id,
          status: 'ok',
          requestId: context.requestId,
        });
      }
      return undefined;
    }),
  },
});
