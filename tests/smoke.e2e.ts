import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

/**
 * 迁移自 e2e/smoke.spec.ts：generated server → 工具 → 测试连接 → 智能体 → 文件预览。
 *
 * 与 Playwright 版的差异：
 * - 用 `app.open()` 直达页面，不点侧栏；
 * - 清理改由 API 完成（页面不一定提供删除入口）；
 * - 第 5 步（真实模型对话）依赖 worker + 模型凭据，保持跳过。
 */
test('smoke: generated server, tool, connection test, agent files', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  const run = Date.now().toString(36);
  const serverName = `e2e-srv-${run}`;
  const agentSlug = `e2e-agent-${run}`;
  const agentName = `E2E Agent ${run}`;

  // 1. 建 generated server，指向公开的 jsonplaceholder
  await app.open('/servers');
  await screen.getByRole('button', '新建连接器').first().tap();
  await screen.getByRole('button', 'HTTP API 转 MCP', { exact: false }).tap();
  await browser.locator('#server-name').fill(serverName);
  await browser.locator('#server-url').fill('https://jsonplaceholder.typicode.com');
  await screen.getByRole('button', '创建').tap();
  await expect(screen.getByText(serverName, { exact: false }).first()).toBeVisible();

  // 2. 新建 generated server 后工具编辑器自动打开，直接添加一个工具。
  await browser.locator('input[id^="tool-name-"]').fill('get-user');
  await browser.locator('input[id^="tool-path-"]').fill('/users/{id}');
  await browser.locator('input[id^="tool-desc-"]').fill('fetch a user by id');
  // 路径里的 {id} 必须在 inputSchema.properties 中有同名属性，否则表单会拦下。
  await browser
    .locator('textarea[id^="tool-schema-"]')
    .fill('{"type":"object","properties":{"id":{"type":"integer"}},"required":["id"]}');
  await screen.getByRole('button', '添加').tap();
  await expect(screen.getByText('工具已添加')).toBeVisible();

  // 3. 工具编辑器保持打开，便于继续添加；先关掉再看列表。
  await screen.getByRole('button', '关闭').tap();

  // 4. 测试连接走行操作菜单：服务端真连平台自己的 /mcp/:id 并 listTools。
  // 行用 data-slot 定位：视觉类名（圆角、颜色）不能当选择器。
  const row = browser.locator('[data-slot="server-card"]').filter({ hasText: serverName }).first();
  await row.getByRole('button', { name: `操作 ${serverName}` }).tap();
  await screen.getByRole('menuitem', '测试连接').tap();
  await expect(screen.getByText('连接成功')).toBeVisible();
  await expect(screen.getByText('get-user', { exact: false }).last()).toBeVisible();

  // 4b. 只读工具目录：复用最近一次测试结果，打开不重新请求；看完关掉再继续。
  await screen.getByRole('button', `查看 ${serverName} 工具与测试详情`).tap();
  const catalog = browser.locator('[role="dialog"]');
  await expect(catalog).toContainText('properties');
  await expect(catalog).toContainText('integer');
  await screen.getByRole('button', '关闭').tap();

  // 5. 建 agent、绑定 server、看渲染出的 .mcp.json
  await app.open('/agents');
  await screen.getByRole('button', '新建专家').first().tap();
  await browser.locator('#new-agent-slug').fill(agentSlug);
  await browser.locator('#new-agent-name').fill(agentName);
  await browser.locator('#new-agent-prompt').fill(' You help test Agentport.');
  await screen.getByRole('button', '创建').tap();

  // 底座 Combobox：点开是 role=combobox 的输入框，选项在 listbox 里点选。
  await screen.getByRole('button', '能力', { exact: false }).tap();
  await screen.getByRole('combobox', 'MCP Server').tap();
  await browser.locator('[role="option"]').filter({ hasText: serverName }).first().click();
  await browser.keyboard.press('Escape');
  await screen.getByRole('button', '保存更改').first().tap();
  await expect(screen.getByText('智能体已保存')).toBeVisible();

  // 预览分两块：内联草稿（配置页）与完整文件（保存后的快照）。
  await expect(
    screen.getByText('将写入 .mcp.json 与 frontmatter', { exact: false }).first(),
  ).toBeVisible();
  await screen.getByRole('button', '.mcp.json', { exact: true }).tap();
  await expect(screen.getByText('"mcpServers"', { exact: false }).first()).toBeVisible();

  await screen.getByRole('button', '行为', { exact: false }).tap();
  const prompt = browser.locator('#agent-prompt');
  await prompt.fill('Unsaved expert draft');
  await screen.getByRole('button', '返回列表', { exact: true }).tap();
  await expect(screen.getByRole('heading', '放弃未保存的更改？')).toBeVisible();
  await screen.getByRole('button', '取消', { exact: true }).tap();
  await expect(prompt).toHaveValue('Unsaved expert draft');
  await screen.getByRole('button', '返回列表', { exact: true }).tap();
  await screen.getByRole('button', '放弃并离开').tap();
  await expect(screen.getByRole('button', `配置 ${agentName}`)).toBeVisible();
});

/**
 * 迁移自 e2e/smoke.spec.ts 第 5 步。需要 worker + 模型凭据；
 * 未设置 E2E_FULL=1 时跳过，与 Playwright 版行为一致。
 * 终态本身不算通过：必须成功，并留下一条真实的助手回复。
 */
test('smoke: chat succeeds with an assistant reply', {
  session: 'admin',
  timeout: 180_000,
}, async ({ app, screen, browser }) => {
  test.skip(process.env.E2E_FULL !== '1', '需要 worker 与模型凭据，设置 E2E_FULL=1 才跑');

  await app.open('/chat');
  const agentSelect = screen.getByRole('combobox', '选择智能体');
  await agentSelect.tap();
  await screen.getByRole('option').first().tap();
  await screen.getByRole('textbox', '消息').fill('hello');

  // POST /api/chat 返回 runId；后续读取真实运行记录，不靠页面终态猜测成败。
  const accepted = browser.waitForResponse(/\/api\/chat$/);
  await screen.getByRole('button', '发送消息').tap();
  const response = await accepted;
  expect(response.status).toBe(202);
  const { runId } = await response.json<{ runId: string }>();

  const readRun = () =>
    browser.evaluate(async (id: string) => {
      const res = await fetch(`/api/runs/${id}`);
      if (!res.ok) throw new Error(`GET /api/runs/${id} -> ${res.status}: ${await res.text()}`);
      return (await res.json()) as {
        run: { status: string };
        steps: Array<{ kind: string; text?: string }>;
      };
    }, runId);

  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timeout']);
  await expect
    .poll(async () => terminal.has((await readRun()).run.status), { timeout: 120_000 })
    .toBe(true);

  const detail = await readRun();
  expect(detail.run.status, '真实模型运行必须成功').toBe('succeeded');

  const assistantIndex = detail.steps.findIndex(
    (step) => step.kind === 'assistant' && Boolean(step.text?.trim()),
  );
  expect(assistantIndex, '运行必须落库一条非空助手回复').toBeGreaterThanOrEqual(0);
  const reply = detail.steps[assistantIndex]?.text?.trim() ?? '';
  expect(reply.length).toBeGreaterThan(0);

  // 用落库回复的真实文本核对页面，不依赖模型会说什么。
  await app.open(`/runs/${runId}?step=${assistantIndex}`);
  await expect(
    screen.getByText(reply.slice(0, 200).trim(), { exact: false }).first(),
  ).toBeVisible();
});
