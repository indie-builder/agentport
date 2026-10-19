#!/usr/bin/env node
// 并发与负载测试。只创建 slug 以 loadtest- 开头的数据，开始与结束各清理一次。
// 用法：node scripts/loadtest.mjs
// 环境变量：BASE_URL（默认 http://localhost:3000）、ADMIN_USER、ADMIN_PASSWORD。
// 可选：PLATFORM_MCP_TOKEN（MCP 测试）、DATABASE_URL（清理；默认读 .env）。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(ROOT, '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const PLATFORM_MCP_TOKEN = process.env.PLATFORM_MCP_TOKEN ?? '';
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const PREFIX = 'loadtest-';
const RUN_ID = Date.now().toString(36);
const READ_CONCURRENCY = 50;
const READ_ROUNDS = 20;

if (!ADMIN_PASSWORD) {
  console.error('缺少 ADMIN_PASSWORD。用法：ADMIN_PASSWORD=... node scripts/loadtest.mjs');
  process.exit(1);
}

// 百分位实现的自检；脚本本身没有测试框架。
assert.equal(pct([1, 2, 3, 4], 0.5), 2.5);
assert.ok(Math.abs(pct([1, 2, 3, 4], 0.95) - 3.85) < 1e-9);

const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pct(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function ms(value) {
  if (value === null || value === undefined) return '-';
  return value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0);
}

function mb(bytes) {
  return bytes === null || bytes === undefined ? '-' : (bytes / 1024 / 1024).toFixed(1);
}

