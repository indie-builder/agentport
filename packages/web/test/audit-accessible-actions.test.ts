import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SearchInput } from '../src/components/search-input.js';

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function Harness() {
  const [value, setValue] = useState('审计登录');
  return createElement(SearchInput, {
    value,
    onChange: setValue,
    label: '按动作前缀过滤',
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('SearchInput clear action', () => {
  it('keeps the clear action named after its field and still clears the value', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(Harness)));

    const clear = host.querySelector<HTMLButtonElement>(
      'button[aria-label="清除：按动作前缀过滤"]',
    );
    expect(clear).not.toBeNull();
    await act(async () => clear?.click());

    expect(host.querySelector<HTMLInputElement>('input')?.value).toBe('');
  });
});
