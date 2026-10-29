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

async function seed(effort: string | null): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = {
    id: newId('agent'),
    slug: `e2e-defaults-${suffix}`,
    name: `E2E 默认值 ${suffix}`,
  };
  const { pool } = await db();
  await pool.query(
    `insert into agents (id, slug, name, model, effort)
     values ($1, $2, $3, 'test-model', $4)`,
    [fixture.id, fixture.slug, fixture.name, effort],
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
