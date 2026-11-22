import { type Browser, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { fixture as runFixture } from './support/fixture.js';

async function createAgent(browser: Browser): Promise<{ id: string }> {
  const slug = `e2e-chat-history-${crypto.randomUUID().slice(0, 8)}`;
  return browser.evaluate(async (value: string) => {
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: value, name: `E2E 历史分页 ${value}` }),
    });
    if (res.status !== 201) throw new Error(`POST /api/agents ${res.status}: ${await res.text()}`);
    return (await res.json()) as { id: string };
  }, slug);
}

async function createConversation(agentId: string, count: number, prefix: string) {
  return runFixture('chat-history-pages', 'createConversation', agentId, count, prefix);
}

async function appendMessages(
  conversationId: string,
  firstIndex: number,
  count: number,
  prefix: string,
): Promise<void> {
  return runFixture(
    'chat-history-pages',
    'appendMessages',
    conversationId,
    firstIndex,
    count,
    prefix,
  );
}

async function cleanup(agentId: string, conversationId?: string): Promise<void> {
  return runFixture('chat-history-pages', 'cleanup', agentId, conversationId);
}

interface ViewportMeasure {
  scrollTop: number;
  distanceFromBottom: number;
}

function measure(browser: Browser): Promise<ViewportMeasure> {
  return browser.evaluate(() => {
    const viewport = document.querySelector('[data-slot="message-scroller-viewport"]');
    if (!(viewport instanceof HTMLElement)) return { scrollTop: -1, distanceFromBottom: -1 };
    return {
      scrollTop: viewport.scrollTop,
      distanceFromBottom: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
    };
  });
}

async function scrollChatToTop(browser: Browser): Promise<void> {
  const scrolled = await browser.evaluate(() => {
    const viewport = document.querySelector('[data-slot="message-scroller-viewport"]');
    if (!(viewport instanceof HTMLElement)) return false;
    viewport.scrollTop = 0;
    return true;
  });
  expect(scrolled).toBe(true);
}

interface MessageGeometry {
  id: string | null;
  top: number;
  visible: boolean;
  distanceFromBottom: number;
  scrollTop: number;
}

function messageGeometry(browser: Browser, text: string): Promise<MessageGeometry> {
  return browser.evaluate((value: string) => {
    const viewport = document.querySelector('[data-slot="message-scroller-viewport"]');
    if (!(viewport instanceof HTMLElement)) {
      return {
        id: null,
        top: Number.NaN,
        visible: false,
        distanceFromBottom: -1,
        scrollTop: -1,
      };
    }
    const leaf = [...viewport.querySelectorAll('p, div')].find(
      (node) => node.children.length === 0 && node.textContent?.trim() === value,
    );
    const item = leaf?.closest('[data-slot="message-scroller-item"]');
    if (!(item instanceof HTMLElement)) {
      return {
        id: null,
        top: Number.NaN,
        visible: false,
        distanceFromBottom: -1,
        scrollTop: viewport.scrollTop,
      };
    }
    const box = viewport.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    return {
      id: item.getAttribute('data-message-id'),
      top: rect.top - box.top,
      visible: rect.bottom > box.top && rect.top < box.bottom,
      distanceFromBottom: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
      scrollTop: viewport.scrollTop,
    };
  }, text);
}

function leafTexts(browser: Browser, prefix: string): Promise<{ total: number; unique: number }> {
  return browser.evaluate((value: string) => {
    const viewport = document.querySelector('[data-slot="message-scroller-viewport"]');
    const seen = new Set<string>();
    let total = 0;
    for (const node of viewport?.querySelectorAll('p, div') ?? []) {
      if (node.children.length > 0) continue;
      const text = node.textContent?.trim() ?? '';
      if (!text.startsWith(value)) continue;
      total += 1;
      seen.add(text);
    }
    return { total, unique: seen.size };
  }, prefix);
}

/** 用真实滚轮把视口推到顶；scroller 只认领 wheel/scroll 声明的用户滚动。 */
async function wheelChatToTop(browser: Browser): Promise<void> {
  const box = await browser.locator('[data-slot="message-scroller-viewport"]').boundingBox();
  if (!box) throw new Error('消息视口不存在');
  await browser.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 15; i += 1) {
    await browser.mouse.wheel(0, -900);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await expect
    .poll(async () => (await measure(browser)).scrollTop, {
      timeout: 5_000,
      message: '滚轮没有把对话滚动到顶部',
    })
    .toBe(0);
}

