import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from '../src/components/copy-button.js';

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CopyButton feedback', () => {
  it('shows copied feedback for 2.5 seconds without replacing the button', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    act(() =>
      root.render(
        createElement(CopyButton, { value: 'run-1', label: '复制编号', showLabel: true }),
      ),
    );

    const button = host.querySelector('button');
    if (!button) throw new Error('missing copy button');
    expect(button.getAttribute('aria-label')).toBe('复制编号');

    await act(async () => button.click());

    expect(writeText).toHaveBeenCalledWith('run-1');
    expect(host.querySelector('button')).toBe(button);
    expect(button.getAttribute('aria-label')).toBe('已复制');
    expect(button.textContent).toContain('已复制');

    await act(async () => vi.advanceTimersByTime(2500));

    expect(button.getAttribute('aria-label')).toBe('复制编号');
    expect(button.textContent).toContain('复制编号');
  });

  it('drops the copied state and its timer when the copied value changes', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const render = (value: string) =>
      act(() =>
        root.render(createElement(CopyButton, { value, label: '复制编号', showLabel: true })),
      );
    render('A');

    const button = host.querySelector('button');
    if (!button) throw new Error('missing copy button');
    await act(async () => button.click());
    expect(writeText).toHaveBeenLastCalledWith('A');
    expect(button.getAttribute('aria-label')).toBe('已复制');

    render('B');
    expect(host.querySelector('button')).toBe(button);
    expect(button.getAttribute('aria-label')).toBe('复制编号');

    await act(async () => button.click());
    expect(writeText).toHaveBeenLastCalledWith('B');

    await act(async () => vi.advanceTimersByTime(2000));
    expect(button.getAttribute('aria-label')).toBe('已复制');
    await act(async () => vi.advanceTimersByTime(500));
    expect(button.getAttribute('aria-label')).toBe('复制编号');
  });
});
