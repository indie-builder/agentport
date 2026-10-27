import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 安装请求在途时页面被卸载，结果仍由 mutation 自己落到 toast 与缓存。 */

const mocks = vi.hoisted(() => ({ installMarketSkill: vi.fn() }));

vi.mock('../src/lib/api.js', async (original) => {
  const api = await original<typeof import('../src/lib/api.js')>();
  return { ...api, api: { ...api.api, installMarketSkill: mocks.installMarketSkill } };
});

import { useInstallMarketSkill } from '../src/lib/queries.js';

const installed = {
  id: 'skill_1',
  slug: 'pdf',
  name: 'PDF',
  description: '处理 PDF',
  body: '',
  sourceId: 'owner/repo/pdf',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let client: QueryClient;
let install: ReturnType<typeof useInstallMarketSkill> | undefined;

function Probe() {
  install = useInstallMarketSkill();
  return null;
}

/** notifyManager 用 setTimeout(0) 派发状态更新，act 内要把这一拍也走完。 */
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount() {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe))),
  );
  return async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(
    ['skills'],
    [{ ...installed, id: 'skill_0', slug: 'old', name: 'Old', sourceId: null, agentCount: 2 }],
  );
  mocks.installMarketSkill.mockReset();
  vi.spyOn(client, 'invalidateQueries');
  vi.spyOn(toast, 'success');
  vi.spyOn(toast, 'info');
  vi.spyOn(toast, 'error');
});

afterEach(() => {
  client.clear();
  vi.restoreAllMocks();
});

describe('market skill install while the page is unmounted', () => {
  it('keeps the pending request alive and lands success, warnings and cache after unmount', async () => {
    const pending = deferred<{ skill: typeof installed; warnings: string[] }>();
    mocks.installMarketSkill.mockReturnValue(pending.promise);
    const unmount = await mount();

    let request!: Promise<unknown>;
    await act(async () => {
      request = install?.mutateAsync({ id: 'owner/repo/pdf' }) ?? Promise.resolve();
    });
    await flush();
    expect(install?.isPending).toBe(true);
    expect(mocks.installMarketSkill).toHaveBeenCalledTimes(1);

    await unmount();
    expect(client.getQueryData<unknown[]>(['skills'])).toHaveLength(1);

    await act(async () => {
      pending.resolve({ skill: installed, warnings: ['已跳过同名文件'] });
      await request;
    });

    expect(toast.success).toHaveBeenCalledWith('已安装「PDF」');
    expect(toast.info).toHaveBeenCalledWith('已跳过同名文件');
    const skills = client.getQueryData<Array<{ id: string; agentCount: number }>>(['skills']);
    expect(skills?.map((skill) => skill.id)).toEqual(['skill_1', 'skill_0']);
    expect(skills?.[0]?.agentCount).toBe(0);
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['skills'] });
  });

  it('reports a late failure after unmount without touching the list', async () => {
    const pending = deferred<never>();
    mocks.installMarketSkill.mockReturnValue(pending.promise);
    const unmount = await mount();

    let request!: Promise<unknown>;
    await act(async () => {
      request = install?.mutateAsync({ id: 'owner/repo/pdf' }) ?? Promise.resolve();
    });
    await flush();
    expect(install?.isPending).toBe(true);
    // 先接住拒绝，避免用例里出现 unhandled rejection。
    const settled = request.then(
      () => undefined,
      (error: unknown) => error,
    );

    await unmount();

    await act(async () => {
      pending.reject(new Error('skills.sh 不可用'));
      await settled;
    });

    expect(toast.error).toHaveBeenCalledWith('skills.sh 不可用', {
      duration: Number.POSITIVE_INFINITY,
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    expect(client.invalidateQueries).not.toHaveBeenCalled();
    expect(client.getQueryData<unknown[]>(['skills'])).toHaveLength(1);
  });
});
