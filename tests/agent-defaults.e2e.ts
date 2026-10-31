import { randomUUID } from 'node:crypto';
import { type Browser, test } from '@e2e-dev/web';
import { expect, type Screen } from 'e2e';
import { createDb, newId } from '../packages/db/dist/index.js';

/**
 * 专家推理默认值的真实浏览器验收：真实页面、真实 API、数据库直写 fixture。
 * DATABASE_URL 必须显式给出，且与页面背后的 API 指向同一个库。
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (!DATABASE_URL) throw new Error('DATABASE_URL is required for agent defaults fixtures');

let dbPromise: ReturnType<typeof createDb> | undefined;
function db() {
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
  description: string;
}

const created: Fixture[] = [];

test.afterEach(async () => {
  const { pool } = await db();
  const ids = created.map((fixture) => fixture.id);
  if (ids.length > 0) {
    await pool.query('delete from audit_log where target = any($1::text[])', [ids]);
    await pool.query('delete from agents where id = any($1::text[])', [ids]);
  }
  created.length = 0;
});

interface SeedOptions {
  name?: string;
  role?: string;
  description?: string;
  createdAt?: Date;
  enabled?: boolean;
}

async function seed(effort: string | null, options: SeedOptions = {}): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = {
    id: newId('agent'),
    slug: `e2e-defaults-${suffix}`,
    name: options.name ?? `E2E 默认值 ${suffix}`,
    description: options.description ?? '',
  };
  const { pool } = await db();
  // RBAC NOT NULL：夹具归属首次初始化的 bootstrap 管理员业务身份。
  await pool.query(
    `insert into agents (id, slug, name, role, description, enabled, model, effort, created_by, owner_business_id, created_at)
     values ($1, $2, $3, $4, $5, $6, 'test-model', $7, 'bootstrap-admin', 'bootstrap-admin', $8)`,
    [
      fixture.id,
      fixture.slug,
      fixture.name,
      options.role ?? '通用助手',
      fixture.description,
      options.enabled ?? true,
      effort,
      options.createdAt ?? new Date(),
    ],
  );
  created.push(fixture);
  return fixture;
}

async function stored(id: string) {
  const { pool } = await db();
  const { rows } = await pool.query<{ effort: string | null }>(
    'select effort from agents where id = $1',
    [id],
  );
  return rows[0];
}

async function freshAgent(browser: Browser, id: string) {
  return browser.evaluate(async (agentId: string) => {
    const res = await fetch(`/api/agents/${agentId}`);
    if (!res.ok) throw new Error(`GET /api/agents/${agentId} ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    return {
      name: String(body.name),
      hasEffort: 'effort' in body,
    };
  }, id);
}

async function openEditor(
  app: { open(path: string): Promise<void> },
  screen: Screen,
  fixture: Fixture,
  name = fixture.name,
): Promise<void> {
  await app.open(`/agents?q=${encodeURIComponent(fixture.slug)}`);
  await screen.getByRole('link', name).tap();
}

async function chooseEffort(screen: Screen, label: string): Promise<void> {
  await screen.getByRole('button', '行为', { exact: false }).tap();
  await screen.getByRole('combobox', '推理强度').tap();
  await screen.getByRole('option', label, { exact: true }).tap();
}

const agentResponse = (browser: Browser, id: string) =>
  browser.waitForResponse(new RegExp(`/api/agents/${id}$`));

test('setting and clearing effort on the page survives save and reload', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  const fixture = await seed(null);
  await openEditor(app, screen, fixture);

  // 默认夹具：effort 未配置，固定思考预算控件已移除。
  await screen.getByRole('button', '行为', { exact: false }).tap();
  await expect(screen.getByRole('combobox', '推理强度')).toHaveText('默认');
  await screen.getByRole('button', '运行限制', { exact: false }).tap();
  expect(await browser.locator('#agent-thinking').count()).toBe(0);

  await chooseEffort(screen, 'high');
  const configured = agentResponse(browser, fixture.id);
  await screen.getByRole('button', '保存更改').tap();
  const configuredResponse = await configured;
  expect(configuredResponse.status).toBe(200);
  expect(await configuredResponse.json<Record<string, unknown>>()).toMatchObject({
    effort: 'high',
  });
  expect(await stored(fixture.id)).toEqual({ effort: 'high' });

  // 回到默认：选择「默认」，保存必须显式发 null。
  await chooseEffort(screen, '默认');
  const cleared = agentResponse(browser, fixture.id);
  await screen.getByRole('button', '保存更改').tap();
  const clearedResponse = await cleared;
  expect(clearedResponse.status).toBe(200);
  expect(await clearedResponse.json<Record<string, unknown>>()).not.toHaveProperty('effort');
  expect(await stored(fixture.id)).toEqual({ effort: null });

  // 不相关字段的全量保存不能把清空后的值带回来。
  const renamed = `E2E 默认值改名 ${randomUUID().slice(0, 8)}`;
  await screen.getByRole('button', '身份', { exact: false }).tap();
  await browser.locator('#agent-name').fill(renamed);
  const saved = agentResponse(browser, fixture.id);
  await screen.getByRole('button', '保存更改').tap();
  const renamedResponse = await saved;
  expect(renamedResponse.status).toBe(200);
  const renamedBody = await renamedResponse.json<Record<string, unknown>>();
  expect(renamedBody).toMatchObject({ name: renamed });
  expect(renamedBody).not.toHaveProperty('effort');
  expect(await stored(fixture.id)).toEqual({ effort: null });
  expect(await freshAgent(browser, fixture.id)).toEqual({
    name: renamed,
    hasEffort: false,
  });

  await browser.reload();
  await openEditor(app, screen, fixture, renamed);
  await screen.getByRole('button', '行为', { exact: false }).tap();
  await expect(screen.getByRole('combobox', '推理强度')).toHaveText('默认');
});

test('PATCH without effort keeps the value, null clears it', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  const fixture = await seed('high');
  await openEditor(app, screen, fixture);
  await screen.getByRole('button', '行为', { exact: false }).tap();
  await expect(screen.getByRole('combobox', '推理强度')).toHaveText('high');

  const patch = (body: { name?: string; effort?: string | null }) =>
    browser.evaluate(
      async (input: { id: string; body: { name?: string; effort?: string | null } }) => {
        const res = await fetch(`/api/agents/${input.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input.body),
        });
        const json =
          res.status === 200
            ? ((await res.json()) as {
                name: string;
                effort?: string;
              })
            : null;
        return { status: res.status, body: json };
      },
      { id: fixture.id, body },
    );

  const kept = await patch({ name: 'Renamed' });
  expect(kept.status).toBe(200);
  expect(kept.body).toMatchObject({ name: 'Renamed', effort: 'high' });
  expect(await stored(fixture.id)).toEqual({ effort: 'high' });

  const cleared = await patch({ effort: null });
  expect(cleared.status).toBe(200);
  expect(cleared.body).not.toHaveProperty('effort');
  expect(await stored(fixture.id)).toEqual({ effort: null });
  expect(await freshAgent(browser, fixture.id)).toEqual({
    name: 'Renamed',
    hasEffort: false,
  });
});

test('removed fixed thinking budget is rejected without writing', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  const fixture = await seed('high');
  await openEditor(app, screen, fixture);

  const result = await browser.evaluate(
    async (input: { id: string; slug: string }) => {
      const patchValues = await Promise.all(
        [2048, null].map(
          async (value) =>
            (
              await fetch(`/api/agents/${input.id}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ maxThinkingTokens: value }),
              })
            ).status,
        ),
      );
      const createStatuses = await Promise.all(
        [2048, null].map(
          async (value) =>
            (
              await fetch('/api/agents', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  slug: input.slug,
                  name: 'Legacy thinking',
                  maxThinkingTokens: value,
                }),
              })
            ).status,
        ),
      );
      return { patchValues, createStatuses };
    },
    { id: fixture.id, slug: `e2e-thinking-${randomUUID().slice(0, 8)}` },
  );
  expect(result.patchValues).toEqual([400, 400]);
  expect(result.createStatuses).toEqual([400, 400]);
  expect(await stored(fixture.id)).toEqual({ effort: 'high' });
  const { pool } = await db();
  const rows = await pool.query('select id from agents where name = $1', ['Legacy thinking']);
  expect(rows.rows).toEqual([]);
});

test('expert cards and employee badge', { session: 'admin' }, async ({ app, screen, browser }) => {
  const token = randomUUID().slice(0, 8);
  const full = await seed(null, {
    name: `E2E 员工工牌 ${token} 完整`,
    role: '数据分析师',
    description:
      '负责把采购、售后与合规流程整理成可复用的检查清单，并在每次交付前核对真实证据与风险。',
    createdAt: new Date('2024-03-05T08:30:00.000Z'),
  });
  const empty = await seed(null, {
    name: `E2E 员工工牌 ${token} 空介绍`,
    role: '通用助手',
    description: '',
    createdAt: new Date('2025-01-02T03:04:05.000Z'),
  });
  const disabled = await seed(null, {
    name: `E2E 员工工牌 ${token} 停用`,
    role: '数字分身',
    description: '停用专家仍然可以查看工牌。',
    createdAt: new Date('2025-06-07T09:10:11.000Z'),
    enabled: false,
  });

  // 默认只列已启用；显式 all 才能同时验停用卡的工牌入口。
  await app.open(`/agents?q=${encodeURIComponent(token)}&status=all`);
  await expect(screen.getByRole('button', `查看 ${full.name} 工牌`)).toBeVisible();

  // 用户可见几何：读真实卡面矩形，不用类名推断。
  const measured = await browser.evaluate((fullName: string) => {
    const list = document.querySelector('[aria-label="专家列表"]');
    if (!(list instanceof HTMLElement)) return null;
    const items = [...list.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    const cards = items.map((item) => {
      const surface =
        item.querySelector('[data-slot="card"], .agent-create-fan') ?? item.firstElementChild;
      const rect = (surface instanceof HTMLElement ? surface : item).getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        text: item.textContent?.trim() ?? '',
      };
    });
    const fullItem = items.find((item) => item.textContent?.includes(fullName));
    const twinAvatar = items[1]?.querySelector('img');
    const dataAvatar = fullItem?.querySelector('img');
    return {
      cards,
      twinAvatar: twinAvatar?.getBoundingClientRect().height ?? 0,
      dataAvatar: dataAvatar?.getBoundingClientRect().height ?? 0,
    };
  }, full.name);

  expect(measured).not.toBeNull();
  if (!measured) throw new Error('专家列表未渲染');
  // 两张创建入口卡 + 本次三位员工卡，过滤后恰好 5 张。
  expect(measured.cards).toHaveLength(5);
  for (const card of measured.cards) expect(card.height).toBeCloseTo(208, 0);
  for (const card of measured.cards) expect(card.width).toBeCloseTo(measured.cards[0].width, 0);

  const rows = new Map<number, typeof measured.cards>();
  for (const card of measured.cards) {
    const key = Math.round(card.y);
    rows.set(key, [...(rows.get(key) ?? []), card]);
  }
  expect(rows.size).toBe(2);
  expect([...rows.values()].map((row) => row.length).sort()).toEqual([2, 3]);
  for (const row of rows.values()) {
    row.sort((left, right) => left.x - right.x);
    for (let index = 1; index < row.length; index += 1) {
      expect(row[index].x - (row[index - 1].x + row[index - 1].width)).toBeCloseTo(16, 0);
    }
  }
  expect(measured.dataAvatar).toBeCloseTo(40, 0);
  expect(measured.twinAvatar).toBeCloseTo(80, 0);

  // 完整工牌：只读摘要字段，关闭后焦点回到实际触发器。
  const badge = screen.getByRole('button', `查看 ${full.name} 工牌`);
  await badge.tap();
  const dialog = browser.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();
  await expect(screen.getByRole('heading', `${full.name} 的工牌`)).toBeVisible();
  const detail = (await dialog.textContent()) ?? '';
  expect(detail).toContain('数字员工');
  expect(detail).toContain(full.name);
  expect(detail).toContain('数据分析师');
  expect(detail).toContain(full.description);
  expect(detail).toContain(full.id);
  expect(detail).toContain('上岗时间');
  expect(detail).toContain('2024');
  expect(detail).toMatch(/\d{1,2}:\d{2}/);
  expect(detail).toMatch(/UTC|GMT|时区|[+-]\d{2}:?\d{2}/);
  await dialog.getByRole('button', '关闭').tap();
  await expect(dialog).toBeHidden();
  await expect(badge).toBeFocused();

  // 空介绍显示明确占位，不伪造资料。
  await screen.getByRole('button', `查看 ${empty.name} 工牌`).tap();
  const emptyDialog = browser.locator('[role="dialog"]');
  await expect(emptyDialog).toContainText('未填写介绍');
  await emptyDialog.getByRole('button', '关闭').tap();
  await expect(emptyDialog).toBeHidden();

  // 停用卡没有可执行对话，但已有工牌仍可查看。
  const disabledCard = browser
    .locator('[aria-label="专家列表"] li')
    .filter({ hasText: disabled.name })
    .first();
  await expect(disabledCard.getByRole('button', `与 ${disabled.name} 开始对话`)).toBeDisabled();
  expect(await disabledCard.getByRole('link', `与 ${disabled.name} 开始对话`).count()).toBe(0);
  await screen.getByRole('button', `查看 ${disabled.name} 工牌`).tap();
  const disabledDialog = browser.locator('[role="dialog"]');
  await expect(disabledDialog).toContainText(disabled.description);
  await expect(disabledDialog).toContainText('已停用');
  await disabledDialog.getByRole('button', '关闭').tap();
  await expect(disabledDialog).toBeHidden();
});
