import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type Browser, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { fixture as runFixture } from './support/fixture.js';

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
 * - E2E_DATABASE_URL / E2E_REDIS_URL 显式给出，且与预览 API 指向同一套实例；
 * - E2E_WORKER_PAUSED=1：父进程已停掉 preview 的 worker。
 */
if (process.env.E2E_WORKER_PAUSED !== '1') {
  throw new Error(
    'E2E_WORKER_PAUSED=1 is required. PARENT ACTION: stop the preview worker, then re-run. This test creates a real queued run for a configured model and must never execute with a live consumer.',
  );
}

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
  slug: string,
  text: { historyUser: string; historyAnswer: string },
): Promise<Fixture> {
  return runFixture('chat-replay', 'seedFixture', slug, text);
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
    return runFixture('chat-replay', 'latestRun', fixture.agentId, fixture.conversationId);
  }, 'POST /api/chat did not create a run within 30s');
}

/** jobId 就是 runId；立刻移除，即使 worker 没停也不会消费到它。 */
async function removeOwnJob(runId: string): Promise<void> {
  return runFixture('chat-replay', 'removeOwnJob', runId);
}

/**
 * 人为构造 1500 条前缀事件 + MAXLEN ~ FIXTURE_TRIM_MAXLEN：只模拟旧版本或异常情况下已被裁掉流头的日志。
 * 生产回放不再按保留窗口推断截断，所以“已截断”标记由 fixture 在终态前主动补发。
 */
async function seedStream(runId: string): Promise<void> {
  return runFixture('chat-replay', 'seedStream', runId);
}

/**
 * 模拟 worker 落库先于终态：写完整回答 → run 置 succeeded → XADD 真实终态事件。
 * 订阅端此时只会回放裁剪后的尾部，前端必须用 /api/runs/:id 补齐。
 */
async function finishRun(runId: string, saved: string): Promise<void> {
  return runFixture('chat-replay', 'finishRun', runId, saved);
}

/** 只写增量：流里始终没有终态，观众只能靠 API 轮询数据库补齐。 */
async function seedPartialStream(runId: string, text: string): Promise<void> {
  return runFixture('chat-replay', 'seedPartialStream', runId, text);
}

/** 模拟 worker 已接手：初始快照必须是非终态，事件流才会进入数据库轮询。 */
async function markRunning(runId: string): Promise<void> {
  return runFixture('chat-replay', 'markRunning', runId);
}

/**
 * 模拟 worker 只把终态写进数据库、没能 XADD run_finished：
 * 指标也只存在于库里，前端必须靠 /api/runs/:id 补齐。
 */
async function finishWithoutEvent(runId: string, saved: string): Promise<void> {
  return runFixture('chat-replay', 'finishWithoutEvent', runId, saved);
}

async function cleanup(fixture: Fixture, runId?: string): Promise<void> {
  return runFixture('chat-replay', 'cleanup', fixture, runId);
}

test('missing terminal event is recovered from the persisted run without XADD run_finished', {
  session: 'admin',
  timeout: 120_000,
}, async ({ app, screen, browser }) => {
  const suffix = randomUUID().slice(0, 8);
  const prompt = `E2E 缺终态提问 ${suffix}`;
  const partial = `流式尾部 ${suffix} `;
  const saved = '数据库补齐的完整回答';
  let runId: string | undefined;

  const fixture = await seedFixture(`e2e-terminal-missing-${suffix}`, {
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
    expect(await runFixture('chat-replay', 'streamLength', runId)).toBe(1);

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
    await expect(screen.getByText('$0.0123', { exact: true })).toBeVisible();
  } finally {
    await restoreFetch(browser).catch(() => undefined);
    try {
      if (runId) {
        const status = await runFixture('chat-replay', 'runStatus', runId);
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
  let runId: string | undefined;

  const fixture = await seedFixture(`e2e-run-gone-${suffix}`, {
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
    await runFixture('chat-replay', 'deleteRun', runId);

    // 连接内轮询（2s）发现行不存在：发固定通知并断开，不伪造完成或失败。
    await expect(screen.getByText(unavailable, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(screen.getByText(unavailable, { exact: true })).toHaveCount(1);
    await expect(screen.getByText(partial.trim(), { exact: false })).toHaveCount(1);
    await expect(screen.getByText(prompt, { exact: true })).toHaveCount(1);
    await expect(screen.getByRole('button', '停止运行')).toHaveCount(0);
    await expect(screen.getByRole('link', '查看本次运行')).toHaveCount(0);
    await expect(screen.getByText('完成', { exact: true })).toHaveCount(0);
    await expect(screen.getByText('失败', { exact: true })).toHaveCount(0);

    expect(await runFixture('chat-replay', 'runCount', runId)).toBe(0);

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
  let runId: string | undefined;

  const fixture = await seedFixture(`e2e-replay-${suffix}`, { historyUser, historyAnswer });

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

    expect(await runFixture('chat-replay', 'userText', runId)).toBe(prompt);

    await removeOwnJob(runId);
    await seedStream(runId);
    // 裁剪完成后、终态前补标记：此时后面只剩 run_finished，不会被后续写入的 MAXLEN 裁掉。
    await runFixture('chat-replay', 'markTruncated', runId);
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
        const status = await runFixture('chat-replay', 'runStatus', runId);
        expect(status).toBe('succeeded');
      }
    } finally {
      await cleanup(fixture, runId);
    }
  }
});
