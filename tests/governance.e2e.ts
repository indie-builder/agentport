import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import { requireExecutionStack } from './support/execution-stack.js';

await requireExecutionStack();

const ADMIN = {
  username: process.env.E2E_ADMIN_USER ?? 'admin',
  password: process.env.E2E_ADMIN_PASSWORD ?? '',
};

interface Account {
  businessId: string;
  username: string;
  password: string;
  name: string;
}

interface ApiResult<T> {
  status: number;
  json: T | null;
  text: string;
}

interface PermissionGrant {
  permissionId: string;
  scope: string;
}

interface Role {
  id: string;
  name: string;
  systemKey: string | null;
  grants: PermissionGrant[];
}

interface RoleMatrix {
  revision: number;
  roles: Role[];
}

interface AlertSettings {
  runFailures: { enabled: boolean; threshold: number; windowMinutes: number };
  queueFailed: { enabled: boolean; threshold: number };
  queueWaiting: { enabled: boolean; threshold: number };
  updatedAt: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`${message}`);
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
}

async function api<T>(
  browser: Browser,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const response = await browserFetch(browser, method, path, body);
  let json: T | null = null;
  try {
    json = response.text === '' ? null : (JSON.parse(response.text) as T);
  } catch {
    json = null;
  }
  return { status: response.status, json, text: response.text };
}

function ensure<T>(result: ApiResult<T>, expected: number | number[], label: string): T {
  const accepted = Array.isArray(expected) ? expected : [expected];
  if (!accepted.includes(result.status)) {
    throw new Error(
      `${label}失败：期望 HTTP ${accepted.join(' 或 ')}，实际 ${result.status}，响应 ${result.text}`,
    );
  }
  return result.json as T;
}

async function login(
  browser: Browser,
  account: { username: string; password: string },
  label: string,
): Promise<void> {
  ensure(
    await api(browser, 'POST', '/api/auth/login', {
      username: account.username,
      password: account.password,
    }),
    200,
    `登录 ${label}`,
  );
}

function adminLogin(browser: Browser): Promise<void> {
  return login(browser, ADMIN, '管理员');
}

async function createAccount(browser: Browser, tag: string, roleIds: string[]): Promise<Account> {
  const token = uniqueSuffix();
  const account: Account = {
    businessId: `e2e-gov-${tag}-${token}`,
    username: `e2e_gov_${tag}_${token}`,
    password: `E2e-gov-${token}-pass`,
    name: `E2E 治理 ${tag} ${token}`,
  };
  ensure(
    await api(browser, 'POST', '/api/accounts', {
      businessId: account.businessId,
      username: account.username,
      name: account.name,
      password: account.password,
      roleIds,
    }),
    201,
    `创建账户 ${tag}（${account.businessId}）`,
  );
  return account;
}

async function bestEffort(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.log(`[治理 E2E 清理跳过] ${label}：${String(error)}`);
  }
}

