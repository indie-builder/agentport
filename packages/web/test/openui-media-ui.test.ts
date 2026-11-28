import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ImageBlock,
  ImageGallery,
  ImageRenderer,
  ImageText,
  ImageTextLarge,
} from '../src/openui/components/content.js';

/**
 * 媒体组件按官方语义渲染：Image 用 3:2 比例提前占位并完整容纳原图，ImageBlock 保原图比例；
 * jsdom 量不到真实几何，这里只断言真实 src/alt/文案与明确的尺寸/比例声明。
 */
const renderNode = () => null;

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
});

async function mount(element: ReactElement) {
  await act(async () => root.render(element));
}

async function failImages() {
  for (const img of host.querySelectorAll('img')) {
    await act(async () => {
      img.dispatchEvent(new Event('error'));
    });
  }
}

async function loadImages() {
  for (const img of host.querySelectorAll('img')) {
    await act(async () => {
      img.dispatchEvent(new Event('load'));
    });
  }
}

describe('Image / ImageBlock', () => {
  it('reserves a 3:2 box for Image and contains the whole picture instead of cropping it', async () => {
    await mount(
      createElement(ImageRenderer, {
        props: { src: 'https://example.com/a.png', alt: '示例图' },
        renderNode,
      }),
    );
    const img = host.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://example.com/a.png');
    expect(img?.getAttribute('alt')).toBe('示例图');
  });

  it('renders no image at all without a URL', async () => {
    await mount(createElement(ImageRenderer, { props: { alt: '无地址' }, renderNode }));
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toBe('');
  });

  it('keeps the reserved box and shows alt text when the image fails', async () => {
    await mount(
      createElement(ImageRenderer, {
        props: { src: 'https://example.com/broken.png', alt: '加载失败的图' },
        renderNode,
      }),
    );
    await failImages();
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('加载失败的图');
  });

  it('keeps ImageBlock at the image natural ratio with no forced height or aspect box', async () => {
    await mount(
      createElement(ImageBlock, {
        props: { src: 'https://example.com/block.png', alt: '图块' },
        renderNode,
      }),
    );
    const img = host.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://example.com/block.png');
    expect(img?.getAttribute('alt')).toBe('图块');
  });

  it('shows a skeleton in the ImageBlock container until the image loads', async () => {
    await mount(
      createElement(ImageBlock, {
        props: { src: 'https://example.com/slow.png', alt: '慢图' },
        renderNode,
      }),
    );
    expect(host.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    await loadImages();
    expect(host.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(host.querySelector('img')).not.toBeNull();
  });

  it('shows readable alt text for ImageBlock when the image fails', async () => {
    await mount(
      createElement(ImageBlock, {
        props: { src: 'https://example.com/broken-block.png', alt: '图块加载失败' },
        renderNode,
      }),
    );
    await failImages();
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('图块加载失败');
  });

  it('keeps a long failure alt fully reachable instead of cropping it', async () => {
    const alt = '超长图片说明'.repeat(30);
    await mount(
      createElement(ImageRenderer, {
        props: { src: 'https://example.com/long-broken.png', alt },
        renderNode,
      }),
    );
    await failImages();
    const text = host.querySelector('span');
    expect(text?.textContent).toBe(alt);
  });

  it('renders no ImageBlock without a URL', async () => {
    await mount(createElement(ImageBlock, { props: { src: '' }, renderNode }));
    expect(host.innerHTML).toBe('');
  });

  it('recovers when streaming replaces a broken src with a valid one', async () => {
    await mount(
      createElement(ImageBlock, {
        props: { src: 'https://example.com/partial', alt: '流式图' },
        renderNode,
      }),
    );
    await failImages();
    expect(host.querySelector('img')).toBeNull();
    await mount(
      createElement(ImageBlock, {
        props: { src: 'https://example.com/partial.png', alt: '流式图' },
        renderNode,
      }),
    );
    expect(host.querySelector('img')?.getAttribute('src')).toBe('https://example.com/partial.png');
  });

  it('retries a failed src after switching away and back', async () => {
    const props = (src: string) => ({ src, alt: '来回切换' });
    await mount(
      createElement(ImageBlock, { props: props('https://example.com/a.png'), renderNode }),
    );
    await failImages();
    expect(host.querySelector('img')).toBeNull();
    await mount(
      createElement(ImageBlock, { props: props('https://example.com/b.png'), renderNode }),
    );
    expect(host.querySelector('img')?.getAttribute('src')).toBe('https://example.com/b.png');
    await mount(
      createElement(ImageBlock, { props: props('https://example.com/a.png'), renderNode }),
    );
    expect(host.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
  });

  it('keeps the failure state while the same src re-renders', async () => {
    await mount(
      createElement(ImageBlock, {
        props: { src: 'https://example.com/broken.png', alt: '别反复请求' },
        renderNode,
      }),
    );
    await failImages();
    for (let i = 0; i < 2; i += 1) {
      await mount(
        createElement(ImageBlock, {
          props: { src: 'https://example.com/broken.png', alt: '别反复请求' },
          renderNode,
        }),
      );
      expect(host.querySelector('img')).toBeNull();
    }
  });
});

describe('ImageGallery', () => {
  it('keeps responsive columns, real alt text and the full caption', async () => {
    const caption =
      '这是一段很长很长的图片说明，用来确认画廊不会把说明截断或丢弃任何文字，窄屏和宽屏都应完整可读。';
    await mount(
      createElement(ImageGallery, {
        props: {
          images: [
            { src: 'https://example.com/1.png', alt: '画廊一', details: caption },
            { src: 'https://example.com/2.png', alt: '画廊二' },
          ],
        },
        renderNode,
      }),
    );
    const images = [...host.querySelectorAll('img')];
    expect(images.map((img) => img.getAttribute('alt'))).toEqual(['画廊一', '画廊二']);
    const figcaption = host.querySelector('figcaption');
    expect(figcaption?.textContent).toBe(caption);
  });

  it('renders nothing without usable sources', async () => {
    await mount(
      createElement(ImageGallery, {
        props: { images: [{ src: '' }, { details: '没有地址' }] },
        renderNode,
      }),
    );
    expect(host.innerHTML).toBe('');
  });

  it('opens preview dialog with prev/next navigation on click', async () => {
    await mount(
      createElement(ImageGallery, {
        props: {
          images: [
            { src: 'https://example.com/1.png', alt: '第一张', details: '说明一' },
            { src: 'https://example.com/2.png', alt: '第二张', details: '说明二' },
          ],
        },
        renderNode,
      }),
    );
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="预览 第一张"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('第一张');
    expect(dialog?.textContent).toContain('说明一');

    const nextBtn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('下一张'),
    );
    await act(async () => nextBtn?.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('第二张');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('说明二');
  });

  it('collapses >5 images behind a show-all button and handles load failures and duplicate URLs', async () => {
    await mount(
      createElement(ImageGallery, {
        props: {
          images: [
            { src: 'https://example.com/same.png', alt: '图1' },
            { src: 'https://example.com/same.png', alt: '图2' },
            { src: 'https://example.com/3.png', alt: '图3' },
            { src: 'https://example.com/4.png', alt: '图4' },
            { src: 'https://example.com/5.png', alt: '图5' },
            { src: 'https://example.com/6.png', alt: '图6' },
          ],
        },
        renderNode,
      }),
    );
    expect(host.querySelectorAll('figure')).toHaveLength(5);
    const showAll = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('查看全部（6 张）'),
    );
    expect(showAll).toBeTruthy();
    await act(async () => showAll?.click());
    expect(host.querySelectorAll('figure')).toHaveLength(6);

    const firstImg = host.querySelector('img');
    await act(async () => {
      firstImg?.dispatchEvent(new Event('error'));
    });
    expect(host.querySelectorAll('img')).toHaveLength(5);
    expect(host.textContent).toContain('图1');
  });
});

describe('ImageText', () => {
  it('uses the official 40px square thumbnail for horizontal layout', async () => {
    await mount(
      createElement(ImageText, {
        props: {
          src: 'https://example.com/avatar.png',
          title: '标题',
          subtitle: '副标题',
          bold: true,
          layout: 'horizontal',
        },
        renderNode,
      }),
    );
    const img = host.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://example.com/avatar.png');
    expect(img?.getAttribute('alt')).toBe('标题');
    const box = img?.parentElement as HTMLElement;
    expect(box.className).toContain('size-(--media-size)');
    expect(box.style.getPropertyValue('--media-size')).toBe('40px');
    expect(host.textContent).toContain('标题');
    expect(host.textContent).toContain('副标题');
  });

  it('honours imageSize without turning the small image into a banner', async () => {
    await mount(
      createElement(ImageText, {
        props: {
          src: 'https://example.com/logo.png',
          title: '标题',
          bold: false,
          layout: 'horizontal',
          imageSize: 64,
        },
        renderNode,
      }),
    );
    const box = host.querySelector('img')?.parentElement as HTMLElement;
    expect(box.className).toContain('size-(--media-size)');
    expect(box.style.getPropertyValue('--media-size')).toBe('64px');
  });

  it('stacks a vertical layout with the official default size', async () => {
    await mount(
      createElement(ImageText, {
        props: {
          src: 'https://example.com/v.png',
          title: '竖排标题',
          bold: false,
          layout: 'vertical',
        },
        renderNode,
      }),
    );
    const box = host.querySelector('img')?.parentElement as HTMLElement;
    expect(box.className).toContain('size-(--media-size)');
    expect(box.style.getPropertyValue('--media-size')).toBe('40px');
  });
});

describe('ImageTextLarge', () => {
  it('reserves the 3:2 banner above the title and subtitle', async () => {
    await mount(
      createElement(ImageTextLarge, {
        props: {
          src: 'https://example.com/banner.png',
          alt: '横幅',
          title: '大图标题',
          subtitle: '大图说明',
          bold: false,
        },
        renderNode,
      }),
    );
    const img = host.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://example.com/banner.png');
    expect(img?.getAttribute('alt')).toBe('横幅');
    expect(host.textContent).toContain('大图标题');
    expect(host.textContent).toContain('大图说明');
  });
});
