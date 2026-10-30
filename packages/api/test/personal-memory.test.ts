import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_USER_ID, repo } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  PERSONAL_MEMORY_MAX_CHARS,
  personalMemoryDir,
  personalMemoryPath,
} from '../src/features/memory/personal.js';
import { registerPersonalMemoryRoutes } from '../src/features/memory/routes.js';
import { expectProblem, infraReady, inject, loginCookie, testConfig } from './helpers.js';

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
    await app.pool.query('delete from memory_changes where user_id = $1', [ADMIN_USER_ID]);
    await app.pool.query('delete from user_preferences where user_id = $1', [ADMIN_USER_ID]);
    await rm(personalMemoryDir(root), { recursive: true, force: true });
  });

  afterAll(async () => {
    try {
      await app.pool.query('delete from memory_changes where user_id = $1', [ADMIN_USER_ID]);
      await app.pool.query('delete from user_preferences where user_id = $1', [ADMIN_USER_ID]);
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

    const file = personalMemoryPath(root);
    expect(await readFile(file, 'utf8')).toBe(content);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const dir = await stat(personalMemoryDir(root));
    expect(dir.isDirectory()).toBe(true);
    expect(dir.mode & 0o777).toBe(0o700);

    const [row] = (
      await app.pool.query<{
        target: unknown;
        before: unknown;
        after: unknown;
        source_review_run_id: string | null;
        state: string;
        user_id: string;
      }>(
        'select target, before, after, source_review_run_id, state, user_id from memory_changes where id = $1',
        [body.changeId],
      )
    ).rows;
    expect(row).toMatchObject({
      target: { kind: 'personal' },
      before: { content: '', globs: null },
      after: { content, globs: null },
      source_review_run_id: null,
      state: 'applied',
      user_id: ADMIN_USER_ID,
    });
  });

  it('rejects a stale revision without touching the database or file', async () => {
    expect((await put({ content: 'first', expectedRevision: 0 })).statusCode).toBe(200);
    const file = personalMemoryPath(root);
    const response = await put({ content: 'stale', expectedRevision: 0 });
    expectProblem(response, 'CONFLICT');
    expect(await readFile(file, 'utf8')).toBe('first');
    const row = await repo.userPreferences.get(app.db, ADMIN_USER_ID);
    expect(row).toMatchObject({ content: 'first', revision: 1 });
    expect(
      await app.pool.query('select count(*)::int as count from memory_changes where user_id = $1', [
        ADMIN_USER_ID,
      ]),
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
    expect(await readFile(personalMemoryPath(root), 'utf8')).toBe(atLimit);

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

  it('refuses a symlinked projection without touching the link target and still saves the database', async () => {
    const outside = join(root, 'outside.md');
    await writeFile(outside, 'do not touch');
    await mkdir(personalMemoryDir(root), { recursive: true });
    await symlink(outside, personalMemoryPath(root));

    const response = await put({ content: 'new', expectedRevision: 0 });
    expect(response.statusCode, response.body).toBe(200);
    expect(await readFile(outside, 'utf8')).toBe('do not touch');
    expect(await repo.userPreferences.get(app.db, ADMIN_USER_ID)).toMatchObject({
      content: 'new',
      revision: 1,
    });
  });

  it('commits the database when the projection directory cannot be used', async () => {
    await writeFile(personalMemoryDir(root), 'not a directory');
    const response = await put({ content: 'new', expectedRevision: 0 });
    expect(response.statusCode, response.body).toBe(200);
    expect(await repo.userPreferences.get(app.db, ADMIN_USER_ID)).toMatchObject({
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

    expect(await repo.userPreferences.get(app.db, ADMIN_USER_ID)).toMatchObject({
      content: 'two',
      revision: 2,
    });
    // 文件仍是旧投影；下一轮运行前 worker 会按数据库重建。
    expect(await readFile(personalMemoryPath(root), 'utf8')).toBe('one');
    const changes = await app.pool.query<{ after: { content: string } }>(
      'select after from memory_changes where user_id = $1 order by created_at',
      [ADMIN_USER_ID],
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
    expect(await repo.userPreferences.get(app.db, ADMIN_USER_ID)).toMatchObject({
      content: 'new',
      revision: 1,
    });
    expect(
      await app.pool.query('select count(*)::int as count from memory_changes where user_id = $1', [
        ADMIN_USER_ID,
      ]),
    ).toMatchObject({ rows: [{ count: 1 }] });
  });

  it('serializes saves on the user advisory lock while reads stay lock-free', async () => {
    const client = await app.pool.connect();
    await client.query('set statement_timeout = 0');
    await client.query('select pg_advisory_lock(hashtext($1))', [`user:${ADMIN_USER_ID}`]);
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
      await client.query('select pg_advisory_unlock(hashtext($1))', [`user:${ADMIN_USER_ID}`]);
      client.release();
    }
    expect((await save)?.statusCode).toBe(200);
    expect(await readFile(personalMemoryPath(root), 'utf8')).toBe('locked');
  });
});
