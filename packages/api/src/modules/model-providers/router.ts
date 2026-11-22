import { modelProvidersContract } from '@agentport/contract/model-providers';
import { decryptSecrets, encryptSecrets, fail } from '@agentport/core';
import { assertServerEndpoint } from '@agentport/core/net-guard';
import { repo } from '@agentport/db';
import {
  HTTP_URL_ONLY_MESSAGE,
  type ModelProvider,
  type ModelProviderUsage,
  PROVIDER_NETWORK_MESSAGE,
  PROVIDER_TIMEOUT_MESSAGE,
  providerErrorKindForStatus,
} from '@agentport/shared';
import { implement } from '@orpc/server';
import { domainAudit } from '../../http/audit.js';
import type { RequestContext } from '../../http/context.js';
import { toIso } from '../../lib/iso.js';

const providers = repo.modelProviders;
const os = implement(modelProvidersContract).$context<RequestContext>();

const audit = domainAudit('model_provider');
const PROVIDER_NOT_FOUND_MESSAGE = '模型供应商不存在';

function toUsage(
  row: repo.modelProviders.ModelProviderRow & { usage: repo.modelProviders.ProviderUsage },
): ModelProviderUsage {
  const budgetUsd = row.monthlyBudgetUsd === null ? null : Number(row.monthlyBudgetUsd);
  return {
    providerId: row.id,
    requests: row.usage.requests,
    inputTokens: row.usage.inputTokens,
    outputTokens: row.usage.outputTokens,
    costUsd: row.usage.costUsd,
    budgetUsd,
    budgetRatio: budgetUsd !== null && budgetUsd > 0 ? row.usage.costUsd / budgetUsd : null,
  };
}

function healthOf(row: repo.modelProviders.ModelProviderRow): ModelProvider['health'] {
  const state =
    row.lastErrorAt !== null && (row.lastSuccessAt === null || row.lastErrorAt > row.lastSuccessAt)
      ? 'unhealthy'
      : row.lastSuccessAt !== null
        ? 'healthy'
        : 'unknown';
  const checkedAt = row.lastErrorAt ?? row.lastSuccessAt;
  return {
    state,
    checkedAt: toIso(checkedAt),
    latencyMs: null,
    message: state === 'unhealthy' ? row.lastError : null,
  };
}

function toModelProvider(
  row: repo.modelProviders.ModelProviderRow & { usage: repo.modelProviders.ProviderUsage },
): ModelProvider {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.baseUrl,
    models: row.models,
    priority: row.priority,
    enabled: row.enabled,
    monthlyBudgetUsd: row.monthlyBudgetUsd === null ? null : Number(row.monthlyBudgetUsd),
    alertRatio: Number(row.alertRatio),
    hasCredential: row.credentialEncrypted.length > 0,
    health: healthOf(row),
    usage: {
      requests: row.usage.requests,
      inputTokens: row.usage.inputTokens,
      outputTokens: row.usage.outputTokens,
      costUsd: row.usage.costUsd,
    },
    lastError: row.lastError,
    lastErrorAt: toIso(row.lastErrorAt),
    lastSuccessAt: toIso(row.lastSuccessAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertProviderBaseUrl(context: RequestContext, baseUrl: string) {
  await assertServerEndpoint(baseUrl, {
    nodeEnv: context.config.NODE_ENV,
    allowlist: context.config.MODEL_PROVIDER_PRIVATE_HOST_ALLOWLIST,
  });
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('INVALID_URL', HTTP_URL_ONLY_MESSAGE);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    fail('INVALID_URL', '模型端点不能包含用户名或密码');
  }
  return url;
}

async function requireProvider(context: RequestContext, id: string) {
  const row = await providers.getModelProvider(context.db, id);
  if (row === null) fail('NOT_FOUND', PROVIDER_NOT_FOUND_MESSAGE);
  return row;
}

function modelsFromPayload(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const entries =
    'data' in payload ? payload.data : 'models' in payload ? payload.models : undefined;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (typeof entry !== 'object' || entry === null || !('id' in entry)) return [];
    return typeof entry.id === 'string' ? [entry.id] : [];
  });
}