function request(method, path, { body, headers = {}, timeoutMs = 30_000 } = {}) {
  const url = new URL(path, BASE_URL);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const finalHeaders = { ...headers };
  if (payload !== undefined) {
    finalHeaders['content-type'] = 'application/json';
    finalHeaders['content-length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: finalHeaders, agent }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function timed(fn) {
  const started = performance.now();
  try {
    const result = await fn();
    return { ok: result.status >= 200 && result.status < 300, status: result.status, ms: performance.now() - started, result };
  } catch (err) {
    return { ok: false, status: 0, ms: performance.now() - started, error: err.message };
  }
}

function summarize(label, samples, rss, startedAt = performance.now(), extra = '') {
  const ok = samples.filter((sample) => sample.ok);
  const latencies = ok.map((sample) => sample.ms);
  const errors = samples.length - ok.length;
  const elapsedMs = performance.now() - startedAt;
  const rps = samples.length / (elapsedMs / 1000);
  const statuses = {};
  for (const sample of samples) {
    if (!sample.ok) statuses[sample.status || 'network'] = (statuses[sample.status || 'network'] ?? 0) + 1;
  }
  const db = rss?.peakDbWaiting ? ` dbWait=${rss.peakDbWaiting}/${rss.peakDbTotal}` : '';
  const line = [
    label.padEnd(24),
    String(samples.length).padStart(5),
    String(errors).padStart(4),
    ms(pct(latencies, 0.5)).padStart(8),
    ms(pct(latencies, 0.95)).padStart(8),
    ms(pct(latencies, 0.99)).padStart(8),
    `${rps.toFixed(0)}`.padStart(8),
    mb(rss?.maxRss).padStart(9),
  ].join(' ');
  console.log(`${line}${db}${extra}`);
  return {
    label,
    samples: samples.length,
    errors,
    errorStatuses: statuses,
    p50: pct(latencies, 0.5),
    p95: pct(latencies, 0.95),
    p99: pct(latencies, 0.99),
    rps,
    rss: rss ?? null,
  };
}

function createSampler(intervalMs = 100) {
  let timer;
  let startRss = null;
  let maxRss = null;
  let endRss = null;
  let last = null;
  let samples = 0;
  let busy = false;
  let peakDbWaiting = 0;
  let peakDbTotal = 0;
  let peakQueue = { waiting: 0, active: 0 };
  const take = async () => {
    if (busy) return;
    busy = true;
    try {
      const res = await request('GET', '/health/metrics', { timeoutMs: 3_000 });
      const metrics = JSON.parse(res.text);
      last = metrics;
      const rss = metrics.process?.memoryRssBytes ?? null;
      if (rss !== null) {
        if (startRss === null) startRss = rss;
        maxRss = maxRss === null ? rss : Math.max(maxRss, rss);
        samples += 1;
      }
      if (metrics.db) {
        peakDbWaiting = Math.max(peakDbWaiting, metrics.db.waiting ?? 0);
        peakDbTotal = Math.max(peakDbTotal, metrics.db.total ?? 0);
      }
      if (metrics.queue) {
        peakQueue.waiting = Math.max(peakQueue.waiting, metrics.queue.waiting ?? 0);
        peakQueue.active = Math.max(peakQueue.active, metrics.queue.active ?? 0);
      }
    } catch {
      // 指标端点偶发失败不能打断压测。
    } finally {
      busy = false;
    }
  };
  return {
    async start() {
      await take();
      timer = setInterval(take, intervalMs);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      await take();
      endRss = last?.process?.memoryRssBytes ?? null;
      return { startRss, maxRss, endRss, samples, peakDbWaiting, peakDbTotal, peakQueue };
    },
    get last() {
      return last;
    },
  };
}

// ---- DB 清理：只用 slug 前缀圈定自己创建的数据 ----
let Pool = null;
try {
  Pool = createRequire(join(ROOT, 'packages/db/package.json'))('pg').Pool;
} catch {
  Pool = null;
}

const hasDb = Boolean(Pool && DATABASE_URL);
const CLEANUP_SQL = [
  `delete from audit_log where target in (
     select id from agent_runs where agent_id in (select id from agents where slug like '${PREFIX}%')
     union select id from agents where slug like '${PREFIX}%'
     union select id from skills where slug like '${PREFIX}%'
   )`,
  `delete from agent_runs where agent_id in (select id from agents where slug like '${PREFIX}%')`,
  `delete from messages where conversation_id in (
     select id from conversations where agent_id in (select id from agents where slug like '${PREFIX}%')
   )`,
  `delete from conversations where agent_id in (select id from agents where slug like '${PREFIX}%')`,
  `delete from skills where slug like '${PREFIX}%'`,
  `delete from agents where slug like '${PREFIX}%'`,
];

async function cleanup(label) {
  if (!hasDb) {
    console.log(`[cleanup:${label}] 跳过（无可用的 pg / DATABASE_URL）`);
    return null;
  }
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  const counts = {};
  try {
    for (const sql of CLEANUP_SQL) {
      const table = /from (\w+)/.exec(sql)?.[1] ?? sql;
      const result = await pool.query(sql);
      counts[table] = (counts[table] ?? 0) + (result.rowCount ?? 0);
    }
    // worker 的工作区目录（WORKSPACES_DIR 相对 worker 的 cwd）。
    const workspaces = join(ROOT, 'packages/worker/data/workspaces');
    if (existsSync(workspaces)) {
      const names = await readdir(workspaces).catch(() => []);
      const mine = names.filter((name) => name.startsWith(PREFIX));
      await Promise.all(mine.map((name) => rm(join(workspaces, name), { recursive: true, force: true })));
      if (mine.length > 0) counts.workspaces = mine.length;
    }
    console.log(`[cleanup:${label}] ${JSON.stringify(counts)}`);
    return counts;
  } catch (err) {
    console.error(`[cleanup:${label}] 失败：${err.message}`);
    return null;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function login() {
  let res;
  try {
    res = await request('POST', '/api/auth/login', {
      body: { username: ADMIN_USER, password: ADMIN_PASSWORD },
      timeoutMs: 10_000,
    });
  } catch (err) {
    console.error(`API 未启动或不可达（${BASE_URL}）：${err.message}`);
    console.error('先启动 api 与 worker，再重试。');
    process.exit(1);
  }
  if (res.status === 429) {
    console.error('登录被限流（10 次/分钟）。等一分钟，或临时 RATE_LIMIT_DISABLED=1 重启 api。');
    process.exit(1);
  }
  if (res.status !== 200) {
    console.error(`登录失败：${res.status} ${res.text}`);
    process.exit(1);
  }
  const cookies = res.headers['set-cookie'] ?? [];
  const token = cookies.map((value) => value.split(';')[0]).find((value) => value?.startsWith('agentport_token='));
  if (!token) {
    console.error('登录响应没有 agentport_token Cookie');
    process.exit(1);
  }
  return token;
}

// ---- 1. 读接口并发 ----
async function readTest(cookie) {
  const results = [];
  for (const path of ['/api/overview', '/api/runs', '/api/agents']) {
    const sampler = createSampler(100);
    await sampler.start();
    const startedAt = performance.now();
    const samples = [];
    for (let round = 0; round < READ_ROUNDS; round += 1) {
      const batch = await Promise.all(
        Array.from({ length: READ_CONCURRENCY }, () =>
          timed(() => request('GET', path, { headers: { Cookie: cookie } })),
        ),
      );
      samples.push(...batch);
    }
    const rss = await sampler.stop();
    results.push(summarize(`GET ${path}`, samples, rss, startedAt));
  }
  return results;
}

// ---- 1b. 读接口加压：找拐点 ----
async function rampTest(cookie) {
  const results = [];
  for (const concurrency of [100, 200]) {
    for (const path of ['/api/overview', '/api/agents']) {
      const sampler = createSampler(100);
      await sampler.start();
      const startedAt = performance.now();
      const samples = [];
      for (let round = 0; round < 10; round += 1) {
        samples.push(
          ...(await Promise.all(
            Array.from({ length: concurrency }, () =>
              timed(() => request('GET', path, { headers: { Cookie: cookie }, timeoutMs: 60_000 })),
            ),
          )),
        );
      }
      const rss = await sampler.stop();
      results.push(summarize(`GET ${path} x${concurrency}`, samples, rss, startedAt));
    }
  }
  // 单查询接口做对照：若它在大并发下仍低，说明瓶颈是查询数 × 连接池，而不是 Node CPU。
  for (const path of ['/health/live', '/api/runs']) {
    const concurrency = 200;
    const samples = [];
    const sampler = createSampler(100);
    await sampler.start();
    const startedAt = performance.now();
    for (let round = 0; round < 10; round += 1) {
      samples.push(
        ...(await Promise.all(
          Array.from({ length: concurrency }, () =>
            timed(() => request('GET', path, { headers: { Cookie: cookie }, timeoutMs: 60_000 })),
          ),
        )),
      );
    }
    results.push(summarize(`GET ${path} x${concurrency}`, samples, await sampler.stop(), startedAt));
  }
  return results;
}

// ---- 2. 写接口并发 ----
async function writeTest(cookie) {
  const body = (index) => ({
    slug: `${PREFIX}${RUN_ID}-skill-${index}`,
    name: `Load test skill ${index}`,
    description: 'loadtest',
    body: 'loadtest',
  });
  const sampler = createSampler(100);
  await sampler.start();
  const startedAt = performance.now();
  const samples = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      timed(() => request('POST', '/api/skills', { body: body(index), headers: { Cookie: cookie } })),
    ),
  );
  const rss = await sampler.stop();
  const summary = summarize('POST /api/skills', samples, rss, startedAt);
  const ids = samples.filter((sample) => sample.ok).map((sample) => JSON.parse(sample.result.text).id);
  // 测试数据立刻删除；DELETE 不计入写延迟。
  const deleted = await Promise.all(
    ids.map((id) => request('DELETE', `/api/skills/${id}`, { headers: { Cookie: cookie } }).then((res) => res.status).catch(() => 0)),
  );
  summary.deleted = deleted.filter((status) => status === 204).length;
  return summary;
}

// ---- 3. SSE 并发 ----
function sse(path, cookie, timeoutMs) {
  const url = new URL(path, BASE_URL);
  return new Promise((resolve) => {
    const started = performance.now();
    let connectMs = null;
    let events = 0;
    let bytes = 0;
    let buffer = '';
    let settled = false;
    const finish = (input) => {
      if (settled) return;
      settled = true;
      resolve({ connectMs, events, bytes, durationMs: performance.now() - started, ...input });
    };
    const req = http.request(url, { method: 'GET', agent, headers: { Cookie: cookie, Accept: 'text/event-stream' } }, (res) => {
      connectMs = performance.now() - started;
      if (res.statusCode !== 200) {
        res.resume();
        finish({ status: res.statusCode, ok: false, error: `status ${res.statusCode}` });
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) if (part.includes('data:')) events += 1;
      });
      res.on('end', () => finish({ status: 200, ok: true }));
      res.on('error', (err) => finish({ status: 0, ok: false, error: err.message }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish({ status: 0, ok: false, error: 'timeout', timedOut: true });
    });
    req.on('error', (err) => finish({ status: 0, ok: false, error: err.message }));
    req.end();
  });
}

async function sseTest(cookie, agentId) {
  const post = await request('POST', '/api/chat', {
    body: { agentId, message: '用一句话回答 1+1 等于几。不要调用任何工具。' },
    headers: { Cookie: cookie },
  });
  if (post.status !== 202) {
    return { skipped: `POST /api/chat 返回 ${post.status} ${post.text}` };
  }
  const runId = JSON.parse(post.text).runId;
  const chatBudget = {
    remaining: Number(post.headers['x-ratelimit-remaining'] ?? 0),
    resetSeconds: Number(post.headers['x-ratelimit-reset'] ?? 60),
  };
  const sampler = createSampler(100);
  await sampler.start();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => sse(`/api/chat/${runId}/events`, cookie, 60_000)),
  );
  const rss = await sampler.stop();

  // 等 run 结束，确保下一项测试不受残留容器/队列影响。
  let status = 'queued';
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await request('GET', `/api/runs/${runId}`, { headers: { Cookie: cookie } });
    if (res.status === 200) status = JSON.parse(res.text).run.status;
    if (['succeeded', 'failed', 'cancelled', 'timeout'].includes(status)) break;
    await sleep(300);
  }
  if (!['succeeded', 'failed', 'cancelled', 'timeout'].includes(status)) {
    await request('POST', `/api/chat/${runId}/cancel`, { headers: { Cookie: cookie } }).catch(() => undefined);
  }
  const ok = results.filter((result) => result.ok);
  const summary = {
    runId,
    finalStatus: status,
    chatBudget,
    ok: ok.length,
    errors: results.length - ok.length,
    connectP50: pct(ok.map((result) => result.connectMs), 0.5),
    connectP95: pct(ok.map((result) => result.connectMs), 0.95),
    durationP50: pct(ok.map((result) => result.durationMs), 0.5),
    durationMax: ok.length ? Math.max(...ok.map((result) => result.durationMs)) : null,
    eventsMin: ok.length ? Math.min(...ok.map((result) => result.events)) : null,
    rss,
  };
  console.log(
    `SSE x20 (${runId}) ok=${summary.ok} err=${summary.errors} connect p50/p95=${ms(summary.connectP50)}/${ms(summary.connectP95)}ms ` +
      `duration p50/max=${ms(summary.durationP50)}/${ms(summary.durationMax)}ms events>=${summary.eventsMin} ` +
      `RSS ${mb(rss.startRss)}->${mb(rss.endRss)} peak ${mb(rss.maxRss)} MB status=${status}`,
  );
  return summary;
}

