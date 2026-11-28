import { checkPattern, settle } from '@ui-sdk/core/testing';
import { createAgent } from '@ui-sdk/react/agent';
import { createMenuController } from '@ui-sdk/react/menu';
import { createTooltipController } from '@ui-sdk/react/tooltip';
import { act, createElement, type ReactElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterSelect } from '../src/components/filter-select.js';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../src/components/ui/accordion.js';
import {
  Autocomplete,
  AutocompleteClear,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteItemText,
  AutocompleteLabel,
  AutocompleteList,
  AutocompleteTrigger,
} from '../src/components/ui/autocomplete.js';
import { Button } from '../src/components/ui/button.js';
import { Calendar } from '../src/components/ui/calendar.js';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  CarouselViewport,
} from '../src/components/ui/carousel.js';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '../src/components/ui/combobox.js';
import { DateInput } from '../src/components/ui/date-input.js';
import { DatePicker } from '../src/components/ui/date-picker.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../src/components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../src/components/ui/dropdown-menu.js';
import { Field, FieldLabel } from '../src/components/ui/field.js';
import { Listbox, ListboxItem, ListboxItemIndicator } from '../src/components/ui/listbox.js';
import { Popover, PopoverContent, PopoverTrigger } from '../src/components/ui/popover.js';
import {
  Progress,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
  ProgressValue,
} from '../src/components/ui/progress.js';
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaCorner,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from '../src/components/ui/scroll-area.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../src/components/ui/select.js';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '../src/components/ui/sheet.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../src/components/ui/tabs.js';
import { TimeInput } from '../src/components/ui/time-input.js';
import {
  createTimelineController,
  Timeline,
  TimelineConnector,
  TimelineDescription,
  TimelineItem,
  TimelineMarker,
  TimelineTime,
  TimelineTitle,
} from '../src/components/ui/timeline.js';
import { Toggle } from '../src/components/ui/toggle.js';
import { ToggleGroup, ToggleGroupItem } from '../src/components/ui/toggle-group.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../src/components/ui/tooltip.js';
import { type ListView, ViewToggle } from '../src/components/view-toggle.js';

const agent = createAgent();

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class MockResizeObserver {
      private callback: ResizeObserverCallback;
      private observed = new Set<Element>();
      private queued = false;
      private active = true;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe(target: Element) {
        if (!this.active || this.observed.has(target)) return;
        this.observed.add(target);
        if (this.queued) return;
        this.queued = true;
        queueMicrotask(() => {
          this.queued = false;
          if (!this.active || this.observed.size === 0) return;
          const entries = Array.from(this.observed)
            .filter((el) => el.isConnected)
            .map((el) => {
              const width = (el as HTMLElement).clientWidth || 300;
              const height = (el as HTMLElement).clientHeight || 120;
              const rect = {
                x: 0,
                y: 0,
                width,
                height,
                top: 0,
                left: 0,
                bottom: height,
                right: width,
                toJSON: () => ({}),
              } as DOMRectReadOnly;
              return {
                target: el,
                contentRect: rect,
                borderBoxSize: [{ inlineSize: width, blockSize: height }],
                contentBoxSize: [{ inlineSize: width, blockSize: height }],
                devicePixelContentBoxSize: [{ inlineSize: width, blockSize: height }],
              } as ResizeObserverEntry;
            });
          if (entries.length > 0) {
            this.callback(entries, this);
          }
        });
      }

      unobserve(target: Element) {
        this.observed.delete(target);
      }

      disconnect() {
        this.active = false;
        this.observed.clear();
      }
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = '';
      thresholds = [];
    },
  );
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await settle();
  });
  host.remove();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
});

async function render(element: ReactElement) {
  await act(async () => root.render(element));
  await flushUi();
}

async function flushUi() {
  await act(async () => {
    await settle();
  });
}

async function focusElement(element: HTMLElement) {
  await act(async () => {
    element.focus();
    await settle();
  });
}

