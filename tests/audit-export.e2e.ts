import { readFile } from 'node:fs/promises';
import { type Browser, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { fixture as runFixture } from './support/fixture.js';

const targetOf = (label: string): string => `e2e-audit-${label}-${crypto.randomUUID()}`;

async function seedAudit(
  target: string,
  action: string,
  extra: { inputDigest?: string; requestId?: string } = {},
): Promise<string> {
  return runFixture('audit-export', 'seedAudit', target, action, extra);
}

async function removeFixtures(ids: string[], targets: string[]): Promise<void> {
  return runFixture('audit-export', 'removeFixtures', ids, targets);
}

async function readJson(file: string): Promise<ExportBody> {
  return JSON.parse(await readFile(file, 'utf8')) as ExportBody;
}

function auditActionTexts(browser: Browser): Promise<{ total: number; unique: number }> {
  return browser.evaluate(() => {
    const seen = new Set<string>();
    let total = 0;
    for (const node of document.querySelectorAll('span, div')) {
      if (node.children.length > 0) continue;
      const text = node.textContent?.trim() ?? '';
      if (!text.startsWith('audit.page.')) continue;
      total += 1;
      seen.add(text);
    }
    return { total, unique: seen.size };
  });
}

interface ExportBody {
  format: string;
  exportedAt: string;
  items: Array<{
    id: string;
    action: string;
    target: string | null;
    status: string;
    inputDigest: string | null;
    requestId: string | null;
  }>;
}

test('target filter narrows the list and the export', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  const ownTarget = targetOf('filter');
  const unrelatedTarget = targetOf('unrelated');
  const ownAction = 'audit.e2e.target.fixture';
  const unrelatedAction = 'audit.e2e.target.unrelated';
  const ids = [
    await seedAudit(ownTarget, ownAction, {
      inputDigest: 'a'.repeat(32),
      requestId: 'req-audit-e2e',
    }),
    await seedAudit(unrelatedTarget, unrelatedAction),
  ];

  try {
    await app.open('/audit');
    await expect(screen.getByRole('heading', '审计')).toBeVisible();

    await screen.getByRole('button', '筛选').tap();
    const targetInput = screen.getByLabel('按目标精确筛选');
    await targetInput.fill(ownTarget);
    await browser.keyboard.press('Escape');
    await expect(browser).toHaveURL(/\/audit\?.*target=/);

    await expect(screen.getByText(ownAction, { exact: true }).first()).toBeVisible();
    await expect(screen.getByText(unrelatedAction, { exact: true }).first()).not.toBeVisible();

    await screen.getByRole('button', '更多操作', { exact: true }).tap();
    await expect(screen.getByRole('menuitem', '导出审计 (JSON)', { exact: true })).toBeEnabled();
    const download = await browser.waitForDownload(() =>
      screen.getByRole('menuitem', '导出审计 (JSON)', { exact: true }).tap(),
    );
    expect(download.suggestedFilename).toBe('audit.json');

    const body = await readJson(download.absolutePath);
    expect(body.format).toBe('agentport/audit@1');
    expect(body.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      action: ownAction,
      target: ownTarget,
      status: 'ok',
      inputDigest: 'a'.repeat(32),
      detail: null,
      requestId: 'req-audit-e2e',
    });
    const raw = await readFile(download.absolutePath, 'utf8');
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
      'action',
      'actor',
      'actorKind',
      'createdAt',
      'detail',
      'detailType',
      'durationMs',
      'id',
      'inputDigest',
      'requestId',
      'status',
      'subjectBusinessId',
      'target',
    ]);
    expect(raw).not.toContain(unrelatedTarget);
    expect(raw).not.toContain('prompt');
    await expect(browser).toHaveURL(/\/audit\?.*target=/);
  } finally {
    await removeFixtures(ids, [ownTarget, unrelatedTarget]);
  }
});

