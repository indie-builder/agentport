import { action, createLibrary, defineComponent, Renderer } from '@openuidev/react-lang';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ButtonRenderer,
  ButtonsRenderer,
  ChipsRenderer,
  FormControlRenderer,
  FormRenderer,
  InputRenderer,
  OptionCardsRenderer,
} from '../src/openui/components/forms.js';

/**
 * 只注册本组用例用得上的组件，schema 用真 Zod，
 * 这样不依赖正在别处变更的完整库契约。
 */
const rules = z
  .object({
    required: z.boolean().optional(),
    email: z.boolean().optional(),
    url: z.boolean().optional(),
    numeric: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    pattern: z.string().optional(),
  })
  .optional();

const ChipItem = defineComponent({
  name: 'ChipItem',
  props: z.object({
    value: z.string(),
    label: z.string(),
    disabled: z.boolean().optional(),
  }),
  component: () => null,
});

const OptionCard = defineComponent({
  name: 'OptionCard',
  props: z.object({
    value: z.string(),
    title: z.string(),
    subtitle: z.string().optional(),
    disabled: z.boolean().optional(),
  }),
  component: () => null,
});

const Chips = defineComponent({
  name: 'Chips',
  props: z.object({
    name: z.string(),
    type: z.enum(['single', 'multiple']),
    items: z.array(ChipItem.ref),
    rules,
    defaultValue: z.union([z.string(), z.array(z.string())]).optional(),
  }),
  component: ChipsRenderer,
});

const OptionCards = defineComponent({
  name: 'OptionCards',
  props: z.object({
    name: z.string(),
    type: z.enum(['single', 'multiple']),
    items: z.array(OptionCard.ref),
    rules,
    defaultValue: z.union([z.string(), z.array(z.string())]).optional(),
  }),
  component: OptionCardsRenderer,
});

const Input = defineComponent({
  name: 'Input',
  props: z.object({
    name: z.string(),
    placeholder: z.string().optional(),
    type: z.enum(['text', 'email', 'password', 'number', 'url']).optional(),
    rules,
    value: z.string().optional(),
  }),
  component: InputRenderer,
});

const FormControl = defineComponent({
  name: 'FormControl',
  props: z.object({
    label: z.string(),
    input: z.union([Input.ref, Chips.ref, OptionCards.ref]),
    hint: z.string().optional(),
  }),
  component: FormControlRenderer,
});

const Button = defineComponent({
  name: 'Button',
  props: z.object({
    label: z.string(),
    action: action().optional(),
    variant: z.enum(['primary', 'secondary', 'tertiary']).optional(),
    type: z.enum(['normal', 'destructive']).optional(),
    size: z.enum(['extra-small', 'small', 'medium', 'large']).optional(),
  }),
  component: ButtonRenderer,
});

const Buttons = defineComponent({
  name: 'Buttons',
  props: z.object({
    buttons: z.array(Button.ref),
    direction: z.enum(['row', 'column']).optional(),
  }),
  component: ButtonsRenderer,
});

const Form = defineComponent({
  name: 'Form',
  props: z.object({
    name: z.string(),
    buttons: Buttons.ref,
    fields: z.array(FormControl.ref),
  }),
  component: FormRenderer,
});

