import { Renderer } from '@openuidev/react-lang';
import { openuiChatLibrary } from '@openuidev/react-ui';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenUiBlock } from '../src/openui/renderer.js';

interface Diagnostic {
  source: string;
  code: string;
  message: string;
  severity?: 'warning';
}

interface Mounted {
  host: HTMLDivElement;
  unmount: () => Promise<void>;
  /** 官方 Renderer 经 onError 上报的诊断；本地侧不产生，恒为空。 */
  diagnostics: Diagnostic[];
}

let mounted: Mounted[] = [];

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  mounted = [];
});

afterEach(async () => {
  const failures: unknown[] = [];
  for (const item of mounted) {
    try {
      await item.unmount();
    } catch (error) {
      failures.push(error);
    } finally {
      item.host.remove();
    }
  }
  mounted = [];
  vi.unstubAllGlobals();
  if (failures.length > 0) throw new AggregateError(failures, 'parity cleanup failed');
});

async function settle(rounds = 16): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(node: ReactElement): Promise<Mounted> {
  const entry: Mounted = {
    host: document.createElement('div'),
    diagnostics: [],
    unmount: async () => {},
  };
  document.body.append(entry.host);
  const root = createRoot(entry.host);
  entry.unmount = async () => {
    await act(async () => root.unmount());
  };
  mounted.push(entry);
  await act(async () => root.render(node));
  await settle();
  return entry;
}

type State = Record<string, unknown>;

const official = async (program: string, initialState?: State): Promise<Mounted> => {
  const diagnostics: Diagnostic[] = [];
  const entry = await mount(
    createElement(
      Renderer.Root,
      {
        response: program,
        library: openuiChatLibrary,
        ...(initialState ? { initialState } : {}),
        onError: (errors: Diagnostic[]) => {
          diagnostics.splice(0, diagnostics.length, ...errors);
        },
      },
      createElement(Renderer.Content, null),
    ),
  );
  entry.diagnostics = diagnostics;
  return entry;
};

const local = (program: string, initialState?: State): Promise<Mounted> =>
  mount(createElement(OpenUiBlock, { program, ...(initialState ? { initialState } : {}) }));

const expectNoErrors = (entry: Mounted): void => {
  expect(entry.diagnostics.filter((item) => item.severity !== 'warning')).toEqual([]);
};

/** 两端各渲染一次，断言只读地跑在 run 里；卸载统一在 afterEach。
 *  必须串行挂载：两个 root 的 act() 并行会互相重叠，React 只提交一部分。 */
async function pair(
  program: string,
  initialState: State | undefined,
  run: (a: HTMLDivElement, b: HTMLDivElement) => void,
): Promise<void> {
  const a = await official(program, initialState);
  const b = await local(program, initialState);
  expectNoErrors(a);
  expectNoErrors(b);
  run(a.host, b.host);
}

const text = (root: Element): string => (root.textContent ?? '').replace(/\s+/g, ' ').trim();

const attrs = (root: Element, name: string): string[] =>
  [...root.querySelectorAll(`[${name}]`)].map((node) => node.getAttribute(name) ?? '\u0000');

const inputValues = (root: Element): string[] =>
  [...root.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])')].map(
    (input) => input.value,
  );

/** 单元格可读值：本地可编辑时是 input.value，官方是只读 span 文本。 */
const cells = (root: Element): string[] => {
  const inputs = inputValues(root);
  if (inputs.length > 0) return inputs;
  return [...root.querySelectorAll('tbody td')].map((td) => text(td));
};

const ISO = /\d{4}-\d{2}-\d{2}/g;

const toIso = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function parseInputIso(value: string): string | null {
  const slash = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (slash) return `${slash[3]}-${slash[1]}-${slash[2]}`;
  const iso = value.match(ISO);
  return iso?.[0] ?? null;
}

/** 单个日期：优先 ISO 字面量，否则取 “Oct 28, 2026” 这样的日期片段再解析。
 *  不能把整段根文本直接丢给 new Date()：表单里还有 “日期”“提交”等标签，会解析失败。 */
