import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthMetrics } from '../src/lib/api.js';
import { StatusPage } from '../src/pages/status.js';

/**
 * 全程走真实 api 适配器：fetch 受控，但 healthMetrics 的 null 语义与
 * probeHealth 的 catch 都真实执行，避免 mock 返回值掩盖「失败被当成成功 null」。
 */

const metrics: HealthMetrics = {
  process: { uptimeSeconds: 120, memoryRssBytes: 1024, nodeVersion: 'v24' },
  queue: { waiting: 3, active: 1, completed: 0, failed: 0, delayed: 0 },
  db: { total: 4, idle: 2, waiting: 0 },
  redis: { pingMs: 2 },
};

const queueCounts = { waiting: 3, active: 1, completed: 0, failed: 0, delayed: 0 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let metricsFetches: Array<() => Promise<Response>> = [];
let root: Root;
let client: QueryClient;
let container: HTMLDivElement;

function installFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/health/metrics') {
      const next = metricsFetches.shift();
      if (!next) throw new Error(`unexpected metrics fetch #${metricsFetches.length}`);
      return next();
    }
    if (path === '/health/live') return json({ status: 'ok' });
    if (path === '/health/ready') return json({ status: 'ok', db: 'ok', redis: 'ok' });
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch);
}

async function mount() {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, refetchOnWindowFocus: false, gcTime: Infinity },
    },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(StatusPage)));
  });
}

async function waitFor(assert: () => void) {
  await act(async () => {
    await vi.waitFor(assert);
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((element) =>
    element.textContent?.trim().startsWith(label),
  );
  if (!found) throw new Error(`missing button ${label}`);
  return found;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

beforeEach(() => {
  metricsFetches = [];
  installFetch();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  container?.remove();
  vi.restoreAllMocks();
});

describe('status metrics failure feedback', () => {
  it('shows unknown, not zeros or a made-up Redis outage, when the first metrics request fails over the network', async () => {
    metricsFetches = [() => Promise.reject(new TypeError('Failed to fetch'))];

    await mount();
    await waitFor(() => expect(container.textContent).toContain('指标读取失败'));

    expect(container.textContent).not.toContain('运行时长');
    expect(container.textContent).not.toContain('PONG');
    expect(container.textContent).not.toContain('BullMQ');
    expect(container.textContent).not.toContain('Ping 失败');
    expect(container.textContent).not.toContain('Redis 不可用');
    expect(container.textContent).not.toContain('指标刷新失败');

    const unknowns = [...container.querySelectorAll('[data-slot="badge"], span')].filter(
      (element) => element.textContent === '未知',
    );
    // 四个指标区块各自有一个「未知」状态徽章 + 一块未知说明。
    expect(unknowns.length).toBeGreaterThanOrEqual(4);
    expect(container.textContent).not.toContain('等待 0');
    expect(container.textContent).not.toContain('总数 0');
  });

  it('keeps the last successful readings through a failed refresh, disables retry while pending, and clears the error after recovery', async () => {
    const retry = deferred<Response>();
    metricsFetches = [
      async () => json(metrics),
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => retry.promise,
    ];

    await mount();
    await waitFor(() => expect(container.textContent).toContain('v24'));
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('PONG');

    await click('刷新');
    await waitFor(() => expect(container.textContent).toContain('指标刷新失败'));
    expect(container.textContent).toContain('以下保留上次成功读取的指标。');
    expect(container.textContent).toContain('v24');
    expect(container.textContent).toContain('PONG');
    expect(container.textContent).toContain('注意');
    expect(button('重试').disabled).toBe(false);

    await click('重试');
    // 重试在途：旧读数与失败提示都保留，按钮禁用防重复提交。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(button('重试').disabled).toBe(true);
    expect(container.textContent).toContain('v24');
    expect(container.textContent).toContain('指标刷新失败');

    retry.resolve(
      json({ ...metrics, queue: { ...queueCounts, waiting: 4 }, redis: { pingMs: 5 } }),
    );
    await waitFor(() => expect(container.textContent).not.toContain('指标刷新失败'));
    expect(container.textContent).toContain('PONG');
    expect(container.textContent).not.toContain('注意');
    expect(container.textContent).not.toContain('未知');
  });
});
