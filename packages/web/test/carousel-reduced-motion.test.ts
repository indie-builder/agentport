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

// 与 carousel-controls.test.ts 相同，在 Embla 的 DOM 测量边界替换 API；
// 这里单独成文件，让 motion 的 reduced-motion 监听在首次挂载前读到 reduce 偏好。
const embla = vi.hoisted(() => ({
  api: {
    scrollPrev: vi.fn(),
    scrollNext: vi.fn(),
    scrollTo: vi.fn(),
    selectedScrollSnap: vi.fn(() => 1),
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
  embla.api.scrollTo.mockClear();
  embla.api.on.mockClear();
  embla.api.off.mockClear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
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

function pointerUpHandler() {
  const registration = embla.api.on.mock.calls.find((call) => call[0] === 'pointerUp');
  if (!registration) throw new Error('pointerUp handler was not registered');
  return registration[1] as () => void;
}

describe('carousel scrolling with reduced motion', () => {
  it('jumps instead of running the JS animation for buttons and arrow keys', async () => {
    const { region, next, previous } = await mountCarousel();

    await act(async () => next.click());
    expect(embla.api.scrollNext).toHaveBeenLastCalledWith(true);

    await act(async () => previous.click());
    expect(embla.api.scrollPrev).toHaveBeenLastCalledWith(true);

    await act(async () => {
      region.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
    });
    expect(embla.api.scrollNext).toHaveBeenLastCalledWith(true);
  });

  it('drops the drag inertia by jumping to the selected snap on pointerUp, then unsubscribes', async () => {
    await mountCarousel();
    const handler = pointerUpHandler();

    await act(async () => handler());
    expect(embla.api.scrollTo).toHaveBeenCalledWith(1, true);

    await act(async () => root?.unmount());
    root = undefined;
    expect(embla.api.off).toHaveBeenCalledWith('pointerUp', handler);
  });
});
