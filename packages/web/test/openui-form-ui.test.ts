import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantText } from '../src/components/openui-message.js';
import { OpenUiBlock } from '../src/openui/renderer.js';

/**
 * 表单字段的无障碍接线：同一消息的两个 UI 段出现同名字段时，
 * DOM id 必须各自唯一，label 指向自己的控件，hint / 错误通过
 * aria-describedby 就地关联，禁用态同步到 Field。
 */

const FENCE = (lines: string[]) => ['```openui-lang', ...lines, '```'].join('\n');

const FORM = [
  'root = Card([form])',
  'form = Form("contact", buttons, [fc, fcSelect])',
  'buttons = Buttons([submit])',
  'submit = Button("提交", @ToAssistant("提交"), "primary")',
  'fc = FormControl("邮箱", mail, "用于接收行程")',
  'mail = Input("email", "", "email", { required: true, email: true })',
  'fcSelect = FormControl("人数", sel)',
  'sel = Select("people", [s1, s2], "选择人数", { required: true })',
  's1 = SelectItem("1", "1 人")',
  's2 = SelectItem("2", "2 人")',
];

const CHIPS_FORM = [
  'root = Card([form])',
  'form = Form("prefs", buttons, [fc])',
  'buttons = Buttons([save])',
  'save = Button("保存", @ToAssistant("保存"), "primary")',
  'fc = FormControl("住宿", chips)',
  'chips = Chips("stay", "multiple", [c1, c2], {}, [])',
  'c1 = ChipItem("hotel", "酒店")',
  'c2 = ChipItem("camp", "露营")',
];

const GROUP_FORM = [
  'root = Card([form])',
  'form = Form("prefs", buttons, [fcRadio, fcCheck, fcChips, fcCards, fcSlider])',
  'buttons = Buttons([save])',
  'save = Button("保存", @ToAssistant("保存"), "primary")',
  'fcRadio = FormControl("节奏", radios, "选择出行节奏")',
  'radios = RadioGroup("pace", [r1, r2], "", { required: true })',
  'r1 = RadioItem("慢", "轻松", "slow")',
  'r2 = RadioItem("快", "紧凑", "fast")',
  'fcCheck = FormControl("兴趣", checks, "选择一项或多项")',
  'checks = CheckBoxGroup("hobbies", [cb1], { required: true })',
  'cb1 = CheckBoxItem("徒步", "山区路线", "hiking")',
  'fcChips = FormControl("住宿", chips, "选择住宿")',
  'chips = Chips("stay", "multiple", [c1], { required: true }, [])',
  'c1 = ChipItem("hotel", "酒店")',
  'fcCards = FormControl("类型", cards, "选择类型")',
  'cards = OptionCards("kind", "single", [o1], { required: true })',
  'o1 = OptionCard("city", "城市", "都市漫步")',
  'fcSlider = FormControl("预算", slider, "拖动选择预算")',
  'slider = Slider("budget", "discrete", 0, 100, 10, [30], "", { min: 60 })',
];

// SwitchGroup 不在 FormControl 的联合里，只能直接挂在 Card 下。
const SWITCH_FORM = [
  'root = Card([switches])',
  'switches = SwitchGroup("notify", [mail, push])',
  'mail = SwitchItem("邮件", "每日摘要", "email", true)',
  'push = SwitchItem("推送", "即时提醒", "push", false)',
];

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

async function settle(rounds = 16): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderText(text: string): Promise<void> {
  await act(async () => {
    root.render(
      createElement(AssistantText, { text, openUi: true, streaming: false, onAction: vi.fn() }),
    );
  });
  await settle();
}

async function renderProgram(program: string, streaming = false): Promise<void> {
  await act(async () => {
    root.render(createElement(OpenUiBlock, { program, streaming }));
  });
  await settle();
}

function all<T extends HTMLElement = HTMLElement>(selector: string): T[] {
  return [...host.querySelectorAll<T>(selector)];
}

function fieldFor(control: HTMLElement): HTMLElement {
  const field = control.closest<HTMLElement>('[data-slot="field"]');
  if (!field) throw new Error('field wrapper not found');
  return field;
}

