import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type Browser, test } from '@e2e-dev/web';
import { expect } from 'e2e';

const envDatabaseUrl = process.env.DATABASE_URL;
if (!envDatabaseUrl) throw new Error('DATABASE_URL is required for evaluation export fixtures');
const DATABASE_URL: string = envDatabaseUrl;

function connectDb() {
  return import('../packages/db/dist/index.js').then(({ createDb }) => createDb(DATABASE_URL));
}

let poolPromise: ReturnType<typeof connectDb> | undefined;
function pool() {
  poolPromise ??= connectDb();
  return poolPromise;
}

test.afterAll(async () => {
  const current = await poolPromise;
  await current?.pool.end();
});

interface ApiRequest {
  path: string;
  payload: { [key: string]: string };
}

async function apiPost<T extends object>(
  browser: Browser,
  path: string,
  payload: ApiRequest['payload'],
): Promise<T> {
  return browser.evaluate(
    async (input: ApiRequest) => {
      const res = await fetch(input.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input.payload),
      });
      const body = await res.text();
      if (res.status !== 201) {
        throw new Error(`${input.path} ${res.status}: ${body}`);
      }
      return JSON.parse(body);
    },
    { path, payload },
  ) as Promise<T>;
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
  const id = `er_${randomUUID()}`;
  const { pool: client } = await pool();
  await client.query(
    `insert into eval_runs (id, agent_id, status, total, passed, created_at, finished_at)
     values ($1, $2, $3, $4, $5, now(), $6)`,
    [id, agentId, status, total, passed, status === 'running' ? null : new Date()],
  );
  return id;
}

async function insertResults(runId: string, rows: ResultSeed[]): Promise<void> {
  const { pool: client } = await pool();
  for (const [index, row] of rows.entries()) {
    await client.query(
      `insert into eval_results (id, eval_run_id, case_id, case_snapshot, passed, output)
       values ($1, $2, null, $3, $4, $5)`,
      [
        `${runId}-${String(index).padStart(3, '0')}`,
        runId,
        JSON.stringify({
          id: `${runId}-case-${index}`,
          name: row.name,
          prompt: row.prompt,
          expectation: row.expectation,
        }),
        row.passed,
        row.output,
      ],
    );
  }
}

async function insertOversizeResults(runId: string): Promise<void> {
  const { pool: client } = await pool();
  // 501 条越过导出上限；caseId 为 NULL 时唯一索引不冲突。
  await client.query(
    `insert into eval_results (id, eval_run_id, case_id, case_snapshot, passed, output)
     select $1 || '-' || g, $2, null,
       jsonb_build_object(
         'id', $1 || '-case-' || g,
         'name', 'oversize case ' || g,
         'prompt', 'prompt ' || g,
         'expectation', ''
       ),
       g % 2 = 0,
       'output ' || g
     from generate_series(1, 501) as g`,
    [runId, runId],
  );
}

async function removeFixture(agentId: string): Promise<void> {
  const { pool: client } = await pool();
  await client.query(
    `delete from audit_log
     where target = $1 or target in (select id from eval_cases where agent_id = $1)`,
    [agentId],
  );
  // 用例、评估批次、结果、版本随 agent 级联删除。
  await client.query('delete from agents where id = $1', [agentId]);
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
