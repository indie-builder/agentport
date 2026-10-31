import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repo } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readMemoryFile, writeMemoryFile } from '../src/features/agents/memory-files.js';
import { registerMemoryChangeRoutes } from '../src/features/memory/changes.js';
import { personalMemoryDir } from '../src/features/memory/personal.js';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  testConfig,
  unique,
  ADMIN_BUSINESS_ID,} from './helpers.js';

const ready = await infraReady;

// 三个记忆测试文件并行时共用同一把会话级 advisory 锁：它们都会删写同一行管理员个人偏好。
const MEMORY_TEST_LOCK = 'agentport.memory-tests';

interface AgentRef {
  id: string;
  slug: string;
}

describe.skipIf(!ready)('memory changes', () => {
  let app: FastifyInstance;
  let cookie: string;
  let root: string;
  let releaseLock: (() => Promise<void>) | undefined;
  const agentSlugs: string[] = [];

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
    root = await mkdtemp(join(await realpath(tmpdir()), 'memory-changes-'));
    app = await buildApp(testConfig({ WORKSPACES_DIR: root }));
    // 路由已由 buildApp 注册；仅在未注册时手动挂载，避免重复声明。
    if (!app.hasRoute({ method: 'GET', url: '/api/agents/:id/memory/:name/versions' })) {
      registerMemoryChangeRoutes(app);
    }
    await app.ready();
    releaseLock = await acquireMemoryLock(app.pool);
    cookie = await loginCookie(app);
  }, 60_000);

  beforeEach(async () => {
    await app.pool.query('delete from memory_changes where business_id = $1', [ADMIN_BUSINESS_ID]);
    await app.pool.query('delete from user_preferences where business_id = $1', [ADMIN_BUSINESS_ID]);
    await rm(personalMemoryDir(root, ADMIN_BUSINESS_ID), { recursive: true, force: true });
  });

  afterAll(async () => {
    try {
      await app.pool.query('delete from memory_changes where business_id = $1', [ADMIN_BUSINESS_ID]);
      await app.pool.query('delete from user_preferences where business_id = $1', [ADMIN_BUSINESS_ID]);
      await cleanup(app, { agentSlugs });
    } finally {
      await releaseLock?.();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  const auth = () => ({ cookie });

  async function newAgent(): Promise<AgentRef> {
    const response = await createAgent(app, cookie, {
      slug: unique('change-agent'),
      track: agentSlugs,
    });
    return response.json<AgentRef>();
  }

  function rollback(changeId: string, headers: Record<string, string> = auth()) {
    return inject(app, {
      method: 'POST',
      url: `/api/memory/changes/${changeId}/rollback`,
      headers,
    });
  }

  async function insertChange(input: {
    agentId?: string;
    target:
      | { kind: 'personal' }
      | { kind: 'agent_memory'; agentId: string }
      | { kind: 'agent_rule'; agentId: string; slug: string };
    before: { content: string | null; globs: string | null };
    after: { content: string | null; globs: string | null };
  }): Promise<string> {
    const row = await repo.memoryChanges.insert(app.db, {
      businessId: ADMIN_BUSINESS_ID,
      agentId: input.agentId ?? null,
      target: input.target,
      before: input.before,
      after: input.after,
    });
    return row.id;
  }

  it('requires auth for versions and rollback', async () => {
    const agentId = unique('agent');
    expectProblem(
      await inject(app, { method: 'GET', url: `/api/agents/${agentId}/memory/MEMORY.md/versions` }),
      'UNAUTHORIZED',
    );
    expectProblem(
      await inject(app, { method: 'GET', url: `/api/agents/${agentId}/rules/style/versions` }),
      'UNAUTHORIZED',
    );
    expectProblem(await rollback(unique('mch'), {}), 'UNAUTHORIZED');
  });

  it('rolls back a personal memory change and keeps the original ledger row', async () => {
    const put = (content: string, expectedRevision: number) =>
      inject(app, {
        method: 'PUT',
        url: '/api/me/memory',
        headers: auth(),
        payload: { content, expectedRevision },
      });

    const first = await put('one', 0);
    expect(first.statusCode, first.body).toBe(200);
    const second = await put('two', 1);
    expect(second.statusCode, second.body).toBe(200);
    const secondChangeId = second.json<{ changeId: string }>().changeId;

    const reversed = await rollback(secondChangeId);
    expect(reversed.statusCode, reversed.body).toBe(200);
    const reverse = reversed.json<{
      id: string;
      target: unknown;
      before: { content: string | null };
      after: { content: string | null };
      reversesChangeId: string | null;
      sourceReviewRunId: string | null;
    }>();
    expect(reverse).toMatchObject({
      target: { kind: 'personal' },
      before: { content: 'two', globs: null },
      after: { content: 'one', globs: null },
      reversesChangeId: secondChangeId,
      sourceReviewRunId: null,
    });
    expect(reverse.id).toMatch(/^mch_/);
    expect(reverse.id).not.toBe(secondChangeId);

    const current = await inject(app, { method: 'GET', url: '/api/me/memory', headers: auth() });
    expect(current.json()).toMatchObject({ content: 'one', revision: 3 });

    const versions = await inject(app, {
      method: 'GET',
      url: '/api/me/memory/versions',
      headers: auth(),
    });
    const items = versions.json<{
      items: Array<{ id: string; reversesChangeId: string | null }>;
    }>().items;
    expect(items[0]).toMatchObject({ id: reverse.id, reversesChangeId: secondChangeId });

    const original = await repo.memoryChanges.find(app.db, secondChangeId);
    expect(original).toMatchObject({ state: 'applied', after: { content: 'two', globs: null } });

    // 回滚后目标已离开该版本，再回滚同一条历史应冲突。
    expectProblem(await rollback(secondChangeId), 'CONFLICT');
  });

  it('lists agent memory versions and rolls back to a missing file and back', async () => {
    const agent = await newAgent();
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', 'v1');
    const changeId = await insertChange({
      agentId: agent.id,
      target: { kind: 'agent_memory', agentId: agent.id },
      before: { content: null, globs: null },
      after: { content: 'v1', globs: null },
    });

    const versions = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/memory/MEMORY.md/versions`,
      headers: auth(),
    });
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json<{ items: Array<{ id: string }> }>().items).toMatchObject([
      { id: changeId },
    ]);

    const otherFile = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/memory/NOTES.md/versions`,
      headers: auth(),
    });
    expect(otherFile.json()).toEqual({ items: [] });

    const reversed = await rollback(changeId);
    expect(reversed.statusCode, reversed.body).toBe(200);
    const reverseId = reversed.json<{ id: string }>().id;
    expect(await readMemoryFile(root, agent.slug, 'MEMORY.md')).toBeNull();
    expect(reversed.json()).toMatchObject({
      before: { content: 'v1' },
      after: { content: null },
      reversesChangeId: changeId,
    });

    // 反向变更的 after 是「文件不存在」；回滚它会重建文件。
    const restored = await rollback(reverseId);
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe('v1');
  });

  it('filters rule versions by slug and restores a deleted rule on rollback', async () => {
    const agent = await newAgent();
    await repo.rules.upsertRule(app.db, agent.id, {
      slug: 'style',
      content: 'v1',
      globs: 'src/**',
    });
    const changeId = await insertChange({
      agentId: agent.id,
      target: { kind: 'agent_rule', agentId: agent.id, slug: 'style' },
      before: { content: null, globs: '' },
      after: { content: 'v1', globs: 'src/**' },
    });
    await insertChange({
      agentId: agent.id,
      target: { kind: 'agent_rule', agentId: agent.id, slug: 'other' },
      before: { content: null, globs: '' },
      after: { content: 'other rule', globs: '' },
    });

    const versions = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/rules/style/versions`,
      headers: auth(),
    });
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json<{ items: Array<{ id: string }> }>().items).toHaveLength(1);
    expect(versions.json<{ items: Array<{ id: string }> }>().items[0]).toMatchObject({
      id: changeId,
    });

    const reversed = await rollback(changeId);
    expect(reversed.statusCode, reversed.body).toBe(200);
    const reverseId = reversed.json<{ id: string }>().id;
    const deleted = await app.pool.query<{ count: number }>(
      'select count(*)::int as count from agent_rules where agent_id = $1 and slug = $2',
      [agent.id, 'style'],
    );
    expect(deleted.rows[0]?.count).toBe(0);

    const restored = await rollback(reverseId);
    expect(restored.statusCode, restored.body).toBe(200);
    const rule = await app.pool.query<{ content: string; globs: string }>(
      'select content, globs from agent_rules where agent_id = $1 and slug = $2',
      [agent.id, 'style'],
    );
    expect(rule.rows[0]).toEqual({ content: 'v1', globs: 'src/**' });

    // 手工删除规则后，历史 after 已不存在，不能再回滚。
    await repo.rules.deleteRule(app.db, agent.id, 'style');
    expectProblem(await rollback(changeId), 'CONFLICT');
  });

  it('refuses rollback while the target agent has an active run', async () => {
    const agent = await newAgent();
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', 'current');
    const changeId = await insertChange({
      agentId: agent.id,
      target: { kind: 'agent_memory', agentId: agent.id },
      before: { content: 'old', globs: null },
      after: { content: 'current', globs: null },
    });
    const conversation = await repo.chat.createConversation(app.db, {
      id: unique('change-conv'),
      agentId: agent.id,
      title: 'active',
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
});
    const runId = unique('change-run');
    await app.pool.query(
      "insert into agent_runs (id, conversation_id, agent_id, status, subject_kind, initiated_by) values ($1, $2, $3, 'queued', 'user', 'bootstrap-admin')",
      [runId, conversation.id, agent.id],
    );

    expectProblem(await rollback(changeId), 'CONFLICT');
    await app.pool.query("update agent_runs set status = 'succeeded' where id = $1", [runId]);
    const ok = await rollback(changeId);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('returns 404 for a missing change or agent', async () => {
    expectProblem(await rollback(unique('mch')), 'NOT_FOUND');
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: `/api/agents/${unique('missing')}/memory/MEMORY.md/versions`,
        headers: auth(),
      }),
      'NOT_FOUND',
    );
  });

  it('refuses rollback when the rule globs changed after the change', async () => {
    const agent = await newAgent();
    await repo.rules.upsertRule(app.db, agent.id, {
      slug: 'style',
      content: 'new',
      globs: 'lib/**',
    });
    const changeId = await insertChange({
      agentId: agent.id,
      target: { kind: 'agent_rule', agentId: agent.id, slug: 'style' },
      before: { content: 'old', globs: 'src/**' },
      after: { content: 'new', globs: 'src/**' },
    });

    expectProblem(await rollback(changeId), 'CONFLICT');
    const rule = await app.pool.query<{ content: string; globs: string }>(
      'select content, globs from agent_rules where agent_id = $1 and slug = $2',
      [agent.id, 'style'],
    );
    expect(rule.rows[0]).toEqual({ content: 'new', globs: 'lib/**' });
  });

  it('records a manual same-content save when the file has no matching change', async () => {
    const agent = await newAgent();
    // 文件被平台外的手工改动写过，账本里没有对应记录。
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', '外部内容');
    const put = () =>
      inject(app, {
        method: 'PUT',
        url: `/api/agents/${agent.id}/memory/MEMORY.md`,
        headers: auth(),
        payload: { content: '外部内容' },
      });

    const first = await put();
    expect(first.statusCode, first.body).toBe(200);
    const rows = await app.pool.query<{ before_content: string; after_content: string }>(
      "select before->>'content' as before_content, after->>'content' as after_content from memory_changes where agent_id = $1 and target->>'kind' = 'agent_memory'",
      [agent.id],
    );
    expect(rows.rows).toEqual([{ before_content: '外部内容', after_content: '外部内容' }]);

    // 最近一次已应用变更的 after 与当前一致时不再重复记账。
    const second = await put();
    expect(second.statusCode, second.body).toBe(200);
    const again = await app.pool.query<{ count: number }>(
      "select count(*)::int as count from memory_changes where agent_id = $1 and target->>'kind' = 'agent_memory'",
      [agent.id],
    );
    expect(again.rows[0]?.count).toBe(1);
  });

  it('records manual MEMORY.md and rule writes as applied versions', async () => {
    const agent = await newAgent();
    const memoryWrite = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/memory/MEMORY.md`,
      headers: auth(),
      payload: { content: 'manual memory' },
    });
    expect(memoryWrite.statusCode, memoryWrite.body).toBe(200);

    const memoryVersions = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/memory/MEMORY.md/versions`,
      headers: auth(),
    });
    expect(memoryVersions.statusCode, memoryVersions.body).toBe(200);
    const memoryItems = memoryVersions.json<{
      items: Array<{ id: string; before: unknown; after: unknown; state: string }>;
    }>().items;
    expect(memoryItems).toMatchObject([
      {
        before: { content: null, globs: null },
        after: { content: 'manual memory', globs: null },
        state: 'applied',
      },
    ]);

    const ruleWrite = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/rules/style`,
      headers: auth(),
      payload: { content: 'manual rule', globs: 'src/**' },
    });
    expect(ruleWrite.statusCode, ruleWrite.body).toBe(200);
    const ruleVersions = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/rules/style/versions`,
      headers: auth(),
    });
    expect(ruleVersions.statusCode, ruleVersions.body).toBe(200);
    expect(ruleVersions.json<{ items: unknown[] }>().items).toMatchObject([
      {
        before: { content: null, globs: '' },
        after: { content: 'manual rule', globs: 'src/**' },
        state: 'applied',
      },
    ]);

    // 手工写入也进入版本账本，可以回滚。
    const firstItem = memoryItems[0];
    if (!firstItem) throw new Error('manual memory write did not record a version');
    const reversed = await rollback(firstItem.id);
    expect(reversed.statusCode, reversed.body).toBe(200);
    expect(await readMemoryFile(root, agent.slug, 'MEMORY.md')).toBeNull();
  });
});
