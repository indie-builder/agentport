import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPENUI_COMPONENT_NAMES } from '@agentport/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenUiBlock } from '../src/openui/renderer.js';

/**
 * 升级最重要的回归：官方新增组件后，若没补渲染实现，组件会**静默渲染成空白**——
 * 「名字都在」的断言抓不到。这里对契约里的每个组件各写一段最小程序，
 * 要求渲染出可读内容；失败项就是升级后需要补实现或改字段的地方。
 *
 * 只覆盖能在 Card 里独立出现的组件；Series/Slice/Point 等纯数据类型由父组件用例覆盖。
 * 样例与登记数据在 openui-coverage-registry.json：同一份数据供 scripts/audit-openui-coverage.mjs
 * 输出缺口报告，改这里只改一处。
 */
type Registry = {
  samples: Record<string, { program: string[]; expect: string }>;
  nestedOnly: string[];
  specialized: Array<{ name: string; evidence: string | null; kind: string }>;
};
const REGISTRY: Registry = JSON.parse(
  // 不用 new URL(..., import.meta.url)：vite 会把它静态改写成 http asset URL。
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'openui-coverage-registry.json'),
    'utf8',
  ),
);
const SAMPLES = REGISTRY.samples;
const NESTED_ONLY = new Set(REGISTRY.nestedOnly);
const SPECIALIZED = REGISTRY.specialized;

describe('every contract component renders content', () => {
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
    // Carousel 用 embla：它需要 matchMedia 与 IntersectionObserver，jsdom 默认都没有。
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
    // Carousel 的 embla 在 jsdom 里可能抛错，别让一次失败污染后续用例。
    try {
      await act(async () => root.unmount());
    } catch {
      // 清理失败不影响断言结论。
    }
    host.remove();
    vi.unstubAllGlobals();
  });

  const covered = Object.keys(SAMPLES);

  it('registers every contract component as sample, nested-only or specialized', () => {
    // 升级护栏：官方新增组件时，它既没有样例，也不在嵌套豁免/专项登记里，这条会红。
    // 只检查登记，不检查专项测试文件是否真的存在或覆盖；nestedInteractive
    // 只表示「嵌套且有交互、尚无行为证据」，不参与这里的齐全性判断。
    const malformed = Object.entries(SAMPLES)
      .filter(([, sample]) => !Array.isArray(sample.program) || typeof sample.expect !== 'string')
      .map(([name]) => name);
    expect(malformed, `样例结构不合法：${malformed.join(', ')}`).toEqual([]);
    const accounted = new Set([...covered, ...NESTED_ONLY, ...SPECIALIZED.map(({ name }) => name)]);
    const missing = [...OPENUI_COMPONENT_NAMES].filter((name) => !accounted.has(name));
    expect(
      missing,
      `未登记样例、嵌套豁免或专项的组件（nestedInteractive 不是豁免桶）：${missing.join(', ')}`,
    ).toEqual([]);
  });

  it.each(Object.entries(SAMPLES).map(([name, sample]) => [name, sample] as const))(
    '%s renders readable output',
    async (name, sample) => {
      // 每个用例独立根：Carousel 的 embla 在 jsdom 会抛错，
      // 复用同一个 root 会让后续用例全部连带失败（Should not already be working）。
      const localHost = document.createElement('div');
      document.body.append(localHost);
      const localRoot = createRoot(localHost);
      const program = ['root = Card([t])', ...sample.program].join('\n');
      try {
        await act(async () => {
          localRoot.render(createElement(OpenUiBlock, { program }));
        });
        if (sample.expect !== '') {
          expect(localHost.textContent, `${name} 没有渲染出预期内容`).toContain(sample.expect);
        }
        // 无论内容是否为空，都不能抛错或渲染成完全空白（Separator/Icon 允许无文本）。
        expect(localHost.innerHTML.length, `${name} 渲染为空`).toBeGreaterThan(0);
      } finally {
        try {
          await act(async () => localRoot.unmount());
        } catch {
          // 渲染已失败时卸载也可能抛错，忽略即可。
        }
        localHost.remove();
      }
    },
  );
});