function firstDay(root: Element): string | null {
  for (const value of inputValues(root)) {
    const parsed = parseInputIso(value);
    if (parsed) return parsed;
  }
  const raw = text(root);
  const iso = raw.match(ISO);
  if (iso?.[0]) return iso[0];
  const label = raw.match(/[A-Z][a-z]{2} \d{1,2}, \d{4}/)?.[0];
  if (!label) return null;
  const parsed = new Date(label);
  return Number.isNaN(parsed.getTime()) ? null : toIso(parsed);
}

function days(root: Element): string[] {
  const found = new Set<string>();
  for (const value of inputValues(root)) {
    const parsed = parseInputIso(value);
    if (parsed) found.add(parsed);
  }
  const raw = text(root);
  for (const match of raw.match(ISO) ?? []) found.add(match);
  for (const label of raw.match(/[A-Z][a-z]{2} \d{1,2}, \d{4}/g) ?? []) {
    const parsed = new Date(label);
    if (!Number.isNaN(parsed.getTime())) found.add(toIso(parsed));
  }
  return [...found].sort();
}

const form = (...lines: string[]) =>
  [
    'root = Card([form])',
    'form = Form("booking", buttons, fields)',
    'buttons = Buttons([submit])',
    'submit = Button("提交", @ToAssistant("提交"), "primary")',
    ...lines,
  ].join('\n');

const checkboxProgram = form(
  'fields = [fc]',
  'fc = FormControl("兴趣", checks)',
  'checks = CheckBoxGroup("hobbies", [cbA, cbB])',
  'cbA = CheckBoxItem("徒步", "山区路线", "a", true)',
  'cbB = CheckBoxItem("游泳", "室内泳池", "b", false)',
);

const switchProgram = [
  'root = Card([switches])',
  'switches = SwitchGroup("notify", [mail, push])',
  'mail = SwitchItem("邮件", "每日摘要", "email", true)',
  'push = SwitchItem("推送", "即时提醒", "push", false)',
].join('\n');

const radioProgram = form(
  'fields = [fc]',
  'fc = FormControl("餐食", radios)',
  'radios = RadioGroup("meal", [r1, r2])',
  'r1 = RadioItem("素食", "不含肉", "veg")',
  'r2 = RadioItem("荤食", "含肉", "meat")',
);

const dateProgram = (mode: 'single' | 'range') =>
  form('fields = [fc]', 'fc = FormControl("日期", date)', `date = DatePicker("when", "${mode}")`);

const sliderProgram = form(
  'fields = [fc]',
  'fc = FormControl("数量", slider)',
  'slider = Slider("qty", "discrete", 0, 100, 1)',
);

const tabsProgram = [
  'root = Card([tabs])',
  'tabs = Tabs([tabA, tabB])',
  'tabA = TabItem("a", "页签一", [TextContent("甲内容")])',
  'tabB = TabItem("b", "页签二", [TextContent("乙内容")])',
].join('\n');

const tableProgram = [
  'root = Card([table])',
  'table = EditableTable("items", [c1, c2], [])',
  'c1 = {type: "text", key: "name", header: "名称"}',
  'c2 = {type: "number", key: "qty", header: "数量"}',
].join('\n');

const tableState: State = {
  items: {
    items: {
      value: [
        { id: 'r1', values: ['苹果', 12] },
        { id: 'r2', values: ['梨', 3] },
      ],
      componentType: 'EditableTable',
    },
  },
};

