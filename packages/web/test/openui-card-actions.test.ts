import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenUiBlock } from '../src/openui/renderer.js';

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
    if (keyName === ' ') {
      target.dispatchEvent(new KeyboardEvent('keyup', { key: keyName, bubbles: true }));
    }
  });
  await settle(2);
}

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
      itemBgColor: 'gray',
    });
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
      selected: { itemIndex: 1, itemId: 'ob', itemTitle: '博物馆', itemSubtitle: '2024' },
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
        itemBgImageSrc: 'https://example.com/louvre.jpg',
      },
    });
    expect(action.formState).toMatchObject(initialState);
    expect(host.querySelectorAll('[data-slot="visual-card-scrim"]')).toHaveLength(2);
  });

  it('includes SnippetCard rhs itemValue, OverviewCard itemMetricValue, and ContextCard Tag title & Markdown body', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Card([snips, overviews, contexts])',
        'snips = SnippetCardBlock([sa, sb], "grid", true, @ToAssistant("选摘要", { s: 1 }))',
        'sa = SnippetCardItem("sa", saLhs, saRhs)',
        'saLhs = IconText(Icon("dollar-sign", "finance"), "neutral", "m", "总收入", "本月", false, "horizontal")',
        'saRhs = Text("number", "284,500", "+12%", "metric")',
        'sb = SnippetCardItem("sb", sbLhs)',
        'sbLhs = IconText(Icon("users", "people"), "neutral", "m", "活跃", "本月", false, "horizontal")',
        'overviews = OverviewCardBlock([oa, ob], "grid", true, @ToAssistant("选概览", { o: 1 }))',
        'oa = OverviewCardItem("oa", oaTop, oaMetric)',
        'oaTop = IconText(Icon("users", "people"), "neutral", "m", "访客数", "年度", false, "vertical")',
        'oaMetric = MetricIndicatorInline("48.7M", "人次")',
        'ob = OverviewCardItem("ob", obTop)',
        'obTop = Text("text", "其它", "无", "text", "sm")',
        'contexts = ContextCardBlock([ca, cb], "grid", true, @ToAssistant("选背景", { c: 1 }))',
        'ca = ContextCardItem("ca", caTag, "包含 **加粗** 正文", "gray", "https://example.com/bg.jpg", "背景图")',
        'caTag = Tag("重点标签", Icon("star", "shapes"), "sm", "info")',
        'cb = ContextCardItem("cb", "普通标题", "说明")',
      ].join('\n'),
      { onAction },
    );

    await click('总收入');
    expect(contextOf(onAction.mock.calls[0]?.[0]).selected).toEqual({
      itemIndex: 0,
      itemId: 'sa',
      itemTitle: '总收入',
      itemSubtitle: '本月',
      itemValue: '284,500',
    });

    await click('访客数');
    expect(contextOf(onAction.mock.calls[1]?.[0]).selected).toEqual({
      itemIndex: 0,
      itemId: 'oa',
      itemTitle: '访客数',
      itemSubtitle: '年度',
      itemMetricValue: '48.7M',
    });

    expect(host.querySelector('[data-streamdown="strong"]')?.textContent).toBe('加粗');
    await click('重点标签');
    expect(contextOf(onAction.mock.calls[2]?.[0]).selected).toEqual({
      itemIndex: 0,
      itemId: 'ca',
      itemTitle: '重点标签',
      itemBody: '包含 **加粗** 正文',
      itemBgColor: 'gray',
      itemBgImageSrc: 'https://example.com/bg.jpg',
      itemBgImageAlt: '背景图',
    });
  });

  it('uses clean aria-label on clickable ListBlock items', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Card([list])',
        'list = ListBlock([l1, l2], "number")',
        'l1 = ListItem("排查日志", "近 24 小时错误", null, "查看", @ToAssistant("查日志"))',
        'l2 = ListItem("纯展示项", "无动作")',
      ].join('\n'),
      { onAction },
    );

    const button = host.querySelector<HTMLButtonElement>('button[aria-label="排查日志"]');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    await settle(2);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[0]).toMatchObject({ message: '查日志' });
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
