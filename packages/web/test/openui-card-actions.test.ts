import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenUiBlock } from '../src/openui/renderer.js';

/**
 * 卡片块与追问条的真实动作载荷：点第二张卡时，块级 @ToAssistant 的原上下文
 * 与选中项字段必须一起到达宿主；未配置动作、流式中都不得派发。
 */

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function settle(rounds = 12): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(program: string, props: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(OpenUiBlock, { program, streaming: false, ...props }));
  });
  await settle();
}

function byText<T extends Element>(selector: string, text: string): T {
  const found = [...host.querySelectorAll<T>(selector)].find((element) =>
    element.textContent?.includes(text),
  );
  if (!found) throw new Error(`${selector} not found: ${text}`);
  return found;
}

async function click(text: string, selector = '[role="button"]'): Promise<void> {
  await act(async () => byText<HTMLElement>(selector, text).click());
  await settle(2);
}

/**
 * 精确文本叶子向上取最近的 BlockCard（shared.tsx 的 rounded-card 容器）。
 * 卡片文本必须恰好等于该文本，避免误取包住整块卡片的 Card 外层。
 */
function cardByText(text: string): HTMLElement {
  const leaf = [...host.querySelectorAll<HTMLElement>('*')].find(
    (element) => element.childElementCount === 0 && element.textContent === text,
  );
  const card = leaf?.closest<HTMLElement>('div.rounded-card');
  if (!card || card.textContent !== text) throw new Error(`card not found: ${text}`);
  return card;
}

async function key(text: string, keyName: string): Promise<void> {
  const target = byText<HTMLElement>('[role="button"]', text);
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true }));
  });
  await settle(2);
}

/** params.context = 原 @ToAssistant 上下文 + 一行 "Selected item: {...}"。 */
function contextOf(action: { params: { context?: unknown } }): {
  original: string;
  selected: Record<string, unknown>;
} {
  const raw = String(action.params.context);
  const [original, suffix] = raw.split('\nSelected item: ');
  expect(suffix, raw).toBeDefined();
  return { original, selected: JSON.parse(suffix as string) };
}

const initialState = { booking: { fullName: { value: '张三', componentType: 'Input' } } };

describe('card block selected-item context', () => {
  it('ContextCardBlock appends id, title and body to the explicit context', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Card([block])',
        'block = ContextCardBlock([a, b], "grid", true, @ToAssistant("继续", { chart: "revenue" }))',
        'a = ContextCardItem("qa", "第一季度", "同比增长 12%", "gray")',
        'b = ContextCardItem("qb", "第二季度", "环比增长 8%", "gray")',
      ].join('\n'),
      { onAction, initialState },
    );

    await click('第二季度');

    expect(onAction).toHaveBeenCalledTimes(1);
    const action = onAction.mock.calls[0]?.[0];
    expect(action).toMatchObject({ type: 'continue_conversation', message: '继续' });
    const { original, selected } = contextOf(action);
    expect(JSON.parse(original)).toEqual({ chart: 'revenue' });
    expect(selected).toEqual({
      itemIndex: 1,
      itemId: 'qb',
      itemTitle: '第二季度',
      itemBody: '环比增长 8%',
    });
    // params.context 同时作为顶层 context 交给模型。
    expect(action.context).toBe(action.params.context);
    expect(action.formState).toMatchObject(initialState);
  });

  it('OverviewCardBlock uses the top IconText title for the second card', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Card([block])',
        'block = OverviewCardBlock([a, b], "grid", true, @ToAssistant("看详情", { report: "q2" }))',
        'a = OverviewCardItem("oa", aTop)',
        'aTop = IconText(aIcon, "neutral", "m", "访客", "2024", false, "vertical")',
        'aIcon = Icon("users", "people")',
        'b = OverviewCardItem("ob", bTop)',
        'bTop = IconText(bIcon, "neutral", "m", "博物馆", "2024", false, "vertical")',
        'bIcon = Icon("landmark", "buildings")',
      ].join('\n'),
      { onAction, initialState },
    );

    await click('博物馆');

    expect(onAction).toHaveBeenCalledTimes(1);
    const action = onAction.mock.calls[0]?.[0];
    expect(action).toMatchObject({ type: 'continue_conversation', message: '看详情' });
    expect(contextOf(action)).toEqual({
      original: '{"report":"q2"}',
      selected: { itemIndex: 1, itemId: 'ob', itemTitle: '博物馆' },
    });
    expect(action.formState).toMatchObject(initialState);
  });

  it('SnippetCardBlock activates on Enter with lhs title and subtitle', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Card([block])',
        'block = SnippetCardBlock([a, b], "grid", true, @ToAssistant("继续", { chart: "revenue" }))',
        'a = SnippetCardItem("sa", aLhs, aRhs)',
        'aLhs = IconText(aIcon, "neutral", "m", "收入", "本月累计", false, "horizontal")',
        'aIcon = Icon("circle-dollar-sign", "finance")',
        'aRhs = Text("number", "284,500", "+12%", "metric")',
        'b = SnippetCardItem("sb", bLhs)',
        'bLhs = IconText(bIcon, "neutral", "m", "活跃用户", "月度活跃", false, "horizontal")',
        'bIcon = Icon("users", "people")',
      ].join('\n'),
      { onAction, initialState },
    );

    await key('活跃用户', 'Enter');

    expect(onAction).toHaveBeenCalledTimes(1);
    const action = onAction.mock.calls[0]?.[0];
    expect(action).toMatchObject({ type: 'continue_conversation', message: '继续' });
    expect(contextOf(action)).toEqual({
      original: '{"chart":"revenue"}',
      selected: {
        itemIndex: 1,
        itemId: 'sb',
        itemTitle: '活跃用户',
        itemSubtitle: '月度活跃',
      },
    });
    expect(action.formState).toMatchObject(initialState);
  });

  it('VisualCardBlock activates on Space with body, subtext and tag', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Card([block])',
        'block = VisualCardBlock([a, b], "grid", true, @ToAssistant("了解这座城市", { city: "paris" }))',
        'a = VisualCardItem(aBody, "va", "https://example.com/eiffel.jpg", aTag)',
        'aBody = BoldText("text", "埃菲尔铁塔", "每日 9 点开放")',
        'aTag = Tag("必看", aTagIcon, "sm", "info")',
        'aTagIcon = Icon("star", "shapes")',
        'b = VisualCardItem(bBody, "vb", "https://example.com/louvre.jpg", bTag)',
        'bBody = BoldText("text", "卢浮宫", "世界最大艺术博物馆")',
        'bTag = Tag("人流 890 万", bTagIcon, "sm", "success")',
        'bTagIcon = Icon("trending-up", "charts")',
      ].join('\n'),
      { onAction, initialState },
    );

    await key('卢浮宫', ' ');

    expect(onAction).toHaveBeenCalledTimes(1);
    const action = onAction.mock.calls[0]?.[0];
    expect(action).toMatchObject({ type: 'continue_conversation', message: '了解这座城市' });
    expect(contextOf(action)).toEqual({
      original: '{"city":"paris"}',
      selected: {
        itemIndex: 1,
        itemId: 'vb',
        itemBody: '卢浮宫',
        itemBodySubtext: '世界最大艺术博物馆',
        itemTag: '人流 890 万',
      },
    });
    expect(action.formState).toMatchObject(initialState);
  });
});

