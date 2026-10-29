import { randomUUID } from 'node:crypto';
import { type Browser, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { createDb, newId } from '../packages/db/dist/index.js';

/**
 * 会话历史分页的真实浏览器验收：真实页面、真实 API、数据库直写 fixture，
 * 不经过队列或模型。DATABASE_URL 必须显式给出，并且与页面背后的 API 指向同一个库。
 */
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required for chat history fixtures');

let dbPromise: ReturnType<typeof createDb> | undefined;
function db() {
  dbPromise ??= createDb(DATABASE_URL);
  return dbPromise;
}

test.afterAll(async () => {
  const current = await dbPromise;
  await current?.pool.end();
});

/** 所有消息共用 created_at，顺序由 (created_at, id) 的次级排序决定。 */
const TIES = new Date('2026-10-22T00:00:00.000Z');
/** 后写入的消息必须排在 TIES 之后，才能成为最新一页窗口的新成员。 */
const LATER = new Date('2026-10-22T00:00:01.000Z');

/** 第 index 条消息（0 起）的 id 与文本都用同一个序号，id 按字典序与序号同序。 */
const messageId = (conversationId: string, index: number): string =>
  `${conversationId}_m${String(index + 1).padStart(3, '0')}`;

async function createAgent(browser: Browser): Promise<{ id: string }> {
  const slug = `e2e-chat-history-${randomUUID().slice(0, 8)}`;
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

async function createConversation(agentId: string, count: number, prefix: string): Promise<string> {
  const id = newId('conversation');
  const { pool } = await db();
  await pool.query('insert into conversations (id, agent_id, title) values ($1, $2, $3)', [
    id,
    agentId,
    `E2E ${prefix}`,
  ]);
  await pool.query(
    `insert into messages (id, conversation_id, role, content, created_at)
     select $1 || '_m' || lpad(g::text, 3, '0'), $1,
       case when g % 2 = 1 then 'user' else 'assistant' end,
       jsonb_build_object('type', 'text', 'text', $3 || lpad((g - 1)::text, 3, '0')),
       $2
     from generate_series(1, $4::int) as g`,
    [id, TIES, prefix, count],
  );
  return id;
}

/** 直写更晚的消息，模拟另一个标签页落库；不经过模型或队列。 */
async function appendMessages(
  conversationId: string,
  firstIndex: number,
  count: number,
  prefix: string,
): Promise<void> {
  // messageId 的序号是 index + 1，文本序号是 index。
  const { pool } = await db();
  await pool.query(
    `insert into messages (id, conversation_id, role, content, created_at)
     select $1 || '_m' || lpad(g::text, 3, '0'), $1,
       case when g % 2 = 1 then 'user' else 'assistant' end,
       jsonb_build_object('type', 'text', 'text', $3 || lpad((g - 1)::text, 3, '0')),
       $2
     from generate_series($4::int, $5::int) as g`,
    [conversationId, LATER, prefix, firstIndex + 1, firstIndex + count],
  );
}

/** 只删自己建的专家：会话与消息随 agent 级联删除；重命名审计行按会话 id 另删。 */
async function cleanup(agentId: string, conversationId?: string): Promise<void> {
  const { pool } = await db();
  await pool.query('delete from audit_log where target = any($1::text[])', [
    conversationId ? [agentId, conversationId] : [agentId],
  ]);
  await pool.query('delete from agents where id = $1', [agentId]);
}

interface ViewportMeasure {
  scrollTop: number;
  /** 距滚动区域底部的像素数；到底部时接近 0。 */
  distanceFromBottom: number;
}

/** 滚动几何用 DOM evaluate 读取，不经过任何接口。 */
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

/** 390px 窄屏没有可点的滚轮目标，直接改滚动位置；这里只验证分页可用。 */
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
  /** 消息所在轮次项的稳定 id；补旧重新解析后必须不变。 */
  id: string | null;
  /** 消息项顶部相对滚动视口顶部的像素，用于判断阅读位置是否保持。 */
  top: number;
  visible: boolean;
  /** 距滚动区域底部的像素数；到底部时接近 0。 */
  distanceFromBottom: number;
  scrollTop: number;
}

/** 按正文前缀定位到消息项，读取稳定 id 与相对视口位置；不经过任何接口。 */
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

/** 每条消息只渲染一个叶子文本节点；总数等于唯一数才说明没有重复拼接。 */
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
  // 先进入应用，fixture 的 same-origin fetch 才能带上会话 cookie。
  await app.open('/chat');
  const agent = await createAgent(browser);
  try {
    const conversation = await createConversation(agent.id, 125, 'history-message-');
    await openConversation(app, agent.id, conversation);

    // 首屏只有最新 50 条：075–124；更早的 074、000 不在 DOM 里。
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
    // 点击前固定阅读锚点：075 所在轮次项的稳定 id 与相对视口顶部的位置。
    const anchorBefore = await messageGeometry(browser, 'history-message-075');
    expect(anchorBefore.id).not.toBeNull();
    expect(anchorBefore.visible).toBe(true);
    const firstResponse = browser.waitForResponse(
      new RegExp(`/api/conversations/${conversation}\\?limit=50&before=`),
    );
    await older.tap();
    const first = await firstResponse;
    expect(first.status).toBe(200);
    const firstBody = await first.json<{
      messages: { id: string }[];
      nextBefore: string | null;
    }>();
    // 游标是已加载历史里最老的一条（075）；第二页返回 025–074，nextBefore 指向 025。
    expect(firstBody.messages.at(-1)?.id).toBe(messageId(conversation, 74));
    expect(firstBody.nextBefore).toBe(messageId(conversation, 25));

    // 第二页 025–074 拼在已加载历史之前，000 仍未加载。
    await expect(screen.getByText('history-message-025', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('history-message-024', { exact: true })).toHaveCount(0);
    expect(await leafTexts(browser, 'history-message-')).toEqual({ total: 100, unique: 100 });

    // 补旧消息保持阅读位置：075 仍是同一个轮次项，相对视口顶部不移动，且远离底部。
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

    // 再向上滚到最后一页入口，记录点击前 025 的相对位置。
    await wheelChatToTop(browser);
    await waitForWheelScrollEnd(browser);
    const last = screen.getByRole('button', '加载更早消息');
    await expect(last).toBeVisible();
    await expect(screen.getByText('history-message-025', { exact: true })).toBeVisible();
    const lastAnchorBefore = await messageGeometry(browser, 'history-message-025');
    expect(lastAnchorBefore.id).not.toBeNull();
    expect(lastAnchorBefore.visible).toBe(true);
    const lastResponse = browser.waitForResponse(
      new RegExp(
        `/api/conversations/${conversation}\\?limit=50&before=${messageId(conversation, 25)}`,
      ),
    );
    await last.tap();
    const lastPage = await lastResponse;
    expect(lastPage.status).toBe(200);
    const lastBody = await lastPage.json<{
      messages: { id: string }[];
      nextBefore: string | null;
    }>();
    expect(lastBody.messages).toHaveLength(25);
    expect(lastBody.messages[0]?.id).toBe(messageId(conversation, 0));
    expect(lastBody.nextBefore).toBeNull();

    // 三页拼完：000–124 各出现一次，入口消失；025 的相对位置仍保持不变。
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
    const conversation = await createConversation(agent.id, 60, 'mobile-history-');
    await openConversation(app, agent.id, conversation);

    // 首屏 010–059；000 与 009 尚未加载。
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
    const first = await createConversation(agent.id, 3, 'switch-a-');
    const second = await createConversation(agent.id, 3, 'switch-b-');

    await openConversation(app, agent.id, first);
    await expect(screen.getByText('switch-a-000', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('switch-b-000', { exact: true })).toHaveCount(0);

    // 历史默认折叠：先从头部显式展开，再用真实列表行切换会话。
    await screen.getByRole('button', '显示会话历史').tap();
    await screen.getByText('E2E switch-b-', { exact: true }).first().tap();
    await expect(browser).toHaveURL(new RegExp(`conversation=${second}`));
    await expect(screen.getByText('switch-b-000', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('switch-a-000', { exact: true })).toHaveCount(0);

    // 切换会话会重载工作区并收起历史，重新展开后再点另一条。
    await screen.getByRole('button', '显示会话历史').tap();
    await screen.getByText('E2E switch-a-', { exact: true }).first().tap();
    await expect(browser).toHaveURL(new RegExp(`conversation=${first}`));
    await expect(screen.getByText('switch-a-000', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('switch-b-000', { exact: true })).toHaveCount(0);
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
    conversation = await createConversation(agent.id, 60, 'refresh-');
    await openConversation(app, agent.id, conversation);
    await expect(screen.getByText('refresh-059', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('refresh-010', { exact: true })).toHaveCount(1);
    expect(await leafTexts(browser, 'refresh-')).toEqual({ total: 50, unique: 50 });

    // 另一个标签页写进两条更晚的消息，本页没有任何流式事件知道它们。
    await appendMessages(conversation, 60, 2, 'refresh-');

    // 历史默认折叠：重命名入口在历史行菜单里，先显式展开列表。
    await screen.getByRole('button', '显示会话历史').tap();
    // 真实 UI 触发会话详情重新拉取：历史菜单里的重命名只做这个副作用。
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

    // 重新拉取拿到的是 012–061 的窗口：已加载的 010、011 不能被丢掉。
    await expect(screen.getByText('refresh-010', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('refresh-011', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('refresh-059', { exact: true })).toHaveCount(1);
    expect(await leafTexts(browser, 'refresh-')).toEqual({ total: 50, unique: 50 });

    // 更早的 000–009 仍可补，总数正好是原来的 60 条，没有重复。
    await wheelChatToTop(browser);
    const olderResponse = browser.waitForResponse(
      new RegExp(`/api/conversations/${conversation}\\?limit=50&before=`),
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
