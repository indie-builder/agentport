import type { AgentMemoryOverview, MemoryPolicy } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryPolicyPanel } from '../src/components/memory/memory-policy.js';
import { api } from '../src/lib/api.js';
import { toastError, toastSuccess } from '../src/lib/toast.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const policy: MemoryPolicy = {
  enabled: true,
  writeMode: 'native_auto',
  injectPersonalMemory: true,
  injectRules: true,
  topicLimit: 20,
};

const overview: AgentMemoryOverview = {
  policy,
  index: { present: true, lines: 10, bytes: 256, maxLines: 200, maxBytes: 25 * 1024 },
  topics: { count: 1, bytes: 512, unlinked: [], stale: [] },
  rules: { count: 1, bytes: 128 },
  personal: { chars: 10, maxChars: 9000 },
  unaccounted: { count: 0, names: [] },
  health: [
    {
      code: 'healthy',
      level: 'ok',
      title: '记忆状态正常',
      detail: '索引、主题、规则与账本都没有需要处理的问题。',
    },
  ],
  recentChanges: [],
  changesTotal: 0,
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
      // 查询或表单还没落地，继续等。
    }
    await flush();
  }
  return probe();
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}

function control<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing control: ${selector}`);
  return element;
}

/** React 19 监听原生 input 事件；直接改 value 不会触发 onChange。 */
async function setInputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
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

async function mountPolicy() {
  mount(createElement(MemoryPolicyPanel, { agentId: 'expert' }));
  await waitFor(() => host.textContent?.includes('保存策略'));
}

beforeEach(() => {
  vi.spyOn(api, 'agentMemoryOverview').mockResolvedValue(overview);
  vi.mocked(toastError).mockClear();
  vi.mocked(toastSuccess).mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});

describe('memory policy', () => {
  it('修改控件后用完整 payload 保存策略', async () => {
    const saved: MemoryPolicy = {
      enabled: false,
      writeMode: 'proposal_only',
      injectPersonalMemory: false,
      injectRules: true,
      topicLimit: 30,
    };
    const update = vi.spyOn(api, 'updateAgentMemoryPolicy').mockResolvedValue({ policy: saved });
    await mountPolicy();

    const text = host.textContent ?? '';
    expect(text).toContain('模型运行中可改记忆，改动不进版本账本。');
    expect(text).toContain('运行期不可写，只能通过记忆提案写入并记账。');
    expect(text).toContain('仅管主会话记忆，子智能体记忆独立。');
    expect(text).toContain('关闭后运行期不加载、不写入专家记忆，手工浏览与编辑仍然可用。');
    expect(text).toContain('仅私有会话生效，频道与服务主体固定不注入。');
    expect(text).toContain('关闭后 .claude/rules 不渲染。');
    expect(text).toContain('超出时新建主题与提案采纳会被拒绝。');
    expect(button('保存策略').disabled).toBe(true);

    const enabled = control<HTMLButtonElement>('[role="switch"][aria-label="启用专家记忆"]');
    expect(enabled.getAttribute('aria-checked')).toBe('true');
    await click(enabled);

    const proposal = [...host.querySelectorAll<HTMLElement>('[role="radio"]')].find((item) =>
      item.closest('label')?.textContent?.startsWith('仅提案'),
    );
    if (!proposal) throw new Error('Missing proposal_only radio');
    await click(proposal);

    const personal = control<HTMLButtonElement>('[role="switch"][aria-label="注入个人记忆"]');
    await click(personal);

    await setInputValue(control<HTMLInputElement>('#memory-policy-topic-limit'), '30');

    expect(button('保存策略').disabled).toBe(false);
    await click(button('保存策略'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith('expert', saved);
    expect(toastSuccess).toHaveBeenCalledWith('记忆策略已保存');
    await waitFor(() => expect(button('保存策略').disabled).toBe(true));
  });

  it('topicLimit 越界（2 与 49）时拒绝提交并显示字段错误', async () => {
    const update = vi.spyOn(api, 'updateAgentMemoryPolicy');
    await mountPolicy();

    const input = control<HTMLInputElement>('#memory-policy-topic-limit');
    for (const value of ['2', '49']) {
      await setInputValue(input, value);
      expect(button('保存策略').disabled).toBe(false);
      await click(button('保存策略'));

      expect(update).not.toHaveBeenCalled();
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')).toContain('memory-policy-topic-limit-error');
      const error = document.getElementById('memory-policy-topic-limit-error');
      expect(error?.textContent?.trim()).not.toBe('');
    }
  });

  it('canWrite=false 时策略面板只读：控件禁用且没有保存按钮', async () => {
    const update = vi.spyOn(api, 'updateAgentMemoryPolicy');
    mount(createElement(MemoryPolicyPanel, { agentId: 'expert', canWrite: false }));
    await waitFor(() => host.textContent?.includes('启用专家记忆'));

    const enabled = control<HTMLButtonElement>('[role="switch"][aria-label="启用专家记忆"]');
    const personal = control<HTMLButtonElement>('[role="switch"][aria-label="注入个人记忆"]');
    const rules = control<HTMLButtonElement>('[role="switch"][aria-label="加载项目规则"]');
    const topicLimit = control<HTMLInputElement>('#memory-policy-topic-limit');
    const modes = [...host.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(modes).toHaveLength(2);

    for (const item of [enabled, personal, rules, topicLimit, ...modes]) {
      const blocked =
        item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true';
      expect(blocked).toBe(true);
    }
    expect(
      [...host.querySelectorAll('button')].some((item) => item.textContent?.trim() === '保存策略'),
    ).toBe(false);

    await click(enabled);
    expect(enabled.getAttribute('aria-checked')).toBe('true');
    expect(update).not.toHaveBeenCalled();
  });

  it('保存失败时保留草稿并提示错误', async () => {
    const update = vi
      .spyOn(api, 'updateAgentMemoryPolicy')
      .mockRejectedValue(new Error('策略保存失败'));
    await mountPolicy();

    const enabled = control<HTMLButtonElement>('[role="switch"][aria-label="启用专家记忆"]');
    await click(enabled);
    await click(button('保存策略'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    const [error] = vi.mocked(toastError).mock.calls[0] ?? [];
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('toastError 未收到 Error');
    expect(error.message).toBe('策略保存失败');
    expect(enabled.getAttribute('aria-checked')).toBe('false');
    expect(button('保存策略').disabled).toBe(false);
  });
});
