import { checkDirection, checkPattern, checkServer, mount, settle } from '@ui-sdk/core/testing';
import { createAgent } from '@ui-sdk/react/agent';
import {
  act,
  type ComponentProps,
  createElement,
  type ReactElement,
  useRef,
  useState,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/components/confirm-dialog.js';
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../src/components/ui/alert-dialog.js';
import { Field, FieldLabel } from '../src/components/ui/field.js';
import {
  FileInput,
  FileInputItem,
  FileInputList,
  FileInputTrigger,
} from '../src/components/ui/file-input.js';
import { MentionList, mentionList, useMentionList } from '../src/components/ui/mention-list.js';
import {
  Meter,
  MeterIndicator,
  MeterLabel,
  MeterTrack,
  MeterValue,
} from '../src/components/ui/meter.js';
import {
  NumberInput,
  NumberInputControl,
  NumberInputDecrement,
  NumberInputGroup,
  NumberInputIncrement,
} from '../src/components/ui/number-input.js';
import {
  PasswordInput,
  PasswordInputControl,
  PasswordInputToggle,
} from '../src/components/ui/password-input.js';
import { Rating, RatingItem } from '../src/components/ui/rating.js';
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from '../src/components/ui/segmented-control.js';
import { Slider } from '../src/components/ui/slider.js';
import {
  SortableList,
  SortableListHandle,
  SortableListItem,
  sortableList,
} from '../src/components/ui/sortable-list.js';
import { Textarea } from '../src/components/ui/textarea.js';

let approve = false;
const agent = createAgent({
  allow: (step) => !step.confirm || approve,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  approve = false;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  await new Promise((resolve) => setTimeout(resolve, 120));
});

async function render(element: ReactElement) {
  await act(async () => root.render(element));
}

async function flushUi() {
  await act(async () => {
    await settle();
  });
}

async function dispatchKey(element: HTMLElement, key: string) {
  await act(async () => {
    const proceeds = element.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
    element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    if (
      proceeds &&
      element instanceof HTMLButtonElement &&
      (key === ' ' || key === 'Enter') &&
      !element.disabled
    ) {
      element.click();
    }
    await settle();
  });
}

async function runPattern(element: Element, pattern: Parameters<typeof checkPattern>[1]) {
  await act(async () => {
    await checkPattern(element, pattern);
  });
}

async function runAgentAct(input: Parameters<typeof agent.act>[0]) {
  let settled = false;
  let promise!: ReturnType<typeof agent.act>;
  await act(async () => {
    promise = agent.act(input).finally(() => {
      settled = true;
    });
    await settle();
  });
  while (!settled) {
    await act(async () => {
      await settle();
    });
  }
  return promise;
}

async function typeIntoInput(element: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    element.focus();
    setter?.call(element, text);
    element.dispatchEvent(new InputEvent('input', { data: text, bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  });
}

describe('SortableList primitive and agent integration', () => {
  it('mounts cleanly and passes checkServer', async () => {
    const labels = { a: '第一列', b: '第二列', c: '第三列' };
    const markup =
      '<root as="fieldset" aria-label="列顺序"><item value="a"><handle value="a">第一列</handle></item><item value="b"><handle value="b">第二列</handle></item><item value="c"><handle value="c">第三列</handle></item></root>';
    const html = checkServer(
      sortableList,
      { value: ['a', 'b', 'c'], labels, onValueChange: () => {} },
      markup,
    );
    expect(html).toContain('<fieldset');
    expect(html).toContain('data-slot="sortable-list"');
    expect(html).toContain('data-slot="sortable-list-item"');
    expect(html).toContain('data-slot="sortable-list-handle"');
    expect(html).toContain('type="button"');

    const onValueChange = vi.fn();
    const view = mount(sortableList, { value: ['a', 'b', 'c'], labels, onValueChange }, markup);
    try {
      expect(view.state.value).toEqual(['a', 'b', 'c']);
      expect(view.state.moving).toBeNull();

      await view.keys('Tab', 'Space', 'ArrowDown');
      expect(view.state.moving).toMatchObject({
        key: 'a',
        order: ['b', 'a', 'c'],
        pointer: false,
      });
      expect(view.root.hasAttribute('data-moving')).toBe(true);
      expect(view.part('item', 'a')?.hasAttribute('data-moving')).toBe(true);

      await view.keys('Escape');
      expect(view.state.moving).toBeNull();
      expect(view.root.hasAttribute('data-moving')).toBe(false);
      expect(onValueChange).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(view.part('handle', 'a'));

      await view.keys('Space', 'ArrowDown', 'Space');
      expect(onValueChange).toHaveBeenCalledWith(
        ['b', 'a', 'c'],
        expect.objectContaining({ reason: 'move-key', source: 'keyboard' }),
      );
      expect(view.changes.at(-1)).toMatchObject({
        key: 'value',
        value: ['b', 'a', 'c'],
        reason: 'move-key',
        source: 'keyboard',
      });
      expect(view.announced).toEqual([
        '已拾取「第一列」，第 1 项，共 3 项。使用方向键调整顺序，空格或回车放下，Escape 取消。',
        '「第一列」已移到第 2 项，共 3 项。',
        '已取消调整「第一列」顺序。',
        '已拾取「第一列」，第 1 项，共 3 项。使用方向键调整顺序，空格或回车放下，Escape 取消。',
        '「第一列」已移到第 2 项，共 3 项。',
        '已放下「第一列」，第 2 项，共 3 项。',
      ]);
    } finally {
      view.unmount();
    }
  });

  it('reports checkDirection mismatch on vertical sortableList', async () => {
    await expect(
      checkDirection(
        sortableList,
        {
          value: ['a', 'b', 'c'],
          labels: { a: '第一列', b: '第二列', c: '第三列' },
          onValueChange: () => {},
        },
        '<root as="fieldset" aria-label="列顺序"><item value="a"><handle value="a">第一列</handle></item><item value="b"><handle value="b">第二列</handle></item><item value="c"><handle value="c">第三列</handle></item></root>',
      ),
    ).rejects.toThrow(/ArrowRight changes nothing/);
  });

  it('reorders items with keyboard Space and ArrowDown and cancels with Escape restoring order and focus', async () => {
    const onReorder = vi.fn();
    function SortableHarness() {
      const [order, setOrder] = useState(['a', 'b', 'c']);
      return createElement(
        SortableList,
        {
          value: order,
          labels: { a: '第一列', b: '第二列', c: '第三列' },
          'aria-label': '列顺序',
          onValueChange: (next) => {
            setOrder(next);
            onReorder(next);
          },
        },
        ({ order: currentOrder }: { order: string[] }) =>
          currentOrder.map((id) =>
            createElement(
              SortableListItem,
              { key: id, value: id },
              createElement(SortableListHandle, { value: id, 'aria-label': `调整 ${id}` }, id),
            ),
          ),
      );
    }

    await render(createElement(SortableHarness));
    const listEl = host.querySelector<HTMLElement>('[data-slot="sortable-list"]');
    const firstHandle = host.querySelector<HTMLElement>('[data-slot="sortable-list-handle"]');
    if (!listEl || !firstHandle) throw new Error('missing sortable list elements');

    firstHandle.focus();
    await dispatchKey(firstHandle, ' ');
    expect(listEl.hasAttribute('data-moving')).toBe(true);

    await dispatchKey(firstHandle, 'ArrowDown');
    await dispatchKey(firstHandle, ' ');

    expect(listEl.hasAttribute('data-moving')).toBe(false);
    expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
    const orderedIds = Array.from(
      host.querySelectorAll<HTMLElement>('[data-slot="sortable-list-item"]'),
    ).map((el) => el.textContent);
    expect(orderedIds).toEqual(['b', 'a', 'c']);

    const handleA = Array.from(
      host.querySelectorAll<HTMLElement>('[data-slot="sortable-list-handle"]'),
    ).find((el) => el.textContent === 'a');
    if (!handleA) throw new Error('missing handle a');
    handleA.focus();
    await dispatchKey(handleA, ' ');
    expect(listEl.hasAttribute('data-moving')).toBe(true);
    await dispatchKey(handleA, 'ArrowDown');
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('[data-slot="sortable-list-item"]')).map(
        (el) => el.textContent,
      ),
    ).toEqual(['b', 'c', 'a']);

    await dispatchKey(handleA, 'Escape');
    expect(listEl.hasAttribute('data-moving')).toBe(false);
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('[data-slot="sortable-list-item"]')).map(
        (el) => el.textContent,
      ),
    ).toEqual(['b', 'a', 'c']);
    expect(document.activeElement).toBe(handleA);
  });

  it('exposes move action and items to agent and reports source agent on move', async () => {
    const onReorder = vi.fn();
    const labels: Record<string, string> = { a: '第一列', b: '第二列', c: '第三列' };
    function SortableAgentHarness() {
      const [order, setOrder] = useState(['a', 'b', 'c']);
      return createElement(
        SortableList,
        {
          value: order,
          labels,
          'aria-label': '导出列顺序',
          onValueChange: (next, details) => {
            setOrder(next);
            onReorder(next, details.source);
          },
        },
        ({ order: currentOrder }: { order: string[] }) =>
          currentOrder.map((id) =>
            createElement(
              SortableListItem,
              { key: id, value: id },
              createElement(
                SortableListHandle,
                { value: id, 'aria-label': `拖拽 ${labels[id] ?? id}` },
                labels[id] ?? id,
              ),
            ),
          ),
      );
    }

    await render(createElement(SortableAgentHarness));
    const entry = agent.snapshot().find((item) => !item.offPage && item.label === '导出列顺序');
    expect(entry).toMatchObject({
      component: 'sortable-list',
      label: '导出列顺序',
      actions: ['move'],
      items: [
        { value: 'a', label: '第一列' },
        { value: 'b', label: '第二列' },
        { value: 'c', label: '第三列' },
      ],
    });

    const result = await runAgentAct({
      steps: [{ ref: '导出列顺序', action: 'move', args: ['c', 0] }],
    });
    expect(result.ok, result.error?.message).toBe(true);
    expect(onReorder).toHaveBeenCalledWith(['c', 'a', 'b'], 'agent');
  });
});

