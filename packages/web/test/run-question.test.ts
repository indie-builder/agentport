import type { PublicRunQuestion } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunQuestionCard } from '../src/components/run-question.js';
import { api } from '../src/lib/api.js';

const at = '2026-10-28T00:00:00.000Z';

function runQuestion(overrides: Partial<PublicRunQuestion> = {}): PublicRunQuestion {
  return {
    requestId: 'qreq_1',
    runId: 'run_1',
    toolUseId: 'toolu_1',
    questions: [
      {
        question: '选择部署环境',
        header: '环境',
        options: [
          { value: '0', label: '预发', description: '先验证' },
          { value: '1', label: '生产', description: '直接上线' },
        ],
        multiSelect: false,
      },
    ],
    status: 'pending',
    answers: null,
    createdAt: at,
    resolvedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    closeReason: null,
    ...overrides,
  };
}

function multiQuestion(): PublicRunQuestion {
  return runQuestion({
    questions: [
      {
        question: '选择检查项',
        header: '检查',
        options: [
          { value: '0', label: '类型检查', description: '' },
          { value: '1', label: '单元测试', description: '' },
          { value: '2', label: '构建', description: '' },
        ],
        multiSelect: true,
      },
    ],
  });
}

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(question: PublicRunQuestion, live: boolean) {
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(RunQuestionCard, { question, live }),
      ),
    );
  });
  await flush();
}

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === label,
  );
}

function role(name: string): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(`[role="${name}"]`)];
}

async function click(element: HTMLElement | undefined) {
  if (!element) throw new Error('Missing element to click');
  await act(async () => element.click());
  await flush();
}

