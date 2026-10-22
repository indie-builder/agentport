import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { createDb, newId } from '../packages/db/dist/index.js';
import { AGENT_PACKAGE_MAX_BYTES, serializeAgentPackage } from '../packages/shared/dist/agent.js';

/**
 * 专家包字节上限的真实浏览器验收：真实页面、真实 API、数据库直写 fixture。
 * DATABASE_URL 必须显式给出（无默认值），且与页面背后 API 指向同一个库。
 */
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required for agent package fixtures');

let dbPromise: ReturnType<typeof createDb> | undefined;
function db(): ReturnType<typeof createDb> {
  dbPromise ??= createDb(DATABASE_URL);
  return dbPromise;
}

test.afterAll(async () => {
  const current = await dbPromise;
  await current?.pool.end();
});

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
  const { pool } = await db();
  const ids = [...created.map((fixture) => fixture.id), ...importedIds];
  if (ids.length > 0) {
    await pool.query('delete from audit_log where target = any($1::text[])', [ids]);
    await pool.query('delete from agents where id = any($1::text[])', [ids]);
  }
  created.length = 0;
  importedIds.length = 0;
});

/** 直写数据库：600 KB 级提示词放不进默认 1 MiB 的导入请求体。 */
async function seed(prompt: string): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = {
    id: newId('agent'),
    slug: `e2e-pkg-${suffix}`,
    name: `E2E 包 ${suffix}`,
    prompt,
  };
  const { pool } = await db();
  await pool.query(
    `insert into agents (id, slug, name, model, system_prompt_md)
     values ($1, $2, $3, 'test-model', $4)`,
    [fixture.id, fixture.slug, fixture.name, prompt],
  );
  created.push(fixture);
  return fixture;
}

interface AgentPackage {
  format: string;
  exportedAt: string;
  agent: { slug: string; name: string; systemPrompt: string };
  workspace: { claudeMd: string; agentMd: string; mcpJson: string };
}

interface ImportResult {
  agent: { id: string; slug: string; systemPrompt: string };
}

test('golden export downloads the exact pretty package and re-imports through the page', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  const prompt = '你是助手。\n包含 "引号"、\\反斜杠 与 🚀\n第二行';
  const fixture = await seed(prompt);

  // 列表页按 slug 过滤，再点标题按钮打开编辑器；URL 不承载选中态。
  await app.open(`/agents?q=${encodeURIComponent(fixture.slug)}`);
  const configure = screen.getByRole('button', `配置 ${fixture.name}`);
  await expect(configure).toBeVisible();
  await configure.tap();

  const download = await browser.waitForDownload(async () => {
    await screen.getByRole('button', '更多操作').tap();
    await screen.getByRole('menuitem', '导出 JSON').tap();
  });
  expect(download.suggestedFilename).toBe(`${fixture.slug}.agent.json`);

  const raw = await readFile(download.absolutePath, 'utf8');
  expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(AGENT_PACKAGE_MAX_BYTES);

  const body = JSON.parse(raw) as AgentPackage;
  expect(body.format).toBe('agentport/agent@1');
  expect(body.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(body.agent.slug).toBe(fixture.slug);
  expect(body.agent.name).toBe(fixture.name);
  expect(body.agent.systemPrompt).toBe(prompt);
  // 工作区预览必须随包保留，且来自同一份提示词。
  expect(body.workspace.claudeMd).toContain(prompt);
  expect(body.workspace.agentMd).toContain(`name: "${fixture.slug}"`);
  expect(body.workspace.mcpJson).toContain('"mcpServers"');
  // 下载字节就是页面的序列化结果；二次排版不会生成导入端拒绝的包。
  expect(raw).toBe(serializeAgentPackage(body));

  // 下载文件原样交给页面里的文件输入，走真实导入端点。
  const responsePromise = browser.waitForResponse(/\/api\/import\/agents$/);
  await browser.locator('input[type="file"]').setInputFiles(download.absolutePath);
  const response = await responsePromise;
  expect(response.status).toBe(201);
  const result = (await response.json()) as ImportResult;
  importedIds.push(result.agent.id);

  // 同 slug 已存在，导入为带后缀的副本，内容不变。
  expect(result.agent.slug).toMatch(new RegExp(`^${fixture.slug}-\\d+$`));
  expect(result.agent.systemPrompt).toBe(prompt);
  await expect(screen.getByText('已导入「', { exact: false }).first()).toBeVisible();
  // 页面留在专家页，编辑器切到副本。
  await expect(browser).toHaveURL(/\/agents\?/);
  await expect(screen.getByRole('button', '更多操作')).toBeVisible();
});

test('oversize export reports the 1 MiB error and keeps the editor usable', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  // 60 万个汉字（UTF-8 约 1.7 MiB）同时出现在 agent 与 workspace.claudeMd，
  // 导出必然超过 1 MiB；直写数据库绕开导入请求体上限。
  const fixture = await seed('提'.repeat(600_000));

  await app.open(`/agents?q=${encodeURIComponent(fixture.slug)}`);
  await screen.getByRole('button', `配置 ${fixture.name}`).tap();

  await screen.getByRole('button', '更多操作').tap();
  await screen.getByRole('menuitem', '导出 JSON').tap();

  await expect(screen.getByText('专家包超过 1 MiB', { exact: false }).first()).toBeVisible();
  // 失败不导航、不关闭编辑器；触发器恢复可再次点击。
  await expect(browser).toHaveURL(/\/agents\?/);
  await expect(screen.getByRole('button', '更多操作')).toBeEnabled();
  await screen.getByRole('button', '更多操作').tap();
  await expect(screen.getByRole('menuitem', '导出 JSON')).toBeEnabled();
});
