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
  await screen.getByRole('button', '新建 Server').first().tap();
  await screen.getByRole('button', 'generated', { exact: false }).tap();
  await browser.locator('#server-name').fill(serverName);
  await browser.locator('#server-url').fill('https://jsonplaceholder.typicode.com');
  await screen.getByRole('button', '创建').tap();
  await expect(screen.getByText(serverName, { exact: false }).first()).toBeVisible();

  // 2. 展开工具定义并添加一个工具
  const card = browser.locator('div.rounded-\\[10px\\]').filter({ hasText: serverName }).first();
  await card.getByRole('button', '工具定义').tap();
  await browser.locator('input[id^="tool-name-"]').fill('get-user');
  await browser.locator('input[id^="tool-path-"]').fill('/users/{id}');
  await browser.locator('input[id^="tool-desc-"]').fill('fetch a user by id');
  await screen.getByRole('button', '添加').tap();
  await expect(screen.getByText('工具已添加')).toBeVisible();

  // 3. 测试连接：服务端真连平台自己的 /mcp/:id 并 listTools
  await card.getByRole('button', '测试').tap();
  await expect(screen.getByText('连接成功')).toBeVisible();
  await expect(screen.getByText('get-user', { exact: false }).last()).toBeVisible();

  // 4. 建 agent、绑定 server、看渲染出的 .mcp.json
  await app.open('/agents');
  await screen.getByRole('button', '新建智能体').first().tap();
  await browser.locator('#new-agent-slug').fill(agentSlug);
  await browser.locator('#new-agent-name').fill(agentName);
  await browser.locator('#new-agent-prompt').fill(' You help test Agentport.');
  await screen.getByRole('button', '创建').tap();

  await screen.getByRole('button', 'MCP Server').tap();
  await browser.locator('label').filter({ hasText: serverName }).getByRole('checkbox').check();
  await browser.keyboard.press('Escape');
  await screen.getByRole('button', '保存更改').first().tap();
  await expect(screen.getByText('智能体已保存')).toBeVisible();

  await screen.getByRole('tab', '文件预览').tap();
  await expect(screen.getByText('"mcpServers"', { exact: false }).first()).toBeVisible();
});

/**
 * 迁移自 e2e/smoke.spec.ts 第 5 步。需要 worker + 模型凭据；
 * 未设置 E2E_FULL=1 时跳过，与 Playwright 版行为一致。
 */
test('smoke: chat runs to a terminal state', { session: 'admin' }, async ({
  app,
  screen,
  agent,
}) => {
  test.skip(process.env.E2E_FULL !== '1', '需要 worker 与模型凭据，设置 E2E_FULL=1 才跑');

  await app.open('/chat');
  // 原生 <select>：用 selectOption，选择第一个可用智能体。
  const agentSelect = screen.getByLabel('选择智能体');
  await agentSelect.selectOption({ index: 0 });
  await screen.getByRole('textbox', '消息').fill('hello');
  await screen.getByRole('button', '发送消息').tap();

  // 等待运行进入终态；用语义等待，避免依赖具体状态文案。
  await agent.waitFor('the chat shows a finished, failed, timed-out or stopped run');
});