// ---- 4. MCP 端点 ----
async function mcpTest() {
  if (!PLATFORM_MCP_TOKEN) return { skipped: 'PLATFORM_MCP_TOKEN 未设置' };
  const sampler = createSampler(100);
  await sampler.start();
  const startedAt = performance.now();
  const samples = await Promise.all(
    Array.from({ length: 20 }, () =>
      timed(async () => {
        const res = await request('POST', '/mcp', {
          body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          headers: {
            Authorization: `Bearer ${PLATFORM_MCP_TOKEN}`,
            Accept: 'application/json, text/event-stream',
          },
        });
        const payload = res.text.split('\n').find((line) => line.startsWith('data:'))?.slice(5) ?? '';
        if (!payload.includes('"tools"')) {
          return { ...res, status: res.status === 200 ? 0 : res.status };
        }
        return res;
      }),
    ),
  );
  const rss = await sampler.stop();
  return summarize('POST /mcp tools/list', samples, rss, startedAt);
}

// ---- 5. 队列 ----
async function queueTest(cookie, agentId, chatBudget) {
  // /api/chat 限 20 次/分钟；上一次运行（或 SSE 测试）的请求可能还在同一窗口。
  if (chatBudget.remaining < 10) {
    const waitMs = (chatBudget.resetSeconds + 1) * 1000;
    console.log(`等待 chat 限流窗口重置（${waitMs}ms，剩余 ${chatBudget.remaining}/20）...`);
    await sleep(waitMs);
  }
  const sampler = createSampler(150);
  await sampler.start();
  const posts = await Promise.all(
    Array.from({ length: 10 }, async (_, index) => {
      const postedAt = Date.now();
      const sample = await timed(() =>
        request('POST', '/api/chat', {
          body: { agentId, message: `负载测试 ${index + 1}：只回复 OK，不要调用工具。` },
          headers: { Cookie: cookie },
        }),
      );
      return {
        ...sample,
        postedAt,
        runId: sample.ok ? JSON.parse(sample.result.text).runId : null,
      };
    }),
  );
  const accepted = posts.filter((post) => post.runId !== null);
  const rateLimited = posts.filter((post) => post.status === 429).length;
  if (accepted.length === 0) {
    const rss = await sampler.stop();
    return {
      accepted: 0,
      rateLimited,
      statuses: posts.map((post) => post.status),
      rss,
    };
  }

  const postById = new Map(accepted.map((post) => [post.runId, post]));
  const states = new Map();
  let peakWaiting = 0;
  let peakActive = 0;
  const deadline = Date.now() + 180_000;
  let allTerminal = false;
  while (Date.now() < deadline) {
    const [list, metrics] = await Promise.all([
      request('GET', '/api/runs?limit=200', { headers: { Cookie: cookie } }).catch(() => null),
      request('GET', '/health/metrics', { timeoutMs: 3_000 }).catch(() => null),
    ]);
    if (metrics?.status === 200) {
      const queue = JSON.parse(metrics.text).queue;
      if (queue) {
        peakWaiting = Math.max(peakWaiting, queue.waiting);
        peakActive = Math.max(peakActive, queue.active);
      }
    }
    if (list?.status === 200) {
      const items = JSON.parse(list.text).items ?? [];
      for (const item of items) {
        if (!postById.has(item.id)) continue;
        const state = states.get(item.id) ?? {};
        state.status = item.status;
        state.startedAt = item.startedAt;
        states.set(item.id, state);
      }
    }
    allTerminal = accepted.every((post) =>
      ['succeeded', 'failed', 'cancelled', 'timeout'].includes(states.get(post.runId)?.status),
    );
    if (allTerminal) break;
    await sleep(250);
  }

  const waits = [];
  const statuses = {};
  for (const post of accepted) {
    const state = states.get(post.runId);
    if (!state) continue;
    statuses[state.status ?? 'unknown'] = (statuses[state.status ?? 'unknown'] ?? 0) + 1;
    if (state.startedAt) {
      waits.push(Math.max(0, Date.parse(state.startedAt) - post.postedAt));
    }
  }
  const rss = await sampler.stop();
  // 未结束的 run 主动取消，避免留下容器。
  for (const post of accepted) {
    if (!['succeeded', 'failed', 'cancelled', 'timeout'].includes(states.get(post.runId)?.status)) {
      await request('POST', `/api/chat/${post.runId}/cancel`, { headers: { Cookie: cookie } }).catch(() => undefined);
    }
  }
  const summary = {
    accepted: accepted.length,
    rateLimited,
    statuses,
    submitP50: pct(accepted.map((post) => post.ms), 0.5),
    submitP95: pct(accepted.map((post) => post.ms), 0.95),
    queueWaitP50: pct(waits, 0.5),
    queueWaitP95: pct(waits, 0.95),
    queueWaitMax: waits.length ? Math.max(...waits) : null,
    peakWaiting,
    peakActive,
    allTerminal,
    rss,
  };
  console.log(
    `queue accepted=${summary.accepted}/10 rateLimited=${rateLimited} submit p50/p95=${ms(summary.submitP50)}/${ms(summary.submitP95)}ms ` +
      `wait p50/p95/max=${ms(summary.queueWaitP50)}/${ms(summary.queueWaitP95)}/${ms(summary.queueWaitMax)}ms ` +
      `peak waiting/active=${peakWaiting}/${peakActive} statuses=${JSON.stringify(statuses)} ` +
      `RSS ${mb(rss.startRss)}->${mb(rss.endRss)} peak ${mb(rss.maxRss)} MB`,
  );
  return summary;
}

