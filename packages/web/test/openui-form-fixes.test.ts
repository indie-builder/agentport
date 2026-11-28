import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUiAgent } from '../src/lib/ui-agent.js';
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

function dateTrigger(): HTMLButtonElement {
  const trigger = host.querySelector<HTMLButtonElement>('[data-slot="date-picker-trigger"]');
  if (!trigger) throw new Error('date picker trigger not found');
  return trigger;
}

function dateInput(): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('[data-slot="date-picker-input"]');
  if (!input) throw new Error('date picker input not found');
  return input;
}

async function settle(rounds = 8) {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function typeDate(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    input.focus();
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function blurDate(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    input.blur();
  });
  await settle();
}

async function pressEnterDate(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await settle();
}

async function dispatchKey(element: HTMLElement, key: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  });
  await settle();
}

function dateInputs(): HTMLInputElement[] {
  return [...host.querySelectorAll<HTMLInputElement>('[data-slot="date-picker-input"]')];
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

    const trigger = dateTrigger();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-slot="date-picker-content"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="calendar-grid"]')).toBeTruthy();
  });

  it('stores the clicked local day and restores it as selected', async () => {
    const onAction = vi.fn();
    await render(
      [FORM, 'fc = FormControl("日期", date)', 'date = DatePicker("when", "single")'].join('\n'),
      { onAction },
    );

    await click(dateTrigger());
    const cell = document.querySelector(`[data-slot="calendar-day"][data-value="${targetIso}"]`);
    await click(cell);
    expect(dateTrigger().getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector<HTMLInputElement>('input[type="hidden"][name="when"]')?.value).toBe(
      targetIso,
    );
    await click(dateTrigger());
    expect(
      document
        .querySelector(`[data-slot="calendar-day"][data-value="${targetIso}"]`)
        ?.getAttribute('aria-selected'),
    ).toBe('true');
    await click(byText('提交'));

    expect(onAction.mock.calls.at(-1)?.[0]?.formState?.booking?.when?.value).toBe(targetIso);

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
    expect(host.querySelector<HTMLInputElement>('input[type="hidden"][name="when"]')?.value).toBe(
      targetIso,
    );
    expect(dateInput().value.length).toBeGreaterThan(0);
    await click(dateTrigger());
    expect(
      document
        .querySelector(`[data-slot="calendar-day"][data-value="${targetIso}"]`)
        ?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('opens on the restored far-future month', async () => {
    await render(
      [FORM, 'fc = FormControl("日期", date)', 'date = DatePicker("when", "single")'].join('\n'),
      { initialState: { booking: { when: { value: '2030-06-15', componentType: 'DatePicker' } } } },
    );

    await click(dateTrigger());
    expect(document.body.textContent).toContain('June 2030');
    expect(
      document
        .querySelector('[data-slot="calendar-day"][data-value="2030-06-15"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
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

    const clear = host.querySelector<HTMLButtonElement>('[data-slot="date-picker-clear"]');
    expect(clear).toBeTruthy();
    expect(clear?.hasAttribute('data-empty')).toBe(false);
    await click(clear);
    expect(dateInput().value).toBe('');
    expect(clear?.hasAttribute('data-empty')).toBe(true);
    await click(dateTrigger());
    expect(
      document
        .querySelector('[data-slot="calendar-day"][data-value="2030-06-15"]')
        ?.getAttribute('aria-selected'),
    ).toBe('false');

    await click(byText('提交'));
    expect(onAction.mock.calls.at(-1)?.[0]?.formState?.booking?.when?.value).toBe('');
  });

  it('shows Invalid format on invalid text, blocks submission, and recovers on valid date or clear', async () => {
    const onAction = vi.fn();
    await render(
      [FORM, 'fc = FormControl("日期", date)', 'date = DatePicker("when", "single")'].join('\n'),
      { onAction },
    );

    await typeDate(dateInput(), 'not-a-date');
    await blurDate(dateInput());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Invalid format');
    expect(dateInput().getAttribute('aria-invalid')).toBe('true');

    await click(byText('提交'));
    expect(onAction).not.toHaveBeenCalled();

    await typeDate(dateInput(), '2030-06-15');
    await pressEnterDate(dateInput());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(dateInput().getAttribute('aria-invalid')).toBeNull();

    await click(byText('提交'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[0]?.formState?.booking?.when?.value).toBe('2030-06-15');

    await typeDate(dateInput(), 'not-a-date');
    await pressEnterDate(dateInput());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Invalid format');

    await click(byText('提交'));
    expect(onAction).toHaveBeenCalledTimes(1);

    await typeDate(dateInput(), '');
    await blurDate(dateInput());
    expect(host.querySelector('[role="alert"]')).toBeNull();

    await click(byText('提交'));
    expect(onAction).toHaveBeenCalledTimes(2);
    expect(onAction.mock.calls[1]?.[0]?.formState?.booking?.when?.value).toBe('');
  });

  it('defaults DatePickerTrigger aria-label to 选择日期 and small Select to sm trigger with Chinese placeholder', async () => {
    await render(
      [
        'root = Form("booking", buttons, [fcDate, fcSelect])',
        'buttons = Buttons([submit])',
        'submit = Button("提交", @ToAssistant("提交"), "primary")',
        'fcDate = FormControl("日期", date)',
        'date = DatePicker("when", "single")',
        'fcSelect = FormControl("规模", sel)',
        'sel = Select("size", [s1, s2], null, {}, null, "small")',
        's1 = SelectItem("s", "小")',
        's2 = SelectItem("m", "中")',
      ].join('\n'),
    );

    const selectTrigger = host.querySelector<HTMLElement>('[data-slot="select-trigger"]');
    expect(selectTrigger?.getAttribute('data-size')).toBe('sm');
    expect(selectTrigger?.textContent).toContain('请选择...');
    expect(dateTrigger().getAttribute('aria-label')).toBe('选择日期');
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

    expect(
      [...host.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="stay"]')].map(
        (input) => input.value,
      ),
    ).toEqual(['2030-06-10', '2030-06-12']);
    await click(dateTrigger());
    expect(document.body.textContent).toContain('June 2030');
    expect(
      document
        .querySelector('[data-slot="calendar-day"][data-value="2030-06-10"]')
        ?.hasAttribute('data-range-start'),
    ).toBe(true);
    expect(
      document
        .querySelector('[data-slot="calendar-day"][data-value="2030-06-11"]')
        ?.hasAttribute('data-range-middle'),
    ).toBe(true);
    expect(
      document
        .querySelector('[data-slot="calendar-day"][data-value="2030-06-12"]')
        ?.hasAttribute('data-range-end'),
    ).toBe(true);
    for (const day of ['2030-06-10', '2030-06-11', '2030-06-12']) {
      expect(
        document
          .querySelector(`[data-slot="calendar-day"][data-value="${day}"]`)
          ?.getAttribute('aria-selected'),
      ).toBe('true');
    }

    await click(document.querySelector('[data-slot="calendar-day"][data-value="2030-06-10"]'));
    await click(document.querySelector('[data-slot="calendar-day"][data-value="2030-06-12"]'));
    await click(byText('提交'));
    expect(onAction.mock.calls.at(-1)?.[0]?.formState?.booking?.stay?.value).toEqual({
      from: '2030-06-10',
      to: '2030-06-12',
    });
  });

  it('blocks submit with This field is required after clearing a populated required range', async () => {
    const onAction = vi.fn();
    await render(
      [
        FORM,
        'fc = FormControl("日期", date)',
        'date = DatePicker("stay", "range", { required: true })',
      ].join('\n'),
      {
        onAction,
        initialState: {
          booking: {
            stay: {
              value: { from: '2030-06-10', to: '2030-06-12' },
              componentType: 'DatePicker',
            },
          },
        },
      },
    );

    const clear = host.querySelector<HTMLButtonElement>('[data-slot="date-picker-clear"]');
    expect(clear?.hasAttribute('data-empty')).toBe(false);
    await click(clear);
    await settle();
    expect(clear?.hasAttribute('data-empty')).toBe(true);

    await click(byText('提交'));
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('This field is required');
    expect(onAction).not.toHaveBeenCalled();
  });

  it('shows Invalid format on invalid range text, blocks submission, and recovers on valid range or clear', async () => {
    const onAction = vi.fn();
    await render(
      [FORM, 'fc = FormControl("日期", date)', 'date = DatePicker("stay", "range")'].join('\n'),
      { onAction },
    );

    const [startInput, endInput] = dateInputs();
    if (!startInput || !endInput) throw new Error('range inputs not found');

    await typeDate(startInput, 'not-a-date');
    await blurDate(startInput);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Invalid format');
    expect(startInput.getAttribute('aria-invalid')).toBe('true');

    await click(byText('提交'));
    expect(onAction).not.toHaveBeenCalled();

    await typeDate(startInput, '2030-06-10');
    await pressEnterDate(startInput);
    await typeDate(endInput, '2030-06-12');
    await pressEnterDate(endInput);
    expect(host.querySelector('[role="alert"]')).toBeNull();

    await click(byText('提交'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[0]?.formState?.booking?.stay?.value).toEqual({
      from: '2030-06-10',
      to: '2030-06-12',
    });

    await typeDate(endInput, 'not-a-date');
    await pressEnterDate(endInput);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Invalid format');

    await click(byText('提交'));
    expect(onAction).toHaveBeenCalledTimes(1);

    await click(host.querySelector<HTMLButtonElement>('[data-slot="date-picker-clear"]'));
    await settle();
    expect(host.querySelector('[role="alert"]')).toBeNull();

    await click(byText('提交'));
    expect(onAction).toHaveBeenCalledTimes(2);
    expect(onAction.mock.calls[1]?.[0]?.formState?.booking?.stay?.value).toBe('');
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(onSaveState.mock.calls.at(-1)?.[0]?.state?.notify?.value).toEqual({
      email: true,
      push: true,
    });
  });

  it('submits defaultChecked checkboxes without clicking and satisfies required', async () => {
    const onAction = vi.fn();
    await render(
      [
        FORM,
        'fc = FormControl("兴趣", checks)',
        'checks = CheckBoxGroup("hobbies", [cb1, cb2], { required: true })',
        'cb1 = CheckBoxItem("徒步", "山区路线", "hiking", true)',
        'cb2 = CheckBoxItem("游泳", "室内泳池", "swim", false)',
      ].join('\n'),
      { onAction },
    );
    await settle();

    await click(byText('提交'));
    await settle();

    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[0]?.formState?.booking?.hobbies?.value).toEqual({
      hiking: true,
      swim: false,
    });
  });

  it('persists SwitchGroup defaultChecked state on mount without clicking', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Card([switches, buttons])',
        'switches = SwitchGroup("notify", [mail, push])',
        'mail = SwitchItem("邮件", "每日摘要", "email", true)',
        'push = SwitchItem("推送", "即时提醒", "push", false)',
        'buttons = Buttons([submit])',
        'submit = Button("保存", @ToAssistant("保存"))',
      ].join('\n'),
      { onAction },
    );
    await settle();

    await click(byText('保存'));
    await settle();

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[0]?.formState?.notify?.value).toEqual({
      email: true,
      push: false,
    });
  });

  it('reports RadioGroup unselected value as null in ui agent snapshot', async () => {
    await render(
      [
        FORM,
        'fc = FormControl("节奏", radios)',
        'radios = RadioGroup("pace", [r1, r2], "")',
        'r1 = RadioItem("慢", "轻松", "slow")',
        'r2 = RadioItem("快", "紧凑", "fast")',
      ].join('\n'),
    );
    await settle();

    const entry = createUiAgent()
      .snapshot()
      .find((item) => !item.offPage && item.component === 'radio' && item.label === '节奏');
    expect(entry).toBeDefined();
    expect(entry?.value).toBeNull();
  });

  it('renders Chips and OptionCards as ToggleGroup with roving focus and agent snapshot exposure', async () => {
    await render(
      [
        'root = Form("prefs", buttons, [fcChips, fcCards])',
        'buttons = Buttons([submit])',
        'submit = Button("提交", @ToAssistant("提交"), "primary")',
        'fcChips = FormControl("住宿", chips)',
        'chips = Chips("stay", "multiple", [c1, c2])',
        'c1 = ChipItem("hotel", "酒店")',
        'c2 = ChipItem("camp", "露营")',
        'fcCards = FormControl("类型", cards)',
        'cards = OptionCards("kind", "single", [o1, o2])',
        'o1 = OptionCard("city", "城市", "都市漫步")',
        'o2 = OptionCard("nature", "自然", "山野路线")',
      ].join('\n'),
    );
    await settle();

    const groups = [...host.querySelectorAll<HTMLElement>('[data-slot="toggle-group"]')];
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.getAttribute('role')).toBe('group');
    }

    const chipButtons = [...(groups[0]?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    expect(chipButtons).toHaveLength(2);
    await act(async () => {
      chipButtons[0]?.focus();
    });
    await dispatchKey(chipButtons[0] as HTMLElement, 'ArrowRight');
    expect(document.activeElement).toBe(chipButtons[1]);
    await dispatchKey(chipButtons[1] as HTMLElement, 'ArrowLeft');
    expect(document.activeElement).toBe(chipButtons[0]);

    const cardButtons = [...(groups[1]?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    expect(cardButtons).toHaveLength(2);
    await act(async () => {
      cardButtons[0]?.focus();
    });
    await dispatchKey(cardButtons[0] as HTMLElement, 'ArrowRight');
    expect(document.activeElement).toBe(cardButtons[1]);
    await dispatchKey(cardButtons[1] as HTMLElement, 'ArrowLeft');
    expect(document.activeElement).toBe(cardButtons[0]);

    const snap = createUiAgent().snapshot();
    const chipsEntry = snap.find((item) => !item.offPage && item.label === '住宿');
    const cardsEntry = snap.find((item) => !item.offPage && item.label === '类型');
    expect(chipsEntry).toMatchObject({
      component: 'toggle',
      label: '住宿',
      actions: ['setValue', 'toggle'],
    });
    expect(cardsEntry).toMatchObject({
      component: 'toggle',
      label: '类型',
      actions: ['setValue', 'toggle'],
    });
  });
});

describe('IconButton', () => {
  it('renders accessible label, fires onAction on click, and disables while streaming', async () => {
    const onAction = vi.fn();
    const program = [
      'root = Card([ib])',
      'ib = IconButton("刷新数据", ic, @ToAssistant("刷新数据"))',
      'ic = Icon("refresh-cw", "arrows")',
    ].join('\n');

    await render(program, { onAction, streaming: false });
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="刷新数据"]');
    expect(button).toBeTruthy();
    expect(button?.disabled).toBe(false);

    await click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[0]).toMatchObject({
      type: 'continue_conversation',
      message: '刷新数据',
    });

    await render(program, { onAction, streaming: true });
    const disabledButton = host.querySelector<HTMLButtonElement>('button[aria-label="刷新数据"]');
    expect(disabledButton?.disabled).toBe(true);
    await click(disabledButton);
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
