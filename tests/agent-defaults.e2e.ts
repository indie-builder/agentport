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

async function seed(effort: string | null, maxThinkingTokens: number | null): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = {
    id: newId('agent'),
    slug: `e2e-defaults-${suffix}`,
    name: `E2E 默认值 ${suffix}`,
  };
  const { pool } = await db();
  await pool.query(
    `insert into agents (id, slug, name, model, effort, max_thinking_tokens)
     values ($1, $2, $3, 'test-model', $4, $5)`,
    [fixture.id, fixture.slug, fixture.name, effort, maxThinkingTokens],
  );
  created.push(fixture);
  return fixture;
}

async function stored(id: string) {
  const { pool } = await db();
  const { rows } = await pool.query<{ effort: string | null; max_thinking_tokens: number | null }>(
    'select effort, max_thinking_tokens from agents where id = $1',
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
      hasThinking: 'maxThinkingTokens' in body,
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
  await screen.getByRole('button', `配置 ${name}`).tap();
}

async function chooseEffort(screen: Screen, label: string): Promise<void> {
  await screen.getByRole('button', '行为', { exact: false }).tap();
  await screen.getByRole('combobox', '推理强度').tap();
  await screen.getByRole('option', label, { exact: true }).tap();
}

const agentResponse = (browser: Browser, id: string) =>
  browser.waitForResponse(new RegExp(`/api/agents/${id}$`));

test('setting and clearing reasoning on the page survives save and reload', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  const fixture = await seed(null, null);
  await openEditor(app, screen, fixture);

  // 默认夹具：两个字段都显示为未配置。
  await screen.getByRole('button', '行为', { exact: false }).tap();
  await expect(screen.getByRole('combobox', '推理强度')).toHaveText('默认');
  await screen.getByRole('button', '运行限制', { exact: false }).tap();
  await expect(browser.locator('#agent-thinking')).toHaveValue('');

  await chooseEffort(screen, 'high');
  await screen.getByRole('button', '运行限制', { exact: false }).tap();
  await browser.locator('#agent-thinking').fill('2048');
  const configured = agentResponse(browser, fixture.id);
  await screen.getByRole('button', '保存更改').tap();
  const configuredResponse = await configured;
  expect(configuredResponse.status).toBe(200);
  expect(await configuredResponse.json<Record<string, unknown>>()).toMatchObject({
    effort: 'high',
    maxThinkingTokens: 2048,
  });
  expect(await stored(fixture.id)).toEqual({ effort: 'high', max_thinking_tokens: 2048 });

  // 回到默认：选择「默认」并清空输入，保存必须显式发 null。
  await chooseEffort(screen, '默认');
  await screen.getByRole('button', '运行限制', { exact: false }).tap();
  await browser.locator('#agent-thinking').clear();
  const cleared = agentResponse(browser, fixture.id);
  await screen.getByRole('button', '保存更改').tap();
  const clearedResponse = await cleared;
  expect(clearedResponse.status).toBe(200);
  const clearedBody = await clearedResponse.json<Record<string, unknown>>();
  expect(clearedBody).not.toHaveProperty('effort');
  expect(clearedBody).not.toHaveProperty('maxThinkingTokens');
  expect(await stored(fixture.id)).toEqual({ effort: null, max_thinking_tokens: null });

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
  expect(renamedBody).not.toHaveProperty('maxThinkingTokens');
  expect(await stored(fixture.id)).toEqual({ effort: null, max_thinking_tokens: null });
  expect(await freshAgent(browser, fixture.id)).toEqual({
    name: renamed,
    hasEffort: false,
    hasThinking: false,
  });

  await browser.reload();
  await openEditor(app, screen, fixture, renamed);
  await screen.getByRole('button', '行为', { exact: false }).tap();
  await expect(screen.getByRole('combobox', '推理强度')).toHaveText('默认');
  await screen.getByRole('button', '运行限制', { exact: false }).tap();
  await expect(browser.locator('#agent-thinking')).toHaveValue('');
});

test('PATCH without reasoning keeps configured values, null clears them', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  const fixture = await seed('high', 2048);
  await openEditor(app, screen, fixture);
  await screen.getByRole('button', '行为', { exact: false }).tap();
  await expect(screen.getByRole('combobox', '推理强度')).toHaveText('high');
  await screen.getByRole('button', '运行限制', { exact: false }).tap();
  await expect(browser.locator('#agent-thinking')).toHaveValue('2048');

  const patch = (body: {
    name?: string;
    effort?: string | null;
    maxThinkingTokens?: number | null;
  }) =>
    browser.evaluate(
      async (input: {
        id: string;
        body: { name?: string; effort?: string | null; maxThinkingTokens?: number | null };
      }) => {
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
                maxThinkingTokens?: number;
              })
            : null;
        return { status: res.status, body: json };
      },
      { id: fixture.id, body },
    );

  const kept = await patch({ name: 'Renamed' });
  expect(kept.status).toBe(200);
  expect(kept.body).toMatchObject({ name: 'Renamed', effort: 'high', maxThinkingTokens: 2048 });
  expect(await stored(fixture.id)).toEqual({ effort: 'high', max_thinking_tokens: 2048 });

  const cleared = await patch({ effort: null, maxThinkingTokens: null });
  expect(cleared.status).toBe(200);
  expect(cleared.body).not.toHaveProperty('effort');
  expect(cleared.body).not.toHaveProperty('maxThinkingTokens');
  expect(await stored(fixture.id)).toEqual({ effort: null, max_thinking_tokens: null });
  expect(await freshAgent(browser, fixture.id)).toEqual({
    name: 'Renamed',
    hasEffort: false,
    hasThinking: false,
  });
});