async function createTestAgent(cookie) {
  const res = await request('POST', '/api/agents', {
    body: { slug: `${PREFIX}${RUN_ID}-agent`, name: `Load test ${RUN_ID}`, description: 'loadtest' },
    headers: { Cookie: cookie },
  });
  if (res.status !== 201) {
    throw new Error(`创建测试智能体失败：${res.status} ${res.text}`);
  }
  return JSON.parse(res.text).id;
}

async function main() {
  console.log(`BASE_URL=${BASE_URL} node=${process.version} prefix=${PREFIX}${RUN_ID}-`);

  const ready = await request('GET', '/health/ready', { timeoutMs: 3_000 }).catch((err) => {
    console.error(`API 未启动或不可达（${BASE_URL}）：${err.message}`);
    console.error('先启动 api 与 worker，再重试。');
    process.exit(1);
  });
  if (ready.status !== 200) {
    console.error(`/health/ready 返回 ${ready.status}：${ready.text}`);
    console.error('数据库或 Redis 未就绪，无法压测。');
    process.exit(1);
  }

  await cleanup('before');
  const cookie = await login();

  console.log('\n测试                          样本  错误   p50(ms)  p95(ms)  p99(ms)   req/s  峰值RSS(MB)');
  const summary = {};
  summary.reads = await readTest(cookie);
  summary.ramp = await rampTest(cookie);
  summary.writes = await writeTest(cookie);

  const agentId = await createTestAgent(cookie);
  summary.sse = await sseTest(cookie, agentId);
  summary.mcp = await mcpTest();
  summary.queue = await queueTest(cookie, agentId, summary.sse.chatBudget);

  await cleanup('after');
  console.log(`\nRESULT_JSON ${JSON.stringify(summary)}`);
  agent.destroy();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    agent.destroy();
    process.exit(1);
  },
);
