import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlobPdf } from '../src/components/blob-pdf.js';

const UNSUPPORTED = '当前浏览器不支持 PDF 预览，请下载原件查看。';
const INVALID = '文件不是可预览的 PDF，请下载原件查看。';
const READ_ERROR = 'PDF 读取失败，请下载原件查看。';

let host: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function setViewer(enabled: boolean | undefined) {
  Object.defineProperty(navigator, 'pdfViewerEnabled', { configurable: true, value: enabled });
}

function pdf(parts: BlobPart[], type = 'application/pdf') {
  return new Blob(parts, { type });
}

function header(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function deferredHeader() {
  let resolve!: (value: ArrayBuffer) => void;
  const promise = new Promise<ArrayBuffer>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 前 5 字节读取可被测试挂起，其余切片仍是真实 Blob。 */
class DeferredHeaderBlob extends Blob {
  constructor(
    text: string,
    private readonly headerResult: Promise<ArrayBuffer>,
  ) {
    super([text], { type: 'application/pdf' });
  }

  override slice(start?: number, end?: number, contentType?: string): Blob {
    if (start === 0 && end === 5) {
      return { arrayBuffer: () => this.headerResult } as unknown as Blob;
    }
    return super.slice(start, end, contentType);
  }
}

function stubUrls() {
  let seed = 0;
  const create = vi.fn((_blob: Blob) => `blob:pdf-${++seed}`);
  const revoke = vi.fn();
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
  return { create, revoke };
}

async function mount(
  blob: Blob,
  title = 'report.pdf',
  className = 'h-[50vh] w-full',
  page?: number,
) {
  await act(async () => {
    root.render(createElement(BlobPdf, { blob, title, className, page }));
  });
  await flush();
}

function iframe(): HTMLIFrameElement | null {
  return host.querySelector('iframe');
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(navigator, 'pdfViewerEnabled');
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
  vi.restoreAllMocks();
});

describe('BlobPdf', () => {
  it.each([false, undefined])(
    'does not mount a viewer when the browser has none: %s',
    async (enabled) => {
      setViewer(enabled);
      const { create } = stubUrls();
      await mount(pdf(['%PDF-1.4\nbody']));

      expect(host.textContent).toContain(UNSUPPORTED);
      expect(iframe()).toBeNull();
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('rejects bytes without the PDF header before creating a URL', async () => {
    setViewer(true);
    const { create } = stubUrls();
    await mount(pdf(['not a pdf']));

    expect(host.textContent).toContain(INVALID);
    expect(iframe()).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('reports a read failure without creating a viewer when the header read rejects', async () => {
    setViewer(true);
    const { create } = stubUrls();
    await mount(
      new DeferredHeaderBlob(
        '%PDF-1.4 body',
        Promise.reject(new DOMException('unreadable', 'NotReadableError')),
      ),
    );

    expect(host.textContent).toContain(READ_ERROR);
    expect(host.textContent).not.toContain(INVALID);
    expect(iframe()).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('mounts an iframe with the component URL and title after the header passes', async () => {
    setViewer(true);
    const { create } = stubUrls();
    await mount(pdf(['%PDF-1.7\nbody']), 'report.pdf', 'h-[50vh] w-full rounded-card border');

    const frame = iframe();
    expect(frame?.getAttribute('src')).toBe('blob:pdf-1');
    expect(frame?.getAttribute('title')).toBe('report.pdf');
    expect(frame?.className).toContain('h-[50vh]');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('forces the PDF MIME when the downloaded blob has a generic type', async () => {
    setViewer(true);
    const { create } = stubUrls();
    await mount(pdf(['%PDF-1.4\nbody'], 'application/octet-stream'));

    expect(iframe()).not.toBeNull();
    const shown = create.mock.calls[0]?.[0];
    expect(shown?.type).toBe('application/pdf');
  });

  it('stops showing the old document immediately when the blob changes', async () => {
    setViewer(true);
    const { create, revoke } = stubUrls();
    await mount(pdf(['%PDF-1.4 first']));
    expect(iframe()?.getAttribute('src')).toBe('blob:pdf-1');

    const late = deferredHeader();
    await act(async () => {
      root.render(
        createElement(BlobPdf, {
          blob: new DeferredHeaderBlob('%PDF-1.4 second', late.promise),
          title: 'report.pdf',
        }),
      );
    });
    await flush();

    expect(iframe()).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:pdf-1');
    expect(create).toHaveBeenCalledTimes(1);

    await act(async () => late.resolve(header('%PDF-')));
    await flush();
    expect(iframe()?.getAttribute('src')).toBe('blob:pdf-2');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('drops a late header result for a blob that was already replaced', async () => {
    setViewer(true);
    const { create } = stubUrls();
    const late = deferredHeader();
    await mount(new DeferredHeaderBlob('%PDF-1.4 first', late.promise));
    expect(iframe()).toBeNull();

    await act(async () => {
      root.render(createElement(BlobPdf, { blob: pdf(['%PDF-1.4 second']), title: 'report.pdf' }));
    });
    await flush();
    expect(iframe()?.getAttribute('src')).toBe('blob:pdf-1');

    await act(async () => late.resolve(header('%PDF-')));
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(iframe()?.getAttribute('src')).toBe('blob:pdf-1');
  });

  it('appends the page fragment and reuses the same object URL when the page changes', async () => {
    setViewer(true);
    const { create, revoke } = stubUrls();
    const doc = pdf(['%PDF-1.4 body']);
    await mount(doc, 'report.pdf', 'h-[50vh] w-full', 3);

    expect(iframe()?.getAttribute('src')).toBe('blob:pdf-1#page=3');
    expect(create).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(createElement(BlobPdf, { blob: doc, title: 'report.pdf', page: 7 }));
    });
    await flush();

    expect(iframe()?.getAttribute('src')).toBe('blob:pdf-1#page=7');
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each([0, -2, 1.5, Number.NaN])(
    'ignores a page that is not a positive integer: %s',
    async (page) => {
      setViewer(true);
      const { create } = stubUrls();
      await mount(pdf(['%PDF-1.4 body']), 'report.pdf', 'h-[50vh] w-full', page);

      expect(iframe()?.getAttribute('src')).toBe('blob:pdf-1');
      expect(create).toHaveBeenCalledTimes(1);
    },
  );

  it('revokes its URL on unmount and under StrictMode re-runs', async () => {
    setViewer(true);
    const { create, revoke } = stubUrls();
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(BlobPdf, { blob: pdf(['%PDF-1.4 body']), title: 'report.pdf' }),
        ),
      );
    });
    await flush();
    expect(create).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    root = createRoot(host);
    expect(revoke).toHaveBeenCalledWith('blob:pdf-1');
  });
});
