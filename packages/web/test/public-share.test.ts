import type { PublicOutputShare } from '@agentport/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readShareToken, ShareView } from '../src/routes/s.$shareId.js';

const sha = 'a'.repeat(64);

function file(overrides: Partial<PublicOutputShare['file']> = {}): PublicOutputShare['file'] {
  return {
    name: 'report.md',
    size: 1234,
    mediaType: 'text/markdown',
    sha256: sha,
    createdAt: '2026-10-28T10:00:00.000Z',
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Call = { url: string; init: RequestInit | undefined };

function installFetch(handle: (url: string) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({ url, init });
    return handle(url);
  }) as typeof fetch);
  return calls;
}

let host: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function mount(shareId: string, token: string | null) {
  await act(async () => {
    root.render(createElement(ShareView, { shareId, token }));
  });
  await flush();
}

function h1(): string | null | undefined {
  return host.querySelector('h1')?.textContent;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/s/share-a#token-a');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.history.replaceState(null, '', '/');
  document.title = '控制台';
  document.querySelector('meta[name="referrer"]')?.remove();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('public share page', () => {
  it('renders metadata and markdown, and downloads with a bearer token', async () => {
    const shared = file();
    const calls = installFetch((url) => {
      if (url.endsWith('/content'))
        return json({ file: shared, content: '# 发布说明\n\n正文内容' });
      if (url.endsWith('/download'))
        return new Response(new Blob(['bytes'], { type: 'text/markdown' }));
      return json({ file: shared });
    });
    const createObjectURL = vi.fn(() => 'blob:download');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    let clicked: HTMLAnchorElement | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked = this;
    });

    await mount('share-a', readShareToken());

    expect(h1()).toBe('report.md');
    expect(host.textContent).toContain('1 KB');
    expect(host.querySelector('h2')?.textContent).toBe('发布说明');
    expect(document.title).toBe('report.md · PACE');
    expect(document.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe(
      'no-referrer',
    );

    expect(calls[0]?.url).toBe('/api/public/output-shares/share-a');
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer token-a' });
    expect(calls[0]?.init?.credentials).toBe('omit');
    expect(calls.some((call) => call.url.endsWith('/content'))).toBe(true);

    const download = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === '下载',
    );
    if (!download) throw new Error('Missing download action');
    await act(async () => download.click());
    await flush();

    const downloadCall = calls.find((call) => call.url.endsWith('/download'));
    expect(downloadCall?.init?.headers).toMatchObject({ authorization: 'Bearer token-a' });
    expect(createObjectURL).toHaveBeenCalled();
    expect(clicked).not.toBeNull();
    expect(clicked?.download).toBe('report.md');
  });

  it('shows one invalid state for a missing token and does not fetch', async () => {
    expect(readShareToken()).toBe('token-a');
    window.history.replaceState(null, '', '/s/share-a');
    expect(readShareToken()).toBeNull();
    const fetch = vi.spyOn(globalThis, 'fetch');
    await mount('share-a', null);

    expect(h1()).toBe('链接无效或已撤销');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('treats a 404 as invalid without retrying', async () => {
    const calls = installFetch(() =>
      json({ code: 'NOT_FOUND', message: '分享不存在或已失效' }, 404),
    );
    await mount('share-a', readShareToken());

    expect(h1()).toBe('链接无效或已撤销');
    expect(calls).toHaveLength(1);
  });

  it('renders HTML as source code instead of executing it', async () => {
    const shared = file({ name: 'page.html', mediaType: 'text/html' });
    installFetch((url) =>
      url.endsWith('/content')
        ? json({
            file: shared,
            content: '<script>window.sharedPwned = true</script>\n<img src="x" onerror="alert(1)">',
          })
        : json({ file: shared }),
    );

    await mount('share-a', readShareToken());

    expect(h1()).toBe('page.html');
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('section img')).toBeNull();
    expect(host.querySelector('pre')?.textContent).toContain('<script>');
    expect((window as { sharedPwned?: boolean }).sharedPwned).toBeUndefined();
  });

  it('keeps the token fragment on in-page anchors and re-fetches with it after remount', async () => {
    const shared = file();
    const calls = installFetch((url) =>
      url.endsWith('/content')
        ? json({
            file: shared,
            content: '# 发布说明\n\n[跳到小节](#part) · [不存在的目标](#missing)\n',
          })
        : json({ file: shared }),
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const target = document.createElement('div');
    target.id = 'part';
    document.body.append(target);

    await mount('share-a', readShareToken());
    const anchor = host.querySelector<HTMLAnchorElement>('a[href="#part"]');
    if (!anchor) throw new Error('Missing in-page anchor');
    // 原生链接的键盘 Enter 会派发 click，这里用同一条激活路径验证。
    await act(async () => anchor.click());
    await flush();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#token-a');

    const missing = host.querySelector<HTMLAnchorElement>('a[href="#missing"]');
    if (!missing) throw new Error('Missing fragment anchor');
    await act(async () => missing.click());
    await flush();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#token-a');

    // 刷新等同于重新挂载：token 仍从地址片段读出，正文请求继续带 bearer token。
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount('share-a', readShareToken());
    expect(h1()).toBe('report.md');
    const contentCalls = calls.filter((call) => call.url.endsWith('/content'));
    expect(contentCalls.length).toBeGreaterThanOrEqual(2);
    expect(contentCalls.at(-1)?.init?.headers).toMatchObject({
      authorization: 'Bearer token-a',
    });

    target.remove();
  });

  it('loads image bytes with the bearer token for the preview', async () => {
    const shared = file({ name: 'photo.png', mediaType: 'image/png' });
    const calls = installFetch((url) =>
      url.endsWith('/download')
        ? new Response(new Blob(['png'], { type: 'image/png' }))
        : json({ file: shared }),
    );
    const createObjectURL = vi.fn(() => 'blob:image');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });

    await mount('share-a', readShareToken());

    const image = host.querySelector('section img');
    expect(image?.getAttribute('src')).toBe('blob:image');
    expect(image?.getAttribute('alt')).toBe('photo.png');
    // decode 之前是占位；只有真正触发 load 才算预览成功。
    expect(image?.className).toContain('hidden');
    await act(async () => image?.dispatchEvent(new Event('load')));
    expect(host.querySelector('section img')?.className).not.toContain('hidden');
    expect(host.querySelector('section [aria-busy="true"]')).toBeNull();
    expect(calls.some((call) => call.url.endsWith('/download'))).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/content'))).toBe(false);
    const downloadCall = calls.find((call) => call.url.endsWith('/download'));
    expect(downloadCall?.init?.headers).toMatchObject({ authorization: 'Bearer token-a' });
    expect(downloadCall?.init?.credentials).toBe('omit');
  });

  it('shows a decode failure with the bearer download still available', async () => {
    const shared = file({ name: 'photo.png', mediaType: 'image/png' });
    const calls = installFetch((url) =>
      url.endsWith('/download')
        ? new Response(new Blob(['broken'], { type: 'image/png' }))
        : json({ file: shared }),
    );
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:broken'), revokeObjectURL: vi.fn() });

    await mount('share-a', readShareToken());
    const image = host.querySelector('section img');
    if (!image) throw new Error('Missing image preview');
    await act(async () => image.dispatchEvent(new Event('error')));

    expect(host.textContent).toContain('图片无法解码，请下载原件查看。');
    expect(calls.some((call) => call.url.endsWith('/download'))).toBe(true);
    const download = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === '下载',
    );
    if (!download) throw new Error('Missing download action');
    await act(async () => download.click());
    await flush();
    const downloadCalls = calls.filter((call) => call.url.endsWith('/download'));
    expect(downloadCalls.at(-1)?.init?.headers).toMatchObject({ authorization: 'Bearer token-a' });
  });
});
