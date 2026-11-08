import type { AgentMemoryAssembly, AgentMemoryOverview } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryOverview } from '../src/components/memory-overview.js';
import { api } from '../src/lib/api.js';

const recentChange: AgentMemoryOverview['recentChanges'][number] = {
  name: 'MEMORY.md',
  createdAt: '2026-10-01T08:00:00.000Z',
  summary: '更新：# 记忆',
};

const overview: AgentMemoryOverview = {
  policy: {
    enabled: true,
    writeMode: 'native_auto',
    injectPersonalMemory: true,
    injectRules: true,
    topicLimit: 20,
  },
  index: { present: true, lines: 42, bytes: 1024, maxLines: 200, maxBytes: 25 * 1024 },
  topics: { count: 3, bytes: 3072, unlinked: [], stale: ['old.md'] },
  rules: { count: 2, bytes: 512 },
  personal: { chars: 120, maxChars: 9000 },
  unaccounted: { count: 0, names: [] },
  health: [
    {
      code: 'topics_stale',
      level: 'warn',
      title: '主题长期未更新',
      detail: '超过 60 天未更新：old.md',
    },
    {
      code: 'healthy',
      level: 'ok',
      title: '记忆状态正常',
      detail: '索引、主题、规则与账本都没有需要处理的问题。',
    },
  ],
  recentChanges: [recentChange],
  changesTotal: 1,
};

const assembly: AgentMemoryAssembly = {
  blocks: [
    {
      kind: 'personal',
      name: 'CLAUDE.md',
      path: '/mnt/user/CLAUDE.md',
      chars: 120,
      lines: null,
      trigger: 'every-run',
      reason: null,
      globs: null,
    },
    {
      kind: 'index',
      name: 'MEMORY.md',
      path: '/mnt/agent-memory/MEMORY.md',
      chars: 1024,
      lines: 42,
      trigger: 'every-run',
      reason: null,
      globs: null,
    },
    {
      kind: 'topic',
      name: 'deploy.md',
      path: '/mnt/agent-memory/deploy.md',
      chars: 800,
      lines: null,
      trigger: 'skipped',
      reason: '专家记忆已停用',
      globs: null,
    },
  ],
  totals: { personalChars: 120, indexBytes: 1024, rulesBytes: 512, topicBytes: 0 },
  notes: ['频道与服务主体由运行期固定不注入个人记忆。'],
};

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function waitFor<T>(probe: () => T, tries = 60): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const value = probe();
      if (value) return value;
    } catch {
      // 查询还没落地，继续等。
    }
    await flush();
  }
  return probe();
}

function mount(element: ReactElement) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false }, mutations: { retry: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(QueryClientProvider, { client }, element)));
}

beforeEach(() => {
  vi.spyOn(api, 'agentMemoryOverview').mockResolvedValue(overview);
  vi.spyOn(api, 'agentMemoryAssembly').mockResolvedValue(assembly);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});

describe('memory overview', () => {
  it('渲染 KPI、健康项、装配 skipped 与 notes', async () => {
    mount(createElement(MemoryOverview, { agentId: 'expert' }));

    await waitFor(() => host.textContent?.includes('频道与服务主体由运行期固定不注入个人记忆。'));
    const text = host.textContent ?? '';

    expect(text).toContain('主题文件数');
    expect(text).toContain('3 个');
    expect(text).toContain('索引占用');
    expect(text).toContain('42 行');
    expect(text).toContain('占上限 21%');
    expect(text).toContain('上限 200 行 / 25 KB');
    // 项目规则的规模只在「指令」页呈现，不在记忆概览里重复。
    expect(text).not.toContain('项目规则');
    expect(text).toContain('当前个人记忆');
    expect(text).toContain('120 字符');
    expect(text).toContain('上限 9000 字符');

    expect(text).toContain('主题长期未更新');
    expect(text).toContain('超过 60 天未更新：old.md');
    expect(text).toContain('记忆状态正常');
    expect(text).toContain('注意');
    expect(text).toContain('正常');

    expect(text).toContain('deploy.md');
    expect(text).toContain('已跳过');
    expect(text).toContain('专家记忆已停用');
    const skippedRow = [...host.querySelectorAll('tr')].find((row) =>
      row.textContent?.includes('deploy.md'),
    );
    expect(skippedRow?.className).toContain('opacity-60');
    // 已跳过的块不能带大小，否则会被读成已加载 800 字节。
    expect(skippedRow?.querySelectorAll('td')[2]?.textContent?.trim()).toBe('—');

    expect(text).toContain('个人 120 字符');
    expect(text).toContain('索引 1 KB');
    expect(text).toContain('规则 512 B');
    expect(text).toContain('主题 0 B');
    expect(text).not.toContain('固定注入');

    expect(text).toContain('最近变更');
    expect(text).toContain('MEMORY.md');
    expect(text).toContain('更新：# 记忆');
    expect(text).toContain('共 1 条');
  });

  it('最近变更只列 3 条，标题旁给真实总数与其余条数', async () => {
    vi.mocked(api.agentMemoryOverview).mockResolvedValue({
      ...overview,
      recentChanges: [
        { name: 'MEMORY.md', createdAt: '2026-10-05T08:00:00.000Z', summary: '更新索引' },
        { name: 'deploy.md', createdAt: '2026-10-04T08:00:00.000Z', summary: '新建：部署步骤' },
        { name: 'review.md', createdAt: '2026-10-03T08:00:00.000Z', summary: '更新：评审约定' },
        { name: 'stale.md', createdAt: '2026-10-02T08:00:00.000Z', summary: '删除' },
      ],
      changesTotal: 7,
    });
    mount(createElement(MemoryOverview, { agentId: 'expert', onOpenFiles: () => {} }));

    await waitFor(() => host.querySelector('[aria-labelledby="memory-recent-title"]'));

    const text = host.textContent ?? '';
    expect(text).toContain('共 7 条');
    expect(text).toContain('其余 4 条在文件视图查看');

    const items = host.querySelectorAll('[aria-labelledby="memory-recent-title"] li');
    expect(items).toHaveLength(3);
    expect(text).not.toContain('stale.md');
  });

  it('停用策略时给出提示，统计与空态仍然保留', async () => {
    vi.mocked(api.agentMemoryOverview).mockResolvedValue({
      ...overview,
      policy: { ...overview.policy, enabled: false },
      health: [
        {
          code: 'policy_disabled',
          level: 'ok',
          title: '专家记忆已停用',
          detail: '该专家运行时不挂载、不加载专家记忆；手工浏览与编辑仍然可用。',
        },
      ],
      recentChanges: [],
      changesTotal: 0,
    });
    mount(createElement(MemoryOverview, { agentId: 'expert' }));

    await waitFor(() =>
      host.textContent?.includes(
        '专家主会话记忆已停用，运行期不加载也不写入；子智能体记忆不受此开关影响',
      ),
    );

    expect(host.textContent).toContain('3 个');
    expect(host.textContent).toContain('42 行');
    expect(host.textContent).toContain('尚无记忆变更');
    expect(host.textContent).not.toContain('共 0 条');
  });

  it('装配查询失败时概览统计仍然渲染', async () => {
    vi.mocked(api.agentMemoryAssembly).mockRejectedValue(new Error('装配预览加载失败'));
    mount(createElement(MemoryOverview, { agentId: 'expert' }));

    await waitFor(() => host.textContent?.includes('装配预览加载失败'));

    expect(host.textContent).toContain('主题文件数');
    expect(host.textContent).toContain('3 个');
    expect(host.textContent).toContain('最近变更');
  });
});
