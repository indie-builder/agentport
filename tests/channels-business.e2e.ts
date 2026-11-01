import { randomUUID } from 'node:crypto';
import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect, type Screen } from 'e2e';
import { createDb } from '../packages/db/dist/index.js';

/**
 * 频道真实业务回归：真实 agentport 库、真实 Redis 逻辑库 3、真实模型网关。
 * 数据不清理：频道与消息就是本轮业务产物，报告里给可回滚 SQL。
 *
 * 运行前提（环境变量）：DATABASE_URL、E2E_APP_URL、E2E_ADMIN_USER、E2E_ADMIN_PASSWORD。
 * API 用独立端口并以 WEB_DIST 托管已构建的 packages/web/dist；worker 独立进程且与 API
 * 共用同一 REDIS_URL（本文件按 db 3 隔离）。如果真实库的默认运行环境仍指向缺少
 * `dist/session-supervisor.js` 的旧沙盒镜像，run 会以 infra 失败；需要临时把默认运行
 * 环境线上版本指向当前 `agentport/sandbox:dev`，跑完恢复原指针。
 *
 * 智能体用库里已启用的真实行：`我的分身`（业务名）与 `QA怀疑者复跑20261028-1124`
 * （唯一另一个模型可用的已启用行；另一个业务名 `Knowledge expert` 的模型 `test`
 * 在真实网关返回 404）。
 */
const DATABASE_URL = process.env.DATABASE_URL;
const BASE_URL = process.env.E2E_APP_URL ?? 'http://127.0.0.1:3401';

let dbPromise: ReturnType<typeof createDb> | undefined;
function db() {
  if (!dbPromise) {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
    dbPromise = createDb(DATABASE_URL);
  }
  return dbPromise;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function logStep(message: string): void {
  console.log(`\n[业务步骤] ${message}`);
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { pool } = db();
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

interface Account {
  businessId: string;
  username: string;
  password: string;
  name: string;
}

interface AgentRef {
  id: string;
  name: string;
  model: string;
}

interface State {
  suffix: string;
  channelId: string;
  channelName: string;
  pm: Account;
  ops: Account;
  viewer: Account;
  agents: [AgentRef, AgentRef];
  firstRunId: string;
  firstReply: string;
  /** 第一个智能体回复里的可检索片段，用来证明它真的被注入第二个 lane。 */
  firstReplyFragment: string;
  firstHumanSeq: number;
  firstReplySeq: number;
  secondRunId: string;
  secondReply: string;
  /** 第二个 lane 首条用户消息的完整注入原文。 */
  injectedContextText: string;
  contextMessageId: string;
  cancelRunIds: string[];
  reloadRunId: string;
}

let state: State | undefined;

const cookieJar = new Map<string, string>();

async function nodeLogin(account: Pick<Account, 'username' | 'password'>): Promise<string> {
  const cached = cookieJar.get(account.username);
  if (cached !== undefined) return cached;
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: account.username, password: account.password }),
  });
  assert(response.status === 200, `登录 ${account.username} 返回 200（实际 ${response.status}）`);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .filter(Boolean)
    .join('; ');
  assert(cookie.includes('agentport_token='), '登录返回 agentport_token cookie');
  cookieJar.set(account.username, cookie);
  return cookie;
}

