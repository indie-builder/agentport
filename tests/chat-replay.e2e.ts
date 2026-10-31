import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { type Browser, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { createDb, newId } from '../packages/db/dist/index.js';
import { RUNS_QUEUE } from '../packages/shared/dist/chat.js';
import { runCancelKey, runStreamKey } from '../packages/shared/dist/run-stream.js';

/**
 * fixture 专用的裁剪上限，只用来模拟旧版本或异常情况下已经被裁掉流头的日志。
 * 它不是生产策略：生产保留 worker 事件预算内的完整日志，并分批完整回放。
 */
const FIXTURE_TRIM_MAXLEN = 1000;

/**
 * 回放截断的真实链路：真实页面、真实 POST /api/chat、真实 BullMQ job、真实 Redis Stream、
 * 真实 GET /api/chat/:runId/events 与 GET /api/runs/:runId。fixture 只直写库与流，
 * 不 mock 任何路由或 EventSource，也不调用模型。
 *
 * 唯一被控制的是时序：页面里的 fetch 包装只推迟把已到达的 POST /api/chat 响应交给应用，
 * 使测试能在 EventSource 打开前写好流与落库结果。
 *
 * 第二条用例覆盖另一条恢复路径：worker 只把终态写进库、没发 run_finished，
 * API 轮询发现后补 terminal_missing + run_finished，前端用已保存结果补全。
 *
 * 前置条件（缺一不可，否则直接失败而不是冒真跑模型的风险）：
 * - DATABASE_URL / REDIS_URL 显式给出，且与预览 API 指向同一套实例；
 * - E2E_WORKER_PAUSED=1：父进程已停掉 preview 的 worker。
 */
if (process.env.E2E_WORKER_PAUSED !== '1') {
  throw new Error(
    'E2E_WORKER_PAUSED=1 is required. PARENT ACTION: stop the preview worker, then re-run. This test creates a real queued run for a configured model and must never execute with a live consumer.',
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the truncated replay e2e`);
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');
const REDIS_URL = requiredEnv('REDIS_URL');

interface RedisPipeline {
  xadd(key: string, ...args: (string | number)[]): RedisPipeline;
  exec(): Promise<unknown>;
}

interface RedisClient {
  xadd(key: string, ...args: (string | number)[]): Promise<string>;
  xlen(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  del(...keys: string[]): Promise<number>;
  pipeline(): RedisPipeline;
  quit(): Promise<string>;
}

interface QueueJob {
  remove(): Promise<void>;
}

interface QueueClient {
  getJob(id: string): Promise<QueueJob | undefined>;
  close(): Promise<void>;
}

// 依赖都声明在 packages/api：从那个 package 解析，免得给根目录添加依赖。
const requireFromApi = createRequire(new URL('../packages/api/package.json', import.meta.url));
const { Redis } = requireFromApi('ioredis') as { Redis: new (url: string) => RedisClient };
const { Queue } = requireFromApi('bullmq') as {
  Queue: new (name: string, options: { connection: { url: string } }) => QueueClient;
};

let dbPromise: ReturnType<typeof createDb> | undefined;
function db() {
  dbPromise ??= createDb(DATABASE_URL);
  return dbPromise;
}

let redisInstance: RedisClient | undefined;
function redis(): RedisClient {
  redisInstance ??= new Redis(REDIS_URL);
  return redisInstance;
}

let queueInstance: QueueClient | undefined;
function queue(): QueueClient {
  queueInstance ??= new Queue(RUNS_QUEUE, { connection: { url: REDIS_URL } });
  return queueInstance;
}

test.afterAll(async () => {
  await Promise.allSettled([redisInstance?.quit(), queueInstance?.close(), dbPromise?.pool.end()]);
});

interface Fixture {
  agentId: string;
  conversationId: string;
}

async function until<T>(
  read: () => Promise<T | null>,
  message: string,
  timeout = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(message);
    await delay(100);
  }
}

/** 专家、会话与两条历史消息直写库；历史段落用固定时间排序，先于本轮提问。 */
async function seedFixture(
  fixture: Fixture,
  slug: string,
  text: { historyUser: string; historyAnswer: string },
): Promise<void> {
  const { pool } = await db();
  await pool.query("insert into agents (id, slug, name, model) values ($1, $2, $3, 'test-model')", [
    fixture.agentId,
    slug,
    'E2E 截断回放',
  ]);
  await pool.query('insert into conversations (id, agent_id, title) values ($1, $2, $3)', [
    fixture.conversationId,
    fixture.agentId,
    'E2E 截断回放',
  ]);
  await pool.query(
    `insert into messages (id, conversation_id, role, content, created_at) values
       ($1, $2, 'user', $3, now() - interval '2 minutes'),
       ($4, $2, 'assistant', $5, now() - interval '1 minute')`,
    [
      newId('message'),
      fixture.conversationId,
      JSON.stringify({ type: 'text', text: text.historyUser }),
      newId('message'),
      JSON.stringify({ type: 'text', text: text.historyAnswer }),
    ],
  );
}

function installChatGate(browser: Browser): Promise<unknown> {
  return browser.evaluate(() => {
    const w = window as unknown as {
      __agentportOriginalFetch?: typeof fetch | undefined;
      __agentportReleaseChat?: (() => void) | undefined;
      __agentportChatHeld?: boolean;
      __agentportChatStatus?: number | undefined;
    };
    if (!w.__agentportOriginalFetch) w.__agentportOriginalFetch = window.fetch.bind(window);
    const original = w.__agentportOriginalFetch;
    w.__agentportChatHeld = false;
    w.__agentportChatStatus = undefined;
    window.fetch = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      const response = await original(input, init);
      // 只推迟响应交付；响应本身来自真实服务端，不伪造。
      if (method === 'POST' && new URL(url, location.href).pathname === '/api/chat') {
        w.__agentportChatStatus = response.status;
        w.__agentportChatHeld = true;
        await new Promise<void>((resolve) => {
          w.__agentportReleaseChat = resolve;
        });
        w.__agentportChatHeld = false;
      }
      return response;
    };
    return true;
  });
}

function chatHeld(browser: Browser): Promise<boolean> {
  return browser.evaluate(() =>
    Boolean((window as unknown as { __agentportChatHeld?: boolean }).__agentportChatHeld),
  );
}

function chatStatus(browser: Browser): Promise<number | null> {
  return browser.evaluate(
    () => (window as unknown as { __agentportChatStatus?: number }).__agentportChatStatus ?? null,
  );
}

function releaseChatGate(browser: Browser): Promise<unknown> {
  return browser.evaluate(() => {
    const w = window as unknown as { __agentportReleaseChat?: (() => void) | undefined };
    const release = w.__agentportReleaseChat;
    w.__agentportReleaseChat = undefined;
    release?.();
    return true;
  });
}

/** 无论成败都恢复页面原始 fetch，避免后续步骤继续被挂起。 */
function restoreFetch(browser: Browser): Promise<unknown> {
  return browser.evaluate(() => {
    const w = window as unknown as {
      __agentportOriginalFetch?: typeof fetch | undefined;
      __agentportReleaseChat?: (() => void) | undefined;
    };
    w.__agentportReleaseChat?.();
    w.__agentportReleaseChat = undefined;
    if (w.__agentportOriginalFetch) {
      window.fetch = w.__agentportOriginalFetch;
      w.__agentportOriginalFetch = undefined;
    }
    return true;
  });
}

async function waitForRun(fixture: Fixture): Promise<string> {
  return until(async () => {
    const { rows } = await db().pool.query<{ id: string }>(
      'select id from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at desc limit 1',
      [fixture.agentId, fixture.conversationId],
    );
    return rows[0]?.id ?? null;
  }, 'POST /api/chat did not create a run within 30s');
}

/** jobId 就是 runId；立刻移除，即使 worker 没停也不会消费到它。 */
async function removeOwnJob(runId: string): Promise<void> {
  const job = await queue().getJob(runId);
  if (!job) {
    throw new Error(
      `BullMQ job ${runId} is missing; a consumer may have claimed it (worker must stay paused)`,
    );
  }
  await job.remove();
}

/**
 * 人为构造 1500 条前缀事件 + MAXLEN ~ FIXTURE_TRIM_MAXLEN：只模拟旧版本或异常情况下已被裁掉流头的日志。
 * 生产回放不再按保留窗口推断截断，所以“已截断”标记由 fixture 在终态前主动补发。
 */
async function seedStream(runId: string): Promise<void> {
  const client = redis();
  const key = runStreamKey(runId);
  const total = 1_500;
  for (let start = 0; start < total; start += 500) {
    const pipe = client.pipeline();
    const end = Math.min(start + 500, total);
    for (let index = start; index < end; index += 1) {
      pipe.xadd(
        key,
        'MAXLEN',
        '~',
        String(FIXTURE_TRIM_MAXLEN),
        '*',
        'payload',
        JSON.stringify({ type: 'text_delta', text: `p${index} ` }),
      );
    }
    await pipe.exec();
  }
  for (let index = 0; index < 3; index += 1) {
    await client.xadd(
      key,
      'MAXLEN',
      '~',
      String(FIXTURE_TRIM_MAXLEN),
      '*',
      'payload',
      JSON.stringify({ type: 'text_delta', text: 'partial-tail ' }),
    );
  }
  await client.expire(key, 3600);
}

/**
 * 模拟 worker 落库先于终态：写完整回答 → run 置 succeeded → XADD 真实终态事件。
 * 订阅端此时只会回放裁剪后的尾部，前端必须用 /api/runs/:id 补齐。
 */
async function finishRun(runId: string, saved: string): Promise<void> {
  const { pool } = await db();
  await pool.query(
    `insert into messages (id, conversation_id, role, content, run_id)
     select $1, conversation_id, 'assistant', $2, id from agent_runs where id = $3`,
    [newId('message'), JSON.stringify({ type: 'text', text: saved }), runId],
  );
  const { rows } = await pool.query(
    `update agent_runs set status = 'succeeded', ended_at = now(), turns = 1
     where id = $1 and status = 'queued' returning id`,
    [runId],
  );
  if (rows.length === 0) {
    throw new Error(
      'run was no longer queued; a worker claimed the job while E2E_WORKER_PAUSED was set',
    );
  }
  await redis().xadd(
    runStreamKey(runId),
    'MAXLEN',
    '~',
    String(FIXTURE_TRIM_MAXLEN),
    '*',
    'payload',
    JSON.stringify({ type: 'run_finished', status: 'succeeded', turns: 1 }),
  );
  await redis().expire(runStreamKey(runId), 3600);
}

/** 只写增量：流里始终没有终态，观众只能靠 API 轮询数据库补齐。 */
async function seedPartialStream(runId: string, text: string): Promise<void> {
  const client = redis();
  await client.xadd(
    runStreamKey(runId),
    'MAXLEN',
    '~',
    String(FIXTURE_TRIM_MAXLEN),
    '*',
    'payload',
    JSON.stringify({ type: 'text_delta', text }),
  );
  await client.expire(runStreamKey(runId), 3600);
}

/** 模拟 worker 已接手：初始快照必须是非终态，事件流才会进入数据库轮询。 */
async function markRunning(runId: string): Promise<void> {
  const { rows } = await db().pool.query(
    `update agent_runs set status = 'running', started_at = now()
     where id = $1 and status = 'queued' returning id`,
    [runId],
  );
  if (rows.length === 0) throw new Error(`run ${runId} was not queued before the stream opened`);
}

/**
 * 模拟 worker 只把终态写进数据库、没能 XADD run_finished：
 * 指标也只存在于库里，前端必须靠 /api/runs/:id 补齐。
 */
async function finishWithoutEvent(runId: string, saved: string): Promise<void> {
  const { pool } = await db();
  await pool.query(
    `insert into messages (id, conversation_id, role, content, run_id)
     select $1, conversation_id, 'assistant', $2, id from agent_runs where id = $3`,
    [newId('message'), JSON.stringify({ type: 'text', text: saved }), runId],
  );
  const { rows } = await pool.query(
    `update agent_runs
        set status = 'succeeded', ended_at = now(), turns = 2, cost_usd = 0.0123,
            latency_ms = 1234, input_tokens = 100, output_tokens = 20
      where id = $1 and status = 'running' returning id`,
    [runId],
  );
  if (rows.length === 0) {
    throw new Error('run was no longer running; a worker claimed the job while E2E_WORKER_PAUSED');
  }
}

async function cleanup(fixture: Fixture, runId?: string): Promise<void> {
  if (runId) {
    await queue()
      .getJob(runId)
      .then((job) => job?.remove());
    await redis().del(runStreamKey(runId), runCancelKey(runId));
  }
  const { pool } = await db();
  const targets = [fixture.agentId, fixture.conversationId, ...(runId ? [runId] : [])];
  await pool.query('delete from audit_log where target = any($1::text[])', [targets]);
  await pool.query('delete from agents where id = $1', [fixture.agentId]);
}

test('missing terminal event is recovered from the persisted run without XADD run_finished', {
  session: 'admin',
  timeout: 120_000,
}, async ({ app, screen, browser }) => {
  const suffix = randomUUID().slice(0, 8);
  const prompt = `E2E 缺终态提问 ${suffix}`;
  const partial = `流式尾部 ${suffix} `;
  const saved = '数据库补齐的完整回答';
  const fixture: Fixture = { agentId: newId('agent'), conversationId: newId('conversation') };
  let runId: string | undefined;

  await seedFixture(fixture, `e2e-terminal-missing-${suffix}`, {
    historyUser: `历史问题 ${suffix}`,
    historyAnswer: `历史回答 ${suffix}`,
  });

  try {
    await app.open(`/chat?agent=${fixture.agentId}&conversation=${fixture.conversationId}`);

    await installChatGate(browser);
    await screen.getByRole('textbox', '消息').fill(prompt);
    await screen.getByRole('button', '发送消息').tap();

    await until(
      async () => ((await chatHeld(browser)) ? true : null),
      'POST /api/chat response was not held before the app opened the event stream',
    );
    runId = await waitForRun(fixture);
    expect(await chatStatus(browser)).toBe(202);

    await removeOwnJob(runId);
    // 初始快照必须是非终态，服务端才会订阅并开始轮询数据库。
    await markRunning(runId);
    await seedPartialStream(runId, partial);

    const events = browser.waitForResponse(new RegExp(`/api/chat/${runId}/events`));
    await releaseChatGate(browser);
    expect((await events).status).toBe(200);
    // 尾部出现在页面上，说明订阅已经完成（回放经由订阅回调送达）。
    await expect(screen.getByText(partial.trim(), { exact: false })).toBeVisible();
    expect(await redis().xlen(runStreamKey(runId))).toBe(1);

    // 只有数据库进入终态；流里永远不会有 run_finished。
    await finishWithoutEvent(runId, saved);

    await expect(screen.getByText(saved, { exact: true })).toHaveCount(1);
    await expect(screen.getByText(prompt, { exact: true })).toHaveCount(1);
    // 落库结果替换了本轮尾部：部分输出与恢复提示都不残留。
    await expect(screen.getByText(partial.trim(), { exact: false })).toHaveCount(0);
    await expect(screen.getByText('结束事件未收到', { exact: false })).toHaveCount(0);
    await expect(screen.getByText('较早事件已截断', { exact: false })).toHaveCount(0);
    await expect(screen.getByText('无法读取已保存结果', { exact: false })).toHaveCount(0);
    await expect(screen.getByText('事件流多次中断', { exact: false })).toHaveCount(0);
    // 指标来自终态（数据库），而不是补发的假事件。
    await expect(screen.getByText('完成', { exact: true }).first()).toBeVisible();
    await expect(screen.getByText('2 轮', { exact: true })).toBeVisible();
    await expect(screen.getByText('$0.012', { exact: true })).toBeVisible();
  } finally {
    await restoreFetch(browser).catch(() => undefined);
    try {
      if (runId) {
        const status = await db()
          .pool.query<{ status: string }>('select status from agent_runs where id = $1', [runId])
          .then((result) => result.rows[0]?.status);
        expect(status).toBe('succeeded');
      }
    } finally {
      await cleanup(fixture, runId);
    }
  }
});

test('a vanished run row ends the stream with a fixed notice and frees the composer', {
  session: 'admin',
  timeout: 120_000,
}, async ({ app, screen, browser }) => {
  const suffix = randomUUID().slice(0, 8);
  const prompt = `E2E 运行记录消失提问 ${suffix}`;
  const partial = `消失前的尾部 ${suffix} `;
  const unavailable = '运行记录已不存在，已停止接收。';
  const fixture: Fixture = { agentId: newId('agent'), conversationId: newId('conversation') };
  let runId: string | undefined;

  await seedFixture(fixture, `e2e-run-gone-${suffix}`, {
    historyUser: `历史问题 ${suffix}`,
    historyAnswer: `历史回答 ${suffix}`,
  });

  try {
    await app.open(`/chat?agent=${fixture.agentId}&conversation=${fixture.conversationId}`);

    await installChatGate(browser);
    await screen.getByRole('textbox', '消息').fill(prompt);
    await screen.getByRole('button', '发送消息').tap();

    await until(
      async () => ((await chatHeld(browser)) ? true : null),
      'POST /api/chat response was not held before the app opened the event stream',
    );
    runId = await waitForRun(fixture);
    expect(await chatStatus(browser)).toBe(202);

    await removeOwnJob(runId);
    await markRunning(runId);
    await seedPartialStream(runId, partial);

    const events = browser.waitForResponse(new RegExp(`/api/chat/${runId}/events`));
    await releaseChatGate(browser);
    expect((await events).status).toBe(200);
    // 真实 SSE 回放已经到达页面，之后才让数据库行消失。
    await expect(screen.getByText(partial.trim(), { exact: false })).toBeVisible();

    // 只删本轮的 run 行：agent 与会话保留，所以还能继续发送。
    await db().pool.query('delete from agent_runs where id = $1', [runId]);

    // 连接内轮询（2s）发现行不存在：发固定通知并断开，不伪造完成或失败。
    await expect(screen.getByText(unavailable, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(screen.getByText(unavailable, { exact: true })).toHaveCount(1);
    await expect(screen.getByText(partial.trim(), { exact: false })).toHaveCount(1);
    await expect(screen.getByText(prompt, { exact: true })).toHaveCount(1);
    await expect(screen.getByRole('button', '停止运行')).toHaveCount(0);
    await expect(screen.getByRole('link', '查看本次运行')).toHaveCount(0);
    await expect(screen.getByText('完成', { exact: true })).toHaveCount(0);
    await expect(screen.getByText('失败', { exact: true })).toHaveCount(0);

    const { rows } = await db().pool.query<{ count: number }>(
      'select count(*)::int as count from agent_runs where id = $1',
      [runId],
    );
    expect(rows[0]?.count).toBe(0);

    // 忙碌已释放：输入框可编辑，输入内容后发送按钮即可用。
    const textbox = screen.getByRole('textbox', '消息');
    await expect(textbox).toBeEnabled({ timeout: 15_000 });
    await textbox.fill(`E2E 下一轮 ${suffix}`);
    await expect(screen.getByRole('button', '发送消息')).toBeEnabled({ timeout: 15_000 });
    // 不点发送：真正入队会留下没有 worker 消费的 job。
  } finally {
    await restoreFetch(browser).catch(() => undefined);
    await cleanup(fixture, runId);
  }
});

// 本条 fixture 人为构造已裁剪的历史日志，只验证旧日志损坏时的落库兜底；生产回放不应发生裁剪。
test('truncated SSE replay restores the persisted answer without duplicating the prompt', {
  session: 'admin',
  timeout: 120_000,
}, async ({ app, screen, browser }) => {
  const suffix = randomUUID().slice(0, 8);
  const prompt = `E2E 截断回放提问 ${suffix}`;
  const historyUser = `历史问题 ${suffix}`;
  const historyAnswer = `历史回答 ${suffix}`;
  const saved = '完整保存的回答：缺失前缀和尾部';
  const fixture: Fixture = { agentId: newId('agent'), conversationId: newId('conversation') };
  let runId: string | undefined;

  await seedFixture(fixture, `e2e-replay-${suffix}`, { historyUser, historyAnswer });

  try {
    await app.open(`/chat?agent=${fixture.agentId}&conversation=${fixture.conversationId}`);
    await expect(screen.getByText(historyUser, { exact: true })).toHaveCount(1);
    await expect(screen.getByText(historyAnswer, { exact: true })).toHaveCount(1);

    await installChatGate(browser);
    await screen.getByRole('textbox', '消息').fill(prompt);
    await screen.getByRole('button', '发送消息').tap();

    // 响应已到浏览器但在应用手里被扣住：此时 EventSource 尚未打开。
    await until(
      async () => ((await chatHeld(browser)) ? true : null),
      'POST /api/chat response was not held before the app opened the event stream',
    );
    runId = await waitForRun(fixture);
    expect(await chatStatus(browser)).toBe(202);

    const user = await db().pool.query<{ text: string | null }>(
      "select content->>'text' as text from messages where run_id = $1 and role = 'user'",
      [runId],
    );
    expect(user.rows[0]?.text).toBe(prompt);

    await removeOwnJob(runId);
    await seedStream(runId);
    // 裁剪完成后、终态前补标记：此时后面只剩 run_finished，不会被后续写入的 MAXLEN 裁掉。
    await redis().xadd(
      runStreamKey(runId),
      '*',
      'payload',
      JSON.stringify({ type: 'replay_truncated', reason: 'retention' }),
    );
    await finishRun(runId, saved);

    // 真实 EventSource 与恢复用的真实 GET 都在 release 之后发生。
    const events = browser.waitForResponse(new RegExp(`/api/chat/${runId}/events`));
    const detail = browser.waitForResponse(new RegExp(`/api/runs/${runId}$`));
    await releaseChatGate(browser);

    expect((await events).status).toBe(200);
    const detailResponse = await detail;
    expect(detailResponse.status).toBe(200);
    const body = await detailResponse.json<{
      steps: Array<{ kind: string; text?: string }>;
    }>();
    expect(body.steps.some((step) => step.kind === 'assistant' && step.text === saved)).toBe(true);

    await expect(screen.getByText(saved, { exact: true })).toHaveCount(1);
    await expect(screen.getByText(prompt, { exact: true })).toHaveCount(1);
    await expect(screen.getByText(historyUser, { exact: true })).toHaveCount(1);
    await expect(screen.getByText(historyAnswer, { exact: true })).toHaveCount(1);
    await expect(screen.getByText('完成', { exact: true }).first()).toBeVisible();
    // 裁剪后的流式尾部已被落库结果替换，不得残留。
    await expect(screen.getByText('partial-tail', { exact: false })).toHaveCount(0);
    await expect(screen.getByText('较早事件已截断', { exact: false })).toHaveCount(0);
    await expect(screen.getByText('无法读取已保存结果', { exact: false })).toHaveCount(0);
    await expect(screen.getByText('事件流多次中断', { exact: false })).toHaveCount(0);
  } finally {
    // 页面包装必须先恢复，否则残留的 gate 会挂住后续网络请求。
    await restoreFetch(browser).catch(() => undefined);
    try {
      if (runId) {
        const status = await db()
          .pool.query<{ status: string }>('select status from agent_runs where id = $1', [runId])
          .then((result) => result.rows[0]?.status);
        expect(status).toBe('succeeded');
      }
    } finally {
      await cleanup(fixture, runId);
    }
  }
});
