import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { AGENT_PACKAGE_MAX_BYTES } from '../packages/shared/dist/agent-package.js';
import { fixture as runFixture } from './support/fixture.js';

interface Fixture {
  id: string;
  slug: string;
  name: string;
  prompt: string;
}

const created: Fixture[] = [];
const importedIds: string[] = [];

test.afterEach(async () => {
  await runFixture('agent-package-bytes', 'cleanup', [
    ...created.map((item) => item.id),
    ...importedIds,
  ]);
  created.length = 0;
  importedIds.length = 0;
});

async function seed(prompt: string): Promise<Fixture> {
  const value = await runFixture('agent-package-bytes', 'seed', prompt);
  created.push(value);
  return value;
}

interface ImportResult {
  agent: { id: string; slug: string; systemPrompt: string };
}

test('golden export downloads a claude directory zip and re-imports through the page', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  const prompt = '你是助手。\n包含 "引号"、\\反斜杠 与 🚀\n第二行';
  const fixture = await seed(prompt);

  await app.open(`/agents?q=${encodeURIComponent(fixture.slug)}`);
  const actions = screen.getByRole('button', `操作 ${fixture.name}`);
  await expect(actions).toBeVisible();
  await actions.tap();
  await screen.getByRole('menuitem', '配置').tap();
  await expect(screen.getByRole('button', '身份', { exact: true })).toBeVisible();

  const download = await browser.waitForDownload(async () => {
    await screen.getByRole('button', '更多操作').tap();
    await screen.getByRole('menuitem', '导出 ZIP').tap();
  });
  expect(download.suggestedFilename).toBe(`${fixture.slug}.zip`);

  const bytes = await readFile(download.absolutePath);
  expect(bytes.byteLength).toBeLessThanOrEqual(AGENT_PACKAGE_MAX_BYTES);
  // ZIP 本地文件头；旧 JSON 导出不应再出现。
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

  await screen.getByRole('button', '返回列表', { exact: true }).tap();
  const responsePromise = browser.waitForResponse(/\/api\/import\/agents$/);
  await browser.locator('input[type="file"]').setInputFiles(download.absolutePath);
  await screen.getByRole('dialog', '导入专家包').getByRole('button', '导入', { exact: true }).tap();
  const response = await responsePromise;
  expect(response.status).toBe(201);
  await expect(browser).toHaveURL(/\/agents\/[^/?#]+(?:\?.*)?$/);
  const importedId = new URL(await browser.url()).pathname.split('/').pop() ?? '';
  const imported = await browser.evaluate(
    async (agentId: string) =>
      (await (await fetch(`/api/agents/${agentId}`)).json()) as ImportResult['agent'],
    importedId,
  );
  importedIds.push(imported.id);

  expect(imported.slug).toMatch(new RegExp(`^${fixture.slug}-\\d+$`));
  expect(imported.systemPrompt).toBe(prompt);
  await expect(screen.getByText('已导入「', { exact: false }).first()).toBeVisible();
  const warnings = screen.getByRole('dialog', '导入提示');
  await expect(warnings).toBeVisible();
  await warnings.getByRole('button', '关闭', { exact: true }).tap();
  await expect(warnings).toBeHidden();
  await screen.getByRole('tab', '配置', { exact: true }).tap();
  await expect(screen.getByRole('button', '更多操作')).toBeVisible();
});

test('oversize export reports the 1 MiB error and keeps the editor usable', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  const fixture = await seed(randomBytes(1_500_000).toString('base64'));

  await app.open(`/agents?q=${encodeURIComponent(fixture.slug)}`);
  await screen.getByRole('button', `操作 ${fixture.name}`).tap();
  await screen.getByRole('menuitem', '配置').tap();
  await expect(screen.getByRole('button', '身份', { exact: true })).toBeVisible();

  await screen.getByRole('button', '更多操作').tap();
  await screen.getByRole('menuitem', '导出 ZIP').tap();

  await expect(screen.getByText('专家包超过 1 MiB', { exact: false }).first()).toBeVisible();
  expect(new URL(await browser.url()).pathname).toBe(`/agents/${fixture.id}`);
  await expect(screen.getByRole('button', '更多操作')).toBeEnabled();
  await screen.getByRole('button', '更多操作').tap();
  await expect(screen.getByRole('menuitem', '导出 ZIP')).toBeEnabled();
});
