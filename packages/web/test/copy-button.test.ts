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
  it('crossfades the copy and success icons without replacing the button', async () => {
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
    const icons = [...button.querySelectorAll('svg')];
    const checkIcon = icons.find((icon) => icon.classList.contains('text-success'));
    const copyIcon = icons.find((icon) => icon !== checkIcon);
    if (!checkIcon || !copyIcon) throw new Error('missing stacked icons');

    expect(icons).toHaveLength(2);
    expect(checkIcon.getAttribute('data-icon')).toBe('inline-start');
    expect(copyIcon.getAttribute('data-icon')).toBe('inline-start');
    expect(copyIcon.classList.contains('opacity-100')).toBe(true);
    expect(checkIcon.classList.contains('opacity-0')).toBe(true);

    await act(async () => button.click());

    expect(writeText).toHaveBeenCalledWith('run-1');
    expect(host.querySelector('button')).toBe(button);
    expect(copyIcon.classList.contains('opacity-0')).toBe(true);
    expect(checkIcon.classList.contains('opacity-100')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('已复制');

    await act(async () => vi.advanceTimersByTime(1500));

    expect(copyIcon.classList.contains('opacity-100')).toBe(true);
    expect(checkIcon.classList.contains('opacity-0')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('复制编号');
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

    // A 的旧计时器不能在切到 B 后把反馈提前收掉。
    await act(async () => vi.advanceTimersByTime(750));
    expect(button.getAttribute('aria-label')).toBe('已复制');
    await act(async () => vi.advanceTimersByTime(750));
    expect(button.getAttribute('aria-label')).toBe('复制编号');
  });
});