describe('mentionList primitive, React integration, and agent', () => {
  const options = [
    { agentId: 'a1', name: '规划师' },
    { agentId: 'a2', name: '研究员' },
    { agentId: 'a3', name: '审校员' },
  ];

  it('mounts cleanly and passes checkServer', () => {
    const markup =
      '<root><list aria-label="提及智能体"><option value="a1">规划师</option><option value="a2">研究员</option></list></root>';
    const html = checkServer(
      mentionList,
      { open: true, options: options.slice(0, 2), onSelect: () => {}, onClose: () => {} },
      markup,
    );
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');

    const onSelect = vi.fn();
    const view = mount(
      mentionList,
      { open: true, options: options.slice(0, 2), onSelect, onClose: () => {} },
      markup,
    );
    try {
      expect(view.state.highlighted).toBe('a1');
      expect(view.part('list')?.getAttribute('role')).toBe('listbox');
      view.api.choose('a2');
      expect(onSelect).toHaveBeenCalledWith('a2');
    } finally {
      view.unmount();
    }
  });

  it('reports checkDirection mismatch on vertical virtual-focus mentionList', async () => {
    await expect(
      checkDirection(
        mentionList,
        { open: true, options: options.slice(0, 2), onSelect: () => {}, onClose: () => {} },
        '<root><list aria-label="提及智能体"><option value="a1">规划师</option><option value="a2">研究员</option></list></root>',
      ),
    ).rejects.toThrow(/ArrowRight changes nothing/);
  });

  it('manages textarea ARIA, wraps arrows, selects on Enter/Tab, closes on Escape, and exposes agent actions only when open', async () => {
    const onSelect = vi.fn();
    const activeIds = new Set(['a2']);

    function MentionHarness() {
      const [open, setOpen] = useState(false);
      const inputRef = useRef<HTMLTextAreaElement | null>(null);
      const handle = useMentionList(
        {
          open,
          options,
          onSelect: (agentId) => {
            onSelect(agentId);
            setOpen(false);
          },
          onClose: () => setOpen(false),
        },
        inputRef,
      );
      return createElement(
        'div',
        null,
        createElement('button', { type: 'button', onClick: () => setOpen(true) }, '打开提及'),
        createElement(MentionList, { handle, options, activeAgentIds: activeIds }),
        createElement(Textarea, {
          ref: inputRef,
          'aria-label': '消息输入',
          onKeyDown: (event) => handle.api.keydown(event.nativeEvent),
        }),
      );
    }

    await render(createElement(MentionHarness));
    const textarea = host.querySelector('textarea');
    const openBtn = host.querySelector('button');
    if (!textarea || !openBtn) throw new Error('missing textarea or open button');

    expect(textarea.hasAttribute('aria-autocomplete')).toBe(false);
    expect(textarea.hasAttribute('aria-controls')).toBe(false);
    expect(
      agent.snapshot().find((entry) => !entry.offPage && entry.component === 'mention-list'),
    ).toBeUndefined();

    await act(async () => openBtn.click());
    await flushUi();

    const listbox = host.querySelector<HTMLElement>('[role="listbox"]');
    if (!listbox) throw new Error('missing listbox');
    const optionEls = Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(optionEls).toHaveLength(3);

    expect(textarea.getAttribute('aria-autocomplete')).toBe('list');
    expect(textarea.getAttribute('aria-haspopup')).toBe('listbox');
    expect(textarea.getAttribute('aria-controls')).toBe(listbox.id);
    expect(textarea.getAttribute('aria-activedescendant')).toBe(optionEls[0]?.id);
    expect(optionEls[0]?.getAttribute('aria-selected')).toBe('true');

    await expect(runPattern(listbox, 'listbox')).rejects.toThrow(/has no tab stop/);

    textarea.focus();
    await dispatchKey(textarea, 'ArrowUp');
    expect(textarea.getAttribute('aria-activedescendant')).toBe(optionEls[2]?.id);
    expect(document.activeElement).toBe(textarea);

    await dispatchKey(textarea, 'ArrowDown');
    expect(textarea.getAttribute('aria-activedescendant')).toBe(optionEls[0]?.id);

    await dispatchKey(textarea, 'ArrowDown');
    expect(textarea.getAttribute('aria-activedescendant')).toBe(optionEls[1]?.id);
    await dispatchKey(textarea, 'Tab');
    expect(onSelect).toHaveBeenCalledWith('a2');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(textarea.hasAttribute('aria-autocomplete')).toBe(false);
    expect(textarea.hasAttribute('aria-activedescendant')).toBe(false);

    await act(async () => openBtn.click());
    await flushUi();
    textarea.focus();
    await dispatchKey(textarea, 'Enter');
    expect(onSelect).toHaveBeenCalledWith('a1');

    await act(async () => openBtn.click());
    await flushUi();
    textarea.focus();
    await dispatchKey(textarea, 'Escape');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(textarea.hasAttribute('aria-controls')).toBe(false);
    expect(document.activeElement).toBe(textarea);

    await act(async () => openBtn.click());
    await flushUi();
    const openEntry = agent
      .snapshot()
      .find((entry) => !entry.offPage && entry.component === 'mention-list');
    expect(openEntry).toMatchObject({
      component: 'mention-list',
      label: '提及智能体',
      actions: ['choose'],
      items: [
        { value: 'a1', label: '规划师' },
        { value: 'a2', label: '研究员' },
        { value: 'a3', label: '审校员' },
      ],
    });

    const actRes = await runAgentAct({
      steps: [{ ref: '提及智能体', action: 'choose', args: ['a3'] }],
    });
    expect(actRes.ok, actRes.error?.message).toBe(true);
    expect(onSelect).toHaveBeenCalledWith('a3');
  });
});

