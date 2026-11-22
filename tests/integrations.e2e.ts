import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import { requireExecutionStack } from './support/execution-stack.js';

const contract = await requireExecutionStack();

interface ReceivedWebhook {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface ExternalCallResult {
  status: number;
  text: string;
  json: Record<string, unknown> | null;
}

interface WebhookCreated {
  id: string;
  name: string;
  direction: 'inbound' | 'outbound';
  agentId: string | null;
  url: string | null;
  events: string[];
  secret: string;
}

interface TokenCreated {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  token: string;
}

interface RunAccepted {
  runId: string;
  conversationId: string;
  status: string;
  replayed?: boolean;
}

interface RunStatus {
  id: string;
  status: string;
  agentId: string;
  conversationId: string;
  trigger: string;
  error: string | null;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('回调服务器没有取到端口'));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function apiCall<T>(
  browser: Browser,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await browserFetch(browser, method, path, body);
  return {
    status: response.status,
    body: (response.text === '' ? null : JSON.parse(response.text)) as T,
  };
}

async function apiJson<T>(browser: Browser, method: string, path: string): Promise<T> {
  const { status, body } = await apiCall<T>(browser, method, path);
  if (status < 200 || status >= 300) throw new Error(`${method} ${path} 返回 ${status}`);
  return body;
}

async function externalCall(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<ExternalCallResult> {
  const response = await fetch(`${contract.appUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: text === '' ? null : (JSON.parse(text) as Record<string, unknown>),
  };
}

function jsonBody<T>(result: ExternalCallResult): T {
  if (result.json === null) throw new Error(`响应不是 JSON：${result.text.slice(0, 500)}`);
  return result.json as unknown as T;
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  check: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(
    `等待超时（${timeoutMs}ms）：${label}${lastError === undefined ? '' : `；最后错误：${String(lastError)}`}`,
  );
}

async function runCount(browser: Browser, agentId: string): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await apiJson<{ items: unknown[]; nextCursor: string | null }>(
      browser,
      'GET',
      `/api/runs?agentId=${encodeURIComponent(agentId)}&limit=100${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    count += page.items.length;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return count;
}

function sign(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

function completedCountFor(received: ReceivedWebhook[], runId: string): number {
  return received.filter(
    (delivery) =>
      delivery.headers['x-agentport-event'] === 'run.completed' &&
      (JSON.parse(delivery.body) as { runId?: unknown }).runId === runId,
  ).length;
}

async function bestEffortStatus(action: () => Promise<{ status: number }>): Promise<number> {
  try {
    return (await action()).status;
  } catch {
    return 0;
  }
}

test('integrations 外部令牌触发运行并收到签名回调，重复事件不重复运行', {
  session: 'admin',
  timeout: 300_000,
}, async ({ app, browser }) => {
  await app.open('/');
  expect(await browser.evaluate(() => location.origin)).toBe(contract.appUrl);

  const suffix = crypto.randomUUID().slice(0, 8);
  const agent = await apiCall<{ id: string }>(browser, 'POST', '/api/agents', {
    slug: `e2e-integrations-${suffix}`,
    name: `E2E 集成 ${suffix}`,
  });
  expect(agent.status).toBe(201);
  const agentId = agent.body.id;

  const received: ReceivedWebhook[] = [];
  const endpointIds: string[] = [];
  const tokenIds: string[] = [];
  let failed = false;
  const callbackServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      received.push({
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });

  try {
    const port = await listen(callbackServer);

    const outbound = await apiCall<WebhookCreated>(browser, 'POST', '/api/integrations/webhooks', {
      name: `E2E outbound ${suffix}`,
      direction: 'outbound',
      url: `http://127.0.0.1:${port}/callback`,
      events: ['run.completed', 'run.failed'],
    });
    expect(outbound.status).toBe(201);
    expect(outbound.body.secret.startsWith('whsec_')).toBe(true);
    endpointIds.push(outbound.body.id);

    const webhookList = (
      await apiJson<{ items: Array<{ id: string }> }>(browser, 'GET', '/api/integrations/webhooks')
    ).items;
    expect(webhookList.some((endpoint) => endpoint.id === outbound.body.id)).toBe(true);

    const rejectedName = `E2E outbound localhost ${suffix}`;
    const loopbackByName = await apiCall<{ code: string }>(
      browser,
      'POST',
      '/api/integrations/webhooks',
      {
        name: rejectedName,
        direction: 'outbound',
        url: `http://localhost:${port}/callback`,
        events: ['run.completed'],
      },
    );
    expect(loopbackByName.status).toBe(400);
    const webhookListAfterRejection = (
      await apiJson<{ items: Array<{ id: string; name: string }> }>(
        browser,
        'GET',
        '/api/integrations/webhooks',
      )
    ).items;
    expect(webhookListAfterRejection.length).toBe(webhookList.length);
    expect(webhookListAfterRejection.some((endpoint) => endpoint.name === rejectedName)).toBe(
      false,
    );

    const token = await apiCall<TokenCreated>(browser, 'POST', '/api/integrations/tokens', {
      name: `E2E token ${suffix}`,
      scopes: ['runs.create', 'runs.read'],
    });
    expect(token.status).toBe(201);
    expect(token.body.token.startsWith('atk_')).toBe(true);
    tokenIds.push(token.body.id);
    const tokenList = await browserFetch(browser, 'GET', '/api/integrations/tokens');
    expect(tokenList.status).toBe(200);
    expect(tokenList.text).not.toContain(token.body.token);
    const tokenEntries = (JSON.parse(tokenList.text) as { items: Array<{ id: string }> }).items;
    expect(tokenEntries.some((entry) => entry.id === token.body.id)).toBe(true);

    const message = `E2E-INTEGRATIONS-${suffix}`;
    const idempotencyKey = crypto.randomUUID();
    const first = await externalCall(
      'POST',
      '/api/v1/runs',
      {
        authorization: `Bearer ${token.body.token}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      JSON.stringify({ agentId, message }),
    );
    expect(first.status).toBe(202);
    const accepted = jsonBody<RunAccepted>(first);
    expect(accepted.status).toBe('queued');
    expect(accepted.replayed).toBeUndefined();
    expect(accepted.runId.length).toBeGreaterThan(0);
    expect(accepted.conversationId.length).toBeGreaterThan(0);

    const terminal = await waitFor('外部令牌触发的 run 到达终态', 120_000, async () => {
      const current = await externalCall('GET', `/api/v1/runs/${accepted.runId}`, {
        authorization: `Bearer ${token.body.token}`,
      });
      if (current.status !== 200) {
        throw new Error(
          `GET /api/v1/runs/${accepted.runId} 返回 ${current.status}：${current.text}`,
        );
      }
      const status = jsonBody<RunStatus>(current);
      return status.status === 'queued' || status.status === 'running' ? null : status;
    });
    expect(terminal.status, JSON.stringify(terminal)).toBe('succeeded');
    expect(terminal.trigger).toBe('event');

    const completed = await waitFor('收到 run.completed 回调', 60_000, async () => {
      const match = received.find(
        (delivery) =>
          delivery.headers['x-agentport-event'] === 'run.completed' &&
          (JSON.parse(delivery.body) as { runId?: unknown }).runId === accepted.runId,
      );
      return match ?? null;
    });
    const timestamp = completed.headers['x-agentport-timestamp'];
    const signature = completed.headers['x-agentport-signature'];
    const deliveryId = completed.headers['x-agentport-delivery'];
    expect(typeof timestamp).toBe('string');
    expect(typeof signature).toBe('string');
    expect(typeof deliveryId).toBe('string');
    expect(deliveryId).not.toBe('');
    expect(signature).toBe(sign(outbound.body.secret, String(timestamp), completed.body));
    expect(JSON.parse(completed.body)).toMatchObject({
      runId: accepted.runId,
      agentId,
      status: 'succeeded',
    });

    const runsAfterFirstTrigger = await runCount(browser, agentId);
    const replay = await externalCall(
      'POST',
      '/api/v1/runs',
      {
        authorization: `Bearer ${token.body.token}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      JSON.stringify({ agentId, message }),
    );
    expect(replay.status).toBe(200);
    const replayed = jsonBody<RunAccepted>(replay);
    expect(replayed.status).toBe('succeeded');
    expect(replayed.replayed).toBe(true);
    expect(replayed.runId).toBe(accepted.runId);
    expect(await runCount(browser, agentId)).toBe(runsAfterFirstTrigger);
    const deliveriesAfterReplay = completedCountFor(received, accepted.runId);
    expect(deliveriesAfterReplay).toBe(1);
    await delay(1_500);
    expect(completedCountFor(received, accepted.runId)).toBe(deliveriesAfterReplay);

    const inbound = await apiCall<WebhookCreated>(browser, 'POST', '/api/integrations/webhooks', {
      name: `E2E inbound ${suffix}`,
      direction: 'inbound',
      agentId,
    });
    expect(inbound.status).toBe(201);
    expect(inbound.body.secret.startsWith('whsec_')).toBe(true);
    endpointIds.push(inbound.body.id);

    const eventId = `evt-${crypto.randomUUID()}`;
    const inboundBody = JSON.stringify({ eventId, message: `E2E-INBOUND-${suffix}` });
    const inboundTimestamp = Date.now().toString();
    const inboundHeaders = {
      'content-type': 'application/json',
      'x-agentport-timestamp': inboundTimestamp,
      'x-agentport-signature': sign(inbound.body.secret, inboundTimestamp, inboundBody),
    };
    const inboundFirst = await externalCall(
      'POST',
      `/api/webhooks/inbound/${inbound.body.id}`,
      inboundHeaders,
      inboundBody,
    );
    expect(inboundFirst.status).toBe(202);
    const inboundAccepted = jsonBody<RunAccepted>(inboundFirst);
    expect(inboundAccepted.status).toBe('queued');

    const runsAfterFirstInbound = await runCount(browser, agentId);
    const inboundReplay = await externalCall(
      'POST',
      `/api/webhooks/inbound/${inbound.body.id}`,
      inboundHeaders,
      inboundBody,
    );
    expect(inboundReplay.status).toBe(200);
    const inboundReplayed = jsonBody<RunAccepted>(inboundReplay);
    expect(inboundReplayed.replayed).toBe(true);
    expect(inboundReplayed.runId).toBe(inboundAccepted.runId);
    expect(await runCount(browser, agentId)).toBe(runsAfterFirstInbound);

    const mismatchEventId = `evt-${crypto.randomUUID()}`;
    const mismatchBody = JSON.stringify({
      eventId: mismatchEventId,
      message: `E2E-INBOUND-MISMATCH-${suffix}`,
    });
    const mismatchTimestamp = Date.now().toString();
    const mismatchedKey = await externalCall(
      'POST',
      `/api/webhooks/inbound/${inbound.body.id}`,
      {
        'content-type': 'application/json',
        'x-agentport-timestamp': mismatchTimestamp,
        'x-agentport-signature': sign(inbound.body.secret, mismatchTimestamp, mismatchBody),
        'x-idempotency-key': crypto.randomUUID(),
      },
      mismatchBody,
    );
    expect(mismatchedKey.status).toBe(400);

    const conflictEventId = `evt-${crypto.randomUUID()}`;
    const conflictFirstBody = JSON.stringify({
      eventId: conflictEventId,
      message: `E2E-INBOUND-CONFLICT-A-${suffix}`,
    });
    const conflictFirstTimestamp = Date.now().toString();
    const conflictFirst = await externalCall(
      'POST',
      `/api/webhooks/inbound/${inbound.body.id}`,
      {
        'content-type': 'application/json',
        'x-agentport-timestamp': conflictFirstTimestamp,
        'x-agentport-signature': sign(
          inbound.body.secret,
          conflictFirstTimestamp,
          conflictFirstBody,
        ),
      },
      conflictFirstBody,
    );
    expect(conflictFirst.status).toBe(202);
    const runsAfterConflictFirst = await runCount(browser, agentId);

    const conflictSecondBody = JSON.stringify({
      eventId: conflictEventId,
      message: `E2E-INBOUND-CONFLICT-B-${suffix}`,
    });
    const conflictSecondTimestamp = Date.now().toString();
    const conflict = await externalCall(
      'POST',
      `/api/webhooks/inbound/${inbound.body.id}`,
      {
        'content-type': 'application/json',
        'x-agentport-timestamp': conflictSecondTimestamp,
        'x-agentport-signature': sign(
          inbound.body.secret,
          conflictSecondTimestamp,
          conflictSecondBody,
        ),
      },
      conflictSecondBody,
    );
    expect(conflict.status).toBe(409);
    expect(await runCount(browser, agentId)).toBe(runsAfterConflictFirst);

    const wrongTimestamp = Date.now().toString();
    const wrongBody = JSON.stringify({ eventId: `evt-${crypto.randomUUID()}`, message });
    const wrongSignature = await externalCall(
      'POST',
      `/api/webhooks/inbound/${inbound.body.id}`,
      {
        'content-type': 'application/json',
        'x-agentport-timestamp': wrongTimestamp,
        'x-agentport-signature': sign(`whsec_wrong_${suffix}`, wrongTimestamp, wrongBody),
      },
      wrongBody,
    );
    expect(wrongSignature.status).toBe(401);

    const readOnly = await apiCall<TokenCreated>(browser, 'POST', '/api/integrations/tokens', {
      name: `E2E read only ${suffix}`,
      scopes: ['runs.read'],
    });
    expect(readOnly.status).toBe(201);
    tokenIds.push(readOnly.body.id);
    const forbidden = await externalCall(
      'POST',
      '/api/v1/runs',
      {
        authorization: `Bearer ${readOnly.body.token}`,
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      JSON.stringify({ agentId, message }),
    );
    expect(forbidden.status).toBe(403);

    const anonymous = await externalCall(
      'POST',
      '/api/v1/runs',
      { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      JSON.stringify({ agentId, message }),
    );
    expect(anonymous.status).toBe(401);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const cleanupStatuses: number[] = [];
    for (const endpointId of endpointIds) {
      cleanupStatuses.push(
        await bestEffortStatus(() =>
          browserFetch(browser, 'DELETE', `/api/integrations/webhooks/${endpointId}`),
        ),
      );
    }
    for (const tokenId of tokenIds) {
      cleanupStatuses.push(
        await bestEffortStatus(() =>
          browserFetch(browser, 'DELETE', `/api/integrations/tokens/${tokenId}`),
        ),
      );
    }
    await close(callbackServer);
    if (!failed) {
      expect(cleanupStatuses).toEqual([...endpointIds.map(() => 204), ...tokenIds.map(() => 204)]);
    }
  }
});