async function type(element: HTMLTextAreaElement | null, value: string) {
  if (!element) throw new Error('Missing textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(api, 'respondToQuestion').mockImplementation(async (_runId, _requestId, response) =>
    runQuestion({
      status: 'answers' in response ? 'answered' : 'declined',
      answers: 'answers' in response ? response.answers : null,
      resolvedAt: at,
    }),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('run question form', () => {
  it('submits the chosen option value for the question index', async () => {
    const question = runQuestion();
    await mount(question, true);

    expect(host.textContent).toContain('需要你的回答');
    await click(role('radio')[0]);
    await click(button('提交回答'));

    expect(api.respondToQuestion).toHaveBeenCalledWith('run_1', 'qreq_1', {
      answers: {},
      choices: { 0: ['0'] },
    });
  });

  it('uses the typed other answer for a single-select question', async () => {
    const question = runQuestion();
    await mount(question, true);

    await click(role('radio').at(-1));
    await type(host.querySelector('textarea'), '灰度 10%');
    await click(button('提交回答'));

    expect(api.respondToQuestion).toHaveBeenCalledWith('run_1', 'qreq_1', {
      answers: { 0: '灰度 10%' },
    });
  });

  it('sends multi-select choices and the other text separately', async () => {
    const question = multiQuestion();
    await mount(question, true);

    const boxes = role('checkbox');
    await click(boxes[1]);
    await click(boxes[0]);
    await click(boxes.at(-1));
    await type(host.querySelector('textarea'), '冒烟');
    await click(button('提交回答'));

    expect(api.respondToQuestion).toHaveBeenCalledWith('run_1', 'qreq_1', {
      answers: { 0: '冒烟' },
      choices: { 0: ['0', '1'] },
    });
  });

  it('drops the hidden other text when other is unchecked in multi-select', async () => {
    const question = multiQuestion();
    await mount(question, true);

    await click(role('checkbox')[0]);
    await click(role('checkbox').at(-1));
    await type(host.querySelector('textarea'), '冒烟');
    await click(role('checkbox').at(-1));
    await click(button('提交回答'));

    expect(api.respondToQuestion).toHaveBeenCalledWith('run_1', 'qreq_1', {
      answers: {},
      choices: { 0: ['0'] },
    });
  });

  it('disables every control while the answer is submitting', async () => {
    let resolveResponse: (question: PublicRunQuestion) => void = () => {};
    vi.mocked(api.respondToQuestion).mockImplementation(
      () =>
        new Promise<PublicRunQuestion>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    await mount(runQuestion(), true);

    await click(role('radio')[0]);
    await click(button('提交回答'));

    const fieldset = host.querySelector('fieldset');
    expect(fieldset?.disabled).toBe(true);
    for (const control of host.querySelectorAll<HTMLElement>('[role="radio"]')) {
      expect(
        (control as HTMLButtonElement).disabled ||
          control.hasAttribute('data-disabled') ||
          control.getAttribute('aria-disabled') === 'true',
      ).toBe(true);
    }
    expect(host.querySelector<HTMLButtonElement>('button[aria-busy="true"]')?.disabled).toBe(true);
    expect(
      [...host.querySelectorAll<HTMLButtonElement>('button')].every((element) => element.disabled),
    ).toBe(true);

    await act(async () => {
      resolveResponse(runQuestion({ status: 'answered', answers: { 0: '预发' }, resolvedAt: at }));
    });
    await flush();
  });

  it('keeps the draft and shows the error when submitting fails', async () => {
    vi.mocked(api.respondToQuestion).mockRejectedValue(new Error('回答必须对应本次提问'));
    await mount(runQuestion(), true);

    await click(role('radio')[0]);
    await click(button('提交回答'));

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('回答必须对应本次提问');
    expect(role('radio')[0].getAttribute('aria-checked')).toBe('true');
    expect(button('提交回答')).not.toBeUndefined();
  });

  it('does not accept a question whose deadline already passed', async () => {
    await mount(runQuestion({ expiresAt: new Date(Date.now() - 1_000).toISOString() }), true);

    expect(host.textContent).toContain('已失效');
    expect(host.textContent).toContain('已超过回答时限，无法提交。');
    expect(host.textContent).not.toContain('智能体将按未回答继续');
    expect(button('提交回答')).toBeUndefined();
    expect(button('暂不回答')).toBeUndefined();
  });

  it('becomes unanswerable when the open form crosses the deadline', async () => {
    vi.useFakeTimers({ now: new Date(at) });
    const question = runQuestion({ expiresAt: '2026-10-28T00:00:01.000Z' });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(RunQuestionCard, { question, live: true }),
        ),
      );
    });

    expect(button('提交回答')).not.toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(host.textContent).toContain('已失效');
    expect(button('提交回答')).toBeUndefined();
    expect(button('暂不回答')).toBeUndefined();
  });

  it('declines without answers', async () => {
    await mount(runQuestion(), true);
    await click(button('暂不回答'));

    expect(api.respondToQuestion).toHaveBeenCalledWith('run_1', 'qreq_1', { decline: true });
  });

  it('keeps a pending question read-only when the run is no longer live', async () => {
    await mount(runQuestion(), false);

    expect(host.textContent).toContain('待回答');
    expect(host.textContent).toContain('请在发起该提问的会话中回答。');
    expect(button('提交回答')).toBeUndefined();
    expect(button('暂不回答')).toBeUndefined();
  });

  it('shows the recorded answers and status once answered', async () => {
    await mount(
      runQuestion({
        status: 'answered',
        answers: { 0: '预发' },
        resolvedAt: at,
      }),
      false,
    );

    expect(host.textContent).toContain('已回答');
    expect(host.textContent).toContain('预发');
    expect(button('提交回答')).toBeUndefined();
  });

  it('shows declined and closed states without controls', async () => {
    await mount(runQuestion({ status: 'declined', resolvedAt: at }), false);
    expect(host.textContent).toContain('暂不回答');
    expect(button('提交回答')).toBeUndefined();
  });

  it('shows closed questions as closed', async () => {
    await mount(
      runQuestion({ status: 'closed', closeReason: 'run_cancelled', resolvedAt: at }),
      false,
    );
    expect(host.textContent).toContain('已关闭');
    expect(button('提交回答')).toBeUndefined();
  });
});