describe('官方 vs 本地差分渲染', () => {
  it('TextContent 文本一致', async () => {
    const p = ['root = Card([t])', 't = TextContent("文本内容")'].join('\n');
    await pair(p, undefined, (a, b) => {
      expect(text(b)).toBe('文本内容');
      expect(text(a)).toBe(text(b));
    });
  });

  it('CheckBoxGroup 默认勾选序列一致', async () => {
    await pair(checkboxProgram, undefined, (a, b) => {
      expect(attrs(b, 'aria-checked')).toEqual(['true', 'false']);
      expect(attrs(a, 'aria-checked')).toEqual(attrs(b, 'aria-checked'));
    });
  });

  it('CheckBoxGroup initialState 勾选序列一致', async () => {
    const state = {
      booking: { hobbies: { value: { a: true, b: true }, componentType: 'CheckBoxGroup' } },
    };
    await pair(checkboxProgram, state, (a, b) => {
      expect(attrs(b, 'aria-checked')).toEqual(['true', 'true']);
      expect(attrs(a, 'aria-checked')).toEqual(attrs(b, 'aria-checked'));
    });
  });

  it('SwitchGroup 默认聚合勾选序列一致', async () => {
    await pair(switchProgram, undefined, (a, b) => {
      expect(attrs(b, 'aria-checked')).toEqual(['true', 'false']);
      expect(attrs(a, 'aria-checked')).toEqual(attrs(b, 'aria-checked'));
    });
  });

  it('RadioGroup initialState 选中序列一致', async () => {
    const state = { booking: { meal: { value: 'meat', componentType: 'RadioGroup' } } };
    await pair(radioProgram, state, (a, b) => {
      expect(attrs(b, 'aria-checked')).toEqual(['false', 'true']);
      expect(attrs(a, 'aria-checked')).toEqual(attrs(b, 'aria-checked'));
    });
  });

  it('DatePicker single initialState 日期一致', async () => {
    const state = { booking: { when: { value: '2026-10-28', componentType: 'DatePicker' } } };
    const p = dateProgram('single');
    await pair(p, state, (a, b) => {
      expect(firstDay(b)).toBe('2026-10-28');
      expect(firstDay(a)).toBe('2026-10-28');
      expect(firstDay(a)).toBe(firstDay(b));
    });
  });

  it('DatePicker range 区间展示：官方 Date 快照与本地 ISO 快照日期集合一致', async () => {
    // 展示层可比：官方选 Date 对象、本地选 ISO 字符串，文本归一后应是同两天。
    const officialState = {
      booking: {
        when: {
          value: { from: new Date(2026, 9, 28), to: new Date(2026, 9, 30) },
          componentType: 'DatePicker',
        },
      },
    };
    const localState = {
      booking: {
        when: { value: { from: '2026-10-28', to: '2026-10-30' }, componentType: 'DatePicker' },
      },
    };
    const p = dateProgram('range');
    const a = await official(p, officialState);
    const b = await local(p, localState);
    expectNoErrors(a);
    expectNoErrors(b);
    expect(days(a.host)).toEqual(['2026-10-28', '2026-10-30']);
    expect(days(a.host)).toEqual(days(b.host));
  });

  it('Slider initialState 数值序列一致', async () => {
    const state = { booking: { qty: { value: [42], componentType: 'Slider' } } };
    await pair(sliderProgram, state, (a, b) => {
      const values = [...b.querySelectorAll<HTMLInputElement>('input[type="range"]')].map(
        (input) => input.value,
      );
      expect(values).toEqual(['42']);
      expect(attrs(a, 'aria-valuenow')).toEqual(values);
    });
  });

  it('Tabs 选中序列一致', async () => {
    await pair(tabsProgram, undefined, (a, b) => {
      expect(attrs(b, 'aria-selected').length).toBeGreaterThan(0);
      expect(attrs(a, 'aria-selected')).toEqual(attrs(b, 'aria-selected'));
    });
  });

  it('EditableTable initialState 单元格值序列一致', async () => {
    await pair(tableProgram, tableState, (a, b) => {
      // 本地是 <input>，inputs facet 直接可用；官方是只读 <span>，inputs 恒为空，故跨端比 cells。
      expect(inputValues(b)).toEqual(['苹果', '12', '梨', '3']);
      expect(cells(b)).toEqual(['苹果', '12', '梨', '3']);
      expect(cells(a)).toEqual(cells(b));
    });
  });
});
