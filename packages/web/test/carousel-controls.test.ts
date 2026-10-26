import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '../src/components/ui/carousel.js';

// jsdom 没有布局，Embla 算不出可滚动的吸附点；只在模块边界替换 API，
// 仍然验证生产组件传给官方 scrollPrev/scrollNext 的 jump 参数。
const embla = vi.hoisted(() => ({
  api: {
    scrollPrev: vi.fn(),
    scrollNext: vi.fn(),
    canScrollPrev: () => true,
    canScrollNext: () => true,
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('embla-carousel-react', () => ({
  default: () => [vi.fn(), embla.api],
}));

let host: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  embla.api.scrollPrev.mockClear();
  embla.api.scrollNext.mockClear();
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
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

async function mountCarousel() {
  await act(async () => {
    root?.render(
      createElement(
        Carousel,
        null,
        createElement(
          CarouselContent,
          null,
          createElement(CarouselItem, null, '第一张'),
          createElement(CarouselItem, null, '第二张'),
        ),
        createElement(CarouselPrevious),
        createElement(CarouselNext),
      ),
    );
  });
  const region = host?.querySelector<HTMLElement>('[data-slot="carousel"]');
  const next = host?.querySelector<HTMLButtonElement>('[data-slot="carousel-next"]');
  const previous = host?.querySelector<HTMLButtonElement>('[data-slot="carousel-previous"]');
  if (!region || !next || !previous) throw new Error('carousel did not render');
  return { region, next, previous };
}

async function press(region: HTMLElement, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await act(async () => {
    region.dispatchEvent(event);
  });
  return event;
}

describe('carousel scrolling without reduced motion', () => {
  it('jumps immediately for arrow keys but keeps the animated button transition', async () => {
    const { region, next, previous } = await mountCarousel();

    const right = await press(region, 'ArrowRight');
    expect(right.defaultPrevented).toBe(true);
    expect(embla.api.scrollNext).toHaveBeenCalledWith(true);

    const left = await press(region, 'ArrowLeft');
    expect(left.defaultPrevented).toBe(true);
    expect(embla.api.scrollPrev).toHaveBeenCalledWith(true);

    await act(async () => next.click());
    expect(embla.api.scrollNext).toHaveBeenLastCalledWith(false);

    await act(async () => previous.click());
    expect(embla.api.scrollPrev).toHaveBeenLastCalledWith(false);
  });
});
