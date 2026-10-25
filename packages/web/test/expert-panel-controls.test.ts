import type { OutputStyle } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { OutputStylesPanel } from '../src/pages/memory-panel.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const style: OutputStyle = {
  id: 'style-1',
  agentId: 'expert',
  slug: 'concise',
  description: '简短',
  keepCodingInstructions: false,
  body: '',
  isSelected: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function waitFor<T>(probe: () => T, tries = 40): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const value = probe();
      if (value) return value;
    } catch {
      // 查询还没落地，继续等。
    }
    await flush();
  }
  return probe();
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}
async function edit(id: string, value: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing input: ${id}`);
  }
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}
function control(id: string): HTMLInputElement | HTMLTextAreaElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing control: ${id}`);
  }
  return element;
}

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false }, mutations: { retry: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(api, 'agentOutputStyles').mockResolvedValue([style]);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});

describe('output style editor controls', () => {
  it('labels every created field and keeps dirty/pending in sync with the save request', async () => {
    const onDirtyChange = vi.fn();
    const onPendingChange = vi.fn();
    const saved = deferred<OutputStyle>();
    const write = vi.spyOn(api, 'writeAgentOutputStyle').mockReturnValue(saved.promise);

    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(OutputStylesPanel, {
            agentId: 'expert',
            onDirtyChange,
            onPendingChange,
          }),
        ),
      );
    });
    await waitFor(() => host.querySelector('button'));
    await click(button('新建风格'));

    expect(host.querySelector('label[for="output-style-slug"]')?.textContent).toBe('风格 slug');
    expect(host.querySelector('label[for="output-style-description"]')?.textContent).toBe(
      '风格描述',
    );
    expect(host.querySelector('label[for="output-style-body"]')?.textContent).toBe('风格内容');
    expect(host.querySelector('label[for="output-style-keep-coding"]')?.textContent).toBe(
      '保留编码指令',
    );
    expect(control('output-style-slug').tagName).toBe('INPUT');
    expect(control('output-style-description').tagName).toBe('INPUT');
    expect(control('output-style-body').tagName).toBe('TEXTAREA');

    await edit('output-style-slug', 'concise');
    await edit('output-style-description', '更短的回答');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    await click(button('风格保存'));
    expect(write).toHaveBeenCalledWith('expert', 'concise', {
      description: '更短的回答',
      keepCodingInstructions: false,
      body: '',
    });
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    const saving = button('保存中…');
    expect(saving.disabled).toBe(true);
    expect(saving.getAttribute('aria-busy')).toBe('true');
    expect(control('output-style-slug').disabled).toBe(true);
    expect(control('output-style-description').disabled).toBe(true);
    expect(control('output-style-body').disabled).toBe(true);
    expect(control('output-style-keep-coding').disabled).toBe(true);

    saved.resolve({ ...style, description: '更短的回答' });
    await flush();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(button('风格保存').disabled).toBe(true);
    expect(control('output-style-description').disabled).toBe(false);
  });
});
