import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';

test('smoke: generated server, tool, connection test, agent files', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  const run = Date.now().toString(36);
  const serverName = `e2e-srv-${run}`;
  const agentSlug = `e2e-agent-${run}`;
  const agentName = `E2E Agent ${run}`;

  let serverId: string | undefined;
  let agentId: string | undefined;
  let creation: Promise<void> | undefined;
  const errors: unknown[] = [];
  try {
    await app.open('/servers');
    await screen.getByRole('button', '新建连接器').first().tap();
    await screen.getByRole('button', 'HTTP API 转 MCP', { exact: false }).tap();
    await browser.locator('#server-name').fill(serverName);
    await browser.locator('#server-url').fill('https://jsonplaceholder.typicode.com');
    creation = browser.waitForResponse(/\/api\/servers$/).then(async (response) => {
      if (response.status === 201) serverId = (await response.json<{ id: string }>()).id;
    });
    await Promise.all([screen.getByRole('button', '创建').tap(), creation]);
    await expect(screen.getByText(serverName, { exact: false }).first()).toBeVisible();

    await browser.locator('input[id^="tool-name-"]').fill('get-user');
    await browser.locator('input[id^="tool-path-"]').fill('/users/{id}');
    await browser.locator('input[id^="tool-desc-"]').fill('fetch a user by id');
    // 路径里的 {id} 必须在 inputSchema.properties 中有同名属性，否则表单会拦下。
    // CodeMirror 只认键盘事件：选中全部再逐字输入，不能直接写 DOM。
    const schema = screen.getByLabel('inputSchema (JSON)');
    await schema.focus();
    await schema.press('ControlOrMeta+a');
    await schema.pressSequentially(
      '{"type":"object","properties":{"id":{"type":"integer"}},"required":["id"]}',
    );
    await screen.getByRole('button', '添加').tap();
    await expect(screen.getByText('工具已添加')).toBeVisible();

    await screen.getByRole('button', '关闭').tap();

    const actions = screen.getByRole('button', { name: `操作 ${serverName}`, exact: true });
    await actions.tap();
    const tested = browser.waitForResponse(new RegExp(`/api/servers/${serverId}/test$`));
    await screen.getByRole('menuitem', '测试连接').tap();
    const result = await (await tested).json<{ ok: boolean; tools: Array<{ name: string }> }>();
    expect(result.ok).toBe(true);
    expect(result.tools.map((tool) => tool.name)).toContain('get-user');

    await actions.tap();
    await screen.getByRole('menuitem', '工具与测试', { exact: true }).tap();
    const catalog = browser.locator('[role="dialog"]');
    await expect(catalog).toContainText('properties');
    await expect(catalog).toContainText('integer');
    await screen.getByRole('button', '关闭').tap();

    await app.open('/agents');
    await screen.getByRole('button', '新建专家').first().tap();
    await screen.getByRole('button', '高级设置', { exact: true }).tap();
    await browser.locator('#new-agent-slug').fill(agentSlug);
    await browser.locator('#new-agent-name').fill(agentName);
    await browser.locator('#new-agent-prompt').fill(' You help test Agentport.');
    creation = browser.waitForResponse(/\/api\/agents$/).then(async (response) => {
      if (response.status === 201) agentId = (await response.json<{ id: string }>()).id;
    });
    await Promise.all([screen.getByRole('button', '创建').tap(), creation]);

    await screen.getByRole('button', '能力', { exact: false }).tap();
    await screen.getByRole('combobox', 'MCP Server').tap();
    await browser.locator('[role="option"]').filter({ hasText: serverName }).first().click();
    await browser.keyboard.press('Escape');
    await screen.getByRole('button', '保存更改').first().tap();
    await expect(screen.getByText('智能体已保存')).toBeVisible();

    await screen.getByRole('button', '.mcp.json 与 frontmatter 草稿', { exact: true }).tap();
    await expect(screen.getByText('"mcpServers"', { exact: false }).first()).toBeVisible();
    await screen.getByRole('tab', '文件与版本', { exact: true }).tap();
    await screen.getByRole('button', '.mcp.json', { exact: true }).tap();
    await expect(screen.getByText('"mcpServers"', { exact: false }).first()).toBeVisible();

    await screen.getByRole('tab', '配置', { exact: true }).tap();
    await screen.getByRole('button', '行为', { exact: false }).tap();
    const prompt = browser.locator('#agent-prompt');
    await prompt.fill('Unsaved expert draft');
    await screen.getByRole('button', '返回列表', { exact: true }).tap();
    await expect(screen.getByRole('heading', '放弃未保存的更改？')).toBeVisible();
    await screen.getByRole('button', '取消', { exact: true }).tap();
    await expect(prompt).toHaveValue('Unsaved expert draft');
    await screen.getByRole('button', '返回列表', { exact: true }).tap();
    await screen.getByRole('button', '放弃并离开').tap();
    await expect(screen.getByRole('link', { name: agentName, exact: true })).toBeVisible();
  } catch (error) {
    errors.push(error);
  } finally {
    await creation?.catch((error) => {
      if (!errors.includes(error)) errors.push(error);
    });
    for (const [resource, id] of [
      ['agents', agentId],
      ['servers', serverId],
    ]) {
      if (id === undefined) continue;
      try {
        const response = await browserFetch(browser, 'DELETE', `/api/${resource}/${id}`);
        if (response.status !== 204 && response.status !== 404) {
          errors.push(
            new Error(`清理 ${resource}/${id} 失败 ${response.status}：${response.text}`),
          );
        }
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'smoke 资产清理失败');
  }
});

