import type { OutputShare } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareDialog } from '../src/components/share-dialog.js';
import { api } from '../src/lib/api.js';
import { toastError, toastSuccess } from '../src/lib/toast.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const createdAt = '2026-10-28T10:05:00.000Z';
const created: OutputShare = {
  id: 'share-1',
  runId: 'run-2',
  path: 'report.md',
  sha256: 'a'.repeat(64),
  createdAt,
  revokedAt: null,
  urlPath: '/s/share-1#secret-token',
};

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let shares: OutputShare[];

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (item) => item.textContent?.trim() === label,
  );
}

function labelled(prefix: string): HTMLButtonElement | undefined {
  return [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button[aria-label]'),
  ].find((item) => item.getAttribute('aria-label')?.startsWith(prefix));
}

function trigger(): HTMLButtonElement {
  const share = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === '分享',
  );
  if (!share) throw new Error('Missing share trigger');
  return share;
}

async function open() {
  await act(async () => trigger().click());
  await flush();
}

async function render(runId = 'run-2', path = 'report.md') {
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ShareDialog, {
          conversationId: 'conversation-a',
          runId,
          path,
          createdAt,
        }),
      ),
    );
  });
  await flush();
}

beforeEach(() => {
  shares = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  vi.spyOn(api, 'outputShares').mockImplementation(async () => ({ items: shares }));
  vi.spyOn(api, 'createOutputShare').mockImplementation(async () => {
    shares = [created];
    return created;
  });
  vi.spyOn(api, 'revokeOutputShare').mockImplementation(async (id: string) => {
    shares = shares.map((share) =>
      share.id === id ? { ...share, revokedAt: '2026-10-28T11:00:00.000Z' } : share,
    );
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('output share dialog', () => {
  it('creates a fixed-version link, copies it and revokes it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await render();
    await open();

    expect(api.outputShares).toHaveBeenCalledWith(
      'conversation-a',
      { runId: 'run-2', path: 'report.md' },
      expect.any(AbortSignal),
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      '持有链接的人可查看和下载此文件。',
    );

    const create = button('创建分享链接');
    if (!create) throw new Error('Missing create action');
    await act(async () => create.click());
    await flush();

    expect(api.createOutputShare).toHaveBeenCalledWith('conversation-a', {
      runId: 'run-2',
      path: 'report.md',
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('http://localhost/s/share-1#secret-token');
    expect(dialog?.textContent).toContain('有效');

    const copy = labelled('复制');
    if (!copy) throw new Error('Missing copy action');
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith('http://localhost/s/share-1#secret-token');
    expect(toastSuccess).toHaveBeenCalled();

    const revoke = button('撤销');
    if (!revoke) throw new Error('Missing revoke action');
    await act(async () => revoke.click());
    await flush();

    expect(api.revokeOutputShare).toHaveBeenCalledWith('share-1');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('已撤销');
    expect(button('撤销')).toBeUndefined();
  });

  it('keeps the holder notice visible when an active link already exists', async () => {
    shares = [created];
    await render();
    await open();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('持有链接的人可查看和下载此文件。');
    expect(dialog?.textContent).toContain('有效');
    expect(button('创建分享链接')).toBeUndefined();
  });

  it('keeps the create action when the list or the create request fails', async () => {
    vi.mocked(api.outputShares).mockRejectedValue(new Error('分享列表没有加载出来'));
    await render();
    await open();

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      '分享列表没有加载出来',
    );
    const create = button('创建分享链接');
    expect(create).not.toBeUndefined();

    vi.mocked(api.createOutputShare).mockRejectedValue(new Error('创建分享失败，请重试'));
    await act(async () => create?.click());
    await flush();

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      '创建分享失败，请重试',
    );
    expect(button('创建分享链接')).not.toBeUndefined();
  });

  it('re-queries the triple when the selected version or path changes', async () => {
    await render('run-1');
    await open();
    expect(vi.mocked(api.outputShares).mock.calls.at(-1)?.[1]).toEqual({
      runId: 'run-1',
      path: 'report.md',
    });

    await render('run-2');
    expect(vi.mocked(api.outputShares).mock.calls.at(-1)?.[1]).toEqual({
      runId: 'run-2',
      path: 'report.md',
    });

    await render('run-2', 'data.json');
    expect(vi.mocked(api.outputShares).mock.calls.at(-1)?.[1]).toEqual({
      runId: 'run-2',
      path: 'data.json',
    });
  });

  it('returns focus to the share trigger when the dialog closes', async () => {
    await render();
    const share = trigger();
    share.focus();
    await open();

    const close = labelled('关闭');
    if (!close) throw new Error('Missing close action');
    await act(async () => close.click());
    await flush();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(share);
    expect(toastError).not.toHaveBeenCalled();
  });
});
