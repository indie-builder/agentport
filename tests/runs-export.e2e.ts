import { readFile } from 'node:fs/promises';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { fixture as runFixture } from './support/fixture.js';

/**
 * 运行导出的真实浏览器验收：真实页面、真实 API、数据库直写 fixture。
 * E2E_DATABASE_URL 必须显式给出（无默认值），且与页面背后 API 指向同一个库。
 */
interface Fixture {
  ownAgentId: string;
  foreignAgentId: string;
  succeededRunId: string;
  failedRunId: string;
  foreignRunId: string;
  targets: string[];
}

/** 自己的 agent 两条运行（succeeded / failed），另一个 agent 一条 failed。 */
async function seed(): Promise<Fixture> {
  return runFixture('runs-export', 'seed');
}

/** 只删自己建的 agent：会话、运行随 agent 级联删除；审计行按 id 另删。 */
async function cleanup(fixture: Fixture): Promise<void> {
  return runFixture('runs-export', 'cleanup', fixture);
}

interface ExportBody {
  format: string;
  exportedAt: string;
  items: Array<Record<string, unknown>>;
}

const ITEM_KEYS = [
  'agentId',
  'agentName',
  'agentVersion',
  'costUsd',
  'endedAt',
  'error',
  'id',
  'inputTokens',
  'latencyMs',
  'outputTokens',
  'startedAt',
  'status',
  'trigger',
  'turns',
];

async function readExport(file: string): Promise<{ raw: string; body: ExportBody }> {
  const raw = await readFile(file, 'utf8');
  return { raw, body: JSON.parse(raw) as ExportBody };
}

test('runs page exports only the filtered agent runs', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  const fixture = await seed();
  try {
    await app.open(`/runs?agent=${fixture.ownAgentId}&view=table`);
    await expect(screen.getByRole('heading', '运行')).toBeVisible();
    await expect(screen.getByText('2 行', { exact: true })).toBeVisible();

    const download = await browser.waitForDownload(() =>
      screen.getByRole('button', '导出运行', { exact: true }).tap(),
    );
    expect(download.suggestedFilename).toBe('runs.json');

    const { raw, body } = await readExport(download.absolutePath);
    expect(body.format).toBe('agentport/runs@1');
    expect(body.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.items).toHaveLength(2);
    expect(body.items.map((item) => item.status).sort()).toEqual(['failed', 'succeeded']);
    expect(body.items.every((item) => item.agentId === fixture.ownAgentId)).toBe(true);
    expect(body.items.map((item) => item.id).sort()).toEqual(
      [fixture.succeededRunId, fixture.failedRunId].sort(),
    );
    // 只有列表字段，没有步骤、消息或提示词。
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
    }
    expect(raw).not.toContain('steps');
    expect(raw).not.toContain('messages');
    expect(raw).not.toContain('prompt');
    expect(raw).not.toContain(fixture.foreignRunId);
    expect(raw).not.toContain(fixture.foreignAgentId);

    // 导出完成后按钮恢复，页面筛选不变。
    await expect(screen.getByRole('button', '导出运行', { exact: true })).toBeEnabled();
    await expect(browser).toHaveURL(new RegExp(`/runs\\?agent=${fixture.ownAgentId}&view=table$`));
  } finally {
    await cleanup(fixture);
  }
});

test('runs page status filter narrows the export', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  const fixture = await seed();
  try {
    await app.open(`/runs?agent=${fixture.ownAgentId}&status=failed&view=table`);
    await expect(screen.getByText('1 行', { exact: true })).toBeVisible();

    const download = await browser.waitForDownload(() =>
      screen.getByRole('button', '导出运行', { exact: true }).tap(),
    );
    expect(download.suggestedFilename).toBe('runs.json');

    const { body } = await readExport(download.absolutePath);
    expect(body.format).toBe('agentport/runs@1');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: fixture.failedRunId,
      agentId: fixture.ownAgentId,
      status: 'failed',
      error: 'fixture boom',
    });
  } finally {
    await cleanup(fixture);
  }
});
