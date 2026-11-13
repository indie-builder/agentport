import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { AGENT_PACKAGE_MAX_BYTES } from '../packages/shared/dist/agent-package.js';
import { fixture as runFixture } from './support/fixture.js';

/**
 * 专家包字节上限的真实浏览器验收：真实页面、真实 API、数据库直写 fixture。
 * E2E_DATABASE_URL 必须显式给出（无默认值），且与页面背后 API 指向同一个库。
 */
interface Fixture {
  id: string;
  slug: string;
  name: string;
  prompt: string;
}

const created: Fixture[] = [];
/** 导入产生的副本是新建行，ID 由 API 返回，单独记录。 */
const importedIds: string[] = [];

/** 只删本文件建的 agent；版本、绑定随 agent 级联删除，审计行按目标另删。 */
test.afterEach(async () => {
  await runFixture('agent-package-bytes', 'cleanup', [
    ...created.map((item) => item.id),
    ...importedIds,
  ]);
  created.length = 0;
  importedIds.length = 0;
});

/** 直写数据库：600 KB 级提示词放不进默认 1 MiB 的导入请求体。 */
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

  // 列表页按 slug 过滤，再打开专家详情。
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

  // 下载文件原样交给列表页里的文件输入，走真实导入端点。
  await screen.getByRole('button', '返回列表', { exact: true }).tap();
  const responsePromise = browser.waitForResponse(/\/api\/import\/agents$/);
  await browser.locator('input[type="file"]').setInputFiles(download.absolutePath);
  await screen.getByRole('dialog', '导入专家包').getByRole('button', '导入', { exact: true }).tap();
  const response = await responsePromise;
  expect(response.status).toBe(201);
  await expect(browser).toHaveURL(/\/agents\/[^/?#]+$/);
  const importedId = new URL(await browser.url()).pathname.split('/').pop() ?? '';
  const imported = await browser.evaluate(
    async (agentId: string) =>
      (await (await fetch(`/api/agents/${agentId}`)).json()) as ImportResult['agent'],
    importedId,
  );
  importedIds.push(imported.id);

  // 同 slug 已存在，导入为带后缀的副本，内容不变。
  expect(imported.slug).toMatch(new RegExp(`^${fixture.slug}-\\d+$`));
  expect(imported.systemPrompt).toBe(prompt);
  await expect(screen.getByText('已导入「', { exact: false }).first()).toBeVisible();
  await expect(screen.getByRole('dialog', '导入提示')).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await screen.getByRole('tab', '配置', { exact: true }).tap();
  await expect(screen.getByRole('button', '更多操作')).toBeVisible();
});

test('oversize export reports the 1 MiB error and keeps the editor usable', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  // 1.5 MB 随机字节转 base64（约 2 MB）不可压缩，压缩后仍超过 1 MiB；
  // 直写数据库绕开导入请求体上限。
  const fixture = await seed(randomBytes(1_500_000).toString('base64'));

  await app.open(`/agents?q=${encodeURIComponent(fixture.slug)}`);
  await screen.getByRole('button', `操作 ${fixture.name}`).tap();
  await screen.getByRole('menuitem', '配置').tap();
  await expect(screen.getByRole('button', '身份', { exact: true })).toBeVisible();

  await screen.getByRole('button', '更多操作').tap();
  await screen.getByRole('menuitem', '导出 ZIP').tap();

  await expect(screen.getByText('专家包超过 1 MiB', { exact: false }).first()).toBeVisible();
  // 失败不导航、不关闭编辑器；触发器恢复可再次点击。
  expect(new URL(await browser.url()).pathname).toBe(`/agents/${fixture.id}`);
  await expect(screen.getByRole('button', '更多操作')).toBeEnabled();
  await screen.getByRole('button', '更多操作').tap();
  await expect(screen.getByRole('menuitem', '导出 ZIP')).toBeEnabled();
});