async function dispatchKey(element: HTMLElement, key: string, init?: KeyboardEventInit) {
  await act(async () => {
    const proceeds = element.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
    element.dispatchEvent(
      new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, ...init }),
    );
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

async function typeSegmentText(element: HTMLInputElement, text: string) {
  await act(async () => {
    element.focus();
    for (const char of text) {
      const proceeds = element.dispatchEvent(
        new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true }),
      );
      if (proceeds) {
        element.dispatchEvent(
          new InputEvent('beforeinput', {
            data: char,
            inputType: 'insertText',
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      element.dispatchEvent(
        new KeyboardEvent('keyup', { key: char, bubbles: true, cancelable: true }),
      );
    }
    await settle();
  });
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

async function clickElement(element: HTMLElement) {
  await act(async () => {
    element.click();
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

function visibleSnapshot() {
  return agent
    .snapshot()
    .filter(
      (entry) => !entry.offPage && entry.component !== 'closed' && entry.component !== 'more',
    );
}

describe('Wave 3 native primitives', () => {
  it('Autocomplete filters suggestions on typing, selects with ArrowDown + Enter, closes on Escape, and works via agent', async () => {
    const onValueChange = vi.fn();
    const fruits = ['Apple', 'Apricot', 'Banana', 'Mango'];

    await render(
      createElement(
        Autocomplete,
        {
          onValueChange: (value, details) => onValueChange(value, details.source),
        },
        createElement(AutocompleteLabel, null, '推荐水果'),
        createElement(AutocompleteInput, { placeholder: '输入水果' }),
        createElement(AutocompleteClear),
        createElement(AutocompleteTrigger),
        createElement(
          AutocompleteContent,
          null,
          createElement(AutocompleteEmpty, null, '无匹配水果'),
          createElement(
            AutocompleteList,
            null,
            fruits.map((fruit) =>
              createElement(
                AutocompleteItem,
                { key: fruit, value: fruit },
                createElement(AutocompleteItemText),
              ),
            ),
          ),
        ),
      ),
    );

    const input = host.querySelector<HTMLInputElement>('[data-slot="autocomplete-input"]');
    if (!input) throw new Error('missing autocomplete input');

    await typeIntoInput(input, 'ap');
    const content = document.body.querySelector<HTMLElement>('[data-slot="autocomplete-content"]');
    expect(content?.hasAttribute('data-open')).toBe(true);
    const filteredItems = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-slot="autocomplete-item"]'),
    ).filter((item) => !item.hidden);
    expect(filteredItems.map((item) => item.textContent)).toEqual(['Apple', 'Apricot']);

    await dispatchKey(input, 'ArrowDown');
    expect(filteredItems[0]?.hasAttribute('data-highlighted')).toBe(true);
    await dispatchKey(input, 'Enter');
    expect(input.value).toBe('Apple');
    expect(onValueChange).toHaveBeenLastCalledWith('Apple', expect.any(String));
    expect(
      document.body.querySelector('[data-slot="autocomplete-content"]')?.hasAttribute('data-open'),
    ).not.toBe(true);

    await typeIntoInput(input, 'ba');
    expect(
      document.body.querySelector('[data-slot="autocomplete-content"]')?.hasAttribute('data-open'),
    ).toBe(true);
    await dispatchKey(input, 'Escape');
    expect(
      document.body.querySelector('[data-slot="autocomplete-content"]')?.hasAttribute('data-open'),
    ).not.toBe(true);
    expect(input.value).toBe('ba');

    const entry = visibleSnapshot().find(
      (item) => item.component === 'autocomplete' && item.label === '推荐水果',
    );
    expect(entry).toMatchObject({
      component: 'autocomplete',
      label: '推荐水果',
      actions: expect.arrayContaining(['setValue', 'clear']),
    });

    const actResult = await runAgentAct({
      steps: [{ ref: '推荐水果', action: 'setValue', args: ['Mango'] }],
    });
    expect(actResult.ok, actResult.error?.message).toBe(true);
    expect(input.value).toBe('Mango');
    expect(onValueChange).toHaveBeenLastCalledWith('Mango', 'agent');
  });

  it('DatePicker supports single mode popup selection, clear reset, Escape focus restoration, and agent actions', async () => {
    const onValueChange = vi.fn();

    await render(
      createElement(
        Field,
        null,
        createElement(FieldLabel, null, '截止日期'),
        createElement(DatePicker, {
          defaultValue: '2026-10-16',
          defaultMonth: '2026-10',
          onValueChange: (value, details) => onValueChange(value, details.source),
        }),
      ),
    );

    const input = host.querySelector<HTMLInputElement>('[data-slot="date-picker-input"]');
    const trigger = host.querySelector<HTMLButtonElement>('[data-slot="date-picker-trigger"]');
    const clearButton = host.querySelector<HTMLButtonElement>('[data-slot="date-picker-clear"]');
    if (!input || !trigger || !clearButton) throw new Error('missing single DatePicker parts');

    await clickElement(trigger);
    const content = document.body.querySelector<HTMLElement>('[data-slot="date-picker-content"]');
    expect(content?.hasAttribute('data-open')).toBe(true);

    const day20 = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[data-slot="calendar-day"]'),
    ).find((day) => day.textContent === '20' && !day.hasAttribute('data-outside'));
    if (!day20) throw new Error('missing day 20 button');
    await clickElement(day20);

    expect(onValueChange).toHaveBeenLastCalledWith('2026-10-20', expect.any(String));
    expect(input.value).not.toBe('');
    expect(
      document.body.querySelector('[data-slot="date-picker-content"]')?.hasAttribute('data-open'),
    ).not.toBe(true);

    await clickElement(clearButton);
    expect(onValueChange).toHaveBeenLastCalledWith(null, expect.any(String));
    expect(input.value).toBe('');
    expect(clearButton.hasAttribute('data-empty')).toBe(true);

    await focusElement(trigger);
    await clickElement(trigger);
    expect(
      document.body.querySelector('[data-slot="date-picker-content"]')?.hasAttribute('data-open'),
    ).toBe(true);
    const activeTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : trigger;
    await dispatchKey(activeTarget, 'Escape');
    expect(
      document.body.querySelector('[data-slot="date-picker-content"]')?.hasAttribute('data-open'),
    ).not.toBe(true);
    expect(document.activeElement).toBe(trigger);

    const entry = visibleSnapshot().find(
      (item) => item.component === 'date-picker' && item.label === '截止日期',
    );
    expect(entry).toMatchObject({
      component: 'date-picker',
      label: '截止日期',
      actions: expect.arrayContaining(['setValue', 'clear']),
    });

    const actResult = await runAgentAct({
      steps: [{ ref: '截止日期', action: 'setValue', args: ['2026-11-05'] }],
    });
    expect(actResult.ok, actResult.error?.message).toBe(true);
    expect(onValueChange).toHaveBeenLastCalledWith('2026-11-05', 'agent');
  });

  it('DatePicker supports range mode selection and clearing', async () => {
    const onValueChange = vi.fn();

    await render(
      createElement(
        Field,
        null,
        createElement(FieldLabel, null, '行程日期'),
        createElement(DatePicker, {
          mode: 'range',
          defaultMonth: '2026-10',
          onValueChange: (value, details) => onValueChange(value, details.source),
        }),
      ),
    );

    const inputs = Array.from(
      host.querySelectorAll<HTMLInputElement>('[data-slot="date-picker-input"]'),
    );
    const trigger = host.querySelector<HTMLButtonElement>('[data-slot="date-picker-trigger"]');
    const clearButton = host.querySelector<HTMLButtonElement>('[data-slot="date-picker-clear"]');
    if (inputs.length !== 2 || !trigger || !clearButton) {
      throw new Error('missing range DatePicker parts');
    }

    await clickElement(trigger);
    const pickDay = (label: string) => {
      const btn = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('[data-slot="calendar-day"]'),
      ).find((day) => day.textContent === label && !day.hasAttribute('data-outside'));
      if (!btn) throw new Error(`missing range day ${label}`);
      return btn;
    };

    await clickElement(pickDay('12'));
    expect(
      document.body.querySelector('[data-slot="date-picker-content"]')?.hasAttribute('data-open'),
    ).toBe(true);

    await clickElement(pickDay('18'));
    expect(onValueChange).toHaveBeenLastCalledWith(
      ['2026-10-12', '2026-10-18'],
      expect.any(String),
    );
    expect(inputs[0]?.value).not.toBe('');
    expect(inputs[1]?.value).not.toBe('');
    expect(
      document.body.querySelector('[data-slot="date-picker-content"]')?.hasAttribute('data-open'),
    ).not.toBe(true);

    await clickElement(clearButton);
    expect(onValueChange).toHaveBeenLastCalledWith(null, expect.any(String));
    expect(inputs[0]?.value).toBe('');
    expect(inputs[1]?.value).toBe('');
  });

  it('TimeInput binds Field + FieldLabel, updates via ArrowUp/ArrowDown and typing, and supports agent setValue', async () => {
    const onValueChange = vi.fn();

    await render(
      createElement(
        Field,
        null,
        createElement(FieldLabel, null, '会议时间'),
        createElement(TimeInput, {
          hourCycle: 24,
          defaultValue: '09:30',
          onValueChange: (value, details) => onValueChange(value, details.source),
        }),
      ),
    );

    const group = host.querySelector<HTMLElement>('[data-slot="time-input"]');
    const label = host.querySelector<HTMLElement>('[data-slot="field-label"]');
    const hourSegment = host.querySelector<HTMLInputElement>(
      '[data-slot="time-input-segment"][data-type="hour"]',
    );
    const minuteSegment = host.querySelector<HTMLInputElement>(
      '[data-slot="time-input-segment"][data-type="minute"]',
    );
    if (!group || !label || !hourSegment || !minuteSegment) {
      throw new Error('missing TimeInput parts');
    }

    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-labelledby')).toBe(label.id);

    await focusElement(hourSegment);
    await dispatchKey(hourSegment, 'ArrowUp');
    expect(onValueChange).toHaveBeenLastCalledWith('10:30', expect.any(String));

    await dispatchKey(hourSegment, 'ArrowDown');
    expect(onValueChange).toHaveBeenLastCalledWith('09:30', expect.any(String));

    await typeSegmentText(minuteSegment, '45');
    expect(onValueChange).toHaveBeenLastCalledWith('09:45', expect.any(String));

    const entry = visibleSnapshot().find(
      (item) => item.component === 'time-input' && item.label === '会议时间',
    );
    expect(entry).toMatchObject({
      component: 'time-input',
      label: '会议时间',
      value: '09:45',
      actions: expect.arrayContaining(['setValue', 'clear']),
    });

    const actResult = await runAgentAct({
      steps: [{ ref: '会议时间', action: 'setValue', args: ['14:20'] }],
    });
    expect(actResult.ok, actResult.error?.message).toBe(true);
    expect(onValueChange).toHaveBeenLastCalledWith('14:20', 'agent');
    expect(hourSegment.value).toBe('14');
    expect(minuteSegment.value).toBe('20');
  });

  it('DateInput binds Field + FieldLabel, edits segments with keyboard, and supports agent setValue', async () => {
    const onValueChange = vi.fn();

    await render(
      createElement(
        Field,
        null,
        createElement(FieldLabel, null, '生效日期'),
        createElement(DateInput, {
          locale: 'en-US',
          defaultValue: '2026-05-15',
          onValueChange: (value, details) => onValueChange(value, details.source),
        }),
      ),
    );

    const group = host.querySelector<HTMLElement>('[data-slot="date-input"]');
    const label = host.querySelector<HTMLElement>('[data-slot="field-label"]');
    const daySegment = host.querySelector<HTMLInputElement>(
      '[data-slot="date-input-segment"][data-type="day"]',
    );
    const monthSegment = host.querySelector<HTMLInputElement>(
      '[data-slot="date-input-segment"][data-type="month"]',
    );
    if (!group || !label || !daySegment || !monthSegment) {
      throw new Error('missing DateInput parts');
    }

    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-labelledby')).toBe(label.id);

    await focusElement(daySegment);
    await dispatchKey(daySegment, 'ArrowUp');
    expect(onValueChange).toHaveBeenLastCalledWith('2026-05-16', expect.any(String));

    await typeSegmentText(monthSegment, '11');
    expect(onValueChange).toHaveBeenLastCalledWith('2026-11-16', expect.any(String));

    const entry = visibleSnapshot().find(
      (item) => item.component === 'date-input' && item.label === '生效日期',
    );
    expect(entry).toMatchObject({
      component: 'date-input',
      label: '生效日期',
      value: '2026-11-16',
      actions: expect.arrayContaining(['setValue', 'clear']),
    });

    const actResult = await runAgentAct({
      steps: [{ ref: '生效日期', action: 'setValue', args: ['2026-12-25'] }],
    });
    expect(actResult.ok, actResult.error?.message).toBe(true);
    expect(onValueChange).toHaveBeenLastCalledWith('2026-12-25', 'agent');
    expect(monthSegment.value).toBe('12');
    expect(daySegment.value).toBe('25');
  });

  it('Listbox supports single and multiple selection, ArrowDown/Space/Enter, checkPattern, and agent actions', async () => {
    const onSingleChange = vi.fn();
    const onMultipleChange = vi.fn();

    await render(
      createElement(
        'div',
        null,
        createElement(
          Listbox,
          {
            'aria-label': '排序方式',
            activation: 'manual',
            defaultValue: 'newest',
            onValueChange: (value, details) => onSingleChange(value, details.source),
          },
          createElement(
            ListboxItem,
            { value: 'newest' },
            '最新',
            createElement(ListboxItemIndicator),
          ),
          createElement(
            ListboxItem,
            { value: 'popular' },
            '最热',
            createElement(ListboxItemIndicator),
          ),
          createElement(
            ListboxItem,
            { value: 'name' },
            '名称',
            createElement(ListboxItemIndicator),
          ),
        ),
        createElement(
          Listbox<string, true>,
          {
            'aria-label': '通知渠道',
            multiple: true,
            defaultValue: ['email'],
            onValueChange: (value, details) => onMultipleChange(value, details.source),
          },
          createElement(
            ListboxItem,
            { value: 'email' },
            '邮件',
            createElement(ListboxItemIndicator),
          ),
          createElement(ListboxItem, { value: 'sms' }, '短信', createElement(ListboxItemIndicator)),
          createElement(
            ListboxItem,
            { value: 'push' },
            '推送',
            createElement(ListboxItemIndicator),
          ),
        ),
      ),
    );

    const listboxes = Array.from(host.querySelectorAll<HTMLElement>('[data-slot="listbox"]'));
    const singleBox = listboxes[0];
    const multiBox = listboxes[1];
    if (!singleBox || !multiBox) throw new Error('missing listbox elements');

    await runPattern(singleBox, 'listbox');

    const singleItems = Array.from(singleBox.querySelectorAll<HTMLElement>('[role="option"]'));
    await focusElement(singleItems[0] as HTMLElement);
    await dispatchKey(singleItems[0] as HTMLElement, 'ArrowDown');
    await dispatchKey(singleItems[1] as HTMLElement, ' ');
    expect(onSingleChange).toHaveBeenLastCalledWith('popular', expect.any(String));

    await dispatchKey(singleItems[1] as HTMLElement, 'ArrowDown');
    await dispatchKey(singleItems[2] as HTMLElement, 'Enter');
    expect(onSingleChange).toHaveBeenLastCalledWith('name', expect.any(String));

    const multiItems = Array.from(multiBox.querySelectorAll<HTMLElement>('[role="option"]'));
    await focusElement(multiItems[0] as HTMLElement);
    await dispatchKey(multiItems[0] as HTMLElement, 'ArrowDown');
    await dispatchKey(multiItems[1] as HTMLElement, ' ');
    expect(onMultipleChange).toHaveBeenLastCalledWith(['email', 'sms'], expect.any(String));

    await dispatchKey(multiItems[1] as HTMLElement, 'ArrowDown');
    await dispatchKey(multiItems[2] as HTMLElement, 'Enter');
    expect(onMultipleChange).toHaveBeenLastCalledWith(['email', 'sms', 'push'], expect.any(String));

    const singleEntry = visibleSnapshot().find(
      (item) => item.component === 'listbox' && item.label === '排序方式',
    );
    expect(singleEntry).toMatchObject({
      component: 'listbox',
      label: '排序方式',
      actions: expect.arrayContaining(['setValue']),
    });

    const actResult = await runAgentAct({
      steps: [
        { ref: '排序方式', action: 'setValue', args: ['newest'] },
        { ref: '通知渠道', action: 'setValue', args: [['email', 'push']] },
      ],
    });
    expect(actResult.ok, actResult.error?.message).toBe(true);
    expect(onSingleChange).toHaveBeenLastCalledWith('newest', 'agent');
    expect(onMultipleChange).toHaveBeenLastCalledWith(['email', 'push'], 'agent');
  });

  it('Timeline renders semantic list/listitem slots, time, status attributes, and supports roving focus', async () => {
    const controller = createTimelineController();

    await render(
      createElement(
        Timeline,
        { 'aria-label': '发布阶段', controller, render: createElement('ol') },
        createElement(
          TimelineItem,
          { value: 'build', status: 'complete', render: createElement('li') },
          createElement(TimelineMarker),
          createElement(TimelineConnector),
          createElement(TimelineTitle, null, '构建镜像'),
          createElement(TimelineTime, { dateTime: '2026-10-01T10:00' }, '10:00'),
          createElement(TimelineDescription, null, '镜像构建完成'),
        ),
        createElement(
          TimelineItem,
          { value: 'deploy', status: 'current', render: createElement('li') },
          createElement(TimelineMarker),
          createElement(TimelineConnector),
          createElement(TimelineTitle, null, '灰度发布'),
          createElement(TimelineTime, { dateTime: '2026-10-01T10:10' }, '10:10'),
          createElement(TimelineDescription, null, '正在部署至生产集群'),
        ),
        createElement(
          TimelineItem,
          { value: 'verify', status: 'upcoming', render: createElement('li') },
          createElement(TimelineMarker),
          createElement(TimelineTitle, null, '健康检查'),
          createElement(TimelineTime, { dateTime: '2026-10-01T10:20' }, '10:20'),
        ),
      ),
    );

    const timelineEl = host.querySelector<HTMLElement>('[data-slot="timeline"]');
    const items = Array.from(host.querySelectorAll<HTMLElement>('[data-slot="timeline-item"]'));
    const markers = Array.from(host.querySelectorAll<HTMLElement>('[data-slot="timeline-marker"]'));
    const times = Array.from(host.querySelectorAll<HTMLElement>('[data-slot="timeline-time"]'));
    if (!timelineEl) throw new Error('missing timeline element');

    expect(timelineEl.tagName).toBe('OL');
    expect(timelineEl.getAttribute('role')).toBe('list');
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.tagName === 'LI')).toBe(true);
    expect(markers).toHaveLength(3);
    expect(times).toHaveLength(3);
    expect(times[0]?.tagName).toBe('TIME');
    expect(times[0]?.getAttribute('datetime')).toBe('2026-10-01T10:00');
    expect(host.querySelectorAll('[data-slot="timeline-title"]')).toHaveLength(3);
    expect(host.querySelectorAll('[data-slot="timeline-description"]')).toHaveLength(2);
    expect(host.querySelectorAll('[data-slot="timeline-connector"]')).toHaveLength(2);

    expect(items[0]?.hasAttribute('data-complete')).toBe(true);
    expect(items[1]?.hasAttribute('data-current')).toBe(true);
    expect(items[1]?.getAttribute('aria-current')).toBe('step');
    expect(items[2]?.hasAttribute('data-upcoming')).toBe(true);
    expect(markers[0]?.hasAttribute('data-complete')).toBe(true);
    expect(markers[1]?.hasAttribute('data-current')).toBe(true);
    expect(times[2]?.hasAttribute('data-upcoming')).toBe(true);

    await focusElement(items[1] as HTMLElement);
    await dispatchKey(items[1] as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(items[2]);
    await dispatchKey(items[2] as HTMLElement, 'Home');
    expect(document.activeElement).toBe(items[0]);

    await act(async () => {
      controller.focus('deploy');
      await settle();
    });
    expect(document.activeElement).toBe(items[1]);
  });

  it('Progress renders role="progressbar", aria-labelledby, aria-valuenow, --progress-value, and indeterminate null', async () => {
    await render(
      createElement(
        'div',
        null,
        createElement(
          Progress,
          { value: 65 },
          createElement(ProgressLabel, null, '上传进度'),
          createElement(ProgressValue),
          createElement(ProgressTrack, null, createElement(ProgressIndicator)),
        ),
        createElement(
          Progress,
          { value: null },
          createElement(ProgressLabel, null, '连接服务器'),
          createElement(ProgressTrack, null, createElement(ProgressIndicator)),
        ),
      ),
    );

    const bars = Array.from(host.querySelectorAll<HTMLElement>('[role="progressbar"]'));
    const determinate = bars[0];
    const indeterminate = bars[1];
    if (!determinate || !indeterminate) throw new Error('missing progress bars');

    const detLabelId = determinate.getAttribute('aria-labelledby');
    expect(detLabelId).toBeTruthy();
    expect(document.getElementById(detLabelId ?? '')?.textContent).toBe('上传进度');
    expect(determinate.getAttribute('aria-valuenow')).toBe('65');
    expect(determinate.style.getPropertyValue('--progress-value')).toBe('65%');
    expect(determinate.hasAttribute('data-progressing')).toBe(true);
    expect(
      determinate.querySelector<HTMLElement>('[data-slot="progress-value"]')?.textContent,
    ).toBe('65%');
    expect(
      determinate.querySelector<HTMLElement>('[data-slot="progress-indicator"]')?.style.width,
    ).toBe('65%');

    const indLabelId = indeterminate.getAttribute('aria-labelledby');
    expect(indLabelId).toBeTruthy();
    expect(document.getElementById(indLabelId ?? '')?.textContent).toBe('连接服务器');
    expect(indeterminate.hasAttribute('aria-valuenow')).toBe(false);
    expect(indeterminate.hasAttribute('data-indeterminate')).toBe(true);
    expect(indeterminate.style.getPropertyValue('--progress-value')).toBe('');
  });

  it('ScrollArea renders viewport, content, scrollbar, thumb, and corner slots', async () => {
    const bindViewportMetrics = (node: HTMLDivElement | null) => {
      if (!node) return;
      Object.defineProperties(node, {
        clientHeight: { value: 120, configurable: true },
        scrollHeight: { value: 360, configurable: true },
        clientWidth: { value: 200, configurable: true },
        scrollWidth: { value: 420, configurable: true },
      });
    };

    await render(
      createElement(
        ScrollArea,
        { type: 'always' },
        createElement(
          ScrollAreaViewport,
          { ref: bindViewportMetrics, role: 'region', 'aria-label': '日志滚动区' },
          createElement(ScrollAreaContent, null, createElement('p', null, '第一行日志')),
        ),
        createElement(
          ScrollAreaScrollbar,
          { orientation: 'vertical' },
          createElement(ScrollAreaThumb),
        ),
        createElement(
          ScrollAreaScrollbar,
          { orientation: 'horizontal' },
          createElement(ScrollAreaThumb),
        ),
        createElement(ScrollAreaCorner),
      ),
    );

    const area = host.querySelector<HTMLElement>('[data-slot="scroll-area"]');
    const viewport = host.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const content = host.querySelector<HTMLElement>('[data-slot="scroll-area-content"]');
    const scrollbars = Array.from(
      host.querySelectorAll<HTMLElement>('[data-slot="scroll-area-scrollbar"]'),
    );
    const thumbs = Array.from(
      host.querySelectorAll<HTMLElement>('[data-slot="scroll-area-thumb"]'),
    );
    const corner = host.querySelector<HTMLElement>('[data-slot="scroll-area-corner"]');

    expect(area).not.toBeNull();
    expect(viewport?.getAttribute('aria-label')).toBe('日志滚动区');
    expect(content?.textContent).toBe('第一行日志');
    expect(scrollbars).toHaveLength(2);
    expect(scrollbars.every((bar) => bar.hasAttribute('data-visible'))).toBe(true);
    expect(scrollbars.map((bar) => bar.getAttribute('data-orientation'))).toEqual([
      'vertical',
      'horizontal',
    ]);
    expect(thumbs).toHaveLength(2);
    expect(thumbs.map((thumb) => thumb.getAttribute('data-orientation'))).toEqual([
      'vertical',
      'horizontal',
    ]);
    expect(corner).not.toBeNull();
  });
});

describe('High-frequency UI wrappers & Wave 4 detached controllers', () => {
  it('FilterSelect and ViewToggle apply optimistic updates immediately and respond to agent.act()', async () => {
    const onDeferredFilter = vi.fn();
    const onDeferredView = vi.fn();
    const onControlledFilter = vi.fn();
    const onControlledView = vi.fn();

    function OptimisticHarness() {
      const [status, setStatus] = useState('all');
      const [view, setView] = useState<ListView>('cards');
      return createElement(
        'div',
        null,
        createElement(FilterSelect, {
          label: '延迟筛选',
          value: 'all',
          options: [
            { value: 'all', label: '全部状态' },
            { value: 'failed', label: '仅看失败' },
          ],
          onValueChange: onDeferredFilter,
        }),
        createElement(ViewToggle, {
          value: 'cards',
          onChange: onDeferredView,
        }),
        createElement(FilterSelect, {
          label: '状态筛选',
          value: status,
          options: [
            { value: 'all', label: '全部' },
            { value: 'running', label: '运行中' },
          ],
          onValueChange: (next) => {
            onControlledFilter(next);
            setStatus(next);
          },
        }),
        createElement(ViewToggle, {
          value: view,
          onChange: (next) => {
            onControlledView(next);
            setView(next);
          },
        }),
      );
    }

    await render(createElement(OptimisticHarness));

    const deferredTrigger = host.querySelector<HTMLButtonElement>('button[aria-label="延迟筛选"]');
    if (!deferredTrigger) throw new Error('missing deferred FilterSelect trigger');
    expect(deferredTrigger.textContent).toContain('全部状态');

    await clickElement(deferredTrigger);
    const failedOption = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]'),
    ).find((item) => item.textContent?.includes('仅看失败'));
    if (!failedOption) throw new Error('missing 仅看失败 option');

    act(() => {
      failedOption.click();
    });
    expect(onDeferredFilter).toHaveBeenCalledWith('failed');
    expect(deferredTrigger.textContent).toContain('仅看失败');

    await flushUi();
    expect(deferredTrigger.textContent).toContain('全部状态');

    const groups = Array.from(
      host.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="切换视图"]'),
    );
    const deferredGroup = groups[0];
    const controlledGroup = groups[1];
    if (!deferredGroup || !controlledGroup) throw new Error('missing ViewToggle groups');
    const deferredTableRadio = Array.from(
      deferredGroup.querySelectorAll<HTMLElement>('[role="radio"]'),
    ).find((el) => el.textContent?.includes('表格'));
    if (!deferredTableRadio) throw new Error('missing 表格 radio');

    act(() => {
      deferredTableRadio.click();
    });
    expect(onDeferredView).toHaveBeenCalledWith('table');
    expect(deferredTableRadio.getAttribute('aria-checked')).toBe('true');

    await flushUi();
    expect(deferredTableRadio.getAttribute('aria-checked')).toBe('false');

    const snap = visibleSnapshot();
    const filterEntry = snap.find(
      (item) => item.component === 'select' && item.label === '状态筛选',
    );
    expect(filterEntry).toMatchObject({
      component: 'select',
      label: '状态筛选',
      value: 'all',
    });

    const controlledAct = await runAgentAct({
      steps: [
        { ref: '状态筛选', action: 'setValue', args: ['running'] },
        { ref: filterEntry?.ref ?? '状态筛选', action: 'expect', args: ['running'] },
      ],
    });
    expect(controlledAct.ok, controlledAct.error?.message).toBe(true);
    expect(onControlledFilter).toHaveBeenCalledWith('running');
    expect(host.querySelector('button[aria-label="状态筛选"]')?.textContent).toContain('运行中');

    await render(
      createElement(() => {
        const [view, setView] = useState<ListView>('cards');
        return createElement(ViewToggle, {
          value: view,
          onChange: (next) => {
            onControlledView(next);
            setView(next);
          },
        });
      }),
    );

    const viewEntry = visibleSnapshot().find(
      (item) => item.component === 'segmented-control' && item.label === '切换视图',
    );
    expect(viewEntry).toMatchObject({
      component: 'segmented-control',
      label: '切换视图',
      value: 'cards',
    });

    const viewAct = await runAgentAct({
      steps: [{ ref: '切换视图', action: 'setValue', args: ['table'] }],
    });
    expect(viewAct.ok, viewAct.error?.message).toBe(true);
    expect(onControlledView).toHaveBeenLastCalledWith('table');
    const activeTableRadio = Array.from(host.querySelectorAll<HTMLElement>('[role="radio"]')).find(
      (el) => el.textContent?.includes('表格'),
    );
    expect(activeTableRadio?.getAttribute('aria-checked')).toBe('true');
  });

  it('Select with items + Field, Combobox filtering + selection, and Tabs keyboard + agent navigation', async () => {
    const onSelectChange = vi.fn();
    const onComboChange = vi.fn();
    const onTabChange = vi.fn();
    const modes = [
      { value: 'fast', label: '快速模式' },
      { value: 'accurate', label: '精准模式' },
    ];
    const frameworks = [
      { value: 'react', label: 'React' },
      { value: 'vue', label: 'Vue' },
      { value: 'solid', label: 'Solid' },
    ];

    await render(
      createElement(
        'div',
        null,
        createElement(
          Field,
          null,
          createElement(FieldLabel, null, '运行模式'),
          createElement(
            Select,
            {
              items: modes,
              defaultValue: 'fast',
              onValueChange: (value, details) => onSelectChange(value, details.source),
            },
            createElement(SelectTrigger, null, createElement(SelectValue)),
            createElement(
              SelectContent,
              null,
              createElement(
                SelectGroup,
                null,
                modes.map((item) =>
                  createElement(SelectItem, { key: item.value, value: item.value }, item.label),
                ),
              ),
            ),
          ),
        ),
        createElement(
          Field,
          null,
          createElement(FieldLabel, null, '前端框架'),
          createElement(
            Combobox,
            {
              items: frameworks,
              itemToLabel: (value) =>
                frameworks.find((item) => item.value === value)?.label ?? value,
              onValueChange: (value, details) => onComboChange(value, details.source),
            },
            createElement(ComboboxInput, { placeholder: '搜索框架' }),
            createElement(ComboboxTrigger, { 'aria-label': '展开框架' }),
            createElement(
              ComboboxContent,
              null,
              createElement(ComboboxEmpty, null, '未找到框架'),
              createElement(ComboboxList, null, (state) =>
                (state.items as typeof frameworks).map((item) =>
                  createElement(
                    ComboboxItem,
                    { key: item.value, value: item.value, label: item.label },
                    item.label,
                  ),
                ),
              ),
            ),
          ),
        ),
        createElement(
          Tabs,
          {
            defaultValue: 'general',
            onValueChange: (value, details) => onTabChange(value, details.source),
          },
          createElement(
            TabsList,
            { 'aria-label': '配置面板' },
            createElement(TabsTrigger, { value: 'general' }, '常规'),
            createElement(TabsTrigger, { value: 'security' }, '安全'),
            createElement(TabsTrigger, { value: 'billing' }, '计费'),
          ),
          createElement(TabsContent, { value: 'general' }, '常规面板内容'),
          createElement(TabsContent, { value: 'security' }, '安全面板内容'),
          createElement(TabsContent, { value: 'billing' }, '计费面板内容'),
        ),
      ),
    );

    const selectTrigger = host.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]');
    if (!selectTrigger) throw new Error('missing select trigger');
    expect(selectTrigger.textContent).toContain('快速模式');
    await clickElement(selectTrigger);
    const accurateOpt = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]'),
    ).find((el) => el.textContent?.includes('精准模式'));
    if (!accurateOpt) throw new Error('missing select option');
    await clickElement(accurateOpt);
    expect(onSelectChange).toHaveBeenLastCalledWith('accurate', expect.any(String));
    expect(selectTrigger.textContent).toContain('精准模式');

    const comboInput = host.querySelector<HTMLInputElement>('[data-slot="combobox-input"]');
    if (!comboInput) throw new Error('missing combobox input');
    await typeIntoInput(comboInput, 'sol');
    const comboItems = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]'),
    ).filter((el) => !el.hidden);
    expect(comboItems.map((el) => el.textContent)).toEqual(['Solid']);
    await dispatchKey(comboInput, 'ArrowDown');
    await dispatchKey(comboInput, 'Enter');
    expect(onComboChange).toHaveBeenLastCalledWith('solid', expect.any(String));
    expect(comboInput.value).toBe('Solid');

    const tabTriggers = Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]'));
    await focusElement(tabTriggers[0] as HTMLElement);
    await dispatchKey(tabTriggers[0] as HTMLElement, 'ArrowRight');
    expect(onTabChange).toHaveBeenLastCalledWith('security', expect.any(String));
    expect(host.textContent).toContain('安全面板内容');

    await dispatchKey(tabTriggers[1] as HTMLElement, 'End');
    expect(onTabChange).toHaveBeenLastCalledWith('billing', expect.any(String));
    expect(host.textContent).toContain('计费面板内容');

    await dispatchKey(tabTriggers[2] as HTMLElement, 'Home');
    expect(onTabChange).toHaveBeenLastCalledWith('general', expect.any(String));
    expect(host.textContent).toContain('常规面板内容');

    const snap = visibleSnapshot();
    expect(snap.map((item) => item.label)).toEqual(
      expect.arrayContaining(['运行模式', '前端框架', '配置面板']),
    );

    const actResult = await runAgentAct({
      steps: [
        { ref: '运行模式', action: 'setValue', args: ['fast'] },
        { ref: '前端框架', action: 'setValue', args: ['React'] },
        { ref: '配置面板', action: 'setValue', args: ['security'] },
      ],
    });
    expect(actResult.ok, actResult.error?.message).toBe(true);
    expect(onSelectChange).toHaveBeenLastCalledWith('fast', 'agent');
    expect(onComboChange).toHaveBeenLastCalledWith('react', 'agent');
    expect(onTabChange).toHaveBeenLastCalledWith('security', 'agent');
  });

  it('DropdownMenu supports standard trigger usage and detached createMenuController payloads with agent.act()', async () => {
    const onStandardAction = vi.fn();
    const onDetachedAction = vi.fn();
    type RowPayload = { id: string; name: string };

    function MenuHarness() {
      const [rowMenu] = useState(() => createMenuController<RowPayload>());
      return createElement(
        'div',
        null,
        createElement(
          DropdownMenu,
          { onAction: (value) => onStandardAction(value) },
          createElement(DropdownMenuTrigger, {
            render: createElement(Button, { type: 'button' }, '文档操作'),
          }),
          createElement(
            DropdownMenuContent,
            null,
            createElement(
              DropdownMenuGroup,
              null,
              createElement(DropdownMenuItem, { value: 'rename' }, '重命名'),
              createElement(DropdownMenuItem, { value: 'remove', variant: 'destructive' }, '删除'),
            ),
          ),
        ),
        createElement(DropdownMenuTrigger, {
          controller: rowMenu,
          payload: { id: 'a1', name: '规划师' },
          render: createElement(
            Button,
            { type: 'button', 'aria-label': '操作 规划师' },
            '规划师菜单',
          ),
        }),
        createElement(DropdownMenuTrigger, {
          controller: rowMenu,
          payload: { id: 'a2', name: '研究员' },
          render: createElement(
            Button,
            { type: 'button', 'aria-label': '操作 研究员' },
            '研究员菜单',
          ),
        }),
        createElement(
          DropdownMenu,
          {
            controller: rowMenu,
            onAction: (value) => onDetachedAction(value, rowMenu.getPayload()?.id),
          },
          createElement(DropdownMenuContent<RowPayload>, null, (state) => {
            const payload = state.payload;
            if (!payload) return null;
            return createElement(
              DropdownMenuGroup,
              null,
              createElement(DropdownMenuItem, { value: 'configure' }, `配置 ${payload.name}`),
              createElement(DropdownMenuItem, { value: 'archive' }, `归档 ${payload.name}`),
            );
          }),
        ),
      );
    }

    await render(createElement(MenuHarness));

    const standardTrigger = Array.from(host.querySelectorAll('button')).find(
      (btn) => btn.textContent === '文档操作',
    );
    const alphaTrigger = host.querySelector<HTMLButtonElement>('button[aria-label="操作 规划师"]');
    const betaTrigger = host.querySelector<HTMLButtonElement>('button[aria-label="操作 研究员"]');
    if (!standardTrigger || !alphaTrigger || !betaTrigger) {
      throw new Error('missing menu triggers');
    }

    await focusElement(standardTrigger);
    await clickElement(standardTrigger);
    const renameItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent === '重命名');
    if (!renameItem) throw new Error('missing standard menu item');
    await clickElement(renameItem);
    expect(onStandardAction).toHaveBeenCalledWith('rename');

    await focusElement(alphaTrigger);
    await clickElement(alphaTrigger);
    expect(document.body.querySelector('[role="menu"]')?.textContent).toContain('配置 规划师');
    const activeInMenu =
      document.activeElement instanceof HTMLElement ? document.activeElement : alphaTrigger;
    await dispatchKey(activeInMenu, 'Escape');
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(alphaTrigger);

    await focusElement(betaTrigger);
    await clickElement(betaTrigger);
    expect(document.body.querySelector('[role="menu"]')?.textContent).toContain('配置 研究员');
    const archiveBeta = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent === '归档 研究员');
    if (!archiveBeta) throw new Error('missing detached menu item');
    await clickElement(archiveBeta);
    expect(onDetachedAction).toHaveBeenCalledWith('archive', 'a2');

    const stdAct = await runAgentAct({
      steps: [{ ref: '文档操作', action: 'press', args: ['删除'] }],
    });
    expect(stdAct.ok, stdAct.error?.message).toBe(true);
    expect(onStandardAction).toHaveBeenCalledWith('remove');

    const detachedAct = await runAgentAct({
      steps: [
        { ref: '操作 规划师', action: 'press', args: ['规划师菜单'] },
        { ref: '操作 规划师', action: 'press', args: ['配置 规划师'] },
      ],
    });
    expect(detachedAct.ok, detachedAct.error?.message).toBe(true);
    expect(onDetachedAction).toHaveBeenCalledWith('configure', 'a1');
  });

  it('Tooltip supports standard usage and detached createTooltipController across multiple triggers', async () => {
    type TipPayload = { id: string; summary: string };

    function TooltipHarness() {
      const [tooltip] = useState(() => createTooltipController<TipPayload>());
      return createElement(
        'div',
        null,
        createElement(
          Tooltip,
          null,
          createElement(TooltipTrigger, {
            render: createElement(Button, { type: 'button' }, '导出提示'),
          }),
          createElement(TooltipContent, null, '下载当前记录'),
        ),
        createElement(TooltipTrigger, {
          controller: tooltip,
          payload: { id: 'm1', summary: '今日 12 次' },
          render: createElement(Button, { type: 'button', 'aria-label': '指标一' }, 'M1'),
        }),
        createElement(TooltipTrigger, {
          controller: tooltip,
          payload: { id: 'm2', summary: '今日 99 次' },
          render: createElement(Button, { type: 'button', 'aria-label': '指标二' }, 'M2'),
        }),
        createElement(
          Tooltip,
          { controller: tooltip },
          createElement(TooltipContent<TipPayload>, null, (state) =>
            state.payload ? `${state.payload.id}: ${state.payload.summary}` : null,
          ),
        ),
      );
    }

    await render(createElement(TooltipHarness));

    const standardBtn = Array.from(host.querySelectorAll('button')).find(
      (btn) => btn.textContent === '导出提示',
    );
    const metricOne = host.querySelector<HTMLButtonElement>('button[aria-label="指标一"]');
    const metricTwo = host.querySelector<HTMLButtonElement>('button[aria-label="指标二"]');
    if (!standardBtn || !metricOne || !metricTwo) throw new Error('missing tooltip triggers');

    await focusElement(standardBtn);
    const openStandardTip = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="tooltip"]'),
    ).find((tip) => tip.hasAttribute('data-open'));
    expect(openStandardTip?.textContent).toContain('下载当前记录');

    await dispatchKey(standardBtn, 'Escape');
    expect(openStandardTip?.hasAttribute('data-open')).toBe(false);
    expect(document.activeElement).toBe(standardBtn);

    await focusElement(metricOne);
    const sharedTip = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="tooltip"]'),
    ).find((tip) => tip.hasAttribute('data-open'));
    expect(sharedTip?.textContent).toContain('m1: 今日 12 次');

    await focusElement(metricTwo);
    const updatedSharedTip = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="tooltip"]'),
    ).find((tip) => tip.hasAttribute('data-open'));
    expect(updatedSharedTip?.textContent).toContain('m2: 今日 99 次');
  });

  it('Popover, Accordion, Dialog, and Sheet open, close on Escape restoring focus, and work via agent', async () => {
    const onPopoverAction = vi.fn();
    const onDialogSave = vi.fn();

    function OverlayAndDisclosureHarness() {
      const [sheetOpen, setSheetOpen] = useState(false);
      const sheetTriggerRef = useRef<HTMLButtonElement | null>(null);
      return createElement(
        'div',
        null,
        createElement(
          Popover,
          null,
          createElement(PopoverTrigger, {
            render: createElement(Button, { type: 'button' }, '打开筛选气泡'),
          }),
          createElement(
            PopoverContent,
            { 'aria-label': '筛选面板' },
            createElement(Button, { type: 'button', onClick: onPopoverAction }, '应用筛选'),
          ),
        ),
        createElement(
          Accordion,
          { 'aria-label': '常见说明' },
          createElement(
            AccordionItem,
            { value: 'sec-a' },
            createElement(AccordionTrigger, null, '部署方式'),
            createElement(AccordionContent, null, '支持容器隔离部署'),
          ),
          createElement(
            AccordionItem,
            { value: 'sec-b' },
            createElement(AccordionTrigger, null, '权限模型'),
            createElement(AccordionContent, null, '按角色最小授权'),
          ),
        ),
        createElement(
          Dialog,
          null,
          createElement(DialogTrigger, {
            render: createElement(Button, { type: 'button' }, '打开配置弹窗'),
          }),
          createElement(
            DialogContent,
            null,
            createElement(
              DialogHeader,
              null,
              createElement(DialogTitle, null, '弹窗标题'),
              createElement(DialogDescription, null, '弹窗说明文案'),
            ),
            createElement(Button, { type: 'button', onClick: onDialogSave }, '确认弹窗配置'),
          ),
        ),
        createElement(
          Button,
          {
            ref: sheetTriggerRef,
            type: 'button',
            onClick: () => setSheetOpen(true),
          },
          '打开侧边抽屉',
        ),
        createElement(
          Sheet,
          {
            open: sheetOpen,
            onOpenChange: setSheetOpen,
            side: 'right',
          },
          createElement(
            SheetContent,
            { finalFocus: () => sheetTriggerRef.current },
            createElement(SheetTitle, null, '抽屉详情'),
            createElement(SheetDescription, null, '侧边抽屉内容'),
            createElement(SheetClose, null, '完成阅读'),
          ),
        ),
      );
    }

    await render(createElement(OverlayAndDisclosureHarness));

    const popoverTrigger = Array.from(host.querySelectorAll('button')).find(
      (btn) => btn.textContent === '打开筛选气泡',
    );
    if (!popoverTrigger) throw new Error('missing popover trigger');
    await focusElement(popoverTrigger);
    await clickElement(popoverTrigger);
    expect(
      document.body.querySelector('[data-slot="popover-content"]')?.hasAttribute('data-open'),
    ).toBe(true);
    const activePopoverTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : popoverTrigger;
    await dispatchKey(activePopoverTarget, 'Escape');
    expect(
      document.body.querySelector('[data-slot="popover-content"]')?.hasAttribute('data-open'),
    ).not.toBe(true);
    expect(document.activeElement).toBe(popoverTrigger);

    const dialogTrigger = Array.from(host.querySelectorAll('button')).find(
      (btn) => btn.textContent === '打开配置弹窗',
    );
    if (!dialogTrigger) throw new Error('missing dialog trigger');
    await focusElement(dialogTrigger);
    await clickElement(dialogTrigger);
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('弹窗标题');
    const activeDialogTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : dialogTrigger;
    await dispatchKey(activeDialogTarget, 'Escape');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(dialogTrigger);

    const sheetTrigger = Array.from(host.querySelectorAll('button')).find(
      (btn) => btn.textContent === '打开侧边抽屉',
    );
    if (!sheetTrigger) throw new Error('missing sheet trigger');
    await focusElement(sheetTrigger);
    await clickElement(sheetTrigger);
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('抽屉详情');
    const activeSheetTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : sheetTrigger;
    await dispatchKey(activeSheetTarget, 'Escape');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(sheetTrigger);

    const accTriggers = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[data-slot="accordion-trigger"]'),
    );
    await clickElement(accTriggers[0] as HTMLElement);
    expect(accTriggers[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('支持容器隔离部署');

    const dialogActRes = await runAgentAct({
      steps: [
        { ref: '打开筛选气泡', action: 'press', args: ['应用筛选'] },
        { ref: '常见说明', action: 'open', args: ['sec-b'] },
        { ref: '打开配置弹窗', action: 'press', args: ['确认弹窗配置'] },
        { ref: '关闭', action: 'press' },
      ],
    });
    expect(dialogActRes.ok, dialogActRes.error?.message).toBe(true);
    expect(onPopoverAction).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('按角色最小授权');
    expect(onDialogSave).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    const openSheetAct = await runAgentAct({
      steps: [{ ref: '打开侧边抽屉', action: 'press' }],
    });
    expect(openSheetAct.ok, openSheetAct.error?.message).toBe(true);
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('抽屉详情');

    const closeSheetAct = await runAgentAct({
      steps: [{ ref: '完成阅读', action: 'press' }],
    });
    expect(closeSheetAct.ok, closeSheetAct.error?.message).toBe(true);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Calendar, Carousel, Toggle, and ToggleGroup handle controls, state updates, and agent.act()', async () => {
    const onDateChange = vi.fn();
    const onPageChange = vi.fn();
    const onToggleChange = vi.fn();
    const onGroupChange = vi.fn();

    const bindCarouselViewport = (node: HTMLDivElement | null) => {
      if (!node) return;
      Object.defineProperties(node, {
        clientWidth: { value: 300, configurable: true },
        scrollWidth: { value: 900, configurable: true },
      });
    };

    const bindCarouselSlide = (index: number) => (node: HTMLDivElement | null) => {
      if (!node) return;
      Object.defineProperties(node, {
        offsetLeft: { value: index * 300, configurable: true },
        offsetWidth: { value: 300, configurable: true },
      });
    };

    await render(
      createElement(
        'div',
        null,
        createElement(Calendar, {
          'aria-label': '排期日历',
          defaultMonth: '2026-10',
          defaultValue: '2026-10-16',
          onValueChange: (value, details) => onDateChange(value, details.source),
        }),
        createElement(
          Carousel,
          {
            'aria-label': '精选卡片轮播',
            onPageChange: (page, details) => onPageChange(page, details.source),
          },
          createElement(
            CarouselViewport,
            { ref: bindCarouselViewport },
            createElement(
              CarouselContent,
              null,
              createElement(
                CarouselItem,
                { ref: bindCarouselSlide(0), style: { width: '300px', height: '100px' } },
                '卡片一',
              ),
              createElement(
                CarouselItem,
                { ref: bindCarouselSlide(1), style: { width: '300px', height: '100px' } },
                '卡片二',
              ),
              createElement(
                CarouselItem,
                { ref: bindCarouselSlide(2), style: { width: '300px', height: '100px' } },
                '卡片三',
              ),
            ),
          ),
          createElement(CarouselPrevious),
          createElement(CarouselNext),
        ),
        createElement(
          Toggle,
          {
            'aria-label': '置顶展示',
            onPressedChange: (pressed, details) => onToggleChange(pressed, details.source),
          },
          '置顶',
        ),
        createElement(
          ToggleGroup,
          {
            'aria-label': '文本对齐',
            defaultValue: ['left'],
            onValueChange: (value, details) => onGroupChange(value, details.source),
          },
          createElement(ToggleGroupItem, { value: 'left' }, '左对齐'),
          createElement(ToggleGroupItem, { value: 'center' }, '居中'),
          createElement(ToggleGroupItem, { value: 'right' }, '右对齐'),
        ),
      ),
    );

    const nextMonthBtn = host.querySelector<HTMLButtonElement>('button[aria-label="下个月"]');
    const prevMonthBtn = host.querySelector<HTMLButtonElement>('button[aria-label="上个月"]');
    if (!nextMonthBtn || !prevMonthBtn) throw new Error('missing calendar nav buttons');

    const initialHeading = host.querySelector('[data-slot="calendar-heading"]')?.textContent;
    await clickElement(nextMonthBtn);
    expect(host.querySelector('[data-slot="calendar-heading"]')?.textContent).not.toBe(
      initialHeading,
    );
    await clickElement(prevMonthBtn);
    expect(host.querySelector('[data-slot="calendar-heading"]')?.textContent).toBe(initialHeading);

    const day22 = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[data-slot="calendar-day"]'),
    ).find((day) => day.textContent === '22' && !day.hasAttribute('data-outside'));
    if (!day22) throw new Error('missing calendar day 22');
    await clickElement(day22);
    expect(onDateChange).toHaveBeenLastCalledWith('2026-10-22', expect.any(String));

    const nextSlideBtn = host.querySelector<HTMLButtonElement>('[data-slot="carousel-next"]');
    const prevSlideBtn = host.querySelector<HTMLButtonElement>('[data-slot="carousel-previous"]');
    if (!nextSlideBtn || !prevSlideBtn) throw new Error('missing carousel buttons');
    await clickElement(nextSlideBtn);
    expect(onPageChange).toHaveBeenLastCalledWith(2, expect.any(String));
    await clickElement(prevSlideBtn);
    expect(onPageChange).toHaveBeenLastCalledWith(1, expect.any(String));

    const toggleBtn = host.querySelector<HTMLButtonElement>('button[aria-label="置顶展示"]');
    if (!toggleBtn) throw new Error('missing toggle button');
    await clickElement(toggleBtn);
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('true');
    expect(onToggleChange).toHaveBeenLastCalledWith(true, expect.any(String));

    const groupItems = Array.from(
      host.querySelectorAll<HTMLButtonElement>(
        '[data-slot="toggle-group"] [role="button"], [data-slot="toggle-group"] button',
      ),
    );
    expect(groupItems).toHaveLength(3);
    await focusElement(groupItems[0] as HTMLElement);
    await dispatchKey(groupItems[0] as HTMLElement, 'ArrowRight');
    expect(document.activeElement).toBe(groupItems[1]);
    await clickElement(groupItems[1] as HTMLElement);
    expect(onGroupChange).toHaveBeenLastCalledWith(['center'], expect.any(String));

    const snap = visibleSnapshot();
    expect(snap.map((item) => item.label)).toEqual(
      expect.arrayContaining(['排期日历', '精选卡片轮播', '置顶展示', '文本对齐']),
    );

    const actResult = await runAgentAct({
      steps: [
        { ref: '排期日历', action: 'setValue', args: ['2026-10-25'] },
        { ref: '精选卡片轮播', action: 'next' },
        { ref: '置顶展示', action: 'toggle' },
        { ref: '文本对齐', action: 'setValue', args: [['right']] },
      ],
    });
    expect(actResult.ok, actResult.error?.message).toBe(true);
    expect(onDateChange).toHaveBeenLastCalledWith('2026-10-25', 'agent');
    expect(onPageChange).toHaveBeenLastCalledWith(2, 'agent');
    expect(onToggleChange).toHaveBeenLastCalledWith(false, 'agent');
    expect(onGroupChange).toHaveBeenLastCalledWith(['right'], 'agent');

    const prevActResult = await runAgentAct({
      steps: [{ ref: '精选卡片轮播', action: 'previous' }],
    });
    expect(prevActResult.ok, prevActResult.error?.message).toBe(true);
    expect(onPageChange).toHaveBeenLastCalledWith(1, 'agent');
  });
});
