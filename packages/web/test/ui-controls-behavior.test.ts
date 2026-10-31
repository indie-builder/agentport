import type { ReactElement } from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Checkbox } from '../src/components/ui/checkbox.js';
import { Field, FieldLabel } from '../src/components/ui/field.js';
import { RadioGroup, RadioGroupItem } from '../src/components/ui/radio-group.js';
import { Switch } from '../src/components/ui/switch.js';

/**
 * 焦点外观由浏览器 computed style 验收；这里只证明控件本身的键盘与标签行为，
 * 避免用类名断言冒充视觉结论。
 */

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

async function render(element: ReactElement) {
  await act(async () => root.render(element));
}

async function pressSpace(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    element.dispatchEvent(
      new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }),
    );
  });
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function control(role: 'checkbox' | 'switch' | 'radio', name?: string): HTMLElement {
  const selector = name ? `[role="${role}"][aria-label="${name}"]` : `[role="${role}"]`;
  const element = host.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

describe('shared choice controls keep real keyboard and label behaviour', () => {
  it('toggles an unchecked checkbox with Space and exposes the checked state', async () => {
    const onCheckedChange = vi.fn();
    await render(createElement(Checkbox, { 'aria-label': '选择', onCheckedChange }));
    const checkbox = control('checkbox');

    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    expect(checkbox.hasAttribute('data-unchecked')).toBe(true);
    expect(checkbox.hasAttribute('data-checked')).toBe(false);

    await pressSpace(checkbox);

    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    expect(checkbox.hasAttribute('data-checked')).toBe(true);
    expect(checkbox.hasAttribute('data-unchecked')).toBe(false);

    await pressSpace(checkbox);

    expect(checkbox.getAttribute('aria-checked')).toBe('false');
  });

  it('does not toggle a disabled checkbox with Space or click', async () => {
    const onCheckedChange = vi.fn();
    await render(
      createElement(Checkbox, { 'aria-label': '禁用选择', disabled: true, onCheckedChange }),
    );
    const checkbox = control('checkbox');

    expect(checkbox.getAttribute('aria-disabled')).toBe('true');
    await pressSpace(checkbox);
    await click(checkbox);

    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
  });

  it('toggles a switch with Space and exposes the checked state', async () => {
    const onCheckedChange = vi.fn();
    await render(createElement(Switch, { 'aria-label': '开关', onCheckedChange }));
    const toggle = control('switch');

    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await pressSpace(toggle);

    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.hasAttribute('data-checked')).toBe(true);
  });

  it('does not toggle a disabled switch with Space or click', async () => {
    const onCheckedChange = vi.fn();
    await render(
      createElement(Switch, { 'aria-label': '禁用开关', disabled: true, onCheckedChange }),
    );
    const toggle = control('switch');

    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    await pressSpace(toggle);
    await click(toggle);

    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('associates an htmlFor label with the checkbox', async () => {
    await render(
      createElement(
        'div',
        null,
        createElement(FieldLabel, { htmlFor: 'terms' }, '同意条款'),
        createElement(Checkbox, { id: 'terms' }),
      ),
    );
    const label = host.querySelector('label');
    if (!label) throw new Error('missing label');

    await click(label);

    expect(control('checkbox').getAttribute('aria-checked')).toBe('true');
    expect(control('checkbox').hasAttribute('data-checked')).toBe(true);
  });

  it('toggles a checkbox wrapped by a plain FieldLabel', async () => {
    await render(createElement(FieldLabel, null, createElement(Checkbox), '启用通知'));
    const label = host.querySelector('label');
    if (!label) throw new Error('missing label');

    await click(label);

    expect(control('checkbox').getAttribute('aria-checked')).toBe('true');
  });

  it('toggles a checkbox inside a card FieldLabel that directly wraps a Field', async () => {
    await render(
      createElement(
        FieldLabel,
        null,
        createElement(Field, null, createElement(Checkbox)),
        '卡片选项',
      ),
    );
    const label = host.querySelector('label');
    if (!label) throw new Error('missing label');

    await click(label);

    expect(control('checkbox').getAttribute('aria-checked')).toBe('true');
  });

  it('moves radio selection with arrow keys and keeps disabled items inert', async () => {
    await render(
      createElement(
        RadioGroup,
        { defaultValue: 'a', 'aria-label': '节奏' },
        createElement(RadioGroupItem, { value: 'a', 'aria-label': '慢' }),
        createElement(RadioGroupItem, { value: 'b', 'aria-label': '快' }),
        createElement(RadioGroupItem, { value: 'c', 'aria-label': '停用', disabled: true }),
      ),
    );
    const slow = control('radio', '慢');
    const fast = control('radio', '快');

    slow.focus();
    expect(slow.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      slow.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
    });

    expect(fast.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(fast);

    // 停用项对点击无反应，也不会成为选中项。
    const stopped = control('radio', '停用');
    expect(stopped.getAttribute('aria-disabled')).toBe('true');
    await click(stopped);
    expect(stopped.getAttribute('aria-checked')).toBe('false');
    expect(fast.getAttribute('aria-checked')).toBe('true');

    // 方向键越过停用项，循环回到第一项而不是停在不可选项上。
    await act(async () => {
      fast.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
    });
    expect(stopped.getAttribute('aria-checked')).toBe('false');
    expect(slow.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(slow);
  });

  it('selects a radio through its htmlFor label', async () => {
    await render(
      createElement(
        RadioGroup,
        { 'aria-label': '部署环境' },
        createElement(FieldLabel, { htmlFor: 'env-staging' }, '预发'),
        createElement(RadioGroupItem, { value: 'staging', id: 'env-staging' }),
      ),
    );
    const label = host.querySelector('label');
    if (!label) throw new Error('missing label');

    await click(label);

    expect(control('radio').getAttribute('aria-checked')).toBe('true');
  });
});
