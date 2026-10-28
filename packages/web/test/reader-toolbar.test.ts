import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReaderToolbar } from '../src/components/reader-toolbar.js';

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
  vi.unstubAllGlobals();
});

describe('ReaderToolbar layout', () => {
  it('keeps every operation inside the reader column when it is narrow', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    await act(async () => {
      root.render(
        createElement(ReaderToolbar, {
          identity: createElement('span', null, '正文.md'),
          meta: createElement('span', null, '12 B'),
          mode: 'read',
          onModeChange: () => {},
          copy: { value: '# 正文', label: '复制 正文.md' },
          download: { href: '/api/file', label: '下载 正文.md' },
          actions: createElement('button', { type: 'button' }, '基于此版本修改'),
        }),
      );
    });

    const copy = host.querySelector<HTMLButtonElement>('button[aria-label="复制 正文.md"]');
    if (!copy) throw new Error('Missing copy action');
    const actions = copy.parentElement;
    if (!actions) throw new Error('Missing actions container');
    // jsdom 没有布局：这里守住宽度上限契约，320px 的实际几何由浏览器复核。
    expect(actions.className).toContain('max-w-full');

    const controls = {
      read: [...host.querySelectorAll<HTMLElement>('button')].find(
        (item) => item.textContent?.trim() === '阅读',
      ),
      source: [...host.querySelectorAll<HTMLElement>('button')].find(
        (item) => item.textContent?.trim() === '源码',
      ),
      copy,
      download: host.querySelector<HTMLElement>('a[aria-label="下载 正文.md"]'),
      action: [...host.querySelectorAll<HTMLElement>('button')].find(
        (item) => item.textContent?.trim() === '基于此版本修改',
      ),
    };
    for (const control of Object.values(controls)) {
      expect(control).not.toBeUndefined();
      if (!control) continue;
      expect(actions.contains(control)).toBe(true);
      control.focus();
      expect(document.activeElement).toBe(control);
    }
  });
});