describe('FollowUpBlock', () => {
  it('sends the second item text and keeps form state', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Card([follow])',
        'follow = FollowUpBlock([f1, f2])',
        'f1 = FollowUpItem("展开讲讲")',
        'f2 = FollowUpItem("换个例子")',
      ].join('\n'),
      { onAction, initialState },
    );

    await act(async () => byText<HTMLButtonElement>('button', '换个例子').click());
    await settle(2);

    expect(onAction).toHaveBeenCalledTimes(1);
    const action = onAction.mock.calls[0]?.[0];
    expect(action).toMatchObject({ type: 'continue_conversation', message: '换个例子' });
    expect(action.params.context).toBeUndefined();
    expect(action.formState).toMatchObject(initialState);
  });
});

describe('inactive card blocks', () => {
  it('stays non-clickable when the action is omitted or null', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Card([a, b])',
        'a = ContextCardBlock([c1, c2], "grid", true)',
        'c1 = ContextCardItem("c1", "第一张")',
        'c2 = ContextCardItem("c2", "第二张")',
        'b = OverviewCardBlock([o1, o2], "grid", true, null)',
        'o1 = OverviewCardItem("o1", o1Top)',
        'o1Top = Text("text", "第一项", "", "text", "sm")',
        'o2 = OverviewCardItem("o2", o2Top)',
        'o2Top = Text("text", "第二项", "", "text", "sm")',
      ].join('\n'),
      { onAction },
    );

    expect(host.textContent).toContain('第二张');
    expect(host.textContent).toContain('第二项');
    // 省略与显式 null 都沿用 definition 的「无动作」：既没有可激活角色，也没有焦点停靠点。
    expect(host.querySelector('[role="button"]')).toBeNull();
    expect(host.querySelector('[tabindex="0"]')).toBeNull();
    const card = cardByText('第二张');
    expect(card.getAttribute('role')).toBeNull();
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onAction).not.toHaveBeenCalled();
  });

  it('disables card activation and native follow-up buttons while streaming', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Card([block, follow])',
        'block = OverviewCardBlock([a, b], "grid", true, @ToAssistant("看详情"))',
        'a = OverviewCardItem("oa", aTop)',
        'aTop = Text("text", "第一项", "", "text", "sm")',
        'b = OverviewCardItem("ob", bTop)',
        'bTop = Text("text", "第二项", "", "text", "sm")',
        'follow = FollowUpBlock([f1, f2])',
        'f1 = FollowUpItem("展开讲讲")',
        'f2 = FollowUpItem("换个例子")',
      ].join('\n'),
      { onAction, streaming: true },
    );

    // 事件必须落在真实卡片容器上，走和可点时同一条 click/keydown 冒泡路径。
    const card = cardByText('第二项');
    await act(async () => {
      card.click();
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle(2);
    expect(onAction).not.toHaveBeenCalled();
    expect(card.getAttribute('role')).toBeNull();
    expect(card.getAttribute('tabindex')).toBeNull();
    expect(host.querySelector('[role="button"]')).toBeNull();
    const followUps = [...host.querySelectorAll<HTMLButtonElement>('button')];
    expect(followUps).toHaveLength(2);
    for (const button of followUps) expect(button.disabled).toBe(true);
    await act(async () => followUps[1]?.click());
    expect(onAction).not.toHaveBeenCalled();
  });
});
