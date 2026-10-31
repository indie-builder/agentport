import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repo } from '@agentport/db';
import type { MemoryReviewTarget } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  PERSONAL_MEMORY_MAX_CHARS,
  personalMemoryDir,
  personalMemoryPath,
} from '../src/features/memory/personal.js';
import { registerPersonalMemoryRoutes } from '../src/features/memory/routes.js';
import {
  ADMIN_BUSINESS_ID,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  testConfig,
} from './helpers.js';

const ready = await infraReady;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 故障注入只影响投影写入；其他 fs 操作继续走真实实现。
const fsFaults = vi.hoisted(() => ({ failRename: false, failWriteFile: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsFaults.failRename) throw new Error('injected rename failure');
      return actual.rename(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (fsFaults.failWriteFile) throw new Error('injected write failure');
      return actual.writeFile(...args);
    },
  };
});

// 三个记忆测试文件并行时共用同一把会话级 advisory 锁：它们都会删写同一行管理员个人偏好。
const MEMORY_TEST_LOCK = 'agentport.memory-tests';

describe.skipIf(!ready)('personal memory', () => {
  let app: FastifyInstance;
  let cookie: string;
  let root: string;
  let releaseLock: (() => Promise<void>) | undefined;

  async function acquireMemoryLock(pool: FastifyInstance['pool']): Promise<() => Promise<void>> {
    const client = await pool.connect();
    // 等锁可能超过连接默认的 statement_timeout。
    await client.query('set statement_timeout = 0');
    await client.query('select pg_advisory_lock(hashtext($1))', [MEMORY_TEST_LOCK]);
    return async () => {
      await client.query('select pg_advisory_unlock(hashtext($1))', [MEMORY_TEST_LOCK]);
      client.release();
    };
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'personal-memory-'));
    app = await buildApp(testConfig({ WORKSPACES_DIR: root }));
    // 路由已由 buildApp 注册；仅在未注册时手动挂载，避免重复声明。
    if (!app.hasRoute({ method: 'GET', url: '/api/me/memory' })) {
      registerPersonalMemoryRoutes(app);
    }
    await app.ready();
    releaseLock = await acquireMemoryLock(app.pool);
    cookie = await loginCookie(app);
  }, 60_000);

  beforeEach(async () => {
    await app.pool.query('delete from memory_changes where business_id = $1', [ADMIN_BUSINESS_ID]);
    await app.pool.query('delete from user_preferences where business_id = $1', [
      ADMIN_BUSINESS_ID,
    ]);
    await rm(personalMemoryDir(root, ADMIN_BUSINESS_ID), { recursive: true, force: true });
  });

  afterAll(async () => {
    try {
      await app.pool.query('delete from memory_changes where business_id = $1', [
        ADMIN_BUSINESS_ID,
      ]);
      await app.pool.query('delete from user_preferences where business_id = $1', [
        ADMIN_BUSINESS_ID,
      ]);
    } finally {
      await releaseLock?.();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  const auth = () => ({ cookie });
  const put = (payload: unknown, headers: Record<string, string> = auth()) =>
    inject(app, { method: 'PUT', url: '/api/me/memory', headers, payload });
  const get = (headers: Record<string, string> = auth()) =>
    inject(app, { method: 'GET', url: '/api/me/memory', headers });

  it('requires auth for every endpoint', async () => {
    expectProblem(await get({}), 'UNAUTHORIZED');
    expectProblem(await put({ content: 'x', expectedRevision: 0 }, {}), 'UNAUTHORIZED');
    expectProblem(
      await inject(app, { method: 'GET', url: '/api/me/memory/download' }),
      'UNAUTHORIZED',
    );
    expectProblem(
      await inject(app, { method: 'GET', url: '/api/me/memory/versions' }),
      'UNAUTHORIZED',
    );
  });

  it('returns an empty memory before the first save', async () => {
    const response = await get();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ content: '', revision: 0, updatedAt: null });
  });

  it('saves, projects CLAUDE.md with private permissions, and records one change', async () => {
    const content = '# 个人偏好\n\n回答先给结论。\n';
    const response = await put({ content, expectedRevision: 0 });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      content: string;
      revision: number;
      updatedAt: string;
      changeId: string;
    }>();
    expect(body).toMatchObject({ content, revision: 1 });
    expect(Number.isNaN(Date.parse(body.updatedAt))).toBe(false);
    expect(body.changeId).toMatch(/^mch_/);

    expect(await get()).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ content, revision: 1, updatedAt: body.updatedAt }),
    });

    const file = personalMemoryPath(root, ADMIN_BUSINESS_ID);
    expect(await readFile(file, 'utf8')).toBe(content);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const dir = await stat(personalMemoryDir(root, ADMIN_BUSINESS_ID));
    expect(dir.isDirectory()).toBe(true);
    expect(dir.mode & 0o777).toBe(0o700);

    const [row] = (
      await app.pool.query<{
        target: unknown;
        before: unknown;
        after: unknown;
        source_review_run_id: string | null;
        state: string;
        business_id: string;
      }>(
        'select target, before, after, source_review_run_id, state, business_id from memory_changes where id = $1',
        [body.changeId],
      )
    ).rows;
    expect(row).toMatchObject({
      target: { kind: 'personal' },
      before: { content: '', globs: null, index: null },
      after: { content, globs: null, index: null },
      source_review_run_id: null,
      state: 'applied',
      business_id: ADMIN_BUSINESS_ID,
    });
  });

  it('rejects a stale revision without touching the database or file', async () => {
    expect((await put({ content: 'first', expectedRevision: 0 })).statusCode).toBe(200);
    const file = personalMemoryPath(root, ADMIN_BUSINESS_ID);
    const response = await put({ content: 'stale', expectedRevision: 0 });
    expectProblem(response, 'CONFLICT');
    expect(await readFile(file, 'utf8')).toBe('first');
    const row = await repo.userPreferences.get(app.db, ADMIN_BUSINESS_ID);
    expect(row).toMatchObject({ content: 'first', revision: 1 });
    expect(
      await app.pool.query(
        'select count(*)::int as count from memory_changes where business_id = $1',
        [ADMIN_BUSINESS_ID],
      ),
    ).toMatchObject({ rows: [{ count: 1 }] });
  });

  it('saves exactly 9000 characters and rejects one more, counting Unicode code points', async () => {
    const atLimit = '界'.repeat(PERSONAL_MEMORY_MAX_CHARS);
    const saved = await put({ content: atLimit, expectedRevision: 0 });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await get()).json()).toMatchObject({ content: atLimit, revision: 1 });

    const over = '界'.repeat(PERSONAL_MEMORY_MAX_CHARS + 1);
    const rejected = await put({ content: over, expectedRevision: 1 });
    expectProblem(rejected, 'PAYLOAD_TOO_LARGE');
    expect(rejected.json<{ message: string }>().message).toBe(
      '个人偏好最多 9000 个字符，请精简后保存',
    );
    expect(await readFile(personalMemoryPath(root, ADMIN_BUSINESS_ID), 'utf8')).toBe(atLimit);

    // 代理对字符按一个码点计，不按 UTF-16 code unit 计。
    const emoji = '😀'.repeat(PERSONAL_MEMORY_MAX_CHARS);
    expect((await put({ content: emoji, expectedRevision: 1 })).statusCode).toBe(200);
  });

  it('downloads the stored content as a CLAUDE.md attachment', async () => {
    const content = '# 偏好\n\n用中文回答。\n';
    await put({ content, expectedRevision: 0 });
    const response = await inject(app, {
      method: 'GET',
      url: '/api/me/memory/download',
      headers: auth(),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="CLAUDE.md"');
    expect(response.body).toBe(content);
  });

  it('lists versions newest first with before and limit', async () => {
    await put({ content: 'one', expectedRevision: 0 });
    await put({ content: 'two', expectedRevision: 1 });

    const all = await inject(app, {
      method: 'GET',
      url: '/api/me/memory/versions',
      headers: auth(),
    });
    expect(all.statusCode, all.body).toBe(200);
    const { items } = all.json<{
      items: Array<{ id: string; target: { kind: string }; after: { content: string } }>;
    }>();
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.after.content)).toEqual(['two', 'one']);
    expect(items[0]?.target).toEqual({ kind: 'personal' });

    const limited = await inject(app, {
      method: 'GET',
      url: '/api/me/memory/versions?limit=1',
      headers: auth(),
    });
    expect(limited.json()).toMatchObject({ items: [{ after: { content: 'two' } }] });

    const future = new Date(Date.now() + 60_000).toISOString();
    const after = await inject(app, {
      method: 'GET',
      url: `/api/me/memory/versions?before=${encodeURIComponent(future)}`,
      headers: auth(),
    });
    expect(after.json()).toMatchObject({
      items: [{ after: { content: 'two' } }, { after: { content: 'one' } }],
    });

    const old = new Date(0).toISOString();
    const none = await inject(app, {
      method: 'GET',
      url: `/api/me/memory/versions?before=${encodeURIComponent(old)}`,
      headers: auth(),
    });
    expect(none.json()).toEqual({ items: [] });
  });

  it('lists only personal versions and never lets agent changes occupy a page', async () => {
    await put({ content: 'one', expectedRevision: 0 });
    // 同一用户采纳专家记忆/规则也写在同一 business_id 下，但不属于个人版本。
    await repo.memoryChanges.insert(app.db, {
      businessId: ADMIN_BUSINESS_ID,
      agentId: null,
      target: { kind: 'agent_memory', agentId: 'agt_expert', name: 'MEMORY.md' },
      before: { content: '', globs: null, index: null },
      after: { content: 'expert memory', globs: null, index: null },
    });
    await repo.memoryChanges.insert(app.db, {
      businessId: ADMIN_BUSINESS_ID,
      agentId: null,
      target: { kind: 'agent_rule', agentId: 'agt_expert', slug: 'style' },
      before: { content: '', globs: null, index: null },
      after: { content: 'expert rule', globs: null, index: null },
    });

    const page = await inject(app, {
      method: 'GET',
      url: '/api/me/memory/versions?limit=1',
      headers: auth(),
    });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json()).toMatchObject({
      items: [{ target: { kind: 'personal' }, after: { content: 'one' } }],
    });

    await put({ content: 'two', expectedRevision: 1 });
    const recent = await inject(app, {
      method: 'GET',
      url: `/api/me/memory/versions?before=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}&limit=1`,
      headers: auth(),
    });
    expect(recent.json()).toMatchObject({
      items: [{ target: { kind: 'personal' }, after: { content: 'two' } }],
    });

    const all = await inject(app, {
      method: 'GET',
      url: '/api/me/memory/versions',
      headers: auth(),
    });
    const { items } = all.json<{ items: Array<{ target: { kind: string } }> }>();
    expect(items.map((item) => item.target.kind)).toEqual(['personal', 'personal']);
  });

  it('pages through every personal version with before and skips agent changes', async () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const at = (seconds: number) => new Date(base + seconds * 1000);
    const insertAt = async (
      content: string,
      createdAt: Date,
      target: MemoryReviewTarget,
    ): Promise<string> => {
      const row = await repo.memoryChanges.insert(app.db, {
        businessId: ADMIN_BUSINESS_ID,
        agentId: null,
        target,
        before: { content: '', globs: null, index: null },
        after: { content, globs: null, index: null },
      });
      // 显式时间戳：分页断言不依赖保存顺序或执行速度。
      await app.pool.query('update memory_changes set created_at = $2 where id = $1', [
        row.id,
        createdAt,
      ]);
      return row.id;
    };

    const one = await insertAt('one', at(1), { kind: 'personal' });
    const two = await insertAt('two', at(2), { kind: 'personal' });
    await insertAt('expert memory', at(3), {
      kind: 'agent_memory',
      agentId: 'agt_expert',
      name: 'MEMORY.md',
    });
    const three = await insertAt('three', at(4), { kind: 'personal' });

    const page = (before?: Date) =>
      inject(app, {
        method: 'GET',
        url: `/api/me/memory/versions?limit=1${
          before === undefined ? '' : `&before=${encodeURIComponent(before.toISOString())}`
        }`,
        headers: auth(),
      });

    const first = await page();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ items: [{ id: three, after: { content: 'three' } }] });

    // 旧实现先取最新一页再内存过滤，第二页会永远为空；专家记忆也不能占用这一页。
    const second = await page(at(4));
    expect(second.json()).toMatchObject({ items: [{ id: two, after: { content: 'two' } }] });

    const third = await page(at(2));
    expect(third.json()).toMatchObject({ items: [{ id: one, after: { content: 'one' } }] });

    const end = await page(at(1));
    expect(end.json()).toEqual({ items: [] });
  });

  it('refuses a symlinked projection without touching the link target and still saves the database', async () => {
    const outside = join(root, 'outside.md');
    await writeFile(outside, 'do not touch');
    await mkdir(personalMemoryDir(root, ADMIN_BUSINESS_ID), { recursive: true });
    await symlink(outside, personalMemoryPath(root, ADMIN_BUSINESS_ID));

    const response = await put({ content: 'new', expectedRevision: 0 });
    expect(response.statusCode, response.body).toBe(200);
    expect(await readFile(outside, 'utf8')).toBe('do not touch');
    expect(await repo.userPreferences.get(app.db, ADMIN_BUSINESS_ID)).toMatchObject({
      content: 'new',
      revision: 1,
    });
  });

  it('commits the database when the projection directory cannot be used', async () => {
    await writeFile(personalMemoryDir(root, ADMIN_BUSINESS_ID), 'not a directory');
    const response = await put({ content: 'new', expectedRevision: 0 });
    expect(response.statusCode, response.body).toBe(200);
    expect(await repo.userPreferences.get(app.db, ADMIN_BUSINESS_ID)).toMatchObject({
      content: 'new',
      revision: 1,
    });
  });

  it('keeps the committed database and change when the projection rename fails', async () => {
    expect((await put({ content: 'one', expectedRevision: 0 })).statusCode).toBe(200);

    fsFaults.failRename = true;
    let saved: Awaited<ReturnType<typeof put>>;
    try {
      saved = await put({ content: 'two', expectedRevision: 1 });
    } finally {
      fsFaults.failRename = false;
    }
    expect(saved.statusCode, saved.body).toBe(200);

    expect(await repo.userPreferences.get(app.db, ADMIN_BUSINESS_ID)).toMatchObject({
      content: 'two',
      revision: 2,
    });
    // 文件仍是旧投影；下一轮运行前 worker 会按数据库重建。
    expect(await readFile(personalMemoryPath(root, ADMIN_BUSINESS_ID), 'utf8')).toBe('one');
    const changes = await app.pool.query<{ after: { content: string } }>(
      'select after from memory_changes where business_id = $1 order by created_at',
      [ADMIN_BUSINESS_ID],
    );
    expect(changes.rows.map((row) => row.after.content)).toEqual(['one', 'two']);
  });

  it('keeps the committed database when the temporary projection cannot be written', async () => {
    fsFaults.failWriteFile = true;
    let saved: Awaited<ReturnType<typeof put>>;
    try {
      saved = await put({ content: 'new', expectedRevision: 0 });
    } finally {
      fsFaults.failWriteFile = false;
    }
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await repo.userPreferences.get(app.db, ADMIN_BUSINESS_ID)).toMatchObject({
      content: 'new',
      revision: 1,
    });
    expect(
      await app.pool.query(
        'select count(*)::int as count from memory_changes where business_id = $1',
        [ADMIN_BUSINESS_ID],
      ),
    ).toMatchObject({ rows: [{ count: 1 }] });
  });

  it('serializes saves on the user advisory lock while reads stay lock-free', async () => {
    const client = await app.pool.connect();
    await client.query('set statement_timeout = 0');
    await client.query('select pg_advisory_lock(hashtext($1))', [`user:${ADMIN_BUSINESS_ID}`]);
    let save: Promise<Awaited<ReturnType<typeof put>>> | undefined;
    try {
      save = put({ content: 'locked', expectedRevision: 0 });
      expect(await Promise.race([save.then(() => 'done'), sleep(150).then(() => 'waiting')])).toBe(
        'waiting',
      );
      expect((await get()).statusCode).toBe(200);
      expect(
        (
          await inject(app, {
            method: 'GET',
            url: '/api/me/memory/versions',
            headers: auth(),
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [`user:${ADMIN_BUSINESS_ID}`]);
      client.release();
    }
    expect((await save)?.statusCode).toBe(200);
    expect(await readFile(personalMemoryPath(root, ADMIN_BUSINESS_ID), 'utf8')).toBe('locked');
  });
});