/**
 * 滚轮到达目标后，合成器可能还在收尾平滑滚动；收尾期间测量会把输入动画算进阅读位置。
 * 优先等 scrollend，浏览器不支持或事件已错过时用短兜底。
 */
async function waitForWheelScrollEnd(browser: Browser): Promise<void> {
  await browser.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const viewport = document.querySelector('[data-slot="message-scroller-viewport"]');
        if (!(viewport instanceof HTMLElement)) {
          resolve();
          return;
        }
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        viewport.addEventListener('scrollend', finish, { once: true });
        setTimeout(finish, 600);
      }),
  );
}

async function openConversation(
  app: { open(path?: string): Promise<void> },
  agentId: string,
  conversationId: string,
): Promise<void> {
  await app.open(`/chat?agent=${agentId}&conversation=${conversationId}`);
}

test('chat history pages older messages without losing the visible position', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1440, height: 900 });
  await app.open('/chat');
  const agent = await createAgent(browser);
  try {
    const { id: conversation, messageIds } = await createConversation(
      agent.id,
      125,
      'history-message-',
    );
    await openConversation(app, agent.id, conversation);

    await expect(screen.getByText('history-message-124', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('history-message-075', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('history-message-074', { exact: true })).toHaveCount(0);
    await expect(screen.getByText('history-message-000', { exact: true })).toHaveCount(0);
    expect(await leafTexts(browser, 'history-message-')).toEqual({ total: 50, unique: 50 });

    // 用真实滚轮把视口推到顶：scroller 靠 wheel/scroll 事件认领“用户在滚动”，
    // 直接改 scrollTop 会被它的自动跟随逻辑再拽回底部。
    await wheelChatToTop(browser);
    await waitForWheelScrollEnd(browser);
    const older = screen.getByRole('button', '加载更早消息');
    await expect(older).toBeVisible();
    await expect(screen.getByText('history-message-075', { exact: true })).toBeVisible();
    const anchorBefore = await messageGeometry(browser, 'history-message-075');
    expect(anchorBefore.id).not.toBeNull();
    expect(anchorBefore.visible).toBe(true);
    const firstResponse = browser.waitForResponse(
      new RegExp(`/api/conversations/${conversation}\\?limit=50&cursor=`),
    );
    await older.tap();
    const first = await firstResponse;
    expect(first.status).toBe(200);
    const firstBody = await first.json<{
      messages: { id: string }[];
      nextCursor: string | null;
    }>();
    expect(firstBody.messages.at(-1)?.id).toBe(messageIds[74]);
    const pageTwoCursor = messageIds[25];
    if (pageTwoCursor === undefined) throw new Error('fixture 缺少第二页游标');
    expect(firstBody.nextCursor).toBe(pageTwoCursor);

    await expect(screen.getByText('history-message-025', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('history-message-024', { exact: true })).toHaveCount(0);
    expect(await leafTexts(browser, 'history-message-')).toEqual({ total: 100, unique: 100 });

    await expect
      .poll(
        async () => {
          const anchor = await messageGeometry(browser, 'history-message-075');
          return {
            sameId: anchor.id === anchorBefore.id,
            offset: Math.abs(anchor.top - anchorBefore.top),
            steady: Math.abs(anchor.top - anchorBefore.top) <= 4,
            top: anchor.top,
            beforeTop: anchorBefore.top,
            scrollTop: anchor.scrollTop,
            visible: anchor.visible,
            distanceFromBottom: anchor.distanceFromBottom,
          };
        },
        { timeout: 10_000, message: '加载更早消息后阅读位置被移动' },
      )
      .toMatchObject({
        sameId: true,
        visible: true,
        steady: true,
      });
    const anchorAfter = await messageGeometry(browser, 'history-message-075');
    expect(anchorAfter.id).toBe(anchorBefore.id);
    expect(Math.abs(anchorAfter.top - anchorBefore.top)).toBeLessThanOrEqual(4);
    expect(anchorAfter.distanceFromBottom).toBeGreaterThan(700);

    await wheelChatToTop(browser);
    await waitForWheelScrollEnd(browser);
    const last = screen.getByRole('button', '加载更早消息');
    await expect(last).toBeVisible();
    await expect(screen.getByText('history-message-025', { exact: true })).toBeVisible();
    const lastAnchorBefore = await messageGeometry(browser, 'history-message-025');
    expect(lastAnchorBefore.id).not.toBeNull();
    expect(lastAnchorBefore.visible).toBe(true);
    const lastResponse = browser.waitForResponse(
      new RegExp(`/api/conversations/${conversation}\\?limit=50&cursor=${messageIds[25]}`),
    );
    await last.tap();
    const lastPage = await lastResponse;
    expect(lastPage.status).toBe(200);
    const lastBody = await lastPage.json<{
      messages: { id: string }[];
      nextCursor: string | null;
    }>();
    expect(lastBody.messages).toHaveLength(25);
    expect(lastBody.messages[0]?.id).toBe(messageIds[0]);
    expect(lastBody.nextCursor).toBeNull();

    await expect(screen.getByText('history-message-000', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('history-message-124', { exact: true })).toHaveCount(1);
    expect(await leafTexts(browser, 'history-message-')).toEqual({ total: 125, unique: 125 });
    await expect(screen.getByRole('button', '加载更早消息')).toHaveCount(0);
    await expect
      .poll(
        async () => {
          const anchor = await messageGeometry(browser, 'history-message-025');
          return {
            sameId: anchor.id === lastAnchorBefore.id,
            visible: anchor.visible,
            steady: Math.abs(anchor.top - lastAnchorBefore.top) <= 4,
            top: anchor.top,
            beforeTop: lastAnchorBefore.top,
            scrollTop: anchor.scrollTop,
            distanceFromBottom: anchor.distanceFromBottom,
          };
        },
        { timeout: 10_000, message: '最后一页加载后阅读位置被移动' },
      )
      .toMatchObject({ sameId: true, visible: true, steady: true });
    const lastAnchorAfter = await messageGeometry(browser, 'history-message-025');
    expect(lastAnchorAfter.id).toBe(lastAnchorBefore.id);
    expect(Math.abs(lastAnchorAfter.top - lastAnchorBefore.top)).toBeLessThanOrEqual(4);
    expect(lastAnchorAfter.distanceFromBottom).toBeGreaterThan(700);
  } finally {
    await cleanup(agent.id);
  }
});

test('chat history pagination works at a 390px viewport', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open('/chat');
  const agent = await createAgent(browser);
  try {
    const { id: conversation } = await createConversation(agent.id, 60, 'mobile-history-');
    await openConversation(app, agent.id, conversation);

    await expect(screen.getByText('mobile-history-059', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('mobile-history-010', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('mobile-history-009', { exact: true })).toHaveCount(0);
    await expect(screen.getByText('mobile-history-000', { exact: true })).toHaveCount(0);

    await scrollChatToTop(browser);
    await screen.getByRole('button', '加载更早消息').tap();
    await expect(screen.getByText('mobile-history-000', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('mobile-history-059', { exact: true })).toHaveCount(1);
    expect(await leafTexts(browser, 'mobile-history-')).toEqual({ total: 60, unique: 60 });
    await expect(screen.getByRole('button', '加载更早消息')).toHaveCount(0);
  } finally {
    await cleanup(agent.id);
  }
});

test('switching conversations in the history panel drops the old messages', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1440, height: 900 });
  await app.open('/chat');
  const agent = await createAgent(browser);
  try {
    const { id: first } = await createConversation(agent.id, 3, 'switch-a-');
    const { id: second } = await createConversation(agent.id, 3, 'switch-b-');

    await openConversation(app, agent.id, first);
    await expect(screen.getByText('switch-a-000', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('switch-b-000', { exact: true })).toHaveCount(0);

    await screen.getByRole('button', '显示会话历史').tap();
    await screen.getByText('E2E switch-b-', { exact: true }).first().tap();
    await expect(browser).toHaveURL(new RegExp(`conversation=${second}`));
    await expect(screen.getByText('switch-b-000', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('switch-a-000', { exact: true })).toHaveCount(0);

    await screen.getByText('E2E switch-a-', { exact: true }).first().tap();
    await expect(browser).toHaveURL(new RegExp(`conversation=${first}`));
    await expect(screen.getByText('switch-a-000', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('switch-b-000', { exact: true })).toHaveCount(0);
  } finally {
    await cleanup(agent.id);
  }
});

test('conversation list cursor stays stable when the anchor receives a newer message', {
  session: 'admin',
}, async ({ app, browser }) => {
  await app.open('/chat');
  const agent = await createAgent(browser);
  try {
    await Promise.all([
      createConversation(agent.id, 3, 'cursor-page-a-'),
      createConversation(agent.id, 3, 'cursor-page-b-'),
      createConversation(agent.id, 3, 'cursor-page-c-'),
    ]);

    const first = await browser.evaluate(async (agentId: string) => {
      const res = await fetch(`/api/conversations?agentId=${agentId}&limit=2`);
      if (res.status !== 200) {
        throw new Error(`GET /api/conversations ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      return { ids: body.items.map((item) => item.id), nextCursor: body.nextCursor };
    }, agent.id);
    expect(first.ids).toHaveLength(2);
    const anchor = first.ids[1];
    if (anchor === undefined || first.nextCursor === null) throw new Error('首页缺少锚点或游标');

    await appendMessages(anchor, 3, 1, 'cursor-anchor-');

    const second = await browser.evaluate(
      async (query: { agentId: string; cursor: string }) => {
        const res = await fetch(
          `/api/conversations?agentId=${query.agentId}&limit=2&cursor=${encodeURIComponent(query.cursor)}`,
        );
        const body = (await res.json()) as { items: { id: string }[] };
        return { status: res.status, ids: body.items.map((item) => item.id) };
      },
      { agentId: agent.id, cursor: first.nextCursor },
    );

    expect(second.status).toBe(200);
    expect(second.ids.length).toBeGreaterThan(0);
    expect(second.ids.filter((id) => first.ids.includes(id))).toEqual([]);
    expect(second.ids).not.toContain(anchor);
    expect(new Set(second.ids).size).toBe(second.ids.length);
  } finally {
    await cleanup(agent.id);
  }
});

test('renaming the open conversation keeps the loaded history and pages older ones', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1440, height: 900 });
  await app.open('/chat');
  const agent = await createAgent(browser);
  let conversation: string | undefined;
  try {
    conversation = (await createConversation(agent.id, 60, 'refresh-')).id;
    await openConversation(app, agent.id, conversation);
    await expect(screen.getByText('refresh-059', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('refresh-010', { exact: true })).toHaveCount(1);
    expect(await leafTexts(browser, 'refresh-')).toEqual({ total: 50, unique: 50 });

    await appendMessages(conversation, 60, 2, 'refresh-');

    await screen.getByRole('button', '显示会话历史').tap();
    const trigger = screen.getByRole('button', `操作「E2E refresh-」`);
    await trigger.hover();
    await trigger.tap();
    await screen.getByRole('menuitem', '重命名').tap();
    await browser.locator('#conversation-title').fill('E2E refresh-renamed');
    const refetched = browser.waitForResponse(
      new RegExp(`/api/conversations/${conversation}\\?limit=50$`),
    );
    await screen.getByRole('button', '保存', { exact: true }).tap();
    expect((await refetched).status).toBe(200);
    await expect(screen.getByRole('heading', '重命名会话')).toHaveCount(0);

    await expect(screen.getByText('refresh-010', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('refresh-011', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('refresh-059', { exact: true })).toHaveCount(1);
    expect(await leafTexts(browser, 'refresh-')).toEqual({ total: 50, unique: 50 });

    await wheelChatToTop(browser);
    const olderResponse = browser.waitForResponse(
      new RegExp(`/api/conversations/${conversation}\\?limit=50&cursor=`),
    );
    await screen.getByRole('button', '加载更早消息').tap();
    expect((await olderResponse).status).toBe(200);
    await expect(screen.getByText('refresh-000', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('refresh-010', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('refresh-059', { exact: true })).toHaveCount(1);
    expect(await leafTexts(browser, 'refresh-')).toEqual({ total: 60, unique: 60 });
  } finally {
    await cleanup(agent.id, conversation);
  }
});