test('smoke: chat runs to a successful terminal state', { session: 'admin' }, async ({
  app,
  screen,
  browser,
  agent,
}) => {
  test.skip(process.env.E2E_FULL !== '1', '需要 worker 与模型凭据，设置 E2E_FULL=1 才跑');

  await app.open('/agents');

  const run = Date.now().toString(36);
  const created = await browserFetch(browser, 'POST', '/api/agents', {
    slug: `e2e-chat-${run}`,
    name: `E2E 对话 ${run}`,
    model: process.env.E2E_CHAT_MODEL ?? 'group/haiku',
  });
  if (created.status !== 201) {
    throw new Error(`创建临时专家失败 ${created.status}：${created.text}`);
  }
  const agentId = (JSON.parse(created.text) as { id: string }).id;

  let failure: unknown;
  try {
    await app.open(`/chat?agent=${agentId}`);
    await screen.getByRole('textbox', '消息').fill('hello');
    await screen.getByRole('button', '发送消息').tap();
    await agent.waitFor('the chat run has finished and is no longer streaming', {
      timeout: 90_000,
      interval: 3_000,
    });

    const deadline = Date.now() + 20_000;
    let latest: { status: string; error: string | null } | undefined;
    while (Date.now() < deadline) {
      const list = JSON.parse(
        (await browserFetch(browser, 'GET', `/api/runs?agentId=${agentId}&limit=1`)).text,
      ) as { items: Array<{ status: string; error: string | null }> };
      latest = list.items[0];
      if (latest !== undefined && !['queued', 'running'].includes(latest.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (latest?.status !== 'succeeded') {
      throw new Error(
        `聊天运行未成功：status=${latest?.status ?? 'missing'} error=${latest?.error ?? ''}`,
      );
    }
  } catch (error) {
    failure = error;
  }

  const deleted = await browserFetch(browser, 'DELETE', `/api/agents/${agentId}`);
  if (deleted.status !== 204) {
    const cleanupError = new Error(`清理临时专家失败 ${deleted.status}：${deleted.text}`);
    if (failure !== undefined) {
      throw new AggregateError([failure, cleanupError], '对话用例与专家清理均失败');
    }
    throw cleanupError;
  }
  if (failure !== undefined) throw failure;
});
