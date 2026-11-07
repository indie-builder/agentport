import { randomUUID } from 'node:crypto';
import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import { requireExecutionStack } from './support/execution-stack.js';

await requireExecutionStack();

interface EvalRunDetail {
  evalRun: {
    id: string;
    status: 'running' | 'succeeded' | 'failed' | 'cancelled';
    total: number;
    passed: number;
    error: string | null;
  };
  results: Array<{
    name: string;
    prompt: string;
    expectation: string;
    passed: boolean;
    output: string;
  }>;
}

async function apiJson<T>(
  browser: Browser,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await browserFetch(browser, method, path, body);
  if (response.status < 200 || response.status >= 300)
    throw new Error(`${path} ${response.status}: ${response.text}`);
  return (response.text === '' ? null : JSON.parse(response.text)) as T;
}

test('runs an evaluation from the page through worker, sandbox and the stub model', {
  session: 'admin',
  timeout: 240_000,
}, async ({ app, screen, browser }) => {
  const contract = await requireExecutionStack();
  await app.open('/');
  expect(await browser.evaluate(() => location.origin)).toBe(contract.appUrl);
  const suffix = randomUUID().slice(0, 8);
  const agent = await apiJson<{ id: string }>(browser, 'POST', '/api/agents', {
    slug: `e2e-eval-exec-${suffix}`,
    name: `E2E 评估执行 ${suffix}`,
  });
  const prompt = `eval-execution-${suffix}`;
  await apiJson(browser, 'POST', '/api/eval/cases', {
    agentId: agent.id,
    name: `case-${suffix}`,
    prompt,
    expectation: prompt,
  });

  await app.open(`/eval?agent=${agent.id}`);
  await expect(screen.getByText(`case-${suffix}`, { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
  const runButton = screen.getByRole('button', { name: '运行评估' });
  await expect(runButton).toBeEnabled({ timeout: 60_000 });
  await runButton.tap();
  await expect(screen.getByText('评估已开始，结果会自动刷新')).toBeVisible({ timeout: 30_000 });

  let detail: EvalRunDetail | null = null;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const page = await apiJson<{ items: Array<{ id: string; status: string }> }>(
      browser,
      'GET',
      `/api/eval/runs?agentId=${agent.id}&limit=10`,
    );
    const run = page.items[0];
    if (run !== undefined) {
      detail = await apiJson<EvalRunDetail>(browser, 'GET', `/api/eval/runs/${run.id}`);
      if (detail.evalRun.status !== 'running') break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  expect(detail, '评估运行没有出现在列表里').not.toBeNull();
  expect(detail?.evalRun, JSON.stringify(detail)).toMatchObject({
    status: 'succeeded',
    total: 1,
    passed: 1,
    error: null,
  });
  expect(detail?.results).toHaveLength(1);
  expect(detail?.results[0]).toMatchObject({
    name: `case-${suffix}`,
    prompt,
    expectation: prompt,
    passed: true,
  });
  expect(detail?.results[0]?.output).toContain(prompt);
});
