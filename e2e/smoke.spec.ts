import { expect, login, test } from './fixtures.js';

test('smoke: server, tool, test connection, agent files, chat stream', async ({ page, unique }) => {
  const serverName = unique('e2e-srv');
  const agentSlug = unique('e2e-agent');
  const agentName = unique('E2E Agent');

  await login(page);
  try {
    // 1. generated server 指向公开的 jsonplaceholder
    await page.getByRole('link', { name: 'MCP Servers', exact: true }).click();
    await page.getByRole('button', { name: '新建 Server' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /generated/ }).click();
    await dialog.locator('#server-name').fill(serverName);
    await dialog.locator('#server-url').fill('https://jsonplaceholder.typicode.com');
    await dialog.getByRole('button', { name: '创建' }).click();

    const card = page
      .locator('div.rounded-\\[10px\\]')
      .filter({ has: page.getByText(serverName, { exact: true }) })
      .first();
    await expect(card).toBeVisible();

    // 2. 展开 generated server 的工具定义并添加一个工具
    await card.getByRole('button', { name: '工具定义' }).click();
    await page.locator('input[id^="tool-name-"]').fill('get-user');
    await page.locator('input[id^="tool-path-"]').fill('/users/{id}');
    await page.locator('input[id^="tool-desc-"]').fill('fetch a user by id');
    await page.getByRole('button', { name: '添加' }).click();
    await expect(page.getByText('工具已添加')).toBeVisible();

    // 3. 测试连接：服务端会真连平台自己的 /mcp/:id 并 listTools
    await card.getByRole('button', { name: '测试', exact: true }).click();
    await expect(page.getByText('连接成功')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('get-user', { exact: true }).last()).toBeVisible();

    // 4. 创建 agent，绑定 server，查看渲染出的 .mcp.json
    await page.getByRole('link', { name: '智能体', exact: true }).click();
    await page.getByRole('button', { name: '新建智能体' }).first().click();
    const agentDialog = page.getByRole('dialog');
    await agentDialog.locator('#new-agent-slug').fill(agentSlug);
    await agentDialog.locator('#new-agent-name').fill(agentName);
    await agentDialog.locator('#new-agent-prompt').fill('You help test Agentport.');
    await agentDialog.getByRole('button', { name: '创建' }).click();

    // 绑定 server：MultiSelect 的触发按钮带 aria-label="MCP Server"。
    await page.getByRole('button', { name: 'MCP Server' }).click();
    await page.locator('label').filter({ hasText: serverName }).getByRole('checkbox').check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '保存更改' }).first().click();
    await expect(page.getByText('智能体已保存')).toBeVisible();

    await page.getByRole('tab', { name: '文件预览' }).click();
    const preview = page.locator('pre').first();
    await expect(preview).toContainText('"mcpServers"');
    await expect(preview).toContainText(serverName);
    await expect(preview).toContainText('"type": "http"');
    await page.getByRole('tab', { name: 'CLAUDE.md' }).click();
    await expect(preview).toContainText('You help test Agentport.');

    // 5. 真实模型跑一轮：需要 docker + worker + 模型凭据。
    test.skip(process.env.E2E_FULL !== '1', 'chat 流程依赖真实模型与沙盒，设置 E2E_FULL=1 才跑');
    await page.getByRole('link', { name: '对话', exact: true }).click();
    await page.getByLabel('选择智能体').selectOption({ label: agentName });
    await page.getByLabel('消息').fill('hello');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText(/运行完成|运行失败|运行超时|已停止/)).toBeVisible({
      timeout: 120_000,
    });
  } finally {
    // 走相对路径：page.request 的 cookie 绑定在 baseURL（5173），直连 3000 会丢 cookie。
    const api = page.request;
    // 用例被 skip 时页面可能已关闭，cleanup 失败不应掩盖真实结果。
    const servers = await api
      .get('/api/servers', { timeout: 10_000 })
      .then((r) => r.json() as Promise<Array<{ id: string; name: string }>>)
      .catch(() => [] as Array<{ id: string; name: string }>);
    for (const s of servers.filter((s) => s.name === serverName)) {
      await api.delete(`/api/servers/${s.id}`, { timeout: 10_000 }).catch(() => undefined);
    }
    const agents = await api
      .get('/api/agents', { timeout: 10_000 })
      .then((r) => r.json() as Promise<Array<{ id: string; slug: string }>>)
      .catch(() => [] as Array<{ id: string; slug: string }>);
    for (const a of agents.filter((a) => a.slug === agentSlug)) {
      await api.delete(`/api/agents/${a.id}`, { timeout: 10_000 }).catch(() => undefined);
    }
  }
});
