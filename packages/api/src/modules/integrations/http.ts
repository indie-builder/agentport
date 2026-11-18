import { decryptSecrets, fail, notFound } from '@agentport/core';
import { repo } from '@agentport/db';
import {
  externalRunAcceptedSchema,
  externalRunInputSchema,
  externalRunStatusSchema,
  inboundWebhookPayloadSchema,
} from '@agentport/shared';
import type { Hono } from 'hono';
import { requireUser } from '../../http/access.js';
import { requestBodyLimit } from '../../http/body-limit.js';
import { type HttpEnv, requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import { authorizeRun } from '../runs/access.js';
import { authenticateApiToken, principalForBusinessId } from './auth.js';
import { verifyWebhookSignature } from './signature.js';
import { submitExternalRun } from './use-cases.js';

const bodyLimitHandler = requestBodyLimit(1_048_576);

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    fail('INVALID_INPUT', '请求体必须是有效 JSON');
  }
}

function toExternalRunStatus(run: NonNullable<Awaited<ReturnType<typeof repo.chat.getRun>>>) {
  return {
    id: run.id,
    status: run.status,
    agentId: run.agentId,
    conversationId: run.conversationId,
    trigger: run.trigger,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    endedAt: run.endedAt?.toISOString() ?? null,
    error: run.error,
    costUsd: run.costUsd === null ? null : Number(run.costUsd),
    turns: run.turns,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
  };
}

export function registerIntegrationsHttp(app: Hono<HttpEnv>): void {
  app.post(
    '/api/v1/runs',
    bodyLimitHandler,
    access({
      kind: 'service',
      boundary: 'api-token',
      reason: 'external run submission authenticates with an application API token',
    }),
    async (c) => {
      const context = requestContext(c);
      const token = await authenticateApiToken(context, 'runs.create');
      const principal = requireUser(context);
      const idempotencyKey = c.req.header('idempotency-key');
      if (
        idempotencyKey !== undefined &&
        (idempotencyKey.length < 1 || idempotencyKey.length > 200)
      ) {
        fail('INVALID_INPUT', 'Idempotency-Key 长度必须在 1 到 200 之间');
      }
      const parsed = externalRunInputSchema.safeParse(
        parseJson(await c.req.text().catch(() => fail('INVALID_INPUT', '请求体必须是有效 JSON'))),
      );
      if (!parsed.success) {
        fail('INVALID_INPUT', parsed.error.issues[0]?.message ?? '请求体格式不正确');
      }
      const result = await submitExternalRun(context, {
        principal,
        source: { kind: 'api_token', id: token.id },
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        request: {
          agentId: parsed.data.agentId,
          message: parsed.data.message,
          ...(parsed.data.conversationId === undefined
            ? {}
            : { conversationId: parsed.data.conversationId }),
        },
        audit: {
          action: 'integration.api_run.submitted',
          input: {
            agentId: parsed.data.agentId,
            tokenId: token.id,
            idempotent: idempotencyKey !== undefined,
          },
        },
      });
      const accepted = externalRunAcceptedSchema.parse({
        runId: result.runId,
        conversationId: result.conversationId,
        status: result.status,
        ...(result.replayed ? { replayed: true } : {}),
      });
      return c.json(accepted, result.replayed ? 200 : 202);
    },
  );

  app.get(
    '/api/v1/runs/:id',
    access({
      kind: 'service',
      boundary: 'api-token',
      reason: 'external run status authenticates with an application API token',
    }),
    async (c) => {
      const context = requestContext(c);
      const token = await authenticateApiToken(context, 'runs.read');
      const run = await authorizeRun(context, c.req.param('id'), 'runs.read');
      if (run.initiatedBy !== token.ownerBusinessId) {
        notFound('run');
      }
      return c.json(externalRunStatusSchema.parse(toExternalRunStatus(run)));
    },
  );

  app.post(
    '/api/webhooks/inbound/:id',
    bodyLimitHandler,
    access({
      kind: 'service',
      boundary: 'webhook',
      reason: 'inbound webhook authenticates with an HMAC signature',
    }),
    async (c) => {
      const context = requestContext(c);
      const endpoint = await repo.integrations.getInboundWebhookEndpoint(
        context.db,
        c.req.param('id'),
      );
      if (endpoint === null || !endpoint.enabled) {
        fail('NOT_FOUND', 'Webhook 端点不存在或已停用');
      }
      const rawBody = await c.req.text();
      const secret =
        decryptSecrets(endpoint.secretEncrypted, context.config.APP_SECRET_KEY).secret ?? '';
      if (
        !verifyWebhookSignature(
          secret,
          c.req.header('x-agentport-timestamp'),
          c.req.header('x-agentport-signature'),
          rawBody,
        )
      ) {
        fail('UNAUTHORIZED', 'Webhook 签名校验失败');
      }
      const parsed = inboundWebhookPayloadSchema.safeParse(parseJson(rawBody));
      if (!parsed.success) {
        fail('INVALID_INPUT', parsed.error.issues[0]?.message ?? '请求体格式不正确');
      }
      const headerKey = c.req.header('x-idempotency-key');
      if (headerKey !== undefined && headerKey !== parsed.data.eventId) {
        fail('INVALID_INPUT', 'X-Idempotency-Key 必须与 eventId 一致');
      }
      const principal = await principalForBusinessId(context, endpoint.ownerBusinessId);
      if (principal === null) fail('UNAUTHORIZED', 'Webhook 端点所属账户不可用');
      context.principal = principal;
      const result = await submitExternalRun(context, {
        principal,
        source: { kind: 'webhook', id: endpoint.id },
        idempotencyKey: parsed.data.eventId,
        request: {
          agentId: endpoint.agentId,
          message: parsed.data.message,
          ...(parsed.data.conversationId === undefined
            ? {}
            : { conversationId: parsed.data.conversationId }),
        },
        audit: {
          action: 'integration.webhook.triggered',
          input: { endpointId: endpoint.id, eventId: parsed.data.eventId },
        },
      });
      const accepted = externalRunAcceptedSchema.parse({
        runId: result.runId,
        conversationId: result.conversationId,
        status: result.status,
        ...(result.replayed ? { replayed: true } : {}),
      });
      return c.json(accepted, result.replayed ? 200 : 202);
    },
  );
}