function describedBy(control: HTMLElement): HTMLElement[] {
  return (control.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => {
      const element = host.querySelector<HTMLElement>(`[id="${id}"]`);
      if (!element) throw new Error(`describedby target not found: ${id}`);
      return element;
    });
}

describe('FormControl field wiring', () => {
  it('keeps DOM ids unique for the same field name in two UI segments', async () => {
    await renderText(`${FENCE(FORM)}\n\n${FENCE(FORM)}`);

    const inputs = all<HTMLInputElement>('input[name="email"]');
    expect(inputs).toHaveLength(2);
    const ids = inputs.map((input) => input.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(host.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);

    // 每个 label 只指向自己那一段的控件。
    for (const label of all('label')) {
      const target = label.getAttribute('for');
      if (!target) continue;
      const control = host.querySelector<HTMLElement>(`[id="${target}"]`);
      expect(control).toBeTruthy();
      expect(fieldFor(control as HTMLElement)).toBe(label.closest('[data-slot="field"]'));
    }
  });

  it('points each label at its own input and select trigger', async () => {
    await renderText(FENCE(FORM));

    // jsdom 不实现点击 label 转发焦点，这里断言浏览器聚焦所依赖的 for / control 关联。
    const [input] = all<HTMLInputElement>('input[name="email"]');
    const inputLabel = document.querySelector<HTMLLabelElement>(`label[for="${input?.id}"]`);
    expect(inputLabel?.htmlFor).toBe(input?.id);
    expect(inputLabel?.control).toBe(input);

    const [trigger] = all('[data-slot="select-trigger"]');
    const selectLabel = document.querySelector<HTMLLabelElement>(`label[for="${trigger?.id}"]`);
    expect(selectLabel?.htmlFor).toBe(trigger?.id);
    expect(selectLabel?.control).toBe(trigger);
  });

  it('associates hint and error with the invalid control in place', async () => {
    await renderText(FENCE(FORM));

    const [input] = all<HTMLInputElement>('input[name="email"]');
    expect(fieldFor(input as HTMLElement).hasAttribute('data-invalid')).toBe(false);
    expect(describedBy(input as HTMLElement).map((element) => element.textContent)).toContain(
      '用于接收行程',
    );

    const submit = all('button').find((button) => button.textContent === '提交');
    await act(async () => submit?.click());

    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(fieldFor(input as HTMLElement).getAttribute('data-invalid')).toBe('true');

    const described = describedBy(input as HTMLElement);
    const texts = described.map((element) => element.textContent);
    expect(texts).toContain('用于接收行程');
    expect(described.find((element) => element.getAttribute('role') === 'alert')?.textContent).toBe(
      'This field is required',
    );
    // 解除错误后接线跟着回退。
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'a@b.co');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input?.getAttribute('aria-invalid')).toBeNull();
    expect(fieldFor(input as HTMLElement).hasAttribute('data-invalid')).toBe(false);
  });

  it('links group controls to the FormControl label', async () => {
    await renderProgram(CHIPS_FORM.join('\n'));

    const group = host.querySelector<HTMLElement>('fieldset[aria-labelledby]');
    expect(group).toBeTruthy();
    const label = host.querySelector<HTMLElement>(
      `[id="${group?.getAttribute('aria-labelledby')}"]`,
    );
    expect(label?.textContent).toContain('住宿');
    // 分组没有单一可聚焦控件，不能渲染成指向不存在 id 的 <label for>。
    expect(host.querySelector('label[for]')).toBeNull();
  });

  it('puts hint, error and invalid on the focusable controls of every group', async () => {
    await renderProgram(GROUP_FORM.join('\n'));

    const radioGroup = host.querySelector<HTMLElement>('[role="radiogroup"]');
    expect(radioGroup).toBeTruthy();
    expect(radioGroup?.hasAttribute('aria-invalid')).toBe(false);
    const radio = radioGroup?.querySelector<HTMLElement>('[role="radio"]');
    expect(describedBy(radio as HTMLElement).map((element) => element.textContent)).toContain(
      '选择出行节奏',
    );

    const checkbox = host.querySelector<HTMLElement>('[role="checkbox"]');
    const checkboxField = fieldFor(checkbox as HTMLElement);
    const chip = all<HTMLButtonElement>('button[aria-pressed]').find(
      (button) => button.textContent === '酒店',
    );
    const card = all<HTMLButtonElement>('button[aria-pressed]').find((button) =>
      button.textContent?.includes('城市'),
    );
    const range = host.querySelector<HTMLInputElement>('input[type="range"]');
    expect(range).toBeTruthy();

    const submit = all('button').find((button) => button.textContent === '保存');
    await act(async () => submit?.click());
    await settle();

    // 分组容器与每个可聚焦控件同步 invalid。
    expect(radioGroup?.getAttribute('aria-invalid')).toBe('true');
    expect(radio?.getAttribute('aria-invalid')).toBe('true');
    expect(checkbox?.getAttribute('aria-invalid')).toBe('true');
    expect(checkboxField.querySelector('fieldset')?.getAttribute('aria-invalid')).toBe('true');
    expect(chip?.getAttribute('aria-invalid')).toBe('true');
    expect(card?.getAttribute('aria-invalid')).toBe('true');
    expect(range?.getAttribute('aria-invalid')).toBe('true');

    // 键盘可聚焦的控件都能就地读到标签、提示与错误。
    for (const control of [radio, checkbox, chip, card, range]) {
      const labelledBy = control?.getAttribute('aria-labelledby');
      const name = labelledBy
        ? host.querySelector(`[id="${labelledBy}"]`)?.textContent
        : control?.textContent;
      expect(name?.length).toBeGreaterThan(0);
      const texts = describedBy(control as HTMLElement).map((element) => element.textContent);
      expect(texts.join(' ')).toContain('选择');
      expect(
        describedBy(control as HTMLElement).find(
          (element) => element.getAttribute('role') === 'alert',
        ),
      ).toBeTruthy();
    }
    expect(describedBy(range as HTMLElement).map((element) => element.textContent)).toContain(
      '拖动选择预算',
    );
    expect(range?.getAttribute('aria-labelledby')).toBeTruthy();

    // 选好值后各自清除，不残留 invalid 与错误关联。
    await act(async () => radio?.click());
    await act(async () => checkbox?.click());
    await act(async () => chip?.click());
    await act(async () => card?.click());
    await settle();
    for (const control of [radio, checkbox, chip, card]) {
      expect(control?.getAttribute('aria-invalid')).toBeNull();
      expect(
        describedBy(control as HTMLElement).some(
          (element) => element.getAttribute('role') === 'alert',
        ),
      ).toBe(false);
    }

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(range, '70');
      range?.dispatchEvent(new Event('input', { bubbles: true }));
      range?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(range?.getAttribute('aria-invalid')).toBeNull();
    expect(
      describedBy(range as HTMLElement).some((element) => element.getAttribute('role') === 'alert'),
    ).toBe(false);
  });

  it('keeps same-named switch groups in two segments independent', async () => {
    await renderText(`${FENCE(SWITCH_FORM)}\n\n${FENCE(SWITCH_FORM)}`);

    const labels = all<HTMLLabelElement>('label[for]');
    expect(labels).toHaveLength(4);
    expect(new Set(labels.map((label) => label.htmlFor)).size).toBe(4);
    for (const label of labels) {
      const control = label.control as HTMLInputElement | null;
      expect(control?.id).toBe(label.htmlFor);
      // 每个 label 指向的隐藏输入与自己的开关同组，不会串到另一段。
      expect(control?.parentElement?.querySelector('[role="switch"]')).toBeTruthy();
      expect(control?.parentElement?.querySelectorAll('[role="switch"]')).toHaveLength(1);
    }

    const switches = all('[role="switch"]');
    expect(switches).toHaveLength(4);
    expect(switches.map((element) => element.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'true',
      'false',
    ]);

    // 第一段的邮件开关只改变自己，第二段保持原样。
    await act(async () => (labels[0]?.control as HTMLInputElement | null)?.click());
    await settle();
    expect(switches.map((element) => element.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
      'false',
    ]);
  });

  it('marks fields disabled and controls disabled while streaming', async () => {
    await renderProgram(FORM.join('\n'), true);

    const [input] = all<HTMLInputElement>('input[name="email"]');
    expect(input?.disabled).toBe(true);
    expect(fieldFor(input as HTMLElement).getAttribute('data-disabled')).toBe('true');
  });
});
