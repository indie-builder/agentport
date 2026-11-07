import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type Browser, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import { fixture as runFixture } from './support/fixture.js';

async function apiPost<T extends object>(
  browser: Browser,
  path: string,
  payload: { [key: string]: string },
): Promise<T> {
  const response = await browserFetch(browser, 'POST', path, payload);
  if (response.status !== 201) throw new Error(`${path} ${response.status}: ${response.text}`);
  return JSON.parse(response.text) as T;
}

async function createAgent(browser: Browser): Promise<{ id: string; name: string }> {
  const slug = `e2e-eval-export-${randomUUID().slice(0, 8)}`;
  return apiPost(browser, '/api/agents', { slug, name: `E2E 评估导出 ${slug}` });
}

async function createCase(
  browser: Browser,
  agentId: string,
  name: string,
): Promise<{ id: string }> {
  return apiPost(browser, '/api/eval/cases', {
    agentId,
    name,
    prompt: `${name} prompt`,
    expectation: `${name} expectation`,
  });
}

interface ResultSeed {
  name: string;
  prompt: string;
  expectation: string;
  passed: boolean;
  output: string;
}

async function insertRun(
  agentId: string,
  status: 'running' | 'succeeded',
  total: number,
  passed: number,
): Promise<string> {
  return runFixture('eval-export', 'insertRun', agentId, status, total, passed);
}

async function insertResults(runId: string, rows: ResultSeed[]): Promise<void> {
  return runFixture('eval-export', 'insertResults', runId, rows);
}

async function insertOversizeResults(runId: string): Promise<void> {
  return runFixture('eval-export', 'insertOversizeResults', runId);
}

async function removeFixture(agentId: string): Promise<void> {
  return runFixture('eval-export', 'removeFixture', agentId);
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function openEval(browser: Browser, agentId: string): Promise<void> {
  await browser.goto(`/eval?agent=${agentId}`);
}

test('eval dataset export downloads the seeded golden file', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/eval');
  const agent = await createAgent(browser);
  try {
    await createCase(browser, agent.id, 'golden alpha');
    await createCase(browser, agent.id, 'golden beta');

    await openEval(browser, agent.id);
    await expect(screen.getByText('golden alpha', { exact: true }).first()).toBeVisible();
    await expect(screen.getByText('golden beta', { exact: true }).first()).toBeVisible();

    const download = await browser.waitForDownload(() =>
      screen.getByRole('button', '导出 JSON', { exact: true }).tap(),
    );
    expect(download.suggestedFilename).toBe('eval-cases.json');

    const body = await readJson(download.absolutePath);
    expect(body.format).toBe('agentport/eval@1');
    expect(body.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.cases).toHaveLength(2);
    expect(body.cases).toEqual(
      expect.arrayContaining([
        {
          name: 'golden alpha',
          prompt: 'golden alpha prompt',
          expectation: 'golden alpha expectation',
        },
        {
          name: 'golden beta',
          prompt: 'golden beta prompt',
          expectation: 'golden beta expectation',
        },
      ]),
    );
    // 导出完成后按钮恢复，页面仍在评估页。
    await expect(screen.getByRole('button', '导出 JSON', { exact: true })).toBeEnabled();
    await expect(browser).toHaveURL(/\/eval\?agent=/);
  } finally {
    await removeFixture(agent.id);
  }
});

test('eval result export downloads the seeded golden run', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/eval');
  const agent = await createAgent(browser);
  try {
    const runId = await insertRun(agent.id, 'succeeded', 2, 1);
    await insertResults(runId, [
      {
        name: 'golden alpha',
        prompt: 'alpha prompt',
        expectation: 'alpha expectation',
        passed: true,
        output: 'alpha output',
      },
      {
        name: 'golden beta',
        prompt: 'beta prompt',
        expectation: 'beta expectation',
        passed: false,
        output: '',
      },
    ]);

    await openEval(browser, agent.id);
    await browser.locator('button[data-row]').first().tap();
    const exportButton = screen.getByRole('button', '导出结果', { exact: true });
    await expect(exportButton).toBeEnabled();

    const download = await browser.waitForDownload(() => exportButton.tap());
    expect(download.suggestedFilename).toBe('eval-result.json');

    const body = await readJson(download.absolutePath);
    expect(body.format).toBe('agentport/eval-run@1');
    expect(body.configurationPinned).toBe(false);
    expect(body.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.evalRun).toMatchObject({
      id: runId,
      status: 'succeeded',
      total: 2,
      passed: 1,
    });
    expect(body.results).toEqual([
      {
        caseId: null,
        name: 'golden alpha',
        prompt: 'alpha prompt',
        expectation: 'alpha expectation',
        passed: true,
        output: 'alpha output',
        runId: null,
      },
      {
        caseId: null,
        name: 'golden beta',
        prompt: 'beta prompt',
        expectation: 'beta expectation',
        passed: false,
        output: '',
        runId: null,
      },
    ]);
    await expect(browser).toHaveURL(/\/eval\?agent=/);
  } finally {
    await removeFixture(agent.id);
  }
});

test('running eval run disables result export', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/eval');
  const agent = await createAgent(browser);
  try {
    await insertRun(agent.id, 'running', 2, 0);

    await openEval(browser, agent.id);
    await browser.locator('button[data-row]').first().tap();
    const exportButton = screen.getByRole('button', '导出结果', { exact: true });
    await expect(exportButton).toBeDisabled();
    await expect(exportButton).toHaveAttribute('title', '运行结束后可导出');
    await expect(screen.getByText('正在逐个执行用例…')).toBeVisible();
    await expect(browser).toHaveURL(/\/eval\?agent=/);
  } finally {
    await removeFixture(agent.id);
  }
});

test('oversize eval result export reports the error and stays on the page', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await app.open('/eval');
  const agent = await createAgent(browser);
  try {
    const runId = await insertRun(agent.id, 'succeeded', 501, 250);
    await insertOversizeResults(runId);

    await openEval(browser, agent.id);
    await browser.locator('button[data-row]').first().tap();
    const exportButton = screen.getByRole('button', '导出结果', { exact: true });
    await expect(exportButton).toBeEnabled();
    await exportButton.tap();

    await expect(screen.getByText('结果超过 500 条', { exact: false }).first()).toBeVisible();
    // 失败不导航、不留在导出中状态。
    await expect(browser).toHaveURL(/\/eval\?agent=/);
    await expect(screen.getByRole('heading', '评估', { exact: true })).toBeVisible();
    await expect(exportButton).toBeEnabled();
  } finally {
    await removeFixture(agent.id);
  }
});
