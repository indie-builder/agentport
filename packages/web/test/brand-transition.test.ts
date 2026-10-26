import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { animateBrand, Brand } from '../src/components/brand.js';

const transitions = vi.hoisted(() => [] as Array<() => void>);
vi.mock('motion/mini', () => ({
  animate: () =>
    Object.assign(new Promise<void>((resolve) => transitions.push(resolve)), { cancel() {} }),
}));

let cleanup = async () => {};
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  transitions.length = 0;
});

async function mount(reducedMotion = false) {
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }));
  vi.stubGlobal('Image', function Image() {
    const image = document.createElement('img');
    image.decode = async () => {};
    return image;
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () =>
    root.render(
      createElement('button', { type: 'button', onClick: animateBrand }, createElement(Brand)),
    ),
  );
  return host;
}

it('changes the picture even when reduced motion disables the transition', async () => {
  const host = await mount(true);
  const image = host.querySelector('img');
  await act(async () => host.querySelector('button')?.click());
  expect(image?.getAttribute('src')).toBe('/brand/scenarios/pace-welcome.webp');
});

it('crossfades both pictures together, ignores rapid clicks and hides the incoming layer after finishing', async () => {
  const host = await mount();
  const image = host.querySelector('img');
  await act(async () => host.querySelector('button')?.click());
  expect(host.querySelectorAll('img')).toHaveLength(2);
  expect(host.querySelector('img[aria-hidden="true"]')?.getAttribute('src')).toBe(
    '/brand/scenarios/pace-welcome.webp',
  );
  expect(image?.getAttribute('src')).toBe('/brand/pace-wordmark.webp');
  await act(async () => host.querySelector('button')?.click());
  expect(host.querySelectorAll('img')).toHaveLength(2);
  await act(async () => transitions.shift()?.());
  expect(image?.getAttribute('src')).toBe('/brand/pace-wordmark.webp');
  await act(async () => transitions.shift()?.());
  expect(image?.getAttribute('src')).toBe('/brand/scenarios/pace-welcome.webp');
  expect(host.querySelector('[data-brand-incoming]')?.getAttribute('class')).toContain('opacity-0');
  expect(host.querySelector<HTMLElement>('[data-brand-incoming]')?.style.opacity).toBe('');
  await act(async () => host.querySelector('button')?.click());
  await act(async () => {
    transitions.shift()?.();
    transitions.shift()?.();
  });
  expect(image?.getAttribute('src')).toBe('/brand/scenarios/pace-working.webp');
});
