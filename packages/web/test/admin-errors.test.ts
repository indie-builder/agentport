import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type EvalRunDetail } from '../src/lib/api.js';
import { EvalPage } from '../src/pages/eval.js';
import { LoginPage } from '../src/pages/login.js';

const state = vi.hoisted(() => ({
  loginError: null as Error | null,
  detail: {} as EvalRunDetail,
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}));
vi.mock('@tanstack/react-query', () => ({
  useMutation: ({ onError }: { onError: (error: Error) => void }) => {
    // Deliver the mutation outcome; React owns the resulting render and state update.
    if (state.loginError) {
      const error = state.loginError;
      state.loginError = null;
      onError(error);
    }
    return { isPending: false, mutate: vi.fn() };
  },
}));
vi.mock('../src/lib/queries.js', () => ({
  queryClient: {},
  useAgents: () => ({ data: [{ id: 'agent', name: 'Expert' }], isSuccess: true }),
  useEvalCases: () => ({ data: [], isSuccess: true }),
  useEvalRuns: () => ({ data: [state.detail.evalRun], isSuccess: true }),
  useEvalRun: () => ({ data: state.detail }),
  useStartEvalRun: () => ({}),
  useCancelEvalRun: () => ({}),
  useImportEvalDataset: () => ({}),
  useEvalComparison: () => ({ data: null }),
  useCreateEvalCase: () => ({}),
  useUpdateEvalCase: () => ({}),
  useDeleteEvalCase: () => ({}),
}));
// SSR cannot click the table disclosure; render its real detail through the public callback.
vi.mock('../src/components/data-table.js', () => ({
  DataTable: ({
    renderExpanded,
  }: {
    renderExpanded: (run: EvalRunDetail['evalRun']) => ReactNode;
  }) => renderExpanded(state.detail.evalRun),
}));

beforeEach(() => {
  state.loginError = null;
  state.detail = {
    evalRun: {
      id: 'eval-1',
      agentId: 'agent',
      status: 'succeeded',
      total: 2,
      passed: 1,
      error: null,
      createdAt: '2026-10-22T00:00:00Z',
      finishedAt: '2026-10-22T00:01:00Z',
    },
    results: [
      {
        caseId: 'case-1',
        name: 'Completed case',
        prompt: 'Say hello',
        expectation: 'Hello',
        passed: true,
        output: 'Hello from completed case',
        runId: null,
      },
    ],
  };
});

describe('login failure recovery', () => {
  it('explains rejected credentials and keeps an enabled retry submission', () => {
    state.loginError = new ApiError(401, 'Unauthorized');
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain('用户名或密码错误');
    expect(html).not.toContain('登录已失效');
    expect(html).toContain('aria-describedby="login-error"');
    const submit = html.match(/<button\b[^>]*type="submit"[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(submit).toContain('重试登录');
    expect(submit).not.toMatch(/\sdisabled=""/);
  });

  it.each([
    [new ApiError(0, 'Failed to fetch'), '连不上 API 服务，请确认它已启动并检查网络后重试。'],
    [
      new ApiError(500, 'Internal detail'),
      '服务端暂时无法完成请求，请稍后重试；持续出现时查看服务日志。',
    ],
    [new Error('HTTP 502'), '请求没有完成，请稍后重试。'],
  ])('retains formatted non-credential error %s', (error, message) => {
    state.loginError = error;
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain(message);
    expect(html).not.toContain('用户名或密码错误');
  });
});

describe('evaluation batch failure details', () => {
  it('shows the batch failure alongside completed case output', () => {
    state.detail.evalRun.status = 'failed';
    state.detail.evalRun.error = 'Worker stopped after first case';
    const html = renderToStaticMarkup(createElement(EvalPage));
    expect(html).toContain('Worker stopped after first case');
    expect(html).toContain('重新运行评估');
    expect(html).toContain('Completed case');
    expect(html).toContain('Hello from completed case');
    expect(html).not.toContain('未生成结果');
  });

  it('retains the failure and fallback reason when no cases completed', () => {
    state.detail.evalRun.status = 'failed';
    state.detail.results = [];
    const html = renderToStaticMarkup(createElement(EvalPage));
    expect(html).toContain('评估失败，未生成结果');
    expect(html).toContain('未提供失败原因');
    expect(html).not.toContain('正在逐个执行');
    expect(html).not.toContain('评估已完成');
  });

  it('shows completed output without a batch failure for a successful run', () => {
    const html = renderToStaticMarkup(createElement(EvalPage));
    expect(html).toContain('Hello from completed case');
    expect(html).not.toContain('评估失败');
    expect(html).not.toContain('未提供失败原因');
    expect(html).not.toContain('重新运行评估');
  });
});