test('round38 same-time audit pagination', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  const target = targetOf('same-time');
  await runFixture('audit-export', 'seedSameTime', target);

  try {
    await app.open('/audit');
    const firstPage = browser.waitForResponse(new RegExp(`/api/audit\\?target=${target}&`));
    await app.open(`/audit?target=${encodeURIComponent(target)}`);
    await expect(screen.getByText('100 行', { exact: true })).toBeVisible();
    await expect(screen.getByText('audit.page.125', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('audit.page.001', { exact: true })).toHaveCount(0);

    const first = await firstPage;
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ items: { id: string; action: string }[] }>();
    expect(firstBody.items).toHaveLength(100);
    expect(firstBody.items.at(-1)?.action).toBe('audit.page.026');
    expect(await auditActionTexts(browser)).toEqual({ total: 100, unique: 100 });

    const nextPage = browser.waitForResponse(/\/api\/audit\?.*cursor=/);
    await screen.getByRole('button', '加载更多', { exact: true }).tap();
    const second = await nextPage;
    expect(second.status).toBe(200);
    expect(second.url).toContain('cursor=');
    expect(second.url).not.toMatch(/[?&]before=/);
    const secondBody = await second.json<{ items: { id: string; action: string }[] }>();
    expect(secondBody.items).toHaveLength(25);
    expect(secondBody.items[0]?.action).toBe('audit.page.025');
    expect(secondBody.items.at(-1)?.action).toBe('audit.page.001');

    await expect(screen.getByText('125 行', { exact: true })).toBeVisible();
    await expect(screen.getByText('audit.page.001', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('audit.page.125', { exact: true })).toHaveCount(1);
    expect(await auditActionTexts(browser)).toEqual({ total: 125, unique: 125 });
    await expect(screen.getByText('已到末尾', { exact: true })).toBeVisible();
    await expect(screen.getByRole('button', '加载更多', { exact: true })).toHaveCount(0);
  } finally {
    await removeFixtures([], [target]);
  }
});

test('oversize audit export reports the error instead of silently truncating', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  const target = targetOf('oversize');
  await runFixture('audit-export', 'seedOversize', target);
  try {
    await app.open(`/audit?target=${encodeURIComponent(target)}`);
    await screen.getByRole('button', '更多操作', { exact: true }).tap();
    await screen.getByRole('menuitem', '导出审计 (JSON)', { exact: true }).tap();
    await expect(screen.getByText('超过 1000 条', { exact: false }).first()).toBeVisible();
    await expect(browser).toHaveURL(/\/audit\?target=/);
    await screen.getByRole('button', '更多操作', { exact: true }).tap();
    await expect(screen.getByRole('menuitem', '导出审计 (JSON)', { exact: true })).toBeEnabled();
    await browser.keyboard.press('Escape');
  } finally {
    await removeFixtures([], [target]);
  }
});

test('exports exactly 1000 audit rows', { session: 'admin' }, async ({ app, screen, browser }) => {
  const target = targetOf('bulk');
  await runFixture('audit-export', 'seedLimit', target);

  try {
    await app.open(`/audit?target=${encodeURIComponent(target)}`);
    await expect(screen.getByText('100 行', { exact: true })).toBeVisible();

    await screen.getByRole('button', '更多操作', { exact: true }).tap();
    const download = await browser.waitForDownload(() =>
      screen.getByRole('menuitem', '导出审计 (JSON)', { exact: true }).tap(),
    );
    const body = await readJson(download.absolutePath);
    expect(body.format).toBe('agentport/audit@1');
    expect(body.items).toHaveLength(1000);
    expect(body.items.every((row) => row.target === target)).toBe(true);
    await screen.getByRole('button', '更多操作', { exact: true }).tap();
    await expect(screen.getByRole('menuitem', '导出审计 (JSON)', { exact: true })).toBeEnabled();
    await browser.keyboard.press('Escape');
    await expect(browser).toHaveURL(/\/audit\?target=/);
  } finally {
    await removeFixtures([], [target]);
  }
});