const library = createLibrary({
  components: [ChipItem, OptionCard, Input, Chips, OptionCards, FormControl, Button, Buttons, Form],
  root: 'Form',
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(
  lines: string[],
  props: { onAction?: (event: unknown) => void; onStateUpdate?: (state: unknown) => void } = {},
) {
  await act(async () => {
    root.render(
      createElement(Renderer, {
        response: lines.join('\n'),
        library,
        isStreaming: false,
        ...props,
      }),
    );
  });
}

function buttonByText(text: string): HTMLButtonElement {
  // OptionCards 的按钮文本会拼上副标题，这里用包含匹配。
  const found = [...host.querySelectorAll('button')].find((element) =>
    element.textContent?.includes(text),
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

async function click(text: string) {
  await act(async () => buttonByText(text).click());
}

async function type(name: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!input) throw new Error(`input not found: ${name}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Chips / OptionCards single selection', () => {
  it('keeps a single chip deselected instead of restoring defaultValue', async () => {
    await render([
      'root = Form("prefs", buttons, [fcChips])',
      'buttons = Buttons([save])',
      'save = Button("保存", @ToAssistant("保存"), "primary")',
      'fcChips = FormControl("住宿", chips)',
      'chips = Chips("stay", "single", [c1, c2], {}, ["hotel"])',
      'c1 = ChipItem("hotel", "酒店")',
      'c2 = ChipItem("camp", "露营")',
    ]);

    // 默认值仍然生效。
    expect(buttonByText('酒店').getAttribute('aria-pressed')).toBe('true');
    expect(buttonByText('露营').getAttribute('aria-pressed')).toBe('false');

    await click('酒店');
    expect(buttonByText('酒店').getAttribute('aria-pressed')).toBe('false');

    await click('露营');
    expect(buttonByText('露营').getAttribute('aria-pressed')).toBe('true');
    expect(buttonByText('酒店').getAttribute('aria-pressed')).toBe('false');

    // 再次取消，不能被默认值重新选上。
    await click('露营');
    expect(buttonByText('露营').getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps a single option card deselected instead of restoring defaultValue', async () => {
    await render([
      'root = Form("prefs", buttons, [fcKind])',
      'buttons = Buttons([save])',
      'save = Button("保存", @ToAssistant("保存"), "primary")',
      'fcKind = FormControl("类型", cards)',
      'cards = OptionCards("kind", "single", [o1, o2], {}, ["city"])',
      'o1 = OptionCard("city", "城市", "都市漫步")',
      'o2 = OptionCard("nature", "自然", "山野路线")',
    ]);

    expect(buttonByText('城市').getAttribute('aria-pressed')).toBe('true');
    await click('城市');
    expect(buttonByText('城市').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('Chips / OptionCards defaults and required', () => {
  it('keeps a multi-chip defaultValue selected until the user changes it', async () => {
    await render([
      'root = Form("prefs", buttons, [fcChips])',
      'buttons = Buttons([save])',
      'save = Button("保存", @ToAssistant("保存"), "primary")',
      'fcChips = FormControl("住宿", chips)',
      'chips = Chips("stay", "multiple", [c1, c2], { required: true }, ["hotel"])',
      'c1 = ChipItem("hotel", "酒店")',
      'c2 = ChipItem("camp", "露营")',
    ]);

    expect(buttonByText('酒店').getAttribute('aria-pressed')).toBe('true');
    expect(buttonByText('露营').getAttribute('aria-pressed')).toBe('false');

    // 默认值满足 required，提交直接通过。
    await click('保存');
    expect(host.querySelector('[role="alert"]')).toBeNull();

    await click('酒店');
    expect(buttonByText('酒店').getAttribute('aria-pressed')).toBe('false');
  });

  it('applies required after a single chip is cleared', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Form("prefs", buttons, [fcChips])',
        'buttons = Buttons([save])',
        'save = Button("保存", @ToAssistant("保存"), "primary")',
        'fcChips = FormControl("住宿", chips)',
        'chips = Chips("stay", "single", [c1, c2], { required: true }, ["hotel"])',
        'c1 = ChipItem("hotel", "酒店")',
        'c2 = ChipItem("camp", "露营")',
      ],
      { onAction },
    );

    await click('酒店');
    await click('保存');
    expect(host.textContent).toContain('This field is required');
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('primary button validation', () => {
  it('blocks a submit-like action on required/email errors', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Form("profile", buttons, [fcName, fcMail])',
        'buttons = Buttons([submit])',
        'submit = Button("提交", @ToAssistant("提交"), "primary")',
        'fcName = FormControl("姓名", name)',
        'name = Input("fullName", "", "text", { required: true })',
        'fcMail = FormControl("邮箱", mail)',
        'mail = Input("email", "", "email", { email: true })',
      ],
      { onAction },
    );

    await click('提交');
    expect(host.textContent).toContain('This field is required');
    expect(onAction).not.toHaveBeenCalled();

    await type('fullName', '张三');
    await type('email', 'not-an-email');
    await click('提交');
    expect(host.textContent).toContain('Please enter a valid email');
    expect(onAction).not.toHaveBeenCalled();

    await type('email', 'zhang@example.com');
    await click('提交');
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'continue_conversation', humanFriendlyMessage: '提交' }),
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not block @OpenUrl on a primary button', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Form("profile", buttons, [fcName])',
        'buttons = Buttons([open])',
        'open = Button("打开", @OpenUrl("https://example.com"), "primary")',
        'fcName = FormControl("姓名", name)',
        'name = Input("fullName", "", "text", { required: true })',
      ],
      { onAction },
    );

    await click('打开');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'open_url', params: { url: 'https://example.com' } }),
    );
  });

  it('does not block @Set on a primary button', async () => {
    const onAction = vi.fn();
    const onStateUpdate = vi.fn();
    await render(
      [
        'root = Form("profile", buttons, [fcName])',
        'buttons = Buttons([setFlag])',
        'setFlag = Button("切换", @Set($flag, true), "primary")',
        'fcName = FormControl("姓名", name)',
        'name = Input("fullName", "", "text", { required: true })',
      ],
      { onAction, onStateUpdate },
    );

    await click('切换');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
    expect(onStateUpdate).toHaveBeenCalledWith(expect.objectContaining({ $flag: true }));
  });

  it('still validates when a plan mixes @Set with @ToAssistant', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Form("profile", buttons, [fcName])',
        'buttons = Buttons([submit])',
        'submit = Button("提交", Action([@Set($flag, true), @ToAssistant("完成")]), "primary")',
        'fcName = FormControl("姓名", name)',
        'name = Input("fullName", "", "text", { required: true })',
      ],
      { onAction },
    );

    await click('提交');
    expect(host.textContent).toContain('This field is required');
    expect(onAction).not.toHaveBeenCalled();
  });
});
