import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type Browser, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { fixture as runFixture } from './support/fixture.js';

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

async function removeOwnJob(runId: string): Promise<void> {
  return runFixture('chat-replay', 'removeOwnJob', runId);
}

async function seedStream(runId: string): Promise<void> {
  return runFixture('chat-replay', 'seedStream', runId);
}

async function finishRun(runId: string, saved: string): Promise<void> {
  return runFixture('chat-replay', 'finishRun', runId, saved);
}

async function seedPartialStream(runId: string, text: string): Promise<void> {
  return runFixture('chat-replay', 'seedPartialStream', runId, text);
}

async function markRunning(runId: string): Promise<void> {
  return runFixture('chat-replay', 'markRunning', runId);
}

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
    await markRunning(runId);
    await seedPartialStream(runId, partial);

    const events = browser.waitForResponse(new RegExp(`/api/chat/${runId}/events`));
    await releaseChatGate(browser);
    expect((await events).status).toBe(200);
    await expect(screen.getByText(partial.trim(), { exact: false })).toBeVisible();
    expect(await runFixture('chat-replay', 'streamLength', runId)).toBe(1);

    await finishWithoutEvent(runId, saved);

    await expect(screen.getByText(saved, { exact: true })).toHaveCount(1);
    await expect(screen.getByText(prompt, { exact: true })).toHaveCount(1);
    await expect(screen.getByText(partial.trim(), { exact: false })).toHaveCount(0);
    await expect(screen.getByText('结束事件未收到', { exact: false })).toHaveCount(0);
    await expect(screen.getByText('较早事件已截断', { exact: false })).toHaveCount(0);
    await expect(screen.getByText('无法读取已保存结果', { exact: false })).toHaveCount(0);
    await expect(screen.getByText('事件流多次中断', { exact: false })).toHaveCount(0);
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
    await expect(screen.getByText(partial.trim(), { exact: false })).toBeVisible();

    await runFixture('chat-replay', 'deleteRun', runId);

    await expect(screen.getByText(unavailable, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(screen.getByText(unavailable, { exact: true })).toHaveCount(1);
    await expect(screen.getByText(partial.trim(), { exact: false })).toHaveCount(1);
    await expect(screen.getByText(prompt, { exact: true })).toHaveCount(1);
    await expect(screen.getByRole('button', '停止运行')).toHaveCount(0);
    await expect(screen.getByRole('link', '查看本次运行')).toHaveCount(0);
    await expect(screen.getByText('完成', { exact: true })).toHaveCount(0);
    await expect(screen.getByText('失败', { exact: true })).toHaveCount(0);

    expect(await runFixture('chat-replay', 'runCount', runId)).toBe(0);

    const textbox = screen.getByRole('textbox', '消息');
    await expect(textbox).toBeEnabled({ timeout: 15_000 });
    await textbox.fill(`E2E 下一轮 ${suffix}`);
    await expect(screen.getByRole('button', '发送消息')).toBeEnabled({ timeout: 15_000 });
  } finally {
    await restoreFetch(browser).catch(() => undefined);
    await cleanup(fixture, runId);
  }
});

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
    await expect(screen.getByText('partial-tail', { exact: false })).toHaveCount(0);
    await expect(screen.getByText('较早事件已截断', { exact: false })).toHaveCount(0);
    await expect(screen.getByText('无法读取已保存结果', { exact: false })).toHaveCount(0);
    await expect(screen.getByText('事件流多次中断', { exact: false })).toHaveCount(0);
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
