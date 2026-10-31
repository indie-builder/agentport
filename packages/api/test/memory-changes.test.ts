import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { personalMemoryDir } from '@agentport/core';
import { newId, repo } from '@agentport/db';
import { AGENT_MEMORY_MAX_BYTES, MEMORY_FILE_MAX_BYTES } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { decodePackage } from '../src/features/agent-package-zip.js';
import { readMemoryFile, writeMemoryFile } from '../src/features/agents/memory-files.js';
import { registerMemoryChangeRoutes } from '../src/features/memory/changes.js';
import { memorySha256, writeMemoryJournal } from '../src/features/memory/journal.js';
import {
  ADMIN_BUSINESS_ID,
  cleanup,
  createAgent,
  createTestAccount,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  setAgentMember,
  testConfig,
  unique,
} from './helpers.js';

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
      | { kind: 'agent_memory'; agentId: string; name: string }
      | { kind: 'agent_rule'; agentId: string; slug: string };
    before: {
      content: string | null;
      globs: string | null;
      index: { content: string | null } | null;
    };
    after: {
      content: string | null;
      globs: string | null;
      index: { content: string | null } | null;
    };
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
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      before: { content: null, globs: null, index: null },
      after: { content: 'v1', globs: null, index: null },
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
      before: { content: null, globs: '', index: null },
      after: { content: 'v1', globs: 'src/**', index: null },
    });
    await insertChange({
      agentId: agent.id,
      target: { kind: 'agent_rule', agentId: agent.id, slug: 'other' },
      before: { content: null, globs: '', index: null },
      after: { content: 'other rule', globs: '', index: null },
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
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      before: { content: 'old', globs: null, index: null },
      after: { content: 'current', globs: null, index: null },
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
      before: { content: 'old', globs: 'src/**', index: null },
      after: { content: 'new', globs: 'src/**', index: null },
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

  it('recomputes a manual theme save against the index restored from a mixed journal', async () => {
    const agent = await newAgent();
    const failedId = newId('memoryChange');
    const indexBefore = '# 索引\n';
    // A 主题创建在账本提交前失败：A 文件已恢复删除，但索引恢复失败，留下 mixed manual 日志。
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', '- [A.md](A.md)\n');
    await writeMemoryJournal(root, agent.slug, {
      operation: 'manual',
      operationId: failedId,
      businessId: ADMIN_BUSINESS_ID,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'A.md' },
      files: [
        {
          name: 'A.md',
          beforeSha256: memorySha256(null),
          afterSha256: memorySha256('# A\n'),
          beforeBase64: null,
        },
        {
          name: 'MEMORY.md',
          beforeSha256: memorySha256(indexBefore),
          afterSha256: memorySha256('- [A.md](A.md)\n'),
          beforeBase64: Buffer.from(indexBefore, 'utf8').toString('base64'),
        },
      ],
    });

    const written = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/memory/B.md`,
      headers: auth(),
      payload: { content: '# B\n' },
    });
    expect(written.statusCode, written.body).toBe(200);
    expect(await readMemoryFile(root, agent.slug, 'A.md')).toBeNull();
    // 恢复后的索引不能再被恢复前的旧 after 写回 A 链接。
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe(
      '# 索引\n- [B.md](B.md)\n',
    );
    const [change] = (
      await app.pool.query<{ index_content: string }>(
        "select after->'index'->>'content' as index_content from memory_changes where agent_id = $1 and target->>'name' = 'B.md'",
        [agent.id],
      )
    ).rows;
    expect(change?.index_content).toBe('# 索引\n- [B.md](B.md)\n');
  });

  it('does not record a version when MEMORY.md is saved unchanged after a theme change', async () => {
    const agent = await newAgent();
    const put = (name: string, content: string) =>
      inject(app, {
        method: 'PUT',
        url: `/api/agents/${agent.id}/memory/${name}`,
        headers: auth(),
        payload: { content },
      });
    expect((await put('deploy.md', '# 部署\n')).statusCode).toBe(200);
    const index = '- [deploy.md](deploy.md)\n';
    const count = async () =>
      (
        await app.pool.query<{ count: number }>(
          'select count(*)::int as count from memory_changes where agent_id = $1',
          [agent.id],
        )
      ).rows[0]?.count ?? -1;
    const before = await count();

    // 最近一条记录是主题变更，其 after.index.content 正是当前 MEMORY.md 正文。
    const saved = await put('MEMORY.md', index);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await count()).toBe(before);
  });

  it('rejects unchanged MEMORY.md saves that are already above the index limits', async () => {
    const agent = await newAgent();
    const put = (content: string) =>
      inject(app, {
        method: 'PUT',
        url: `/api/agents/${agent.id}/memory/MEMORY.md`,
        headers: auth(),
        payload: { content },
      });
    const count = async () =>
      (
        await app.pool.query<{ count: number }>(
          'select count(*)::int as count from memory_changes where agent_id = $1',
          [agent.id],
        )
      ).rows[0]?.count ?? -1;

    const tooManyLines = Array.from(
      { length: 201 },
      (_, index) => `- [t${index}](t${index}.md)`,
    ).join('\n');
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', tooManyLines);
    expectProblem(await put(tooManyLines), 'INVALID_INPUT');
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe(tooManyLines);
    expect(await count()).toBe(0);

    const tooLarge = 'x'.repeat(AGENT_MEMORY_MAX_BYTES + 1);
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', tooLarge);
    expectProblem(await put(tooLarge), 'INVALID_INPUT');
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe(tooLarge);
    expect(await count()).toBe(0);
  });

  it('still deletes a theme when the untouched index is above the index limits', async () => {
    const agent = await newAgent();
    const oversized = Array.from({ length: 201 }, (_, index) => `- [t${index}](t${index}.md)`).join(
      '\n',
    );
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', oversized);
    await writeMemoryFile(root, agent.slug, 'keep.md', '# 保留\n');

    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/agents/${agent.id}/memory/keep.md`,
      headers: auth(),
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(await readMemoryFile(root, agent.slug, 'keep.md')).toBeNull();
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe(oversized);
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
        before: { content: null, globs: null, index: null },
        after: { content: 'manual memory', globs: null, index: null },
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

  it('records theme writes and adds the index link in the same change', async () => {
    const agent = await newAgent();
    const put = (name: string, content: string) =>
      inject(app, {
        method: 'PUT',
        url: `/api/agents/${agent.id}/memory/${name}`,
        headers: auth(),
        payload: { content },
      });

    const written = await put('deploy.md', '# 部署\n');
    expect(written.statusCode, written.body).toBe(200);
    expect(await readMemoryFile(root, agent.slug, 'MEMORY.md')).toMatchObject({
      content: '- [deploy.md](deploy.md)\n',
    });

    const rows = await app.pool.query<{ before: unknown; after: unknown }>(
      "select before, after from memory_changes where agent_id = $1 and target->>'name' = 'deploy.md'",
      [agent.id],
    );
    expect(rows.rows).toEqual([
      {
        before: { content: null, globs: null, index: { content: null } },
        after: {
          content: '# 部署\n',
          globs: null,
          index: { content: '- [deploy.md](deploy.md)\n' },
        },
      },
    ]);

    // 第二个主题后，版本列表仍按文件名在 LIMIT 前收窄，MEMORY.md 能看到伴随索引变更。
    expect((await put('ops.md', '运维')).statusCode).toBe(200);
    const themeVersions = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/memory/deploy.md/versions?limit=1`,
      headers: auth(),
    });
    expect(themeVersions.statusCode, themeVersions.body).toBe(200);
    expect(themeVersions.json<{ items: Array<{ target: unknown }> }>().items).toEqual([
      expect.objectContaining({
        target: { kind: 'agent_memory', agentId: agent.id, name: 'deploy.md' },
      }),
    ]);
    const indexVersions = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/memory/MEMORY.md/versions`,
      headers: auth(),
    });
    expect(
      indexVersions
        .json<{ items: Array<{ target: { name: string } }> }>()
        .items.map((item) => item.target.name)
        .sort(),
    ).toEqual(['deploy.md', 'ops.md']);
  });

  it('keeps the index unchanged when deleting a theme and records both snapshots', async () => {
    const agent = await newAgent();
    await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/memory/deploy.md`,
      headers: auth(),
      payload: { content: '# 部署\n' },
    });
    const indexBeforeDelete = '- [deploy.md](deploy.md)\n';
    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/agents/${agent.id}/memory/deploy.md`,
      headers: auth(),
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(await readMemoryFile(root, agent.slug, 'deploy.md')).toBeNull();
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe(indexBeforeDelete);
    const rows = await app.pool.query<{ before: unknown; after: unknown }>(
      "select before, after from memory_changes where agent_id = $1 and target->>'name' = 'deploy.md' order by created_at desc limit 1",
      [agent.id],
    );
    expect(rows.rows[0]).toEqual({
      before: {
        content: '# 部署\n',
        globs: null,
        index: { content: indexBeforeDelete },
      },
      after: { content: null, globs: null, index: { content: indexBeforeDelete } },
    });
  });

  it('rolls back a created theme and its index as one change', async () => {
    const agent = await newAgent();
    const put = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/memory/deploy.md`,
      headers: auth(),
      payload: { content: '# 部署\n' },
    });
    expect(put.statusCode, put.body).toBe(200);
    const [change] = (
      await app.pool.query<{ id: string }>(
        "select id from memory_changes where agent_id = $1 and target->>'name' = 'deploy.md'",
        [agent.id],
      )
    ).rows;
    if (!change) throw new Error('theme write did not record a change');

    const reversed = await rollback(change.id);
    expect(reversed.statusCode, reversed.body).toBe(200);
    expect(reversed.json()).toMatchObject({
      reversesChangeId: change.id,
      before: { content: '# 部署\n', index: { content: '- [deploy.md](deploy.md)\n' } },
      after: { content: null, index: { content: null } },
    });
    expect(await readMemoryFile(root, agent.slug, 'deploy.md')).toBeNull();
    expect(await readMemoryFile(root, agent.slug, 'MEMORY.md')).toBeNull();
  });

  it('rolls back a theme update without requiring an unchanged later index', async () => {
    const agent = await newAgent();
    const put = (name: string, content: string) =>
      inject(app, {
        method: 'PUT',
        url: `/api/agents/${agent.id}/memory/${name}`,
        headers: auth(),
        payload: { content },
      });
    await put('deploy.md', 'v1');
    await put('deploy.md', 'v2');
    const [second] = (
      await app.pool.query<{ id: string }>(
        "select id from memory_changes where agent_id = $1 and target->>'name' = 'deploy.md' order by created_at desc limit 1",
        [agent.id],
      )
    ).rows;
    if (!second) throw new Error('theme update did not record a change');
    // 该版本只改主题正文，索引在前后的快照相同。
    await put('ops.md', '运维');

    const reversed = await rollback(second.id);
    expect(reversed.statusCode, reversed.body).toBe(200);
    expect((await readMemoryFile(root, agent.slug, 'deploy.md'))?.content).toBe('v1');
    // 后续新增的索引链接保留，不被主题回滚抹掉。
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe(
      '- [deploy.md](deploy.md)\n- [ops.md](ops.md)\n',
    );

    await put('deploy.md', 'v3');
    expectProblem(await rollback(second.id), 'CONFLICT');
  });

  it('applies the index line and 25KB limits to manual saves', async () => {
    const agent = await newAgent();
    const lines = Array.from({ length: 201 }, (_, index) => `- [t${index}](t${index}.md)`).join(
      '\n',
    );
    const tooManyLines = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/memory/MEMORY.md`,
      headers: auth(),
      payload: { content: lines },
    });
    expectProblem(tooManyLines, 'INVALID_INPUT');
    expect(await readMemoryFile(root, agent.slug, 'MEMORY.md')).toBeNull();

    const tooLarge = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/memory/topic.md`,
      headers: auth(),
      payload: { content: 'x'.repeat(MEMORY_FILE_MAX_BYTES + 1) },
    });
    expectProblem(tooLarge, 'PAYLOAD_TOO_LARGE');
    expect(await readMemoryFile(root, agent.slug, 'topic.md')).toBeNull();
  });

  it('downloads only the native memory files and re-imports them into another agent', async () => {
    const agent = await newAgent();
    const put = (id: string, name: string, content: string) =>
      inject(app, {
        method: 'PUT',
        url: `/api/agents/${id}/memory/${name}`,
        headers: auth(),
        payload: { content },
      });
    expect((await put(agent.id, 'MEMORY.md', '# 索引\n')).statusCode).toBe(200);
    expect((await put(agent.id, 'deploy.md', '# 部署\n使用蓝绿发布。')).statusCode).toBe(200);

    expectProblem(
      await inject(app, { method: 'GET', url: `/api/agents/${agent.id}/memory/download` }),
      'UNAUTHORIZED',
    );

    // 有 agents.memory.read 功能权限、但不是该专家成员的账户被对象范围拒绝；
    // 范围不符统一按对象不存在返回，避免泄露其他用户的对象。
    const maintainer = await createTestAccount(app, cookie, { systemKeys: ['maintainer'] });
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: `/api/agents/${agent.id}/memory/download`,
        headers: { cookie: maintainer.cookie },
      }),
      'NOT_FOUND',
    );
    // 授予维护范围后，同一对象下载放行。
    await setAgentMember(app, cookie, agent.id, maintainer.businessId, {
      canUse: false,
      canMaintain: true,
    });
    const memberDownload = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/memory/download`,
      headers: { cookie: maintainer.cookie },
    });
    expect(memberDownload.statusCode, memberDownload.body).toBe(200);

    const download = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/memory/download`,
      headers: auth(),
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers['content-type']).toContain('application/zip');
    expect(download.headers['content-disposition']).toBe(
      `attachment; filename="${agent.slug}-memory.zip"`,
    );
    expect(download.headers['cache-control']).toBe('no-store');
    const files = decodePackage(download.rawPayload);
    expect([...files.keys()].sort()).toEqual(['MEMORY.md', 'deploy.md']);
    expect(files.get('MEMORY.md')).toBe('# 索引\n- [deploy.md](deploy.md)\n');
    expect(files.get('deploy.md')).toBe('# 部署\n使用蓝绿发布。');

    // 真实解包后走公开 PUT 回导另一位专家，正文与相对链接不依赖原 agentId/slug。
    const copy = await newAgent();
    for (const [name, content] of files) {
      const imported = await put(copy.id, name, content);
      expect(imported.statusCode, imported.body).toBe(200);
    }
    expect((await readMemoryFile(root, copy.slug, 'deploy.md'))?.content).toBe(
      '# 部署\n使用蓝绿发布。',
    );
    expect((await readMemoryFile(root, copy.slug, 'MEMORY.md'))?.content).toBe(
      '# 索引\n- [deploy.md](deploy.md)\n',
    );
    const again = await inject(app, {
      method: 'GET',
      url: `/api/agents/${copy.id}/memory/download`,
      headers: auth(),
    });
    expect([...decodePackage(again.rawPayload).entries()].sort()).toEqual(
      [...files.entries()].sort(),
    );

    const empty = await newAgent();
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: `/api/agents/${empty.id}/memory/download`,
        headers: auth(),
      }),
      'NOT_FOUND',
    );
  });

  it('refuses memory downloads with links or above the package size limit', async () => {
    const agent = await newAgent();
    const dir = join(root, agent.slug, 'agent-memory');
    await mkdir(dir, { recursive: true });
    await symlink('/private/secret.md', join(dir, 'topic.md'));
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: `/api/agents/${agent.id}/memory/download`,
        headers: auth(),
      }),
      'INVALID_INPUT',
    );
    await rm(join(dir, 'topic.md'));

    // 每个文件都在单文件上限内，但合计超过专家包 4 MiB 的解压上限。
    for (let index = 0; index < 21; index += 1) {
      await writeMemoryFile(root, agent.slug, `big-${index}.md`, 'x'.repeat(200_000));
    }
    expectProblem(
      await inject(app, {
        method: 'GET',
        url: `/api/agents/${agent.id}/memory/download`,
        headers: auth(),
      }),
      'CONFLICT',
    );
  });

  it('restores both files when a manual theme write cannot commit the ledger', async () => {
    const agent = await newAgent();
    const put = () =>
      inject(app, {
        method: 'PUT',
        url: `/api/agents/${agent.id}/memory/deploy.md`,
        headers: auth(),
        payload: { content: '# 部署\n' },
      });
    const spy = vi
      .spyOn(app.db, 'transaction')
      .mockRejectedValueOnce(new Error('injected database commit failure') as never);
    let failed: Awaited<ReturnType<typeof put>>;
    try {
      failed = await put();
    } finally {
      spy.mockRestore();
    }
    expect(failed.statusCode, failed.body).toBe(500);
    expect(await readMemoryFile(root, agent.slug, 'deploy.md')).toBeNull();
    expect(await readMemoryFile(root, agent.slug, 'MEMORY.md')).toBeNull();

    const retried = await put();
    expect(retried.statusCode, retried.body).toBe(200);
    expect((await readMemoryFile(root, agent.slug, 'deploy.md'))?.content).toBe('# 部署\n');
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe(
      '- [deploy.md](deploy.md)\n',
    );
    const rows = await app.pool.query<{ count: number }>(
      "select count(*)::int as count from memory_changes where agent_id = $1 and target->>'name' = 'deploy.md'",
      [agent.id],
    );
    expect(rows.rows[0]?.count).toBe(1);
  });
  it('converges a retried rollback on the existing reverse change', async () => {
    const agent = await newAgent();
    const link = '- [deploy.md](deploy.md)\n';
    await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/memory/deploy.md`,
      headers: auth(),
      payload: { content: '# 部署\n' },
    });
    const [change] = (
      await app.pool.query<{ id: string }>(
        "select id from memory_changes where agent_id = $1 and target->>'name' = 'deploy.md'",
        [agent.id],
      )
    ).rows;
    if (!change) throw new Error('theme write did not record a change');
    const reversed = await rollback(change.id);
    expect(reversed.statusCode, reversed.body).toBe(200);
    const reverseId = reversed.json<{ id: string }>().id;

    // 账本已提交、日志删除失败：重试同一回滚只返回既有反向变更。
    await writeMemoryJournal(root, agent.slug, {
      operation: 'rollback',
      operationId: change.id,
      businessId: ADMIN_BUSINESS_ID,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'deploy.md' },
      files: [
        {
          name: 'deploy.md',
          beforeSha256: memorySha256('# 部署\n'),
          afterSha256: null,
          beforeBase64: Buffer.from('# 部署\n', 'utf8').toString('base64'),
        },
        {
          name: 'MEMORY.md',
          beforeSha256: memorySha256(link),
          afterSha256: null,
          beforeBase64: Buffer.from(link, 'utf8').toString('base64'),
        },
      ],
    });
    const retried = await rollback(change.id);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json<{ id: string }>().id).toBe(reverseId);
    expect(await readMemoryFile(root, agent.slug, 'MEMORY.md')).toBeNull();
    await expect(
      rm(join(root, agent.slug, '.memory-journal', `${change.id}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers an uncommitted manual write with its preallocated change id', async () => {
    const agent = await newAgent();
    const operationId = newId('memoryChange');
    // 文件已全部落盘，但账本事务还没提交：日志的身份必须先于写入分配。
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', '# 手工\n');
    await writeMemoryJournal(root, agent.slug, {
      operation: 'manual',
      operationId,
      businessId: ADMIN_BUSINESS_ID,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      files: [
        {
          name: 'MEMORY.md',
          beforeSha256: memorySha256(null),
          afterSha256: memorySha256('# 手工\n'),
          beforeBase64: null,
        },
      ],
    });

    const retried = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/memory/MEMORY.md`,
      headers: auth(),
      payload: { content: '# 手工\n' },
    });
    expect(retried.statusCode, retried.body).toBe(200);

    const rows = await app.pool.query<{ id: string; before: unknown; after: unknown }>(
      'select id, before, after from memory_changes where agent_id = $1',
      [agent.id],
    );
    expect(rows.rows).toEqual([
      {
        id: operationId,
        before: { content: null, globs: null, index: null },
        after: { content: '# 手工\n', globs: null, index: null },
      },
    ]);
    await expect(
      rm(join(root, agent.slug, '.memory-journal', `${operationId}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not repeat a committed manual change after only the index changed externally', async () => {
    const agent = await newAgent();
    const put = () =>
      inject(app, {
        method: 'PUT',
        url: `/api/agents/${agent.id}/memory/deploy.md`,
        headers: auth(),
        payload: { content: '# 部署\n' },
      });
    const first = await put();
    expect(first.statusCode, first.body).toBe(200);
    const [change] = (
      await app.pool.query<{ id: string }>(
        "select id from memory_changes where agent_id = $1 and target->>'name' = 'deploy.md'",
        [agent.id],
      )
    ).rows;
    if (!change) throw new Error('theme write did not record a change');

    // 账本已提交但清日志失败：残留日志与已提交行使用同一稳定身份。
    await writeMemoryJournal(root, agent.slug, {
      operation: 'manual',
      operationId: change.id,
      businessId: ADMIN_BUSINESS_ID,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'deploy.md' },
      files: [
        {
          name: 'deploy.md',
          beforeSha256: memorySha256(null),
          afterSha256: memorySha256('# 部署\n'),
          beforeBase64: null,
        },
        {
          name: 'MEMORY.md',
          beforeSha256: memorySha256(null),
          afterSha256: memorySha256('- [deploy.md](deploy.md)\n'),
          beforeBase64: null,
        },
      ],
    });
    // SDK 随后只改了索引；残留日志不能再据此补记或复制原来那条变更。
    await writeMemoryFile(
      root,
      agent.slug,
      'MEMORY.md',
      '- [deploy.md](deploy.md)\n- [notes.md](notes.md)\n',
    );

    const retried = await put();
    expect(retried.statusCode, retried.body).toBe(200);
    const duplicated = await app.pool.query<{ count: number }>(
      "select count(*)::int as count from memory_changes where agent_id = $1 and target->>'name' = 'deploy.md' and before->>'content' is null",
      [agent.id],
    );
    expect(duplicated.rows[0]?.count).toBe(1);
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe(
      '- [deploy.md](deploy.md)\n- [notes.md](notes.md)\n',
    );
    await expect(
      rm(join(root, agent.slug, '.memory-journal', `${change.id}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an uncommitted manual journal blocking when the file was edited externally', async () => {
    const agent = await newAgent();
    const operationId = newId('memoryChange');
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', '# 手工\n');
    await writeMemoryJournal(root, agent.slug, {
      operation: 'manual',
      operationId,
      businessId: ADMIN_BUSINESS_ID,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      files: [
        {
          name: 'MEMORY.md',
          beforeSha256: memorySha256(null),
          afterSha256: memorySha256('# 手工\n'),
          beforeBase64: null,
        },
      ],
    });
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', '第三方内容');

    expectProblem(
      await inject(app, {
        method: 'PUT',
        url: `/api/agents/${agent.id}/memory/MEMORY.md`,
        headers: auth(),
        payload: { content: '# 再写\n' },
      }),
      'CONFLICT',
    );
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe('第三方内容');
    await expect(
      rm(join(root, agent.slug, '.memory-journal', `${operationId}.json`)),
    ).resolves.toBeUndefined();
  });
});