test('governance 对象授权、预算拦截与离职交接', {
  session: 'admin',
  timeout: 300_000,
}, async ({ app, browser }) => {
  await app.open('/');
  const suffix = uniqueSuffix();
  const accounts: Account[] = [];
  const budgetIds: string[] = [];
  let skillId: string | undefined;
  let departmentId: string | undefined;
  let customRoleName: string | undefined;

  try {
    const matrix = ensure<RoleMatrix>(await api(browser, 'GET', '/api/roles'), 200, '读取角色矩阵');
    const userRole = matrix.roles.find((role) => role.systemKey === 'user');
    assert(userRole !== undefined, `角色矩阵缺少系统「用户」角色：${JSON.stringify(matrix.roles)}`);
    customRoleName = `E2E 治理协作者 ${suffix}`;
    const customGrants: PermissionGrant[] = [
      ...userRole.grants,
      { permissionId: 'skills.read', scope: 'own_data' },
      { permissionId: 'skills.read', scope: 'authorized_resources' },
      { permissionId: 'skills.create', scope: 'own_data' },
      { permissionId: 'skills.update', scope: 'own_data' },
      { permissionId: 'skills.delete', scope: 'own_data' },
      { permissionId: 'knowledge.read', scope: 'own_data' },
      { permissionId: 'knowledge.create', scope: 'own_data' },
      { permissionId: 'knowledge.update', scope: 'own_data' },
      { permissionId: 'knowledge.delete', scope: 'own_data' },
      { permissionId: 'knowledge.content.manage', scope: 'own_data' },
      { permissionId: 'data_domains.read', scope: 'own_data' },
    ];
    const replaced = ensure<RoleMatrix>(
      await api(browser, 'PUT', '/api/roles', {
        expectedRevision: matrix.revision,
        roles: [
          ...matrix.roles.map((role) => ({
            id: role.id,
            name: role.name,
            grants: role.grants,
          })),
          { name: customRoleName, grants: customGrants },
        ],
      }),
      200,
      '创建自定义角色',
    );
    const customRole = replaced.roles.find((role) => role.name === customRoleName);
    assert(
      customRole !== undefined,
      `自定义角色未出现在角色矩阵：${JSON.stringify(replaced.roles.map((role) => role.name))}`,
    );

    const alice = await createAccount(browser, 'alice', [customRole.id]);
    const bob = await createAccount(browser, 'bob', [customRole.id]);
    const charlie = await createAccount(browser, 'charlie', [userRole.id]);
    accounts.push(alice, bob, charlie);

    await login(browser, alice, 'alice');
    const skill = ensure<{ id: string }>(
      await api(browser, 'POST', '/api/skills', {
        slug: `e2e-gov-${suffix}`,
        name: `E2E 治理技能 ${suffix}`,
        description: '治理 E2E 技能',
        body: '# 治理 E2E',
      }),
      201,
      'alice 创建技能',
    );
    skillId = skill.id;
    const aliceList = ensure<Array<{ id: string }>>(
      await api(browser, 'GET', '/api/skills'),
      200,
      'alice 读取技能列表',
    );
    assert(
      aliceList.some((row) => row.id === skill.id),
      `alice 的技能列表应包含 ${skill.id}，实际 ${JSON.stringify(aliceList.map((row) => row.id))}`,
    );

    await login(browser, bob, 'bob');
    const bobList = ensure<Array<{ id: string }>>(
      await api(browser, 'GET', '/api/skills'),
      200,
      'bob 读取技能列表',
    );
    assert(
      !bobList.some((row) => row.id === skill.id),
      `bob 不应看到 alice 的技能 ${skill.id}，实际 ${JSON.stringify(bobList.map((row) => row.id))}`,
    );
    ensure(
      await api(browser, 'GET', `/api/skills/${skill.id}`),
      404,
      'bob 直接读取 alice 的技能应返回 404',
    );

    await login(browser, charlie, 'charlie');
    ensure(
      await api(browser, 'GET', '/api/skills'),
      403,
      'charlie 无 skills.read 权限叶读取技能列表应返回 403',
    );

    await adminLogin(browser);
    ensure(
      await api(browser, 'PUT', '/api/governance/resource-grants', {
        resourceKind: 'skill',
        resourceId: skill.id,
        businessId: bob.businessId,
        canUse: true,
        canManage: false,
      }),
      200,
      '管理员授予 bob 技能使用权限',
    );
    await login(browser, bob, 'bob');
    ensure(await api(browser, 'GET', `/api/skills/${skill.id}`), 200, 'bob 获得资源授权后读取技能');
    await adminLogin(browser);
    ensure(
      await api(
        browser,
        'DELETE',
        `/api/governance/resource-grants?resourceKind=skill&resourceId=${encodeURIComponent(skill.id)}&businessId=${encodeURIComponent(bob.businessId)}`,
      ),
      204,
      '管理员撤销 bob 的技能授权',
    );
    await login(browser, bob, 'bob');
    ensure(
      await api(browser, 'GET', `/api/skills/${skill.id}`),
      404,
      '撤销授权后 bob 读取技能应返回 404',
    );

    await adminLogin(browser);
    const aliceBudget = ensure<{ id: string }>(
      await api(browser, 'PUT', '/api/governance/budgets', {
        scopeKind: 'user',
        scopeId: alice.businessId,
        metric: 'cost_usd_month',
        limitValue: 0,
        alertRatio: 0.8,
        enabled: true,
      }),
      200,
      '设置 alice 用户预算',
    );
    budgetIds.push(aliceBudget.id);
    await login(browser, alice, 'alice');
    const aliceDenied = ensure<{ code?: string } | null>(
      await api(browser, 'POST', '/api/chat', { message: '治理 E2E 用户预算拦截' }),
      409,
      'alice 预算超限发起对话应返回 409',
    );
    assert(
      aliceDenied?.code === 'BUDGET_EXCEEDED',
      `alice 预算拦截错误码应为 BUDGET_EXCEEDED，实际 ${JSON.stringify(aliceDenied)}`,
    );

    await adminLogin(browser);
    const department = ensure<{ id: string }>(
      await api(browser, 'POST', '/api/governance/departments', {
        name: `E2E 治理部门 ${suffix}`,
      }),
      201,
      '创建部门',
    );
    departmentId = department.id;
    ensure(
      await api(browser, 'PUT', `/api/governance/departments/${department.id}/members`, {
        members: [{ businessId: bob.businessId, isManager: false }],
      }),
      200,
      '把 bob 加入部门',
    );
    const departmentBudget = ensure<{ id: string }>(
      await api(browser, 'PUT', '/api/governance/budgets', {
        scopeKind: 'department',
        scopeId: department.id,
        metric: 'cost_usd_month',
        limitValue: 0,
        alertRatio: 0.8,
        enabled: true,
      }),
      200,
      '设置部门预算',
    );
    budgetIds.push(departmentBudget.id);
    await login(browser, bob, 'bob');
    const bobDenied = ensure<{ code?: string } | null>(
      await api(browser, 'POST', '/api/chat', { message: '治理 E2E 部门预算拦截' }),
      409,
      'bob 部门预算超限发起对话应返回 409',
    );
    assert(
      bobDenied?.code === 'BUDGET_EXCEEDED',
      `bob 部门预算拦截错误码应为 BUDGET_EXCEEDED，实际 ${JSON.stringify(bobDenied)}`,
    );

    await adminLogin(browser);
    ensure(
      await api(browser, 'DELETE', `/api/governance/budgets/${aliceBudget.id}`),
      204,
      '清除 alice 预算',
    );
    ensure(
      await api(browser, 'DELETE', `/api/governance/budgets/${departmentBudget.id}`),
      204,
      '清除部门预算',
    );
    budgetIds.length = 0;

    const checklist = ensure<{
      counts: { skills: number };
      items: { skills: Array<{ id: string }> };
    }>(
      await api(browser, 'GET', `/api/governance/handover/${alice.businessId}`),
      200,
      '读取 alice 交接清单',
    );
    assert(
      checklist.counts.skills >= 1,
      `alice 交接清单 skills 计数应 >= 1，实际 ${checklist.counts.skills}`,
    );
    assert(
      checklist.items.skills.some((item) => item.id === skill.id),
      `alice 交接清单应包含技能 ${skill.id}，实际 ${JSON.stringify(checklist.items.skills)}`,
    );
    const forward = ensure<{ total: number }>(
      await api(browser, 'POST', `/api/governance/handover/${alice.businessId}/transfer`, {
        toBusinessId: bob.businessId,
      }),
      200,
      '把 alice 名下资源转交 bob',
    );
    assert(forward.total >= 1, `正向转交总数应 >= 1，实际 ${forward.total}`);
    await login(browser, bob, 'bob');
    ensure(await api(browser, 'GET', `/api/skills/${skill.id}`), 200, '转交后 bob 读取技能');
    await login(browser, alice, 'alice');
    ensure(
      await api(browser, 'GET', `/api/skills/${skill.id}`),
      404,
      '转交后 alice 读取技能应返回 404',
    );
    await adminLogin(browser);
    const backward = ensure<{ total: number }>(
      await api(browser, 'POST', `/api/governance/handover/${bob.businessId}/transfer`, {
        toBusinessId: alice.businessId,
      }),
      200,
      '把 bob 名下资源转回 alice',
    );
    assert(backward.total >= 1, `反向转交总数应 >= 1，实际 ${backward.total}`);
    await login(browser, alice, 'alice');
    ensure(
      await api(browser, 'GET', `/api/skills/${skill.id}`),
      200,
      '反向转交后 alice 恢复读取技能',
    );
  } finally {
    await bestEffort('管理员重新登录', () => adminLogin(browser));
    for (const budgetId of budgetIds) {
      await bestEffort(`删除预算 ${budgetId}`, async () =>
        ensure(
          await api(browser, 'DELETE', `/api/governance/budgets/${budgetId}`),
          204,
          '删除预算',
        ),
      );
    }
    if (departmentId !== undefined) {
      await bestEffort(`删除部门 ${departmentId}`, async () =>
        ensure(
          await api(browser, 'DELETE', `/api/governance/departments/${departmentId}`),
          204,
          '删除部门',
        ),
      );
    }
    if (skillId !== undefined) {
      await bestEffort(`删除技能 ${skillId}`, async () =>
        ensure(await api(browser, 'DELETE', `/api/skills/${skillId}`), 204, '删除技能'),
      );
    }
    for (const account of accounts) {
      await bestEffort(`删除账户 ${account.businessId}`, async () =>
        ensure(
          await api(browser, 'DELETE', `/api/accounts/${account.businessId}`),
          200,
          '删除账户',
        ),
      );
    }
    if (customRoleName !== undefined) {
      await bestEffort('移除自定义角色', async () => {
        const current = ensure<RoleMatrix>(
          await api(browser, 'GET', '/api/roles'),
          200,
          '读取角色矩阵',
        );
        const target = current.roles.find((role) => role.name === customRoleName);
        if (target === undefined) return;
        ensure(
          await api(browser, 'PUT', '/api/roles', {
            expectedRevision: current.revision,
            roles: current.roles
              .filter((role) => role.id !== target.id)
              .map((role) => ({ id: role.id, name: role.name, grants: role.grants })),
          }),
          200,
          '移除自定义角色',
        );
      });
    }
  }
});