describe('Slider, PasswordInput, Rating, Meter, SegmentedControl, FileInput, and AlertDialog', () => {
  it('passes checkPattern slider, handles keyboard arrows/Home/End, and commits agent setValue', async () => {
    const onValueChange = vi.fn();
    const onValueCommit = vi.fn();
    await render(
      createElement(Slider, {
        'aria-label': '输出温度',
        defaultValue: 40,
        min: 0,
        max: 100,
        step: 10,
        onValueChange: (value, details) => onValueChange(value, details.source),
        onValueCommit: (value, details) => onValueCommit(value, details.source),
      }),
    );

    const sliderRoot = host.querySelector<HTMLElement>('[data-slot="slider"]');
    const thumbInput = host.querySelector<HTMLInputElement>('input[type="range"]');
    if (!sliderRoot || !thumbInput) throw new Error('missing slider elements');

    await runPattern(sliderRoot, 'slider');

    thumbInput.focus();
    await dispatchKey(thumbInput, 'ArrowRight');
    expect(thumbInput.value).toBe('50');
    await dispatchKey(thumbInput, 'End');
    expect(thumbInput.value).toBe('100');
    await dispatchKey(thumbInput, 'Home');
    expect(thumbInput.value).toBe('0');

    const result = await runAgentAct({
      steps: [{ ref: '输出温度', action: 'setValue', args: [70] }],
    });
    expect(result.ok, result.error?.message).toBe(true);
    expect(thumbInput.value).toBe('70');
    expect(onValueChange).toHaveBeenLastCalledWith(70, 'agent');
    expect(onValueCommit).toHaveBeenLastCalledWith(70, 'agent');
  });

  it('redacts PasswordInput value in agent snapshot even when password visibility is toggled on', async () => {
    await render(
      createElement(
        Field,
        null,
        createElement(FieldLabel, null, '访问密钥'),
        createElement(
          PasswordInput,
          null,
          createElement(PasswordInputControl),
          createElement(PasswordInputToggle),
        ),
      ),
    );

    const input = host.querySelector<HTMLInputElement>('input');
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="显示密码"]');
    if (!input || !toggle) throw new Error('missing password input or toggle');

    expect(input.type).toBe('password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    await typeIntoInput(input, 'secret-pass-99');

    let entry = agent
      .snapshot()
      .find((item) => !item.offPage && item.component === 'password-input');
    expect(entry).toMatchObject({
      label: '访问密钥',
      value: '[redacted]',
      visible: false,
    });

    await act(async () => toggle.click());
    await flushUi();

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(input.type).toBe('text');

    entry = agent.snapshot().find((item) => !item.offPage && item.component === 'password-input');
    expect(entry).toMatchObject({
      label: '访问密钥',
      value: '[redacted]',
      visible: true,
    });
  });

  it('supports Rating keyboard selection, readOnly img display, and agent setValue', async () => {
    const onValueChange = vi.fn();
    await render(
      createElement(
        'div',
        null,
        createElement(
          Rating,
          {
            'aria-label': '回答满意度',
            defaultValue: 2,
            deselectable: true,
            onValueChange,
          },
          createElement(RatingItem),
        ),
        createElement(Rating, {
          value: 4.2,
          readOnly: true,
          getValueLabel: (value, max) => `平均评分 ${value} / ${max}`,
        }),
      ),
    );

    const radiogroup = host.querySelector<HTMLElement>('[role="radiogroup"]');
    const readOnlyImg = host.querySelector<HTMLElement>('[role="img"]');
    if (!radiogroup || !readOnlyImg) throw new Error('missing rating elements');

    expect(readOnlyImg.getAttribute('aria-label')).toBe('平均评分 4.2 / 5');

    const radios = Array.from(radiogroup.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(radios).toHaveLength(5);
    expect(radios[1]?.getAttribute('aria-checked')).toBe('true');

    radios[1]?.focus();
    await dispatchKey(radios[1] as HTMLElement, 'ArrowRight');
    expect(radios[2]?.getAttribute('aria-checked')).toBe('true');
    expect(onValueChange).toHaveBeenCalledWith(3, expect.anything());

    await dispatchKey(radios[2] as HTMLElement, ' ');
    expect(onValueChange).toHaveBeenLastCalledWith(null, expect.anything());
    expect(radios.every((radio) => radio.getAttribute('aria-checked') === 'false')).toBe(true);

    const entry = agent
      .snapshot()
      .find((item) => !item.offPage && item.component === 'rating' && item.label === '回答满意度');
    expect(entry).toMatchObject({
      component: 'rating',
      label: '回答满意度',
      actions: ['setValue'],
    });

    const actResult = await runAgentAct({
      steps: [{ ref: '回答满意度', action: 'setValue', args: [5] }],
    });
    expect(actResult.ok, actResult.error?.message).toBe(true);
    expect(radios[4]?.getAttribute('aria-checked')).toBe('true');
  });

  it('renders Meter, SegmentedControl, and FileInput accessible names, state attributes, and file changes', async () => {
    const onSegmentChange = vi.fn();
    const onFileChange = vi.fn();
    await render(
      createElement(
        'div',
        null,
        createElement(
          Meter,
          { value: 68 },
          createElement(MeterLabel, null, '上下文占用'),
          createElement(MeterValue),
          createElement(MeterTrack, null, createElement(MeterIndicator)),
        ),
        createElement(
          SegmentedControl,
          {
            'aria-label': '视图模式',
            defaultValue: 'list',
            onValueChange: onSegmentChange,
          },
          createElement(SegmentedControlIndicator),
          createElement(SegmentedControlItem, { value: 'list' }, '列表'),
          createElement(SegmentedControlItem, { value: 'grid' }, '网格'),
        ),
        createElement(
          FileInput,
          { directory: true, onValueChange: onFileChange },
          createElement(FileInputTrigger, null, '上传目录'),
          createElement(
            FileInputList,
            { 'aria-label': '待上传文件' },
            createElement(FileInputItem, null, ({ file }) =>
              createElement('span', null, file.name),
            ),
          ),
        ),
      ),
    );

    const meter = host.querySelector<HTMLElement>('[role="meter"]');
    const meterIndicator = host.querySelector<HTMLElement>('[data-slot="meter-indicator"]');
    const meterValue = host.querySelector<HTMLElement>('[data-slot="meter-value"]');
    if (!meter || !meterIndicator || !meterValue) throw new Error('missing meter elements');
    const labelledBy = meter.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy ?? '')?.textContent).toBe('上下文占用');
    expect(meter.style.getPropertyValue('--meter-value')).toBe('68%');
    expect(meterIndicator.style.width).toBe('68%');
    expect(meterValue.textContent).toBe('68%');

    const segmented = host.querySelector<HTMLElement>('[role="radiogroup"]');
    if (!segmented) throw new Error('missing segmented control');
    await runPattern(segmented, 'radio-group');
    const indicator = segmented.querySelector<HTMLElement>(
      '[data-slot="segmented-control-indicator"]',
    );
    expect(indicator?.getAttribute('data-orientation')).toBe('horizontal');
    const segmentItems = Array.from(segmented.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(segmentItems[0]?.hasAttribute('data-checked')).toBe(true);
    expect(segmentItems[1]?.hasAttribute('data-unchecked')).toBe(true);

    await act(async () => segmentItems[1]?.click());
    await flushUi();
    expect(onSegmentChange).toHaveBeenCalledWith('grid', expect.anything());
    expect(segmentItems[1]?.hasAttribute('data-checked')).toBe(true);
    expect(segmentItems[0]?.hasAttribute('data-checked')).toBe(false);

    segmentItems[1]?.focus();
    await dispatchKey(segmentItems[1] as HTMLElement, 'ArrowLeft');
    expect(onSegmentChange).toHaveBeenLastCalledWith('list', expect.anything());
    expect(segmentItems[0]?.hasAttribute('data-checked')).toBe(true);

    const trigger = host.querySelector<HTMLButtonElement>('[data-slot="file-input-trigger"]');
    const fileInputEl = host.querySelector<HTMLInputElement>('input[type="file"]');
    if (!trigger || !fileInputEl) throw new Error('missing file input elements');
    expect(trigger.textContent).toBe('上传目录');
    expect(fileInputEl.hasAttribute('webkitdirectory')).toBe(true);
    expect(fileInputEl.hasAttribute('multiple')).toBe(true);

    const sample = new File(['hello'], 'readme.md', { type: 'text/markdown' });
    Object.defineProperty(fileInputEl, 'files', { value: [sample], configurable: true });
    await act(async () => {
      fileInputEl.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
    });

    expect(onFileChange).toHaveBeenCalledTimes(1);
    expect(onFileChange.mock.calls[0]?.[0]).toEqual([sample]);
    expect(host.querySelector('[data-slot="file-input-item"]')?.textContent).toContain('readme.md');
  });

  it('passes checkPattern alertdialog and enforces data-agent-confirm via allow flag', async () => {
    const onConfirm = vi.fn(async () => {});
    function DialogHarness({
      onTriggerConfirm,
    }: {
      onTriggerConfirm: ComponentProps<typeof ConfirmDialog>['onConfirm'];
    }) {
      const [open, setOpen] = useState(false);
      return createElement(
        'div',
        null,
        createElement(
          AlertDialog,
          null,
          createElement(AlertDialogTrigger, null, '打开确认弹窗'),
          createElement(AlertDialogBackdrop),
          createElement(
            AlertDialogContent,
            null,
            createElement(
              AlertDialogHeader,
              null,
              createElement(AlertDialogTitle, null, '确认删除资源'),
            ),
            createElement(AlertDialogDescription, null, '删除后无法恢复'),
            createElement(
              AlertDialogFooter,
              null,
              createElement(AlertDialogClose, null, '取消'),
              createElement(
                AlertDialogClose,
                {
                  value: 'confirm',
                  'data-agent-confirm': '永久删除资源',
                  onClick: () => void onTriggerConfirm(),
                },
                '彻底删除',
              ),
            ),
          ),
        ),
        createElement('button', { type: 'button', onClick: () => setOpen(true) }, '显示业务弹窗'),
        open
          ? createElement(ConfirmDialog, {
              open,
              onClose: () => setOpen(false),
              title: '删除知识库',
              description: '删除后知识库内容不可恢复',
              confirmLabel: '确认删除知识库',
              onConfirm,
            })
          : null,
      );
    }

    await render(createElement(DialogHarness, { onTriggerConfirm: onConfirm }));
    const trigger = Array.from(host.querySelectorAll('button')).find(
      (btn) => btn.textContent === '打开确认弹窗',
    );
    if (!trigger) throw new Error('missing alert dialog trigger');

    await act(async () => trigger.click());
    await flushUi();
    const alertDialogEl = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
    if (!alertDialogEl) throw new Error('missing alertdialog element');
    await runPattern(alertDialogEl, 'alertdialog');

    const reopenedDialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
    const closeBtn = Array.from(reopenedDialog?.querySelectorAll('button') ?? []).find(
      (btn) => btn.textContent === '取消',
    );
    await act(async () => closeBtn?.click());
    await flushUi();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();

    const step = {
      steps: [{ ref: '打开确认弹窗', action: 'press', args: ['彻底删除'] }],
    };
    const denied = await runAgentAct(step);
    expect(denied.ok).toBe(false);
    expect(denied.error?.message).toContain('永久删除资源');
    expect(onConfirm).not.toHaveBeenCalled();

    approve = true;
    const allowed = await runAgentAct(step);
    expect(allowed.ok, allowed.error?.message).toBe(true);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    const openConfirmBtn = Array.from(host.querySelectorAll('button')).find(
      (btn) => btn.textContent === '显示业务弹窗',
    );
    await act(async () => openConfirmBtn?.click());
    await flushUi();

    const businessDialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
    if (!businessDialog) throw new Error('missing ConfirmDialog alertdialog');
    await runPattern(businessDialog, 'alertdialog');
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();

    await act(async () => openConfirmBtn?.click());
    await flushUi();

    approve = false;
    const deniedBusiness = await runAgentAct({
      steps: [{ ref: '确认删除知识库', action: 'press' }],
    });
    expect(deniedBusiness.ok).toBe(false);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    approve = true;
    const allowedBusiness = await runAgentAct({
      steps: [{ ref: '确认删除知识库', action: 'press' }],
    });
    expect(allowedBusiness.ok, allowedBusiness.error?.message).toBe(true);
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});

describe('NumberInput primitive, Field integration, and agent', () => {
  it('defaults format to useGrouping false, preserves data-slot names, and wires FieldLabel and step buttons', async () => {
    await render(
      createElement(
        'div',
        null,
        createElement(
          Field,
          null,
          createElement(FieldLabel, null, '超时毫秒'),
          createElement(
            NumberInput,
            {
              defaultValue: 30000,
              min: 1000,
              max: 60000,
              step: 500,
              className: (state) => (state.disabled ? 'is-disabled' : 'is-ready'),
            },
            createElement(
              NumberInputGroup,
              null,
              createElement(NumberInputDecrement),
              createElement(NumberInputControl),
              createElement(NumberInputIncrement),
            ),
          ),
        ),
        createElement(
          Field,
          { invalid: true },
          createElement(FieldLabel, null, '千分位数值'),
          createElement(
            NumberInput,
            {
              defaultValue: 30000,
              format: { useGrouping: true },
            },
            createElement(
              NumberInputGroup,
              null,
              createElement(NumberInputControl),
              createElement(NumberInputDecrement, { 'aria-label': '下调' }, '-'),
              createElement(NumberInputIncrement, { 'aria-label': '上调' }, '+'),
            ),
          ),
        ),
      ),
    );

    const roots = Array.from(host.querySelectorAll<HTMLElement>('[data-slot="number-input"]'));
    const groups = Array.from(
      host.querySelectorAll<HTMLElement>('[data-slot="number-input-group"]'),
    );
    const controls = Array.from(
      host.querySelectorAll<HTMLInputElement>('[data-slot="number-input-control"]'),
    );
    const decrements = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[data-slot="number-input-decrement"]'),
    );
    const increments = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[data-slot="number-input-increment"]'),
    );
    const labels = Array.from(host.querySelectorAll<HTMLLabelElement>('label'));

    expect(roots).toHaveLength(2);
    expect(groups).toHaveLength(2);
    expect(controls).toHaveLength(2);
    expect(decrements).toHaveLength(2);
    expect(increments).toHaveLength(2);

    const [firstRoot, secondRoot] = roots;
    const [firstControl, secondControl] = controls;
    const [firstDec, secondDec] = decrements;
    const [firstInc, secondInc] = increments;
    const [firstLabel] = labels;
    if (
      !firstRoot ||
      !secondRoot ||
      !firstControl ||
      !secondControl ||
      !firstDec ||
      !secondDec ||
      !firstInc ||
      !secondInc ||
      !firstLabel
    ) {
      throw new Error('missing number input elements');
    }

    expect(firstRoot.className).toContain('is-ready');
    expect(firstControl.value).toBe('30000');
    expect(secondControl.value).toBe('30,000');
    expect(secondControl.getAttribute('aria-invalid')).toBe('true');

    expect(firstLabel.htmlFor).toBe(firstControl.id);
    expect(firstControl.getAttribute('aria-labelledby')).toContain(firstLabel.id);

    expect(firstDec.getAttribute('aria-label')).toBe('减少');
    expect(firstInc.getAttribute('aria-label')).toBe('增加');
    expect(firstDec.tabIndex).toBe(-1);
    expect(firstInc.tabIndex).toBe(-1);
    expect(firstDec.getAttribute('aria-controls')).toBe(firstControl.id);
    expect(firstInc.getAttribute('aria-controls')).toBe(firstControl.id);
    expect(firstDec.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(firstInc.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

    expect(secondDec.getAttribute('aria-label')).toBe('下调');
    expect(secondDec.textContent).toBe('-');
    expect(secondInc.getAttribute('aria-label')).toBe('上调');
    expect(secondInc.textContent).toBe('+');
  });

  it('handles ArrowUp, ArrowDown, Home, End, step buttons, clamping on Enter/blur, and empty null', async () => {
    const onValueChange = vi.fn();
    const onValueCommit = vi.fn();

    await render(
      createElement(
        Field,
        null,
        createElement(FieldLabel, null, '重试次数'),
        createElement(
          NumberInput,
          {
            defaultValue: 4,
            min: 0,
            max: 10,
            step: 2,
            onValueChange: (value, details) => onValueChange(value, details.reason),
            onValueCommit: (value, details) => onValueCommit(value, details.reason),
          },
          createElement(
            NumberInputGroup,
            null,
            createElement(NumberInputDecrement),
            createElement(NumberInputControl),
            createElement(NumberInputIncrement),
          ),
        ),
      ),
    );

    const control = host.querySelector<HTMLInputElement>('[data-slot="number-input-control"]');
    const decrement = host.querySelector<HTMLButtonElement>('[data-slot="number-input-decrement"]');
    const increment = host.querySelector<HTMLButtonElement>('[data-slot="number-input-increment"]');
    if (!control || !decrement || !increment) throw new Error('missing number input controls');

    expect(control.value).toBe('4');

    await act(async () => {
      increment.click();
      await settle();
    });
    expect(control.value).toBe('6');
    expect(onValueCommit).toHaveBeenLastCalledWith(6, 'increment-press');

    await act(async () => {
      decrement.click();
      await settle();
    });
    expect(control.value).toBe('4');
    expect(onValueCommit).toHaveBeenLastCalledWith(4, 'decrement-press');

    await act(async () => {
      control.focus();
      await settle();
    });
    await dispatchKey(control, 'ArrowUp');
    expect(control.value).toBe('6');
    expect(onValueChange).toHaveBeenLastCalledWith(6, 'step-key');
    expect(onValueCommit).toHaveBeenLastCalledWith(6, 'step-key');

    await dispatchKey(control, 'ArrowDown');
    expect(control.value).toBe('4');

    await dispatchKey(control, 'End');
    expect(control.value).toBe('10');
    expect(increment.hasAttribute('data-at-bound')).toBe(true);
    expect(increment.disabled).toBe(true);

    await dispatchKey(control, 'Home');
    expect(control.value).toBe('0');
    expect(decrement.hasAttribute('data-at-bound')).toBe(true);
    expect(decrement.disabled).toBe(true);

    await typeIntoInput(control, '99');
    await dispatchKey(control, 'Enter');
    expect(control.value).toBe('10');
    expect(onValueCommit).toHaveBeenLastCalledWith(10, 'input-commit');

    await typeIntoInput(control, '-5');
    await act(async () => {
      control.blur();
      await settle();
    });
    expect(control.value).toBe('0');
    expect(onValueCommit).toHaveBeenLastCalledWith(0, 'input-commit');

    await typeIntoInput(control, '');
    await act(async () => {
      control.blur();
      await settle();
    });
    expect(control.value).toBe('');
    expect(onValueChange).toHaveBeenLastCalledWith(null, 'input-change');
    expect(onValueCommit).toHaveBeenLastCalledWith(null, 'input-change');
  });

  it('exposes number-input actions in agent.snapshot and commits setValue with source agent', async () => {
    const onValueChange = vi.fn();
    const onValueCommit = vi.fn();

    await render(
      createElement(
        Field,
        null,
        createElement(FieldLabel, null, '并发数'),
        createElement(
          NumberInput,
          {
            defaultValue: 4,
            min: 1,
            max: 16,
            step: 1,
            onValueChange: (value, details) => onValueChange(value, details.source),
            onValueCommit: (value, details) => onValueCommit(value, details.source),
          },
          createElement(
            NumberInputGroup,
            null,
            createElement(NumberInputDecrement),
            createElement(NumberInputControl),
            createElement(NumberInputIncrement),
          ),
        ),
      ),
    );

    const control = host.querySelector<HTMLInputElement>('[data-slot="number-input-control"]');
    if (!control) throw new Error('missing number input control');

    const entry = agent
      .snapshot()
      .find(
        (item) => !item.offPage && item.component === 'number-input' && item.label === '并发数',
      );
    expect(entry).toMatchObject({
      component: 'number-input',
      label: '并发数',
      value: 4,
      min: 1,
      max: 16,
      step: 1,
      actions: expect.arrayContaining(['setValue', 'increment', 'decrement']),
    });

    const result = await runAgentAct({
      steps: [{ ref: '并发数', action: 'setValue', args: [12] }],
    });
    expect(result.ok, result.error?.message).toBe(true);
    expect(control.value).toBe('12');
    expect(onValueChange).toHaveBeenLastCalledWith(12, 'agent');
    expect(onValueCommit).toHaveBeenLastCalledWith(12, 'agent');
  });
});