export const modelProvidersRouter = os.router({
  list: os.list.handler(async ({ context }) => {
    const rows = await providers.listModelProviders(context.db);
    return rows.map(toModelProvider);
  }),
  usage: os.usage.handler(async ({ context }) => {
    const rows = await providers.listModelProviders(context.db);
    return rows.map(toUsage);
  }),
  create: os.create.handler(async ({ input, context }) => {
    const body = input.body;
    await assertProviderBaseUrl(context, body.baseUrl);
    const row = await providers.createModelProvider(context.db, {
      name: body.name,
      protocol: body.protocol,
      baseUrl: body.baseUrl,
      credentialEncrypted: await encryptSecrets(
        { credential: body.credential },
        context.config.APP_SECRET_KEY,
      ),
      models: body.models,
      priority: body.priority,
      enabled: body.enabled,
      monthlyBudgetUsd: body.monthlyBudgetUsd,
      alertRatio: body.alertRatio,
    });
    await audit(context, 'created', row.id, {
      name: body.name,
      protocol: body.protocol,
      baseUrl: body.baseUrl,
      models: body.models,
      priority: body.priority,
      enabled: body.enabled,
      monthlyBudgetUsd: body.monthlyBudgetUsd,
      alertRatio: body.alertRatio,
    });
    return toModelProvider({
      ...row,
      usage: { requests: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
    });
  }),
  update: os.update.handler(async ({ input, context }) => {
    await requireProvider(context, input.params.id);
    const { credential, ...patch } = input.body;
    if (patch.baseUrl !== undefined) {
      await assertProviderBaseUrl(context, patch.baseUrl);
    }
    const row = await providers.updateModelProvider(context.db, input.params.id, {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.protocol === undefined ? {} : { protocol: patch.protocol }),
      ...(patch.baseUrl === undefined ? {} : { baseUrl: patch.baseUrl }),
      ...(patch.models === undefined ? {} : { models: patch.models }),
      ...(patch.priority === undefined ? {} : { priority: patch.priority }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: patch.monthlyBudgetUsd }),
      ...(patch.alertRatio === undefined ? {} : { alertRatio: patch.alertRatio }),
      ...(credential === undefined
        ? {}
        : {
            credentialEncrypted: await encryptSecrets(
              { credential },
              context.config.APP_SECRET_KEY,
            ),
          }),
    });
    if (row === null) fail('NOT_FOUND', PROVIDER_NOT_FOUND_MESSAGE);
    await audit(context, 'updated', row.id, patch);
    const [withUsage] = (await providers.listModelProviders(context.db)).filter(
      (provider) => provider.id === row.id,
    );
    return toModelProvider(
      withUsage ?? { ...row, usage: { requests: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 } },
    );
  }),
  remove: os.remove.handler(async ({ input, context }) => {
    const result = await providers.deleteModelProvider(context.db, input.params.id);
    if (result === 'not_found') fail('NOT_FOUND', PROVIDER_NOT_FOUND_MESSAGE);
    if (result === 'in_use') {
      fail('CONFLICT', '供应商已有历史请求、运行或审批引用，请改为停用');
    }
    await audit(context, 'deleted', input.params.id);
  }),
  test: os.test.handler(async ({ input, context }) => {
    const row = await requireProvider(context, input.params.id);
    const credential = (
      await decryptSecrets(row.credentialEncrypted, context.config.APP_SECRET_KEY)
    ).credential;
    if (credential === undefined) fail('SERVICE_UNAVAILABLE', '模型供应商凭证不可用');
    const target = await assertProviderBaseUrl(context, row.baseUrl);
    target.pathname = `${target.pathname.replace(/\/+$/, '')}/v1/models`;
    target.search = '';
    target.hash = '';
    const started = performance.now();
    try {
      const response = await fetch(target, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-api-key': credential,
          authorization: `Bearer ${credential}`,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      });
      const latencyMs = Math.round(performance.now() - started);
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const errorKind = providerErrorKindForStatus(response.status);
        await providers.recordProviderRequest(context.db, {
          providerId: row.id,
          statusCode: response.status,
          errorKind,
          durationMs: latencyMs,
          error: `HTTP ${response.status}`,
        });
        await audit(context, 'tested', row.id, { ok: false, statusCode: response.status });
        return {
          ok: false,
          latencyMs,
          message: `上游返回 HTTP ${response.status}`,
          models: [],
        };
      }
      await providers.recordProviderRequest(context.db, {
        providerId: row.id,
        statusCode: response.status,
        durationMs: latencyMs,
      });
      await audit(context, 'tested', row.id, { ok: true, statusCode: response.status });
      return {
        ok: true,
        latencyMs,
        message: '连接成功',
        models: modelsFromPayload(payload),
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - started);
      const timedOut =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      await providers.recordProviderRequest(context.db, {
        providerId: row.id,
        errorKind: timedOut ? 'timeout' : 'network',
        durationMs: latencyMs,
        error: timedOut ? PROVIDER_TIMEOUT_MESSAGE : PROVIDER_NETWORK_MESSAGE,
      });
      await audit(context, 'tested', row.id, {
        ok: false,
        errorKind: timedOut ? 'timeout' : 'network',
      });
      return {
        ok: false,
        latencyMs,
        message: timedOut ? '连接超时（5 秒）' : '无法连接模型端点',
        models: [],
      };
    }
  }),
});