async function nodeApi<T = unknown>(
  account: Pick<Account, 'username' | 'password'>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T | null; text: string }> {
  const cookie = await nodeLogin(account);
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: T | null = null;
  try {
    json = text === '' ? null : (JSON.parse(text) as T);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

interface ApiResponse {
  status: number;
  text: string;
}

/** 同源请求：复用浏览器里的登录 cookie。 */
async function apiRaw(
  browser: Browser,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  return browser.evaluate(
    async (input: { method: string; path: string; body: string | null }) => {
      const response = await fetch(input.path, {
        method: input.method,
        ...(input.body === null
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: input.body }),
      });
      return { status: response.status, text: await response.text() };
    },
    { method, path, body: body === undefined ? null : JSON.stringify(body) },
  );
}

async function apiJson<T>(
  browser: Browser,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T | null }> {
  const response = await apiRaw(browser, method, path, body);
  let json: T | null = null;
  try {
    json = response.text === '' ? null : (JSON.parse(response.text) as T);
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

async function loginAs(
  browser: Browser,
  account: Pick<Account, 'username' | 'password'>,
): Promise<void> {
  const result = await apiRaw(browser, 'POST', '/api/auth/login', {
    username: account.username,
    password: account.password,
  });
  assert(result.status === 200, `浏览器登录 ${account.username} 返回 200（实际 ${result.status}）`);
}

async function browserAs(
  app: { open: (path: string) => Promise<void> },
  browser: Browser,
  account: Pick<Account, 'username' | 'password'>,
): Promise<void> {
  await app.open('/login');
  await loginAs(browser, account);
}

/** 让服务端按真实入口建账户；roleIds 显式指定平台「用户」角色。 */
async function createAccount(
  suffix: string,
  tag: string,
  name: string,
  roleIds: string[],
): Promise<Account> {
  const account: Account = {
    businessId: `biz-${tag}-${suffix}`,
    username: `biz_${tag}_${suffix}`,
    password: `Biz-${suffix}-Pass1!`,
    name,
  };
  const result = await nodeApi(ADMIN, 'POST', '/api/accounts', {
    businessId: account.businessId,
    username: account.username,
    name: account.name,
    password: account.password,
    roleIds,
  });
  assert(
    result.status === 201,
    `创建账户 ${tag} 返回 201（实际 ${result.status}：${result.text}）`,
  );
  return account;
}

const ADMIN = {
  username: process.env.E2E_ADMIN_USER ?? 'admin',
  password: process.env.E2E_ADMIN_PASSWORD ?? '',
};

async function ensureState(): Promise<State> {
  if (state !== undefined) return state;
  const suffix = uniqueSuffix();

  logStep('准备真实账户与真实智能体');
  const roles = await nodeApi<{ roles: Array<{ id: string; systemKey: string | null }> }>(
    ADMIN,
    'GET',
    '/api/roles',
  );
  assert(
    roles.status === 200 && roles.json !== null,
    `读取角色矩阵返回 200（实际 ${roles.status}）`,
  );
  const userRole = roles.json.roles.find((role) => role.systemKey === 'user');
  assert(userRole !== undefined, '存在平台「用户」角色');
  const roleIds = [userRole.id];

  const pm = await createAccount(suffix, 'pm', `产品经理-${suffix}`, roleIds);
  const ops = await createAccount(suffix, 'ops', `运营-${suffix}`, roleIds);
  const viewer = await createAccount(suffix, 'viewer', `观察者-${suffix}`, roleIds);

  const agents = await query<AgentRef>(
    `select id, name, model from agents
      where enabled
        and id = any($1::text[])`,
    [['agt_01m5yncjsyf24vnsjqnz7g6e5f', 'agt_01m610yc53fqabc8gvtvass2ea']],
  );
  assert(agents.length === 2, `绑定 2 个真实已启用智能体（实际 ${agents.length}）`);
  const primary = agents.find((agent) => agent.name === '我的分身');
  assert(primary !== undefined, '主智能体「我的分身」存在');
  const secondary = agents.find((agent) => agent.id !== primary.id);
  assert(secondary !== undefined, '第二个智能体存在');

  // 新同事默认看不到别人名下的智能体；由负责人（admin）把这两个智能体授权给
  // 产品经理与运营使用，模拟真实的团队共享，而不是复制或改动智能体定义。
  for (const agent of agents) {
    for (const account of [pm, ops]) {
      const granted = await nodeApi(
        ADMIN,
        'PUT',
        `/api/agents/${agent.id}/members/${account.businessId}`,
        { canUse: true, canMaintain: false },
      );
      assert(
        granted.status === 200,
        `授权 ${account.businessId} 使用 ${agent.name} 返回 200（实际 ${granted.status}：${granted.text}）`,
      );
    }
  }
  const visible = await nodeApi<unknown[]>(pm, 'GET', '/api/agents');
  assert(
    visible.status === 200 && (visible.json?.length ?? 0) >= 2,
    `产品经理可见已授权的智能体（实际 ${visible.json?.length ?? 0}）`,
  );

  state = {
    suffix,
    channelId: '',
    channelName: `增长周会 2026-11 ${suffix}`,
    pm,
    ops,
    viewer,
    agents: [primary, secondary],
    firstRunId: '',
    firstReply: '',
    firstReplyFragment: '',
    firstHumanSeq: 0,
    firstReplySeq: 0,
    secondRunId: '',
    secondReply: '',
    injectedContextText: '',
    contextMessageId: '',
    cancelRunIds: [],
    reloadRunId: '',
  };
  console.log(
    `  账户：PM=${pm.businessId} OPS=${ops.businessId} VIEWER=${viewer.businessId}（平台角色：用户）`,
  );
  console.log(
    `  智能体：${primary.name}（${primary.id}, ${primary.model}）；${secondary.name}（${secondary.id}, ${secondary.model}）`,
  );
  return state;
}

function channelIdFromUrl(url: string): string {
  const id = new URL(url).pathname.split('/').filter(Boolean).at(-1);
  if (!id) throw new Error(`URL 里没有频道 ID：${url}`);
  return id;
}

/** 输入 @ 后从补全菜单选中智能体，再把正文追加到提及后面并发送。 */
async function sendMention(screen: Screen, agentName: string, text: string): Promise<void> {
  const composer = screen.getByRole('textbox', '消息');
  await composer.fill('@');
  await screen.getByRole('listbox', '提及智能体').getByRole('option', { name: agentName }).tap();
  await composer.focus();
  await composer.press('End');
  await composer.pressSequentially(text);
  await expect(composer).toHaveValue(`@${agentName} ${text}`);
  await screen.getByRole('button', '发送消息').tap();
}

function replyPrefix(reply: string): string {
  // 取最长的连续文本段：跨过 Markdown 标记后仍能在页面文本节点里原样匹配。
  const runs =
    reply.match(/[\p{Script=Han}A-Za-z0-9，。！？：；、“”‘’（）()·%.,:;!?\-_/]+/gu) ?? [];
  const longest = runs
    .map((run) => run.trim())
    .filter((run) => run.length >= 8)
    .sort((left, right) => right.length - left.length)[0];
  return (longest ?? reply.replace(/\s+/g, '')).slice(0, 30);
}

/** 模型表示「读不到频道」的常见措辞；只在同一句提到频道/上下文时才算命中。 */
function readFailureEvidence(reply: string): string[] {
  const markers =
    /读不到|拿不到|看不到|没有历史对话|没有(?:访问|读取|获取)|无法(?:读取|访问|查看)/g;
  const evidence: string[] = [];
  for (const match of reply.matchAll(markers)) {
    const at = match.index ?? 0;
    const window = reply
      .slice(Math.max(0, at - 24), Math.min(reply.length, at + 32))
      .replaceAll('\n', ' ');
    if (/频道|上下文|历史|上文|消息|内容|对话/.test(window)) evidence.push(window);
  }
  return [...new Set(evidence)];
}

/** 该 run 在 lane 里的用户消息正文（频道注入会拼在触发消息前面）。 */
async function laneUserMessages(runId: string): Promise<string[]> {
  const rows = await query<{ content: string }>(
    `select content->>'text' as content from messages where run_id = $1 and role = 'user' order by created_at asc`,
    [runId],
  );
  return rows.map((row) => row.content);
}

async function latestRunForTrigger(
  triggerMessageId: string,
): Promise<{ id: string; status: string; agent_id: string; conversation_id: string } | undefined> {
  const rows = await query<{
    id: string;
    status: string;
    agent_id: string;
    conversation_id: string;
  }>(
    `select id, status, agent_id, conversation_id
       from agent_runs
      where channel_trigger_message_id = $1
      order by created_at desc
      limit 1`,
    [triggerMessageId],
  );
  return rows[0];
}

async function messageByBody(channelId: string, body: string) {
  const rows = await query<{
    id: string;
    seq: number;
    kind: string;
    agent_id: string | null;
    run_id: string | null;
    body: string;
  }>(
    `select id, seq, kind, agent_id, run_id, body
       from channel_messages
      where channel_id = $1 and body = $2
      order by seq desc
      limit 1`,
    [channelId, body],
  );
  return rows[0];
}

async function agentMessagesForRun(channelId: string, runId: string) {
  return query<{ id: string; seq: number; agent_id: string | null; body: string }>(
    `select id, seq, agent_id, body
       from channel_messages
      where channel_id = $1 and run_id = $2 and kind = 'agent'
      order by seq asc`,
    [channelId, runId],
  );
}

async function waitRunSettled(triggerMessageId: string, timeoutMs = 600_000) {
  let last: Awaited<ReturnType<typeof latestRunForTrigger>>;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    last = await latestRunForTrigger(triggerMessageId);
    if (last !== undefined && ['succeeded', 'failed', 'cancelled'].includes(last.status))
      return last;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `等待运行结束超时：trigger=${triggerMessageId}；最后状态=${last?.status ?? '无'}`,
  );
}

test.describe('频道真实业务回归（增长周会 2026-11）', { serial: true }, () => {
  test('1. 产品经理建频道、绑定 2 个智能体并拉运营/观察者入频道', { timeout: 300_000 }, async ({
    app,
    screen,
    browser,
  }) => {
    const ctx = await ensureState();
    const started = Date.now();

    await browserAs(app, browser, ctx.pm);
    await app.open('/channels');
    await screen.getByRole('button', '新建频道').first().tap();
    await screen.getByLabel('名称').fill(ctx.channelName);
    await screen.getByRole('button', { name: '创建频道' }).tap();
    await expect(screen.getByRole('heading', { name: ctx.channelName, level: 1 })).toBeVisible();
    ctx.channelId = channelIdFromUrl(await browser.url());
    console.log(`  频道 ID：${ctx.channelId}（${Date.now() - started}ms）`);

    for (const agent of ctx.agents) {
      const select = screen.getByLabel('选择要绑定的智能体');
      await expect(select).toBeVisible({ timeout: 60_000 });
      await select.tap();
      const option = screen.getByRole('option', { name: agent.name });
      await expect(option).toBeVisible({ timeout: 30_000 });
      await option.tap();
      const bindButton = screen.getByRole('button', { name: '绑定智能体' });
      await expect(bindButton).toBeEnabled();
      await bindButton.tap();
      await expect(screen.getByText('智能体已加入频道').first()).toBeVisible();
    }

    for (const [account, role] of [
      [ctx.ops, 'member'],
      [ctx.viewer, 'viewer'],
    ] as const) {
      const added = await nodeApi(ctx.pm, 'POST', `/api/channels/${ctx.channelId}/members`, {
        businessId: account.businessId,
        role,
      });
      assert(
        added.status === 201,
        `PM 添加 ${role} 返回 201（实际 ${added.status}：${added.text}）`,
      );
    }

    const members = await query<{ business_id: string; role: string }>(
      'select business_id, role from channel_members where channel_id = $1 order by role',
      [ctx.channelId],
    );
    expect(members.map((row) => `${row.business_id}:${row.role}`).sort()).toEqual(
      [
        `${ctx.pm.businessId}:owner`,
        `${ctx.ops.businessId}:member`,
        `${ctx.viewer.businessId}:viewer`,
      ].sort(),
    );
    const bindings = await query<{ agent_id: string; status: string }>(
      'select agent_id, status from channel_agent_bindings where channel_id = $1 order by agent_id',
      [ctx.channelId],
    );
    expect(bindings.length).toBe(2);
    assert(
      bindings.every((row) => row.status === 'active'),
      `两个绑定均为 active（实际 ${bindings.map((row) => row.status).join(',')}）`,
    );
    console.log(`  步骤耗时：${Date.now() - started}ms`);
  });

  test('2. 产品经理 @ 智能体提需求并拿到真实模型结论', { timeout: 600_000 }, async ({
    app,
    screen,
    browser,
  }) => {
    const ctx = await ensureState();
    assert(ctx.channelId !== '', '频道已由上一步创建');
    const started = Date.now();
    const requirement =
      '我是产品经理。增长周会在复盘 2026-11 的频道协作：请基于当前频道上下文，指出团队在拉新转化上的主要瓶颈，先给出结论，再给出 3 条可执行建议，每条建议要包含负责人和衡量指标。回复中必须包含项目代号 REV-2026-11。';

    await browserAs(app, browser, ctx.pm);
    await app.open(`/channels/${ctx.channelId}`);
    await expect(screen.getByRole('heading', { name: ctx.channelName, level: 1 })).toBeVisible();

    await sendMention(screen, ctx.agents[0].name, requirement);
    await expect(screen.getByText('运行中').first()).toBeVisible({ timeout: 120_000 });
    console.log(`  运行已开始：${Date.now() - started}ms`);

    // 运行中由运营补一条不带 @ 的上下文：必须进入时间线，但不能唤醒任何智能体。
    const context = `补充上下文 ${ctx.suffix}：上周拉新渠道里，内容合作带来的线索占比最高，但首单转化偏低；客服响应时长是另一个已知问题。`;
    const runsBefore = await query<{ count: string }>(
      'select count(*)::text as count from agent_runs where channel_id = $1',
      [ctx.channelId],
    );
    const posted = await nodeApi<{ id: string; seq: number }>(
      ctx.ops,
      'POST',
      `/api/channels/${ctx.channelId}/messages`,
      { body: context },
    );
    assert(
      posted.status === 201 && posted.json !== null,
      `运营插话返回 201（实际 ${posted.status}）`,
    );
    ctx.contextMessageId = posted.json.id;
    const runsAfter = await query<{ count: string }>(
      'select count(*)::text as count from agent_runs where channel_id = $1',
      [ctx.channelId],
    );
    expect(runsAfter[0]?.count).toBe(runsBefore[0]?.count);
    const contextWoke = await query<{ count: string }>(
      'select count(*)::text as count from agent_runs where channel_trigger_message_id = $1',
      [ctx.contextMessageId],
    );
    expect(contextWoke[0]?.count).toBe('0');
    await expect(screen.getByText(context)).toBeVisible({ timeout: 30_000 });

    const run = await waitRunSettled(
      (await messageByBody(ctx.channelId, `@${ctx.agents[0].name} ${requirement}`))?.id ?? '',
    );
    expect(run.status).toBe('succeeded');
    ctx.firstRunId = run.id;
    const human = await messageByBody(ctx.channelId, `@${ctx.agents[0].name} ${requirement}`);
    assert(human !== undefined, '需求消息已落库');
    ctx.firstHumanSeq = human.seq;
    const agentMessages = await agentMessagesForRun(ctx.channelId, run.id);
    expect(agentMessages.length).toBe(1);
    const reply = agentMessages[0];
    assert(reply !== undefined, '智能体回复已落库');
    expect(reply.agent_id).toBe(ctx.agents[0].id);
    expect(reply.body.trim().length).toBeGreaterThan(50);
    assert(
      reply.body.includes('REV-2026-11'),
      `第一个智能体回复包含约定项目代号 REV-2026-11；原文：${reply.body.slice(0, 500)}`,
    );
    expect(Number(reply.seq)).toBeGreaterThan(Number(human.seq));
    expect(Number(posted.json?.seq ?? 0)).toBeGreaterThan(Number(human.seq));
    ctx.firstReply = reply.body;
    ctx.firstReplyFragment = replyPrefix(reply.body);
    assert(ctx.firstReplyFragment.length >= 8, '第一个回复有可注入检索的连续片段');
    ctx.firstReplySeq = reply.seq;
    const firstLane = await laneUserMessages(run.id);
    expect(firstLane.length).toBe(1);
    console.log(
      `  第一个 lane 用户消息含注入头=${(firstLane[0] ?? '').includes('【频道上下文】')}（此时频道还没有更早消息）`,
    );
    console.log(
      `  运行 ID：${run.id}；回复长度：${reply.body.length} 字；耗时：${Date.now() - started}ms`,
    );
    console.log(`  真实模型摘录：${reply.body.slice(0, 220).replaceAll('\n', ' ')}…`);

    await expect(screen.getByText(replyPrefix(reply.body), { exact: false })).toBeVisible({
      timeout: 60_000,
    });
    await expect(screen.getByText('空闲').first()).toBeVisible({ timeout: 60_000 });
    console.log(`  步骤耗时：${Date.now() - started}ms`);
  });

  test('3. 运营 @ 第二个智能体把结论整理成周报摘要', { timeout: 600_000 }, async ({
    app,
    screen,
    browser,
  }) => {
    const ctx = await ensureState();
    assert(ctx.firstReply !== '', '第一步已有真实结论');
    const started = Date.now();
    const ask =
      '请基于上一条结论，把它整理成一份可直接发到群里的周报摘要：包含本周结论、3 条行动项和下周关注点。';

    await browserAs(app, browser, ctx.ops);
    await app.open(`/channels/${ctx.channelId}`);
    await sendMention(screen, ctx.agents[1].name, ask);
    await expect(screen.getByText('运行中').first()).toBeVisible({ timeout: 120_000 });

    const trigger = await messageByBody(ctx.channelId, `@${ctx.agents[1].name} ${ask}`);
    assert(trigger !== undefined, '周报请求已落库');
    const run = await waitRunSettled(trigger.id);
    expect(run.status).toBe('succeeded');
    ctx.secondRunId = run.id;
    const messages = await agentMessagesForRun(ctx.channelId, run.id);
    expect(messages.length).toBe(1);
    const reply = messages[0];
    assert(reply !== undefined, '第二个智能体回复已落库');
    expect(reply.agent_id).toBe(ctx.agents[1].id);
    expect(reply.body.trim().length).toBeGreaterThan(50);
    expect(Number(reply.seq)).toBeGreaterThan(Number(trigger.seq));
    ctx.secondReply = reply.body;

    // DB 硬断言：第二个 lane 的首条用户消息确实带上了第一个智能体的结论。
    const lane = await laneUserMessages(ctx.secondRunId);
    expect(lane.length).toBe(1);
    const injected = lane[0] ?? '';
    ctx.injectedContextText = injected;
    const headerAt = injected.indexOf('【频道上下文】');
    const currentAt = injected.indexOf('【当前消息】');
    const markerAt = injected.indexOf('REV-2026-11');
    const fragmentAt = injected.indexOf(ctx.firstReplyFragment);
    assert(headerAt === 0, `注入以【频道上下文】开头（实际开头：${injected.slice(0, 60)}）`);
    assert(
      currentAt > headerAt,
      `注入包含【当前消息】且位于上下文之后（header=${headerAt}，current=${currentAt}）`,
    );
    assert(
      markerAt > headerAt && markerAt < currentAt,
      `上下文里包含第一个智能体的项目代号 REV-2026-11（位置 ${markerAt}）`,
    );
    assert(
      fragmentAt > headerAt && fragmentAt < currentAt,
      `上下文里包含第一个回复的核心片段「${ctx.firstReplyFragment}」（位置 ${fragmentAt}）`,
    );
    assert(
      injected.slice(headerAt, currentAt).includes(`智能体 ${ctx.agents[0].id}：`),
      `上下文把该片段标为第一个智能体的回复（${ctx.agents[0].id}）`,
    );
    assert(
      injected.endsWith(`@${ctx.agents[1].name} ${ask}`),
      `【当前消息】之后是本次触发消息（实际结尾：${injected.slice(-80)}）`,
    );
    console.log(
      `  注入上下文：${injected.length} 字；含 REV-2026-11=${markerAt >= 0}；含首个回复片段=${fragmentAt >= 0}`,
    );
    console.log(`  注入原文：${injected.slice(0, 900).replaceAll('\n', '⏎')}…`);

    // 产品层软断言：回复不应再表示读不到频道。
    const readFailures = readFailureEvidence(ctx.secondReply);
    assert(
      readFailures.length === 0,
      `第二个智能体回复不得表示读不到频道（命中：${readFailures.join(' ｜ ')}）；原文：${ctx.secondReply}`,
    );
    console.log(
      `  引用检查：回复提及 REV-2026-11=${ctx.secondReply.includes('REV-2026-11')}，提及首个回复片段=${ctx.secondReply.includes(ctx.firstReplyFragment)}`,
    );

    const firstRun = await query<{ conversation_id: string }>(
      'select conversation_id from agent_runs where id = $1',
      [ctx.firstRunId],
    );
    const secondRun = await query<{ conversation_id: string }>(
      'select conversation_id from agent_runs where id = $1',
      [ctx.secondRunId],
    );
    expect(secondRun[0]?.conversation_id).not.toBe(firstRun[0]?.conversation_id);
    console.log(
      `  运行 ID：${run.id}；回复长度：${reply.body.length} 字；耗时：${Date.now() - started}ms`,
    );
    console.log(`  真实模型摘录：${reply.body.slice(0, 220).replaceAll('\n', ' ')}…`);

    await expect(screen.getByText(replyPrefix(reply.body), { exact: false })).toBeVisible({
      timeout: 60_000,
    });
    await expect(screen.getByText('空闲').first()).toBeVisible({ timeout: 60_000 });
    console.log(`  步骤耗时：${Date.now() - started}ms`);
  });

  test('4. 运行中停止：状态变为已停止且不产生残缺回复', { timeout: 600_000 }, async ({
    app,
    screen,
    browser,
  }) => {
    const ctx = await ensureState();
    const started = Date.now();
    const ask =
      '请详细分析频道协作对增长转化的影响，输出不少于 800 字的完整报告，按章节展开，不要省略。';

    await browserAs(app, browser, ctx.pm);
    await app.open(`/channels/${ctx.channelId}`);
    await sendMention(screen, ctx.agents[0].name, ask);
    const stop = screen.getByRole('button', { name: '停止' }).first();
    await expect(stop).toBeVisible({ timeout: 120_000 });
    const stopVisibleAt = Date.now();
    await stop.tap();

    await expect(screen.getByText('运行已停止。')).toBeVisible({ timeout: 120_000 });
    const trigger = await messageByBody(ctx.channelId, `@${ctx.agents[0].name} ${ask}`);
    assert(trigger !== undefined, '中断请求已落库');
    const run = await latestRunForTrigger(trigger.id);
    assert(run !== undefined, '中断请求有运行记录');
    ctx.cancelRunIds.push(run.id);
    await expect
      .poll(async () => (await latestRunForTrigger(trigger.id))?.status, {
        timeout: 120_000,
      })
      .toBe('cancelled');
    const leftovers = await agentMessagesForRun(ctx.channelId, run.id);
    expect(leftovers.length).toBe(0);
    console.log(
      `  运行 ID：${run.id}；停止按钮出现→点击 ${stopVisibleAt - started}ms；终态 cancelled；残缺回复 ${leftovers.length} 条`,
    );
    console.log(`  步骤耗时：${Date.now() - started}ms`);
  });

  test('5. 观察者只能读：时间线可读，发送能力不可用', { timeout: 300_000 }, async ({
    app,
    screen,
    browser,
  }) => {
    const ctx = await ensureState();
    await browserAs(app, browser, ctx.viewer);
    await app.open(`/channels/${ctx.channelId}`);

    await expect(screen.getByRole('heading', { name: ctx.channelName, level: 1 })).toBeVisible();
    await expect(screen.getByText(replyPrefix(ctx.firstReply), { exact: false })).toBeVisible({
      timeout: 30_000,
    });
    const composer = screen.getByRole('textbox', '消息');
    await expect(composer).toBeDisabled();
    await expect(composer).toHaveAttribute('placeholder', '频道只读');
    await expect(screen.getByText('你在该频道是只读成员，不能发送消息。')).toBeVisible();
    await expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
    await expect(screen.getByLabel('选择要绑定的智能体')).toHaveCount(0);

    const denied = await nodeApi(ctx.viewer, 'POST', `/api/channels/${ctx.channelId}/messages`, {
      body: '观察者尝试发言',
    });
    expect(denied.status).toBe(403);
    const deniedBind = await nodeApi(ctx.viewer, 'POST', `/api/channels/${ctx.channelId}/agents`, {
      agentId: ctx.agents[0].id,
    });
    expect(deniedBind.status).toBe(403);
    // 观察者本来也没有这两个智能体的使用授权，绑定下拉不会出现；记录 UI 状态供报告核对。
    const manageControls = await screen.getByLabel('选择要绑定的智能体').count();
    console.log(
      `  只读断言通过；API 发言 ${denied.status}；API 绑定智能体 ${deniedBind.status}；可见绑定控件 ${manageControls}`,
    );
  });

  test('6. 未读与已读：运营发言后产品经理看到未读，进入频道后清零', { timeout: 300_000 }, async ({
    app,
    screen,
    browser,
  }) => {
    const ctx = await ensureState();
    const started = Date.now();
    const message = `周报已整理，请产品经理审阅 ${ctx.suffix}`;
    const posted = await nodeApi<{ id: string }>(
      ctx.ops,
      'POST',
      `/api/channels/${ctx.channelId}/messages`,
      { body: message },
    );
    assert(posted.status === 201, `运营发消息返回 201（实际 ${posted.status}）`);

    await browserAs(app, browser, ctx.pm);
    await app.open('/channels');
    const row = screen.getByRole('link', { name: new RegExp(escapeRegExp(ctx.channelName)) });
    await expect(row).toBeVisible();
    await expect(row.getByLabel(/条未读/)).toBeVisible({ timeout: 30_000 });
    const unreadText = await row.getByLabel(/条未读/).getAttribute('aria-label');
    console.log(`  产品经理列表未读标记：${unreadText}`);

    await row.tap();
    await expect(screen.getByText(message)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () => {
          const list = await apiJson<Array<{ id: string; unreadCount: number }>>(
            browser,
            'GET',
            '/api/channels',
          );
          return list.json?.find((item) => item.id === ctx.channelId)?.unreadCount ?? -1;
        },
        { timeout: 60_000 },
      )
      .toBe(0);
    console.log(`  未读清零；耗时：${Date.now() - started}ms`);
  });

  test('7. 刷新恢复：运行中刷新后历史与运行状态都能恢复', { timeout: 600_000 }, async ({
    app,
    screen,
    browser,
  }) => {
    const ctx = await ensureState();
    const started = Date.now();
    const ask =
      '请用不少于 400 字说明接下来的增长实验计划，给出优先级、负责人和衡量指标，分点展开。';

    await browserAs(app, browser, ctx.ops);
    await app.open(`/channels/${ctx.channelId}`);
    await sendMention(screen, ctx.agents[0].name, ask);
    const stop = screen.getByRole('button', { name: '停止' }).first();
    await expect(stop).toBeVisible({ timeout: 120_000 });
    const wasRunning = (await screen.getByText('运行中').count()) > 0;
    await browser.reload();

    await expect(screen.getByText(`@${ctx.agents[0].name} ${ask}`)).toBeVisible({
      timeout: 30_000,
    });
    const afterReloadRunning = (await screen.getByText('运行中').count()) > 0;
    await expect(screen.getByText('空闲').first()).toBeVisible({ timeout: 300_000 });

    const trigger = await messageByBody(ctx.channelId, `@${ctx.agents[0].name} ${ask}`);
    assert(trigger !== undefined, '刷新前请求已落库');
    const run = await waitRunSettled(trigger.id);
    expect(run.status).toBe('succeeded');
    ctx.reloadRunId = run.id;
    const messages = await agentMessagesForRun(ctx.channelId, run.id);
    expect(messages.length).toBe(1);
    const reply = messages[0];
    assert(reply !== undefined, '刷新后回复已落库');
    expect(reply.body.trim().length).toBeGreaterThan(50);
    await expect(screen.getByText(replyPrefix(reply.body), { exact: false })).toBeVisible({
      timeout: 60_000,
    });
    console.log(
      `  刷新前运行中=${wasRunning}，刷新后仍运行中=${afterReloadRunning}；运行 ${run.id} ${run.status}；回复 ${reply.body.length} 字；耗时：${Date.now() - started}ms`,
    );
  });

  test.afterAll(async () => {
    if (state !== undefined) {
      const runs = await query<{ id: string; status: string; agent_id: string }>(
        'select id, status, agent_id from agent_runs where channel_id = $1 order by created_at asc',
        [state.channelId],
      );
      const counts = await query<{ kind: string; count: string }>(
        'select kind, count(*)::text as count from channel_messages where channel_id = $1 group by kind order by kind',
        [state.channelId],
      );
      console.log(
        `\n[产物汇总] channel=${state.channelId} name=${state.channelName}\n  messages=${JSON.stringify(
          Object.fromEntries(counts.map((row) => [row.kind, row.count])),
        )}\n  runs=${JSON.stringify(runs)}`,
      );
    }
    await dbPromise?.pool.end();
  });
});
