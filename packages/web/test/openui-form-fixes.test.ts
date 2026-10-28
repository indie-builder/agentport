import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenUiBlock } from '../src/openui/renderer.js';

/**
 * 表单控件与官方组合语义的回归：日期按钮必须真的打开日历、纯日期按本地年月日
 * 往返，复选/开关在提交或写回时带上全部条目（含 defaultChecked 与显式 false）。
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

async function render(program: string, props: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(createElement(OpenUiBlock, { program, ...props }));
  });
}

async function click(element: Element | undefined | null) {
  await act(async () => {
    (element as HTMLElement | null)?.click();
  });
}

function byText(text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(text),
  );
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

const FORM = [
  'root = Form("booking", buttons, [fc])',
  'buttons = Buttons([submit])',
  'submit = Button("提交", @ToAssistant("提交"), "primary")',
].join('\n');

const today = new Date();
const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
const targetIso = `${month}-28`;

describe('DatePicker', () => {
  it('opens the calendar from the trigger', async () => {
    await render(
      [FORM, 'fc = FormControl("日期", date)', 'date = DatePicker("when", "single")'].join('\n'),
    );

    const trigger = byText('Select date');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-slot="calendar"]')).toBeTruthy();
  });

  it('stores the clicked local day and restores it as selected', async () => {
    const onAction = vi.fn();
    await render(
      [FORM, 'fc = FormControl("日期", date)', 'date = DatePicker("when", "single")'].join('\n'),
      { onAction },
    );

    await click(byText('Select date'));
    const cell = document.querySelector(`td[data-day="${targetIso}"]`);
    await click(cell?.querySelector('button'));
    await click(byText('提交'));

    expect(onAction.mock.calls.at(-1)?.[0]?.formState?.booking?.when?.value).toBe(targetIso);

    // 恢复快照后同一个日期仍处于选中态。
    await act(async () => root.unmount());
    root = createRoot(host);
    await render(
      [FORM, 'fc = FormControl("日期", date)', 'date = DatePicker("when", "single")'].join('\n'),
      {
        initialState: {
          booking: { when: { value: targetIso, componentType: 'DatePicker' } },
        },
      },
    );
    expect(byText(targetIso)).toBeTruthy();
    await click(byText(targetIso));
    expect(
      document.querySelector(`td[data-day="${targetIso}"]`)?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('opens on the restored far-future month', async () => {
    await render(
      [FORM, 'fc = FormControl("日期", date)', 'date = DatePicker("when", "single")'].join('\n'),
      { initialState: { booking: { when: { value: '2030-06-15', componentType: 'DatePicker' } } } },
    );

    await click(byText('2030-06-15'));
    expect(document.body.textContent).toContain('June 2030');
    expect(document.querySelector('td[data-day="2030-06-15"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('clears a literal initial date instead of restoring it', async () => {
    const onAction = vi.fn();
    await render(
      [
        FORM,
        'fc = FormControl("日期", date)',
        'date = DatePicker("when", "single", {}, "2030-06-15")',
      ].join('\n'),
      { onAction },
    );

    await click(byText('2030-06-15'));
    await click(document.querySelector('td[data-day="2030-06-15"] button'));
    expect(byText('Select date')).toBeTruthy();

    await click(byText('提交'));
    expect(onAction.mock.calls.at(-1)?.[0]?.formState?.booking?.when?.value).toBe('');
  });
});

describe('DatePicker range', () => {
  it('restores both ends, opens on the from month and stores a real two-day pick', async () => {
    const onAction = vi.fn();
    const program = [
      FORM,
      'fc = FormControl("日期", date)',
      'date = DatePicker("stay", "range")',
    ].join('\n');
    await render(program, {
      onAction,
      initialState: {
        booking: {
          stay: {
            value: { from: '2030-06-10', to: '2030-06-12' },
            componentType: 'DatePicker',
          },
        },
      },
    });

    await click(byText('2030-06-10 → 2030-06-12'));
    expect(document.body.textContent).toContain('June 2030');
    expect(
      document.querySelector('td[data-day="2030-06-10"] button')?.getAttribute('data-range-start'),
    ).toBe('true');
    expect(
      document.querySelector('td[data-day="2030-06-12"] button')?.getAttribute('data-range-end'),
    ).toBe('true');

    await click(document.querySelector('td[data-day="2030-06-10"] button'));
    await click(document.querySelector('td[data-day="2030-06-12"] button'));
    await click(byText('提交'));
    expect(onAction.mock.calls.at(-1)?.[0]?.formState?.booking?.stay?.value).toEqual({
      from: '2030-06-10',
      to: '2030-06-12',
    });
  });
});

describe('selection groups', () => {
  it('submits every checkbox with its default and explicit false', async () => {
    const onAction = vi.fn();
    await render(
      [
        FORM,
        'fc = FormControl("兴趣", checks)',
        'checks = CheckBoxGroup("hobbies", [cb1, cb2])',
        'cb1 = CheckBoxItem("徒步", "山区路线", "hiking", true)',
        'cb2 = CheckBoxItem("游泳", "室内泳池", "swim", false)',
      ].join('\n'),
      { onAction },
    );

    const boxes = () => [...host.querySelectorAll('[role="checkbox"]')];
    expect(boxes()[0]?.getAttribute('aria-checked')).toBe('true');

    await click(boxes()[1]);
    await click(byText('提交'));
    expect(onAction.mock.calls.at(-1)?.[0]?.formState?.booking?.hobbies?.value).toEqual({
      hiking: true,
      swim: true,
    });

    // 关掉一个开关后提交，显式 false 不能被丢掉。
    await click(boxes()[1]);
    await click(byText('提交'));
    expect(onAction.mock.calls.at(-1)?.[0]?.formState?.booking?.hobbies?.value).toEqual({
      hiking: true,
      swim: false,
    });
  });

  it('writes every switch state back with its default', async () => {
    const onSaveState = vi.fn().mockResolvedValue(undefined);
    await render(
      [
        'root = Card([switches])',
        'switches = SwitchGroup("notify", [mail, push])',
        'mail = SwitchItem("邮件", "每日摘要", "email", true)',
        'push = SwitchItem("推送", "即时提醒", "push", false)',
      ].join('\n'),
      { conversationId: 'c1', messageId: 'm1', blockKey: '0', onSaveState },
    );

    const switches = [...host.querySelectorAll<HTMLElement>('[role="switch"]')];
    expect(switches.map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false']);

    await click(switches[1]);
    // 状态写回按块防抖 400ms，等它落盘。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(onSaveState.mock.calls.at(-1)?.[0]?.state?.notify?.value).toEqual({
      email: true,
      push: true,
    });
  });
});
