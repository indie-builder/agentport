import { randomUUID } from 'node:crypto';
import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import { requireExecutionStack } from './support/execution-stack.js';
import { fixture } from './support/fixture.js';

await requireExecutionStack();

const ADMIN = {
  username: process.env.E2E_ADMIN_USER ?? 'admin',
  password: process.env.E2E_ADMIN_PASSWORD ?? '',
};

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timeout']);

interface ApiResult<T> {
  status: number;
  json: T | null;
  text: string;
}

interface ProviderView {
  id: string;
  health: { state: string };
  lastError: string | null;
  lastSuccessAt: string | null;
}

interface ObservabilitySnapshot {
  window: { minutes: number };
  sloWindowMinutes: number;
  providers: Array<{ providerId: string; requests: number; errors: number }>;
}

interface ProviderUsage {
  providerId: string;
  costUsd: number;
}

interface SloSettingsView {
  enabled: boolean;
  windowMinutes: number;
  runSuccessTarget: number;
  runP95LatencyMs: number;
  queueOldestWaitMs: number;
  providerErrorRateTarget: number;
}

interface PolicyView {
  id: string;
}

interface PolicyEvent {
  id: string;
  policyId: string | null;
  sourceKind: string;
  snippet: string;
}

interface PolicyApproval {
  id: string;
  consumedAt: string | null;
}

interface ViolationCase {
  policyId: string | null;
  subjectId: string;
}

interface AuditItem {
  action: string;
  target: string | null;
}

interface Problem {
  code?: string;
  resourceId?: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api<T>(
  browser: Browser,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const response = await browserFetch(browser, method, path, body);
  let json: T | null = null;
  try {
    json = response.text === '' ? null : (JSON.parse(response.text) as T);
  } catch {
    json = null;
  }
  return { status: response.status, json, text: response.text };
}

function ensure<T>(result: ApiResult<T>, expected: number | number[], label: string): T {
  const accepted = Array.isArray(expected) ? expected : [expected];
  if (!accepted.includes(result.status)) {
    throw new Error(
      `${label}失败：期望 HTTP ${accepted.join(' 或 ')}，实际 ${result.status}，响应 ${result.text}`,
    );
  }
  return result.json as T;
}

async function login(
  browser: Browser,
  account: { username: string; password: string },
  label: string,
): Promise<void> {
  ensure(
    await api(browser, 'POST', '/api/auth/login', {
      username: account.username,
      password: account.password,
    }),
    200,
    `登录 ${label}`,
  );
}

function adminLogin(browser: Browser): Promise<void> {
  return login(browser, ADMIN, '管理员');
}

async function waitRun(browser: Browser, runId: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  let last = '';
  while (Date.now() < deadline) {
    const detail = ensure<{ run: { status: string } }>(
      await api(browser, 'GET', `/api/runs/${runId}`),
      200,
      '读取运行状态',
    );
    last = JSON.stringify(detail);
    if (detail.run.status === 'succeeded') return;
    if (TERMINAL_STATUSES.has(detail.run.status)) {
      throw new Error(`运行 ${runId} 终态 ${detail.run.status}: ${last}`);
    }
    await sleep(1_000);
  }
  throw new Error(`等待运行 ${runId} 进入终态超时：${last}`);
}

async function upstreamPrompts(fakeModelUrl: string): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(`${fakeModelUrl}/__e2e_upstream/hits`);
  } catch (error) {
    throw new Error(`读取假模型上游 prompts 网络失败：${String(error)}`);
  }
  if (!response.ok) throw new Error(`读取假模型上游 prompts 失败：HTTP ${response.status}`);
  const body: unknown = await response.json().catch(() => null);
  const prompts: unknown =
    typeof body === 'object' && body !== null ? (body as { prompts?: unknown }).prompts : undefined;
  assert(
    Array.isArray(prompts) && prompts.every((prompt) => typeof prompt === 'string'),
    `假模型上游 prompts 格式不符：${JSON.stringify(body)}`,
  );
  return prompts;
}

async function createAgent(
  browser: Browser,
  suffix: string,
  created: string[],
  model?: string,
): Promise<string> {
  const agent = ensure<{ id: string }>(
    await api(browser, 'POST', '/api/agents', {
      slug: `e2e-model-security-${suffix}`,
      name: `E2E 模型安全 ${suffix}`,
      systemPrompt: 'E2E model security agent',
      ...(model === undefined ? {} : { model }),
    }),
    201,
    '创建智能体',
  );
  created.push(agent.id);
  ensure(
    await api(browser, 'POST', `/api/agents/${agent.id}/publish`, { note: 'e2e model security' }),
    200,
    '发布智能体',
  );
  return agent.id;
}

