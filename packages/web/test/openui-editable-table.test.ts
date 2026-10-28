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

async function settle(rounds = 16): Promise<void> {
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

function inputs(): HTMLInputElement[] {
  return [...host.querySelectorAll<HTMLInputElement>('tbody input')];
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(2);
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((element) =>
    element.textContent?.includes(text),
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await settle(2);
}

const P = (lines: string[]) => lines.join('\n');

const table = (name: string, data: string, columns = 'cols') =>
  P([
    `root = Card([table])`,
    `table = EditableTable("${name}", ${columns}, ${data})`,
    `cols = [{type: "text", key: "name", header: "名称"}, {type: "number", key: "qty", header: "数量"}]`,
  ]);

describe('EditableTable streaming and hydration', () => {
  it('renders rows that arrive after an empty streamed program', async () => {
    await act(async () => {
      root.render(
        createElement(OpenUiBlock, {
          program: table('items', '[]'),
          streaming: true,
        }),
      );
    });
    await settle(2);
    expect(inputs()).toHaveLength(0);

    await render(table('items', '[{id: "a", values: ["苹果", 3]}, {id: "b", values: ["梨", 5]}]'));
    expect(inputs().map((input) => input.value)).toEqual(['苹果', '3', '梨', '5']);
  });

  it('restores saved rows from initialState under the table namespace', async () => {
    await render(table('items', '[{id: "a", values: ["模型值", 1]}]'), {
      initialState: {
        items: {
          items: { value: [{ id: 'a', values: ['恢复值', 7] }], componentType: 'EditableTable' },
        },
      },
    });
    expect(inputs().map((input) => input.value)).toEqual(['恢复值', '7']);
  });

  it('restores a saved payload after unmount', async () => {
    const onAction = vi.fn();
    await render(table('items', '[{id: "a", values: ["苹果", 3]}]'), { onAction });
    await type(inputs()[1] as HTMLInputElement, '12');
    await click(buttonByText('Save Changes'));
    const event = onAction.mock.calls.at(-1)?.[0] as { formState: Record<string, unknown> };

    await act(async () => root.unmount());
    root = createRoot(host);
    await render(table('items', '[]'), { initialState: event.formState });

    expect(inputs().map((input) => input.value)).toEqual(['苹果', '12']);
  });
});

describe('EditableTable draft, Reset and Save', () => {
  it('saves the namespace payload with numeric columns converted', async () => {
    const onAction = vi.fn();
    await render(table('items', '[{id: "a", values: ["苹果", 3]}]'), { onAction });

    await type(inputs()[1] as HTMLInputElement, '12');
    await click(buttonByText('Save Changes'));

    const event = onAction.mock.calls.at(-1)?.[0] as {
      formState: Record<string, { items: { value: unknown[] } }>;
    };
    expect(event.formState.items?.items?.value).toEqual([{ id: 'a', values: ['苹果', 12] }]);
    expect(host.textContent).not.toContain('处修改');
  });

  it('keeps dirty edits across source updates, and Reset adopts the latest source', async () => {
    await render(table('items', '[{id: "a", values: ["苹果", 3]}]'));
    await type(inputs()[0] as HTMLInputElement, '香蕉');
    expect(host.textContent).toContain('1 处修改');

    await render(table('items', '[{id: "a", values: ["新版", 9]}]'));
    expect(inputs().map((input) => input.value)).toEqual(['香蕉', '3']);

    await click(buttonByText('Reset'));
    expect(inputs().map((input) => input.value)).toEqual(['新版', '9']);
    expect(host.textContent).not.toContain('处修改');
  });

  it('drops the draft when edits return to the baseline', async () => {
    await render(table('items', '[{id: "a", values: ["苹果", 3]}]'));
    await type(inputs()[0] as HTMLInputElement, '香蕉');
    expect(host.textContent).toContain('1 处修改');
    await type(inputs()[0] as HTMLInputElement, '苹果');
    expect(host.textContent).not.toContain('处修改');
    expect(host.querySelectorAll('tbody input')).toHaveLength(2);
  });
});

describe('EditableTable cell types', () => {
  it('edits select, url, number and date-single cells', async () => {
    const onAction = vi.fn();
    await render(
      P([
        'root = Card([table])',
        'table = EditableTable("items", cols, [{id: "a", values: ["", "", 1, ""]}])',
        'cols = [{type: "select", key: "status", header: "状态", options: [{value: "open", label: "打开"}, {value: "done", label: "完成"}]}, {type: "url", key: "link", header: "链接"}, {type: "number", key: "qty", header: "数量"}, {type: "date-single", key: "day", header: "日期"}]',
      ]),
      { onAction },
    );

    const url = inputs().find((input) => input.type === 'url');
    const number = inputs().find((input) => input.type === 'number');
    expect(url).toBeTruthy();
    await type(url as HTMLInputElement, 'https://example.com');
    await type(number as HTMLInputElement, '4.5');

    await click(host.querySelector<HTMLElement>('[aria-label="状态 第 1 行"]') as HTMLElement);
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent?.trim() === '完成',
    );
    if (!option) throw new Error('missing select option');
    await click(option);

    await click(host.querySelector<HTMLElement>('[aria-label="日期 第 1 行"]') as HTMLElement);
    const day = [...document.querySelectorAll<HTMLElement>('[role="gridcell"] button')].find(
      (item) => item.textContent?.trim() === '15',
    );
    if (!day) throw new Error('missing calendar day');
    await click(day);

    await click(buttonByText('Save Changes'));
    const event = onAction.mock.calls.at(-1)?.[0] as {
      formState: { items: { items: { value: Array<{ values: unknown[] }> } } };
    };
    const values = event.formState.items?.items?.value?.[0]?.values ?? [];
    expect(values[0]).toBe('done');
    expect(values[1]).toBe('https://example.com');
    expect(values[2]).toBe(4.5);
    expect(values[3]).toMatch(/^\d{4}-\d{2}-15$/);
  });

  it('clears a date cell and saves an empty string', async () => {
    const onAction = vi.fn();
    await render(
      P([
        'root = Card([table])',
        'table = EditableTable("items", cols, [{id: "a", values: ["2030-06-15"]}])',
        'cols = [{type: "date-single", key: "day", header: "日期"}]',
      ]),
      { onAction },
    );

    await click(host.querySelector<HTMLElement>('[aria-label="日期 第 1 行"]') as HTMLElement);
    const selected = document.querySelector<HTMLElement>('[data-selected-single="true"]');
    expect(selected?.textContent?.trim()).toBe('15');
    if (!selected) throw new Error('missing selected calendar day');
    await click(selected);

    expect(host.textContent).toContain('选择日期');
    await click(buttonByText('Save Changes'));

    const event = onAction.mock.calls.at(-1)?.[0] as {
      formState: { items: { items: { value: Array<{ values: unknown[] }> } } };
    };
    expect(event.formState.items.items.value[0]?.values).toEqual(['']);
  });

  it('opens the calendar on the month of the saved date', async () => {
    await render(
      P([
        'root = Card([table])',
        'table = EditableTable("items", cols, [{id: "a", values: ["2030-06-15"]}])',
        'cols = [{type: "date-single", key: "day", header: "日期"}]',
      ]),
    );

    await click(host.querySelector<HTMLElement>('[aria-label="日期 第 1 行"]') as HTMLElement);
    const caption = document.querySelector<HTMLElement>('.rdp-caption_label');
    expect(caption?.textContent).toContain('2030');
    expect(document.querySelector('[data-selected-single="true"]')?.textContent?.trim()).toBe('15');
  });

  it('discards a draft when the same node switches to another table name', async () => {
    const onAction = vi.fn();
    await render(table('alpha', '[{id: "a", values: ["A值", 1]}]'), { onAction });
    await type(inputs()[0] as HTMLInputElement, 'A草稿');
    expect(host.textContent).toContain('1 处修改');

    await render(table('beta', '[{id: "b", values: ["B值", 2]}]'), { onAction });
    expect(inputs().map((input) => input.value)).toEqual(['B值', '2']);
    expect(host.textContent).not.toContain('处修改');

    await type(inputs()[0] as HTMLInputElement, 'B草稿');
    await click(buttonByText('Save Changes'));

    const event = onAction.mock.calls.at(-1)?.[0] as { formState: Record<string, unknown> };
    expect(event.formState.beta).toEqual({
      beta: { value: [{ id: 'b', values: ['B草稿', 2] }], componentType: 'EditableTable' },
    });
    expect(event.formState.alpha).toBeUndefined();
  });

  it('saves by column key after the column order changes', async () => {
    const onAction = vi.fn();
    const data = '[{id: "a", values: ["苹果", 3]}]';
    await render(
      P([
        'root = Card([table])',
        `table = EditableTable("items", [{type: "text", key: "name", header: "名称"}, {type: "number", key: "qty", header: "数量"}], ${data})`,
      ]),
      { onAction },
    );
    await type(inputs()[1] as HTMLInputElement, '12');

    await render(
      P([
        'root = Card([table])',
        `table = EditableTable("items", [{type: "number", key: "qty", header: "数量"}, {type: "text", key: "name", header: "名称"}], ${data})`,
      ]),
      { onAction },
    );
    expect(inputs().map((input) => input.value)).toEqual(['12', '苹果']);

    await click(buttonByText('Save Changes'));
    const event = onAction.mock.calls.at(-1)?.[0] as {
      formState: { items: { items: { value: Array<{ values: unknown[] }> } } };
    };
    expect(event.formState.items.items.value).toEqual([{ id: 'a', values: [12, '苹果'] }]);
  });

  it('keeps two tables with different names isolated', async () => {
    await render(
      P([
        'root = Card([left, right])',
        'left = EditableTable("left", cols, [{id: "l", values: ["左", 1]}])',
        'right = EditableTable("right", cols, [{id: "r", values: ["右", 2]}])',
        'cols = [{type: "text", key: "name", header: "名称"}]',
      ]),
    );
    await type(inputs()[0] as HTMLInputElement, '改左');
    expect(inputs().map((input) => input.value)).toEqual(['改左', '右']);
  });
});