test('governance 告警回读、成本汇总与页面冒烟', {
  session: 'admin',
  timeout: 180_000,
}, async ({ app, screen, browser }) => {
  await app.open('/');
  await adminLogin(browser);
  const before = ensure<AlertSettings>(
    await api(browser, 'GET', '/api/governance/alerts'),
    200,
    '读取告警设置',
  );
  const nextThreshold = before.runFailures.threshold === 1 ? 2 : 1;
  const changed = ensure<AlertSettings>(
    await api(browser, 'PUT', '/api/governance/alerts', {
      ...before,
      runFailures: { ...before.runFailures, threshold: nextThreshold },
    }),
    200,
    '修改告警阈值',
  );
  assert(
    changed.runFailures.threshold === nextThreshold,
    `PUT 告警阈值应立即生效：期望 ${nextThreshold}，实际 ${changed.runFailures.threshold}`,
  );
  const reread = ensure<AlertSettings>(
    await api(browser, 'GET', '/api/governance/alerts'),
    200,
    '回读告警设置',
  );
  assert(
    reread.runFailures.threshold === nextThreshold,
    `GET 回读告警阈值应为 ${nextThreshold}，实际 ${reread.runFailures.threshold}`,
  );
  ensure(
    await api(browser, 'PUT', '/api/governance/alerts', {
      ...reread,
      runFailures: { ...reread.runFailures, threshold: before.runFailures.threshold },
    }),
    200,
    '恢复告警阈值',
  );
  const restored = ensure<AlertSettings>(
    await api(browser, 'GET', '/api/governance/alerts'),
    200,
    '确认告警阈值已恢复',
  );
  assert(
    restored.runFailures.threshold === before.runFailures.threshold,
    `告警阈值应恢复为 ${before.runFailures.threshold}，实际 ${restored.runFailures.threshold}`,
  );

  for (const groupBy of ['user', 'department', 'model'] as const) {
    const summary = ensure<{ groupBy: string; groups: unknown[] }>(
      await api(browser, 'GET', `/api/governance/cost-summary?days=7&groupBy=${groupBy}`),
      200,
      `读取成本汇总（${groupBy}）`,
    );
    assert(
      Array.isArray(summary.groups),
      `成本汇总（${groupBy}）groups 应为数组，实际 ${JSON.stringify(summary)}`,
    );
    assert(
      summary.groupBy === groupBy,
      `成本汇总 groupBy 应为 ${groupBy}，实际 ${summary.groupBy}`,
    );
  }

  await app.open('/governance');
  await expect(screen.getByRole('heading', { level: 1 })).toHaveCount(1, { timeout: 60_000 });
  await expect(screen.getByRole('heading', { name: '治理', level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  const sections = [
    ['成本', () => screen.getByRole('button', { name: '按人', exact: true })],
    ['预算', () => screen.getByRole('button', { name: '新建预算', exact: true })],
    ['部门', () => screen.getByRole('button', { name: '新建部门', exact: true })],
    ['资源授权', () => screen.getByRole('button', { name: '添加授权', exact: true })],
    ['交接', () => screen.getByText('选择离职账户', { exact: true })],
    ['告警', () => screen.getByRole('button', { name: '保存设置', exact: true })],
  ] as const;
  for (const [tab, locator] of sections) {
    await screen.getByRole('tab', { name: tab, exact: true }).tap();
    await expect(locator()).toBeVisible({
      timeout: 30_000,
    });
  }
  const overflow = (await browser.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )) as number;
  assert(overflow <= 1, `/governance 在 1440px 出现 ${overflow}px 横向溢出`);
});