async function createProvider(
  browser: Browser,
  input: { name: string; baseUrl: string; models: string[]; priority: number; enabled: boolean },
): Promise<string> {
  const provider = ensure<{ id: string }>(
    await api(browser, 'POST', '/api/model-providers', {
      name: input.name,
      protocol: 'anthropic',
      baseUrl: input.baseUrl,
      credential: `e2e-provider-credential-${input.priority}`,
      models: input.models,
      priority: input.priority,
      enabled: input.enabled,
    }),
    201,
    `创建供应商 ${input.name}`,
  );
  return provider.id;
}

async function createPolicy(
  browser: Browser,
  input: {
    name: string;
    action: 'block' | 'require_approval' | 'redact';
    pattern: string;
    agentId: string;
  },
): Promise<string> {
  const policy = ensure<PolicyView>(
    await api(browser, 'POST', '/api/security/policies', {
      name: input.name,
      direction: 'inbound',
      action: input.action,
      matchType: 'keyword',
      pattern: input.pattern,
      agentId: input.agentId,
    }),
    201,
    `创建策略 ${input.name}`,
  );
  return policy.id;
}

async function bestEffort(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.log(`[模型安全 E2E 清理跳过] ${label}：${String(error)}`);
  }
}

test('model security 供应商故障切换与内容安全审批', { timeout: 600_000 }, async ({
  app,
  browser,
}) => {
  await app.open('/');
  await adminLogin(browser);
  const suffix = uniqueSuffix();
  const providerModel = `e2e-provider-${suffix}`;
  const fakeModelUrl = (process.env.E2E_FAKE_MODEL_URL ?? '').replace(/\/+$/, '');
  assert(fakeModelUrl.length > 0, '缺少 E2E_FAKE_MODEL_URL');
  const agentIds: string[] = [];
  const providerIds: string[] = [];
  const policyIds: string[] = [];
  let sloOriginal: SloSettingsView | null = null;

  try {
    const me = ensure<{ authenticated: boolean; user?: { businessId: string } }>(
      await api(browser, 'GET', '/api/auth/me'),
      200,
      '读取当前账户',
    );
    assert(me.authenticated === true && me.user !== undefined, '管理员未登录');
    const adminBusinessId = me.user.businessId;

    sloOriginal = ensure<SloSettingsView>(
      await api(browser, 'GET', '/api/observability/slo'),
      200,
      '读取 SLO 设置',
    );
    ensure(
      await api(browser, 'PUT', '/api/observability/slo', {
        ...sloOriginal,
        windowMinutes: 5,
      }),
      200,
      '调整 SLO 评估窗口',
    );
    const decoupled = ensure<ObservabilitySnapshot>(
      await api(browser, 'GET', '/api/observability?windowMinutes=60'),
      200,
      '读取解耦后的可观测快照',
    );
    expect(decoupled.sloWindowMinutes).toBe(5);
    expect(decoupled.window.minutes).toBe(60);

    const failoverAgentId = await createAgent(
      browser,
      `${suffix}-failover`,
      agentIds,
      providerModel,
    );
    const providerA = await createProvider(browser, {
      name: `E2E 故障供应商 ${suffix}`,
      baseUrl: 'http://127.0.0.1:1',
      models: [providerModel],
      priority: 10,
      enabled: true,
    });
    providerIds.push(providerA);
    const providerB = await createProvider(browser, {
      name: `E2E 正常供应商 ${suffix}`,
      baseUrl: fakeModelUrl,
      models: [providerModel],
      priority: 20,
      enabled: true,
    });
    providerIds.push(providerB);

    const firstRun = ensure<{ runId: string }>(
      await api(browser, 'POST', '/api/chat', {
        agentId: failoverAgentId,
        message: `E2E 供应商故障切换 ${suffix}`,
      }),
      202,
      '发起故障切换运行',
    );
    await waitRun(browser, firstRun.runId);

    const firstState = await fixture('model-security', 'getRunProviderState', firstRun.runId);
    assert(firstState !== null, '缺少第一次运行的供应商状态');
    expect(firstState.status).toBe('succeeded');
    expect(firstState.servedProviderId).toBe(providerB);
    expect(firstState.providerFailovers).toBeGreaterThanOrEqual(1);

    const logs = await fixture('model-security', 'listProviderRequestLogs', firstRun.runId);
    const failedIndex = logs.findIndex(
      (log) => log.providerId === providerA && log.errorKind === 'network',
    );
    const servedIndex = logs.findIndex(
      (log) => log.providerId === providerB && log.statusCode === 200 && log.errorKind === null,
    );
    expect(failedIndex).toBeGreaterThanOrEqual(0);
    expect(servedIndex).toBeGreaterThan(failedIndex);
    expect(logs[servedIndex]?.failoverFromProviderId).toBe(providerA);

    const snapshot = ensure<ObservabilitySnapshot>(
      await api(browser, 'GET', '/api/observability?windowMinutes=60'),
      200,
      '读取可观测快照',
    );
    const metricA = snapshot.providers.find((row) => row.providerId === providerA);
    const metricB = snapshot.providers.find((row) => row.providerId === providerB);
    assert(metricA !== undefined && metricB !== undefined, '可观测快照缺少供应商指标');
    expect(metricA.errors).toBeGreaterThanOrEqual(1);
    expect(metricB.errors).toBe(0);
    expect(metricB.requests).toBeGreaterThanOrEqual(1);

    const providers = ensure<ProviderView[]>(
      await api(browser, 'GET', '/api/model-providers'),
      200,
      '读取供应商列表',
    );
    const listedA = providers.find((row) => row.id === providerA);
    const listedB = providers.find((row) => row.id === providerB);
    assert(listedA !== undefined && listedB !== undefined, '供应商列表缺少新建供应商');
    expect(listedA.health.state).toBe('unhealthy');
    expect(listedA.lastError).not.toBeNull();
    expect(listedB.health.state).toBe('healthy');
    expect(listedB.lastSuccessAt).not.toBeNull();

    ensure(
      await api(browser, 'PATCH', `/api/model-providers/${providerA}`, { enabled: false }),
      200,
      '停用故障供应商',
    );
    ensure(
      await api(browser, 'PATCH', `/api/model-providers/${providerB}`, { priority: 5 }),
      200,
      '提升正常供应商优先级',
    );
    const secondRun = ensure<{ runId: string }>(
      await api(browser, 'POST', '/api/chat', {
        agentId: failoverAgentId,
        message: `E2E 供应商切换后直连 ${suffix}`,
      }),
      202,
      '发起切换后运行',
    );
    await waitRun(browser, secondRun.runId);
    const secondState = await fixture('model-security', 'getRunProviderState', secondRun.runId);
    assert(secondState !== null, '缺少第二次运行的供应商状态');
    expect(secondState.status).toBe('succeeded');
    expect(secondState.servedProviderId).toBe(providerB);
    expect(secondState.providerFailovers).toBe(0);

    await fixture('model-security', 'setRunCost', secondRun.runId, 1.25);
    const usageBeforeDelete = ensure<ProviderUsage[]>(
      await api(browser, 'GET', '/api/model-providers/usage'),
      200,
      '读取供应商成本归因',
    );
    const usageA = usageBeforeDelete.find((row) => row.providerId === providerA);
    const usageB = usageBeforeDelete.find((row) => row.providerId === providerB);
    assert(usageA !== undefined && usageB !== undefined, '供应商用量列表缺少新建供应商');
    expect(usageB.costUsd).toBeGreaterThanOrEqual(1.25);
    expect(usageA.costUsd).toBe(0);

    const deleteConflict = await api<Problem>(
      browser,
      'DELETE',
      `/api/model-providers/${providerB}`,
    );
    expect(deleteConflict.status).toBe(409);
    expect(deleteConflict.json?.code).toBe('CONFLICT');

    const usageAfterDelete = ensure<ProviderUsage[]>(
      await api(browser, 'GET', '/api/model-providers/usage'),
      200,
      '读取删除被拒绝后的供应商成本归因',
    );
    const remainingA = usageAfterDelete.find((row) => row.providerId === providerA);
    const remainingB = usageAfterDelete.find((row) => row.providerId === providerB);
    assert(remainingA !== undefined && remainingB !== undefined, '供应商用量列表缺少历史供应商');
    expect(remainingA.costUsd).toBe(usageA.costUsd);
    expect(remainingB.costUsd).toBeGreaterThanOrEqual(1.25);

    const unusedProvider = await createProvider(browser, {
      name: `E2E 未使用供应商 ${suffix}`,
      baseUrl: fakeModelUrl,
      models: [`e2e-unused-${suffix}`],
      priority: 30,
      enabled: false,
    });
    providerIds.push(unusedProvider);
    ensure(
      await api(browser, 'DELETE', `/api/model-providers/${unusedProvider}`),
      204,
      '删除未使用供应商',
    );
    providerIds.splice(providerIds.indexOf(unusedProvider), 1);
    const providersAfterDelete = ensure<ProviderView[]>(
      await api(browser, 'GET', '/api/model-providers'),
      200,
      '读取删除后的供应商列表',
    );
    expect(providersAfterDelete.some((row) => row.id === unusedProvider)).toBe(false);

    const policyAgentId = await createAgent(browser, `${suffix}-policy`, agentIds);
    const outboundApproval = await api<Problem>(browser, 'POST', '/api/security/policies', {
      name: `E2E 出站审批拒绝 ${suffix}`,
      direction: 'outbound',
      action: 'require_approval',
      matchType: 'keyword',
      pattern: `OUTBOUND-${suffix}`,
      agentId: null,
    });
    expect(outboundApproval.status).toBe(400);
    expect(outboundApproval.json?.code).toBe('INVALID_INPUT');
    const blockPattern = `E2E-BLOCK-${suffix}`;
    const blockPolicyId = await createPolicy(browser, {
      name: `E2E 阻断策略 ${suffix}`,
      action: 'block',
      pattern: blockPattern,
      agentId: policyAgentId,
    });
    policyIds.push(blockPolicyId);

    const blocked = await api<Problem>(browser, 'POST', '/api/chat', {
      agentId: policyAgentId,
      message: `前缀 ${blockPattern} 后缀`,
    });
    expect(blocked.status).toBe(403);
    expect(blocked.json?.code).toBe('CONTENT_BLOCKED');

    const events = ensure<{ items: PolicyEvent[] }>(
      await api(browser, 'GET', '/api/security/events?action=block'),
      200,
      '读取阻断事件',
    );
    const blockedEvent = events.items.find((event) => event.policyId === blockPolicyId);
    assert(blockedEvent !== undefined, '阻断事件列表缺少该策略事件');
    expect(blockedEvent.sourceKind).toBe('run_prompt');
    expect(blockedEvent.snippet).toContain('[REDACTED]');
    expect(blockedEvent.snippet).not.toContain(blockPattern);

    const attachmentBlocked = await api<Problem>(browser, 'POST', '/api/chat', {
      agentId: policyAgentId,
      message: `附件文件名检测 ${suffix}`,
      attachments: [
        {
          filename: `${blockPattern}.txt`,
          dataBase64: Buffer.from('ordinary contents').toString('base64'),
        },
      ],
    });
    expect(attachmentBlocked.status).toBe(403);
    expect(attachmentBlocked.json?.code).toBe('CONTENT_BLOCKED');

    const policyEvents = ensure<{ items: PolicyEvent[] }>(
      await api(browser, 'GET', '/api/security/events?action=block'),
      200,
      '读取附件阻断事件',
    );
    const policyEventsForBlock = policyEvents.items.filter(
      (event) => event.policyId === blockPolicyId,
    );
    expect(policyEventsForBlock.length).toBeGreaterThanOrEqual(2);
    for (const event of policyEventsForBlock) {
      expect(event.snippet).toContain('[REDACTED]');
      expect(event.snippet).not.toContain(blockPattern);
    }

    const violations = ensure<{ items: ViolationCase[] }>(
      await api(browser, 'GET', '/api/security/violations?status=open'),
      200,
      '读取违规工单',
    );
    const violation = violations.items.find((item) => item.policyId === blockPolicyId);
    assert(violation !== undefined, '违规工单列表缺少该策略工单');
    expect(violation.subjectId).toBe(adminBusinessId);

    const blockedAudit = ensure<{ items: AuditItem[] }>(
      await api(browser, 'GET', '/api/audit?action=policy.blocked'),
      200,
      '读取阻断审计',
    );
    expect(blockedAudit.items.some((item) => item.target === blockedEvent.id)).toBe(true);

    const approvalPattern = `E2E-APPROVAL-${suffix}`;
    const approvalPolicyId = await createPolicy(browser, {
      name: `E2E 审批策略 ${suffix}`,
      action: 'require_approval',
      pattern: approvalPattern,
      agentId: policyAgentId,
    });
    policyIds.push(approvalPolicyId);
    const approvalMessage = `请处理 ${approvalPattern} 内容`;

    const needsApproval = await api<Problem>(browser, 'POST', '/api/chat', {
      agentId: policyAgentId,
      message: approvalMessage,
    });
    expect(needsApproval.status).toBe(409);
    expect(needsApproval.json?.code).toBe('CONTENT_APPROVAL_REQUIRED');
    const approvalId = needsApproval.json?.resourceId;
    assert(typeof approvalId === 'string' && approvalId.length > 0, '审批问题缺少 resourceId');

    const pendingPrompts = await upstreamPrompts(fakeModelUrl);
    expect(pendingPrompts.some((prompt) => prompt.includes(approvalPattern))).toBe(false);

    const pending = ensure<{ items: PolicyApproval[] }>(
      await api(browser, 'GET', '/api/security/approvals?status=pending'),
      200,
      '读取待审批列表',
    );
    expect(pending.items.some((item) => item.id === approvalId)).toBe(true);

    ensure(
      await api(browser, 'POST', `/api/security/approvals/${approvalId}/decision`, {
        decision: 'approve',
      }),
      200,
      '批准内容外发',
    );
    const approvedRun = ensure<{ runId: string }>(
      await api(browser, 'POST', '/api/chat', {
        agentId: policyAgentId,
        message: approvalMessage,
      }),
      202,
      '审批后重试同一消息',
    );
    await waitRun(browser, approvedRun.runId);

    const approvedPrompts = await upstreamPrompts(fakeModelUrl);
    expect(approvedPrompts.some((prompt) => prompt === approvalMessage)).toBe(true);

    const approved = ensure<{ items: PolicyApproval[] }>(
      await api(browser, 'GET', '/api/security/approvals?status=approved'),
      200,
      '读取已批准列表',
    );
    const consumed = approved.items.find((item) => item.id === approvalId);
    assert(consumed !== undefined, '已批准列表缺少该审批');
    expect(consumed.consumedAt).not.toBeNull();

    const approvalAudit = ensure<{ items: AuditItem[] }>(
      await api(browser, 'GET', '/api/audit?action=security.approval.decided'),
      200,
      '读取审批审计',
    );
    expect(approvalAudit.items.some((item) => item.target === approvalId)).toBe(true);

    const redactPattern = `E2E-REDACT-${suffix}`;
    const redactPolicyId = await createPolicy(browser, {
      name: `E2E 脱敏策略 ${suffix}`,
      action: 'redact',
      pattern: redactPattern,
      agentId: policyAgentId,
    });
    policyIds.push(redactPolicyId);
    const redactedRun = ensure<{ runId: string }>(
      await api(browser, 'POST', '/api/chat', {
        agentId: policyAgentId,
        message: `请处理 ${redactPattern} 内容`,
      }),
      202,
      '发起脱敏运行',
    );
    await waitRun(browser, redactedRun.runId);

    const redactedPrompts = await upstreamPrompts(fakeModelUrl);
    expect(
      redactedPrompts.some(
        (prompt) => prompt.includes('[REDACTED]') && !prompt.includes(redactPattern),
      ),
    ).toBe(true);

    const redactedEvents = ensure<{ items: PolicyEvent[] }>(
      await api(browser, 'GET', '/api/security/events?action=redact'),
      200,
      '读取脱敏事件',
    );
    const redactedEvent = redactedEvents.items.find((event) => event.policyId === redactPolicyId);
    assert(redactedEvent !== undefined, '脱敏事件列表缺少该策略事件');
    expect(redactedEvent.snippet).toContain('[REDACTED]');
    expect(redactedEvent.snippet).not.toContain(redactPattern);

    const redactedAudit = ensure<{ items: AuditItem[] }>(
      await api(browser, 'GET', '/api/audit?action=policy.redacted'),
      200,
      '读取脱敏审计',
    );
    expect(redactedAudit.items.some((item) => item.target === redactedEvent.id)).toBe(true);
  } finally {
    await bestEffort('管理员重新登录', () => adminLogin(browser));
    const original = sloOriginal;
    if (original !== null) {
      await bestEffort('恢复 SLO 设置', async () =>
        ensure(await api(browser, 'PUT', '/api/observability/slo', original), 200, '恢复 SLO 设置'),
      );
    }
    for (const id of policyIds) {
      await bestEffort(`删除策略 ${id}`, async () =>
        ensure(await api(browser, 'DELETE', `/api/security/policies/${id}`), 204, '删除策略'),
      );
    }
    for (const id of providerIds) {
      await bestEffort(`停用供应商 ${id}`, async () =>
        ensure(
          await api(browser, 'PATCH', `/api/model-providers/${id}`, { enabled: false }),
          200,
          '停用供应商',
        ),
      );
    }
    for (const id of agentIds) {
      await bestEffort(`删除智能体 ${id}`, async () =>
        ensure(await api(browser, 'DELETE', `/api/agents/${id}`), 204, '删除智能体'),
      );
    }
  }
});
