import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fsModule from 'node:fs/promises';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { personalMemoryDir, personalMemoryPath } from '@agentport/core';
import { repo } from '@agentport/db';
import { AGENT_MEMORY_MAX_BYTES, AGENT_MEMORY_MAX_LINES } from '@agentport/shared';
import { buildApp } from '../src/app.js';
import { readMemoryFile, writeMemoryFile } from '../src/modules/agents/memory-files.js';
import { memorySha256, writeMemoryJournal } from '../src/modules/memory/journal.js';
import { MEMORY_REVIEW_MAX_BYTES } from '../src/modules/memory-reviews/router.js';
import { closeProducer, getQueue } from '../src/queue/producer.js';
import {
  ADMIN_BUSINESS_ID,
  acquireMemoryLock,
  cleanup,
  createAgent,
  createTestAccount,
  expectProblem,
  infraReady,
  loginCookie,
  request,
  type TestApp,
  testConfig,
  unique,
} from './helpers.js';

const ready = await infraReady;

// 故障注入只影响本文件的写入投影；其他 fs 操作继续走真实实现。
const fsFaults = {
  failRename: false,
  /** 第 N 次 rename 失败（1 起算）；0 表示不按次数失败。 */
  failRenameAt: 0,
  /** 第 N 次 rename 暂停；0 表示任意一次都暂停。 */
  gateAt: 0,
  /** 日志清理阶段的 unlink 失败：已提交的账本不能被改写成 500。 */
  failUnlink: false,
  renameCalls: 0,
  gate: null as null | { entered: () => void; release: Promise<void> },
};
const realFs = { ...fsModule };
mock.module('node:fs/promises', () => {
  const actual = realFs;
  return {
    ...actual,
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (fsFaults.failUnlink) throw new Error('injected unlink failure');
      return actual.unlink(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      fsFaults.renameCalls += 1;
      const gated = fsFaults.gateAt === 0 || fsFaults.renameCalls === fsFaults.gateAt;
      if (fsFaults.gate && gated) {
        fsFaults.gate.entered();
        await fsFaults.gate.release;
      }
      if (fsFaults.failRename || fsFaults.renameCalls === fsFaults.failRenameAt) {
        throw new Error('injected rename failure');
      }
      return actual.rename(...args);
    },
  };
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 三个记忆测试文件共用同一把会话级 advisory 锁（见 helpers.acquireMemoryLock）。
interface AgentRef {
  id: string;
  slug: string;
}

interface JobRecord {
  name: string;
  data: { runId: string; agentId: string; conversationId: string; prompt: string };
  options: { jobId?: string; attempts?: number };
}

describe.skipIf(!ready)('memory reviews', () => {
  let app: TestApp;
  let cookie: string;
  let root: string;
  let addSpy: { mockRestore: () => void };
  let releaseLock: (() => Promise<void>) | undefined;
  const agentSlugs: string[] = [];
  const jobs: JobRecord[] = [];
  let messageSeq = 0;

  beforeAll(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), 'memory-reviews-'));
    app = await buildApp(testConfig({ WORKSPACES_DIR: root }));
    releaseLock = await acquireMemoryLock(app.client);
    cookie = await loginCookie(app);
    addSpy = spyOn(getQueue(), 'add').mockImplementation((async (
      name: string,
      data: JobRecord['data'],
      options: JobRecord['options'],
    ) => {
      jobs.push({ name, data, options });
      return { id: data.runId };
    }) as never);
  }, 60_000);

  beforeEach(async () => {
    await app.client.unsafe('delete from memory_changes where business_id = $1', [
      ADMIN_BUSINESS_ID,
    ]);
    await app.client.unsafe('delete from user_preferences where business_id = $1', [
      ADMIN_BUSINESS_ID,
    ]);
    await rm(personalMemoryDir(root, ADMIN_BUSINESS_ID), { recursive: true, force: true });
    jobs.length = 0;
    fsFaults.failRename = false;
    fsFaults.failRenameAt = 0;
    fsFaults.gateAt = 0;
    fsFaults.failUnlink = false;
    fsFaults.renameCalls = 0;
    fsFaults.gate = null;
  });

  afterAll(async () => {
    try {
      addSpy.mockRestore();
      await app.client.unsafe('delete from memory_reviews where business_id = $1', [
        ADMIN_BUSINESS_ID,
      ]);
      await app.client.unsafe('delete from memory_changes where business_id = $1', [
        ADMIN_BUSINESS_ID,
      ]);
      await app.client.unsafe('delete from user_preferences where business_id = $1', [
        ADMIN_BUSINESS_ID,
      ]);
      await cleanup(app, { agentSlugs });
    } finally {
      await releaseLock?.();
      await closeProducer();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  const auth = () => ({ cookie });

  async function newAgent(): Promise<AgentRef> {
    const response = await createAgent(app, cookie, {
      slug: unique('review-agent'),
      track: agentSlugs,
    });
    return response.json<AgentRef>();
  }

  async function newConversation(agentId: string, title = 'review source'): Promise<string> {
    const conversation = await repo.chat.createConversation(app.db, {
      id: unique('review-conv'),
      agentId,
      title,
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
    });
    return conversation.id;
  }

  async function seedMessage(
    conversationId: string,
    role: 'user' | 'assistant' | 'tool',
    text: string,
  ): Promise<string> {
    const id = unique('review-msg');
    // 显式递增时间，避免同一毫秒内插入时按 id 排序打乱起止边界。
    const createdAt = new Date(Date.now() + messageSeq++ * 1000);
    await app.client.unsafe(
      'insert into messages (id, conversation_id, role, content, created_at) values ($1, $2, $3, $4::jsonb, $5)',
      [
        id,
        conversationId,
        role,
        JSON.stringify(role === 'tool' ? { type: 'tool' } : { type: 'text', text }),
        createdAt.toISOString(),
      ],
    );
    return id;
  }

  function reviewBody(input: {
    modelAgentId: string;
    target:
      | { kind: 'personal' }
      | { kind: 'agent_memory'; agentId: string; name: string }
      | { kind: 'agent_rule'; agentId: string; slug: string };
    sources: Array<{ conversationId: string; fromMessageId?: string; throughMessageId?: string }>;
    instruction?: string;
  }) {
    return {
      modelAgentId: input.modelAgentId,
      target: input.target,
      sources: input.sources,
      ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
    };
  }

  function postReview(body: unknown, key: string | null = randomUUID()) {
    return request(app, {
      method: 'POST',
      url: '/api/memory-reviews',
      headers: {
        ...auth(),
        ...(key === null ? {} : { 'idempotency-key': key }),
      },
      payload: body,
    });
  }

  async function completeReview(
    runId: string,
    proposedContent: string | null,
    evidence: { messageId: string; quote: string; kind?: string },
  ) {
    await app.client.unsafe('update memory_reviews set proposal = $2::jsonb where run_id = $1', [
      runId,
      JSON.stringify({
        summary: '生成的提案',
        proposedContent,
        evidence:
          proposedContent === null ? [] : [{ ...evidence, kind: evidence.kind ?? 'user_fact' }],
      }),
    ]);
    await app.client.unsafe(
      "update agent_runs set status = 'succeeded', ended_at = now(), cost_usd = '0.0123' where id = $1",
      [runId],
    );
  }

  function applyReview(runId: string) {
    return request(app, {
      method: 'POST',
      url: `/api/memory-reviews/${runId}/apply`,
      headers: auth(),
    });
  }

  function rejectReview(runId: string) {
    return request(app, {
      method: 'PATCH',
      url: `/api/memory-reviews/${runId}`,
      headers: auth(),
      payload: { decision: 'rejected' },
    });
  }

  function rollbackChange(changeId: string) {
    return request(app, {
      method: 'POST',
      url: `/api/memory/changes/${changeId}/rollback`,
      headers: auth(),
    });
  }

  function journalPath(agent: AgentRef, runId: string): string {
    return join(root, agent.slug, '.memory-journal', `${runId}.json`);
  }

  function journalExists(agent: AgentRef, runId: string): Promise<boolean> {
    return readFile(journalPath(agent, runId)).then(
      () => true,
      () => false,
    );
  }

  function saveMemory(agent: AgentRef, content: string) {
    return request(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/memory/MEMORY.md`,
      headers: auth(),
      payload: { content },
    });
  }

  /** 账本已提交但清日志失败：合法日志与已提交行使用同一稳定身份。 */
  async function writeCommittedManualJournal(agent: AgentRef, changeId: string, content: string) {
    await writeMemoryJournal(root, agent.slug, {
      operation: 'manual',
      operationId: changeId,
      businessId: ADMIN_BUSINESS_ID,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      files: [
        {
          name: 'MEMORY.md',
          beforeSha256: memorySha256(null),
          afterSha256: memorySha256(content),
          beforeBase64: null,
        },
      ],
    });
  }

  async function manualChangeId(agent: AgentRef): Promise<string> {
    const [change] = await app.client.unsafe<{ id: string }[]>(
      "select id from memory_changes where agent_id = $1 and target->>'name' = 'MEMORY.md'",
      [agent.id],
    );
    if (!change) throw new Error('manual write did not record a change');
    return change.id;
  }

  async function reviewChangeCount(runId: string): Promise<number> {
    const result = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from memory_changes where source_review_run_id = $1',
      [runId],
    );
    return result[0]?.count ?? -1;
  }

  function getReview(runId: string) {
    return request(app, { method: 'GET', url: `/api/memory-reviews/${runId}`, headers: auth() });
  }

  it('requires auth for every endpoint', async () => {
    const runId = unique('run');
    expectProblem(
      await request(app, {
        method: 'POST',
        url: '/api/memory-reviews',
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          modelAgentId: 'missing',
          target: { kind: 'personal' },
          sources: [{ conversationId: 'missing' }],
        },
      }),
      'UNAUTHORIZED',
    );
    expectProblem(
      await request(app, { method: 'GET', url: '/api/memory-reviews' }),
      'UNAUTHORIZED',
    );
    expectProblem(
      await request(app, { method: 'GET', url: `/api/memory-reviews/${runId}` }),
      'UNAUTHORIZED',
    );
    expectProblem(
      await request(app, { method: 'POST', url: `/api/memory-reviews/${runId}/apply` }),
      'UNAUTHORIZED',
    );
    expectProblem(
      await request(app, {
        method: 'PATCH',
        url: `/api/memory-reviews/${runId}`,
        payload: { decision: 'rejected' },
      }),
      'UNAUTHORIZED',
    );
  });

  it('is idempotent for the same key and hash, and rejects a different body', async () => {
    const agent = await newAgent();
    const conversationId = await newConversation(agent.id);
    const messageId = await seedMessage(conversationId, 'user', '回答先给结论');
    const key = randomUUID();
    const body = reviewBody({
      modelAgentId: agent.id,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      sources: [{ conversationId }],
    });

    const first = await postReview(body, key);
    expect(first.statusCode, first.body).toBe(202);
    const runId = first.json<{ runId: string }>().runId;

    const second = await postReview(body, key);
    expect(second.statusCode, second.body).toBe(202);
    expect(second.json()).toEqual({ runId });

    const conflicting = await postReview({ ...body, instruction: '换个要求' }, key);
    expectProblem(conflicting, 'CONFLICT');

    const missingKey = await postReview(body, null);
    expectProblem(missingKey, 'INVALID_INPUT');

    const runs = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from agent_runs where id = $1',
      [runId],
    );
    expect(runs[0]?.count).toBe(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      name: 'run',
      data: { runId, agentId: agent.id, conversationId, prompt: '记忆审核' },
      options: { jobId: runId, attempts: 1 },
    });
    expect(messageId).toBeTruthy();
  });

  it('enforces own-only sources for explicit scope, including the idempotent early return', async () => {
    const other = await createTestAccount(app, cookie, { systemKeys: ['user'] });
    const agent = await newAgent();
    const ownConversation = await newConversation(agent.id, '本人来源');
    await seedMessage(ownConversation, 'user', '本人偏好');
    const otherConversation = await repo.chat.createConversation(app.db, {
      id: unique('review-conv'),
      agentId: agent.id,
      title: '他人来源',
      subject: { kind: 'user', businessId: other.businessId },
    });
    await seedMessage(otherConversation.id, 'user', '别人偏好');
    const key = randomUUID();
    const body = reviewBody({
      modelAgentId: agent.id,
      target: { kind: 'personal' },
      sources: [{ conversationId: ownConversation }, { conversationId: otherConversation.id }],
    });

    const scoped = (scope: string, payload: unknown, idempotencyKey = randomUUID()) =>
      request(app, {
        method: 'POST',
        url: `/api/memory-reviews?scope=${encodeURIComponent(scope)}`,
        headers: { ...auth(), 'idempotency-key': idempotencyKey },
        payload,
      });

    // 不带 scope 时保留既有平台授权语义。
    expect((await postReview(body, key)).statusCode).toBe(202);

    // 相同幂等键也不能跳过 own 校验：管理员选择他人来源一律按不存在处理。
    expectProblem(await scoped('own', body, key), 'NOT_FOUND');

    const ownBody = reviewBody({
      modelAgentId: agent.id,
      target: { kind: 'personal' },
      sources: [{ conversationId: ownConversation }],
    });
    const ownKey = randomUUID();
    const created = await scoped('own', ownBody, ownKey);
    expect(created.statusCode, created.body).toBe(202);
    const runId = created.json<{ runId: string }>().runId;
    const repeated = await scoped('own', ownBody, ownKey);
    expect(repeated.statusCode, repeated.body).toBe(202);
    expect(repeated.json()).toEqual({ runId });

    expectProblem(await scoped('all', ownBody), 'INVALID_INPUT');
  });

  it('validates snapshot boundaries, empty text, and the size limit', async () => {
    const agent = await newAgent();
    const conversationId = await newConversation(agent.id);
    const firstId = await seedMessage(conversationId, 'user', 'remember this');
    const toolId = await seedMessage(conversationId, 'tool', '');
    const lastId = await seedMessage(conversationId, 'assistant', 'noted');

    const emptyRange = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId, fromMessageId: toolId, throughMessageId: toolId }],
      }),
    );
    expectProblem(emptyRange, 'INVALID_INPUT');

    const unknownBoundary = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId, fromMessageId: unique('missing') }],
      }),
    );
    expectProblem(unknownBoundary, 'INVALID_INPUT');

    const reversed = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId, fromMessageId: lastId, throughMessageId: firstId }],
      }),
    );
    expectProblem(reversed, 'INVALID_INPUT');

    const bounded = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId, fromMessageId: firstId, throughMessageId: lastId }],
      }),
    );
    expect(bounded.statusCode, bounded.body).toBe(202);

    const bigConversation = await newConversation(agent.id);
    await seedMessage(bigConversation, 'user', 'x'.repeat(60 * 1024));
    await repo.rules.upsertRule(app.db, agent.id, {
      slug: 'big',
      content: 'y'.repeat(200 * 1024),
      globs: '',
    });
    const oversized = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_rule', agentId: agent.id, slug: 'big' },
        sources: [{ conversationId: bigConversation }],
      }),
    );
    expectProblem(oversized, 'PAYLOAD_TOO_LARGE');
  });

  it('checks model agent state and source ownership', async () => {
    const owner = await newAgent();
    const other = await newAgent();
    const otherConversation = await newConversation(other.id);
    await seedMessage(otherConversation, 'user', '跨专家的会话');

    const crossAgent = await postReview(
      reviewBody({
        modelAgentId: owner.id,
        target: { kind: 'agent_memory', agentId: owner.id, name: 'MEMORY.md' },
        sources: [{ conversationId: otherConversation }],
      }),
    );
    expectProblem(crossAgent, 'INVALID_INPUT');

    const personalCrossAgent = await postReview(
      reviewBody({
        modelAgentId: owner.id,
        target: { kind: 'personal' },
        sources: [{ conversationId: otherConversation }],
      }),
    );
    expect(personalCrossAgent.statusCode, personalCrossAgent.body).toBe(202);

    const missingModel = await postReview(
      reviewBody({
        modelAgentId: unique('missing-agent'),
        target: { kind: 'personal' },
        sources: [{ conversationId: otherConversation }],
      }),
    );
    expectProblem(missingModel, 'AGENT_NOT_FOUND');

    await app.client.unsafe('update agents set enabled = false where id = $1', [owner.id]);
    const disabledModel = await postReview(
      reviewBody({
        modelAgentId: owner.id,
        target: { kind: 'personal' },
        sources: [{ conversationId: otherConversation }],
      }),
    );
    expectProblem(disabledModel, 'AGENT_DISABLED');
    await app.client.unsafe('update agents set enabled = true where id = $1', [owner.id]);
  });

  it('keeps rule proposals open while expert memory is disabled', async () => {
    const agent = await newAgent();
    const conversationId = await newConversation(agent.id);
    await seedMessage(conversationId, 'user', '回答要先给结论');
    await repo.rules.upsertRule(app.db, agent.id, {
      slug: 'style',
      content: '旧规则',
      globs: '',
    });
    const saved = await request(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/memory/policy`,
      headers: auth(),
      payload: { policy: { enabled: false } },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    // 规则由 injectRules 独立控制，停用记忆不该连带拒绝规则提案。
    const rule = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_rule', agentId: agent.id, slug: 'style' },
        sources: [{ conversationId }],
      }),
    );
    expect(rule.statusCode, rule.body).toBe(202);

    // 记忆提案仍按停用策略拒绝。
    const memory = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId }],
      }),
    );
    expectProblem(memory, 'CONFLICT');
  });

  it('creates a review run without writing messages or touching the SDK session', async () => {
    const agent = await newAgent();
    const conversationId = await newConversation(agent.id);
    const messageId = await seedMessage(conversationId, 'user', '请记住我喜欢简短回答');
    await app.client.unsafe('update conversations set sdk_session_id = $2 where id = $1', [
      conversationId,
      'sdk-session-before',
    ]);
    const beforeCount = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from messages where conversation_id = $1',
      [conversationId],
    );

    const response = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId, fromMessageId: messageId, throughMessageId: messageId }],
        instruction: '只保留偏好',
      }),
    );
    expect(response.statusCode, response.body).toBe(202);
    const runId = response.json<{ runId: string }>().runId;

    const afterCount = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from messages where conversation_id = $1',
      [conversationId],
    );
    expect(afterCount[0]?.count).toBe(beforeCount[0]?.count);
    const conversation = await app.client.unsafe<{ sdk_session_id: string | null }[]>(
      'select sdk_session_id from conversations where id = $1',
      [conversationId],
    );
    expect(conversation[0]?.sdk_session_id).toBe('sdk-session-before');

    const run = await app.client.unsafe<
      {
        agent_id: string;
        conversation_id: string;
        trigger: string;
        status: string;
      }[]
    >('select agent_id, conversation_id, trigger, status from agent_runs where id = $1', [runId]);
    expect(run[0]).toMatchObject({
      agent_id: agent.id,
      conversation_id: conversationId,
      trigger: 'review',
      status: 'queued',
    });

    const filtered = await request(app, {
      method: 'GET',
      url: `/api/runs?agentId=${encodeURIComponent(agent.id)}&trigger=review`,
      headers: auth(),
    });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json<{ items: Array<{ id: string; trigger: string }> }>().items).toMatchObject([
      { id: runId, trigger: 'review' },
    ]);

    const review = await app.client.unsafe<
      {
        model_agent_id: string;
        target: unknown;
        before: unknown;
        instruction: string;
      }[]
    >('select model_agent_id, target, before, instruction from memory_reviews where run_id = $1', [
      runId,
    ]);
    expect(review[0]).toMatchObject({
      model_agent_id: agent.id,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      before: { content: null, globs: null, index: null },
      instruction: '只保留偏好',
    });
  });

  it('returns detail and list summaries without full source text', async () => {
    const agent = await newAgent();
    const conversationId = await newConversation(agent.id, '偏好讨论');
    const messageId = await seedMessage(conversationId, 'user', '回答先给结论');
    const body = reviewBody({
      modelAgentId: agent.id,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      sources: [{ conversationId }],
    });
    const created = await postReview(body);
    expect(created.statusCode, created.body).toBe(202);
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '# Memory', { messageId, quote: '回答先给结论' });

    const detail = await getReview(runId);
    expect(detail.statusCode, detail.body).toBe(200);
    const review = detail.json<{
      runId: string;
      modelAgentId: string;
      status: string;
      decision: string;
      costUsd: string | null;
      error: string | null;
      sources: Array<{
        conversationId: string;
        title: string;
        messageCount: number;
        text?: string;
      }>;
      proposal: { summary: string; proposedContent: string } | null;
    }>();
    expect(review).toMatchObject({
      runId,
      modelAgentId: agent.id,
      status: 'succeeded',
      decision: 'pending',
      costUsd: '0.0123',
      error: null,
      sources: [{ conversationId, title: '偏好讨论', messageCount: 1 }],
      proposal: { summary: '生成的提案', proposedContent: '# Memory' },
    });
    expect(review.sources[0]).not.toHaveProperty('text');
    expect(JSON.stringify(review.sources)).not.toContain('回答先给结论');

    const list = await request(app, {
      method: 'GET',
      url: `/api/memory-reviews?conversationId=${encodeURIComponent(conversationId)}`,
      headers: auth(),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(
      list.json<{ items: Array<{ runId: string; sources: unknown[] }> }>().items,
    ).toMatchObject([{ runId, sources: [{ conversationId }] }]);

    const byAgent = await request(app, {
      method: 'GET',
      url: `/api/memory-reviews?agentId=${encodeURIComponent(agent.id)}`,
      headers: auth(),
    });
    expect(byAgent.statusCode, byAgent.body).toBe(200);
    expect(
      byAgent.json<{ items: Array<{ runId: string }> }>().items.map((item) => item.runId),
    ).toContain(runId);

    const old = new Date(0).toISOString();
    const empty = await request(app, {
      method: 'GET',
      url: `/api/memory-reviews?conversationId=${encodeURIComponent(conversationId)}&before=${encodeURIComponent(old)}`,
      headers: auth(),
    });
    expect(empty.json()).toEqual({ items: [] });
  });

  it('applies a proposal to personal memory, agent memory, and an agent rule', async () => {
    const model = await newAgent();

    // 个人记忆：写入 CLAUDE.md、推进 revision，并记录来源运行。
    const personalConversation = await newConversation(model.id);
    const personalMessage = await seedMessage(personalConversation, 'user', '回答先给结论');
    const personalReview = await postReview(
      reviewBody({
        modelAgentId: model.id,
        target: { kind: 'personal' },
        sources: [{ conversationId: personalConversation }],
      }),
    );
    const personalRunId = personalReview.json<{ runId: string }>().runId;
    await completeReview(personalRunId, '回答先给结论。', {
      messageId: personalMessage,
      quote: '回答先给结论',
    });
    const personalApply = await applyReview(personalRunId);
    expect(personalApply.statusCode, personalApply.body).toBe(200);
    const personalChange = personalApply.json<{
      id: string;
      target: unknown;
      sourceReviewRunId: string | null;
      before: { content: string | null };
      after: { content: string | null };
    }>();
    expect(personalChange).toMatchObject({
      target: { kind: 'personal' },
      sourceReviewRunId: personalRunId,
      before: { content: '' },
      after: { content: '回答先给结论。' },
    });
    expect(personalChange.id).toMatch(/^mch_/);
    expect(await readFile(personalMemoryPath(root, ADMIN_BUSINESS_ID), 'utf8')).toBe(
      '回答先给结论。',
    );
    const personal = await request(app, { method: 'GET', url: '/api/me/memory', headers: auth() });
    expect(personal.json()).toMatchObject({ content: '回答先给结论。', revision: 1 });
    const personalDetail = await getReview(personalRunId);
    expect(personalDetail.json()).toMatchObject({
      decision: 'applied',
      appliedChangeId: personalChange.id,
    });

    // 专家记忆：写官方 MEMORY.md。
    const memoryAgent = await newAgent();
    const memoryConversation = await newConversation(memoryAgent.id);
    const memoryMessage = await seedMessage(memoryConversation, 'user', '记住这个约定');
    const memoryReview = await postReview(
      reviewBody({
        modelAgentId: model.id,
        target: { kind: 'agent_memory', agentId: memoryAgent.id, name: 'MEMORY.md' },
        sources: [{ conversationId: memoryConversation }],
      }),
    );
    const memoryRunId = memoryReview.json<{ runId: string }>().runId;
    await completeReview(memoryRunId, '# 约定\n', {
      messageId: memoryMessage,
      quote: '记住这个约定',
    });
    const stored = await app.client.unsafe<{ business_id: string; run_id: string }[]>(
      'select business_id, run_id from memory_reviews where run_id = $1',
      [memoryRunId],
    );
    expect(stored[0]).toEqual({ business_id: ADMIN_BUSINESS_ID, run_id: memoryRunId });
    const memoryApply = await applyReview(memoryRunId);
    expect(memoryApply.statusCode, memoryApply.body).toBe(200);
    expect(memoryApply.json()).toMatchObject({
      target: { kind: 'agent_memory', agentId: memoryAgent.id, name: 'MEMORY.md' },
      sourceReviewRunId: memoryRunId,
    });
    expect(await readFile(join(root, memoryAgent.slug, 'agent-memory', 'MEMORY.md'), 'utf8')).toBe(
      '# 约定\n',
    );

    // 规则：复用规则写入，并保留审核时的 globs。
    const ruleAgent = await newAgent();
    await repo.rules.upsertRule(app.db, ruleAgent.id, {
      slug: 'style',
      content: '旧规则',
      globs: 'src/**',
    });
    const ruleConversation = await newConversation(ruleAgent.id);
    const ruleMessage = await seedMessage(ruleConversation, 'user', '新规则');
    const ruleReview = await postReview(
      reviewBody({
        modelAgentId: model.id,
        target: { kind: 'agent_rule', agentId: ruleAgent.id, slug: 'style' },
        sources: [{ conversationId: ruleConversation }],
      }),
    );
    const ruleRunId = ruleReview.json<{ runId: string }>().runId;
    await completeReview(ruleRunId, '新规则正文', { messageId: ruleMessage, quote: '新规则' });
    const ruleApply = await applyReview(ruleRunId);
    expect(ruleApply.statusCode, ruleApply.body).toBe(200);
    expect(ruleApply.json()).toMatchObject({
      target: { kind: 'agent_rule', agentId: ruleAgent.id, slug: 'style' },
      before: { content: '旧规则', globs: 'src/**', index: null },
      after: { content: '新规则正文', globs: 'src/**', index: null },
    });
    const rule = await app.client.unsafe<{ content: string; globs: string }[]>(
      'select content, globs from agent_rules where agent_id = $1 and slug = $2',
      [ruleAgent.id, 'style'],
    );
    expect(rule[0]).toEqual({ content: '新规则正文', globs: 'src/**' });
  });

  it('rejects an agent memory proposal above the MEMORY.md index limits without writing', async () => {
    const agent = await newAgent();
    const conversationId = await newConversation(agent.id);
    const messageId = await seedMessage(conversationId, 'user', '记住这个约定');
    const memoryFile = join(root, agent.slug, 'agent-memory', 'MEMORY.md');

    async function applyProposal(content: string) {
      const created = await postReview(
        reviewBody({
          modelAgentId: agent.id,
          target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
          sources: [{ conversationId }],
        }),
      );
      const runId = created.json<{ runId: string }>().runId;
      await completeReview(runId, content, { messageId, quote: '记住这个约定' });
      return { runId, response: await applyReview(runId) };
    }

    // 200 行是索引上限，边界值可采纳。
    const atLimit = Array.from(
      { length: AGENT_MEMORY_MAX_LINES },
      (_, index) => `- [主题 ${index}](topic-${index}.md)`,
    ).join('\n');
    const accepted = await applyProposal(atLimit);
    expect(accepted.response.statusCode, accepted.response.body).toBe(200);
    expect(await readFile(memoryFile, 'utf8')).toBe(atLimit);

    const tooManyLines = await applyProposal(`${atLimit}\n- [多一行](one-more.md)`);
    expectProblem(tooManyLines.response, 'INVALID_INPUT');
    expect(tooManyLines.response.json<{ message: string }>().message).toBe(
      `MEMORY.md 不能超过 ${AGENT_MEMORY_MAX_LINES} 行；请把详细内容移到主题文件`,
    );
    expect((await getReview(tooManyLines.runId)).json()).toMatchObject({
      decision: 'pending',
      appliedChangeId: null,
    });

    const tooLarge = await applyProposal('x'.repeat(AGENT_MEMORY_MAX_BYTES + 1));
    expectProblem(tooLarge.response, 'INVALID_INPUT');
    expect(await readFile(memoryFile, 'utf8')).toBe(atLimit);
  });

  it('refuses to overwrite a target edited after the review', async () => {
    const agent = await newAgent();
    const conversationId = await newConversation(agent.id);
    const messageId = await seedMessage(conversationId, 'user', '旧偏好');
    const created = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'personal' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '新偏好', { messageId, quote: '旧偏好' });

    const edited = await request(app, {
      method: 'PUT',
      url: '/api/me/memory',
      headers: auth(),
      payload: { content: '用户手动改过', expectedRevision: 0 },
    });
    expect(edited.statusCode, edited.body).toBe(200);

    expectProblem(await applyReview(runId), 'CONFLICT');
    const detail = await getReview(runId);
    expect(detail.json()).toMatchObject({ decision: 'pending', appliedChangeId: null });
    const changes = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from memory_changes where source_review_run_id = $1',
      [runId],
    );
    expect(changes[0]?.count).toBe(0);
    expect(
      await request(app, { method: 'GET', url: '/api/me/memory', headers: auth() }).then((r) =>
        r.json<{ content: string }>(),
      ),
    ).toMatchObject({ content: '用户手动改过' });
  });

  it('returns the same change when applying twice and rejects after rejection', async () => {
    const agent = await newAgent();
    const conversationId = await newConversation(agent.id);
    const messageId = await seedMessage(conversationId, 'user', '记住这个偏好');
    const created = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '偏好内容', { messageId, quote: '记住这个偏好' });

    const first = await applyReview(runId);
    expect(first.statusCode, first.body).toBe(200);
    const changeId = first.json<{ id: string }>().id;
    const second = await applyReview(runId);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ id: changeId });

    const changes = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from memory_changes where source_review_run_id = $1',
      [runId],
    );
    expect(changes[0]?.count).toBe(1);

    const rejectedAfterApplied = await request(app, {
      method: 'PATCH',
      url: `/api/memory-reviews/${runId}`,
      headers: auth(),
      payload: { decision: 'rejected' },
    });
    expectProblem(rejectedAfterApplied, 'CONFLICT');

    const conversationId2 = await newConversation(agent.id);
    const messageId2 = await seedMessage(conversationId2, 'user', '另一条偏好');
    const created2 = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId: conversationId2 }],
      }),
    );
    const runId2 = created2.json<{ runId: string }>().runId;
    await completeReview(runId2, '不建议写入', { messageId: messageId2, quote: '另一条偏好' });

    const rejected = await request(app, {
      method: 'PATCH',
      url: `/api/memory-reviews/${runId2}`,
      headers: auth(),
      payload: { decision: 'rejected' },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({ decision: 'rejected' });
    expectProblem(await applyReview(runId2), 'CONFLICT');
  });

  it('refuses to apply expert memory while the target agent has an active run', async () => {
    const model = await newAgent();
    const target = await newAgent();
    const conversationId = await newConversation(target.id);
    const messageId = await seedMessage(conversationId, 'user', '记忆内容');
    const created = await postReview(
      reviewBody({
        modelAgentId: model.id,
        target: { kind: 'agent_memory', agentId: target.id, name: 'MEMORY.md' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '记忆内容', { messageId, quote: '记忆内容' });

    const activeRunId = unique('active-run');
    await app.client.unsafe(
      "insert into agent_runs (id, conversation_id, agent_id, status, subject_kind, initiated_by) values ($1, $2, $3, 'queued', 'user', 'bootstrap-admin')",
      [activeRunId, conversationId, target.id],
    );
    expectProblem(await applyReview(runId), 'CONFLICT');

    await app.client.unsafe("update agent_runs set status = 'cancelled' where id = $1", [
      activeRunId,
    ]);
    expect((await applyReview(runId)).statusCode).toBe(200);
  });

  it('rejects traversal rule slugs at the request boundary and again on apply', async () => {
    const agent = await newAgent();
    const conversationId = await newConversation(agent.id);
    const messageId = await seedMessage(conversationId, 'user', '新规则');

    for (const slug of ['../../../_user/CLAUDE', 'Bad.Slug', '']) {
      const response = await postReview(
        reviewBody({
          modelAgentId: agent.id,
          target: { kind: 'agent_rule', agentId: agent.id, slug },
          sources: [{ conversationId }],
        }),
      );
      expectProblem(response, 'INVALID_INPUT');
    }
    const rulesAfterReject = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from agent_rules where agent_id = $1',
      [agent.id],
    );
    expect(rulesAfterReject[0]?.count).toBe(0);

    // 绕过入口直接改库：apply 必须重新校验，不能写规则行。
    const created = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_rule', agentId: agent.id, slug: 'style' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '新规则正文', { messageId, quote: '新规则' });
    await app.client.unsafe('update memory_reviews set target = $2::jsonb where run_id = $1', [
      runId,
      JSON.stringify({ kind: 'agent_rule', agentId: agent.id, slug: '../../../_user/CLAUDE' }),
    ]);
    expectProblem(await applyReview(runId), 'INVALID_INPUT');
    const rulesAfterApply = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from agent_rules where agent_id = $1',
      [agent.id],
    );
    expect(rulesAfterApply[0]?.count).toBe(0);
    const changes = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from memory_changes where source_review_run_id = $1',
      [runId],
    );
    expect(changes[0]?.count).toBe(0);
  });

  it('refuses to apply when the rule globs changed after the review', async () => {
    const model = await newAgent();
    const target = await newAgent();
    await repo.rules.upsertRule(app.db, target.id, {
      slug: 'style',
      content: '旧规则',
      globs: 'src/**',
    });
    const conversationId = await newConversation(target.id);
    const messageId = await seedMessage(conversationId, 'user', '新规则');
    const created = await postReview(
      reviewBody({
        modelAgentId: model.id,
        target: { kind: 'agent_rule', agentId: target.id, slug: 'style' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '新规则正文', { messageId, quote: '新规则' });

    // 正文没变、只改适用范围：基线也必须比较 globs。
    await repo.rules.upsertRule(app.db, target.id, {
      slug: 'style',
      content: '旧规则',
      globs: 'lib/**',
    });
    expectProblem(await applyReview(runId), 'CONFLICT_STALE');
    const rule = await app.client.unsafe<{ content: string; globs: string }[]>(
      'select content, globs from agent_rules where agent_id = $1 and slug = $2',
      [target.id, 'style'],
    );
    expect(rule[0]).toEqual({ content: '旧规则', globs: 'lib/**' });
    const changes = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from memory_changes where source_review_run_id = $1',
      [runId],
    );
    expect(changes[0]?.count).toBe(0);
  });

  it('serializes concurrent applies on the same baseline so only one wins', async () => {
    const model = await newAgent();
    const target = await newAgent();
    await repo.rules.upsertRule(app.db, target.id, {
      slug: 'style',
      content: '旧规则',
      globs: '',
    });
    const conversationId = await newConversation(target.id);

    async function proposal(content: string): Promise<string> {
      const messageId = await seedMessage(conversationId, 'user', content);
      const created = await postReview(
        reviewBody({
          modelAgentId: model.id,
          target: { kind: 'agent_rule', agentId: target.id, slug: 'style' },
          sources: [{ conversationId }],
        }),
      );
      const runId = created.json<{ runId: string }>().runId;
      await completeReview(runId, content, { messageId, quote: content });
      return runId;
    }

    const first = await proposal('第一条规则');
    const second = await proposal('第二条规则');
    const responses = await Promise.all([applyReview(first), applyReview(second)]);
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([200, 409]);

    const applied = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from memory_changes where source_review_run_id in ($1, $2)',
      [first, second],
    );
    expect(applied[0]?.count).toBe(1);
  });

  it('serializes memory apply and chat admission on the agent lock', async () => {
    const model = await newAgent();
    const target = await newAgent();
    await repo.rules.upsertRule(app.db, target.id, {
      slug: 'style',
      content: '旧规则',
      globs: '',
    });
    const conversationId = await newConversation(target.id);
    const messageId = await seedMessage(conversationId, 'user', '新规则');
    const created = await postReview(
      reviewBody({
        modelAgentId: model.id,
        target: { kind: 'agent_rule', agentId: target.id, slug: 'style' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '新规则正文', { messageId, quote: '新规则' });

    const holdLock = async (): Promise<{
      release: () => Promise<void>;
    }> => {
      const client = await app.client.reserve();
      await client.unsafe('set statement_timeout = 0');
      await client.unsafe('select pg_advisory_lock(hashtext($1))', [`agent:${target.id}`]);
      return {
        release: async () => {
          await client.unsafe('select pg_advisory_unlock(hashtext($1))', [`agent:${target.id}`]);
          client.release();
        },
      };
    };

    const first = await holdLock();
    const applyPromise = applyReview(runId);
    expect(
      await Promise.race([applyPromise.then(() => 'done'), sleep(150).then(() => 'waiting')]),
    ).toBe('waiting');
    await first.release();
    expect((await applyPromise).statusCode, (await applyPromise).body).toBe(200);

    const second = await holdLock();
    const admission = repo.chat.admitChatRun(app.db, {
      agentId: target.id,
      message: 'lock probe',
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
    });
    expect(
      await Promise.race([admission.then(() => 'done'), sleep(150).then(() => 'waiting')]),
    ).toBe('waiting');
    await second.release();
    const admitted = await admission;
    expect(admitted.run.status).toBe('queued');
  });

  async function reviewForMemory(content: string): Promise<{
    agent: AgentRef;
    runId: string;
  }> {
    const agent = await newAgent();
    const conversationId = await newConversation(agent.id);
    const messageId = await seedMessage(conversationId, 'user', content);
    const created = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '# 约定\n', { messageId, quote: content });
    return { agent, runId };
  }

  it('leaves the review pending when the file projection fails and succeeds on retry', async () => {
    const { agent, runId } = await reviewForMemory('记住这个约定');

    // 第 1 次 rename 写日志，第 2 次才是 MEMORY.md 投影。
    fsFaults.failRenameAt = 2;
    const failed = await applyReview(runId);
    fsFaults.failRenameAt = 0;
    expect(failed.statusCode, failed.body).toBe(500);
    expect(await readMemoryFile(root, agent.slug, 'MEMORY.md')).toBeNull();
    expect(await journalExists(agent, runId)).toBe(false);
    expect((await getReview(runId)).json()).toMatchObject({
      decision: 'pending',
      appliedChangeId: null,
    });

    const retried = await applyReview(runId);
    expect(retried.statusCode, retried.body).toBe(200);
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe('# 约定\n');
    expect((await getReview(runId)).json()).toMatchObject({ decision: 'applied' });
  });

  it('restores the original file when the change transaction fails after the rename', async () => {
    const { agent, runId } = await reviewForMemory('记住这个约定');

    // 文件先落盘、账本事务失败：同一把锁内把原文件（这里是不存在）恢复回去。
    const spy = spyOn(app.db, 'transaction').mockRejectedValueOnce(
      new Error('injected database commit failure') as never,
    );
    let failed: Awaited<ReturnType<typeof applyReview>>;
    try {
      failed = await applyReview(runId);
    } finally {
      spy.mockRestore();
    }
    expect(failed.statusCode, failed.body).toBe(500);
    expect(await readMemoryFile(root, agent.slug, 'MEMORY.md')).toBeNull();
    expect(await journalExists(agent, runId)).toBe(false);
    expect((await getReview(runId)).json()).toMatchObject({
      decision: 'pending',
      appliedChangeId: null,
    });
    expect(await reviewChangeCount(runId)).toBe(0);

    const retried = await applyReview(runId);
    expect(retried.statusCode, retried.body).toBe(200);
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe('# 约定\n');
    expect((await getReview(runId)).json()).toMatchObject({ decision: 'applied' });
  });

  it('keeps the journal and blocks reject when the original file cannot be restored', async () => {
    const agent = await newAgent();
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', '旧内容');
    const conversationId = await newConversation(agent.id);
    const messageId = await seedMessage(conversationId, 'user', '记住这个约定');
    const created = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '# 约定\n', { messageId, quote: '记住这个约定' });

    // 准备原文件占第 1 次 rename；第 2 次写日志、第 3 次落提案、第 4 次恢复原文件时失败。
    fsFaults.failRenameAt = 4;
    const spy = spyOn(app.db, 'transaction').mockRejectedValueOnce(
      new Error('injected database commit failure') as never,
    );
    let failed: Awaited<ReturnType<typeof applyReview>>;
    try {
      failed = await applyReview(runId);
    } finally {
      spy.mockRestore();
      fsFaults.failRenameAt = 0;
    }
    expect(failed.statusCode, failed.body).toBe(500);
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe('# 约定\n');
    expect(await journalExists(agent, runId)).toBe(true);
    expect((await getReview(runId)).json()).toMatchObject({
      decision: 'pending',
      appliedChangeId: null,
    });
    expect(await reviewChangeCount(runId)).toBe(0);

    // 文件可能已生效：不能把审核改成 rejected。
    const rejected = await rejectReview(runId);
    expectProblem(rejected, 'CONFLICT');
    expect(rejected.json<{ message: string }>().message).toBe(
      '目标写入未完成，请先重试采用或重新生成',
    );

    // 重试按日志与 after 哈希恢复，只补记一次。
    const retried = await applyReview(runId);
    expect(retried.statusCode, retried.body).toBe(200);
    const changeId = retried.json<{ id: string }>().id;
    expect(await reviewChangeCount(runId)).toBe(1);
    expect(await journalExists(agent, runId)).toBe(false);
    expect((await getReview(runId)).json()).toMatchObject({
      decision: 'applied',
      appliedChangeId: changeId,
    });

    const repeated = await applyReview(runId);
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json<{ id: string }>().id).toBe(changeId);
    expect(await reviewChangeCount(runId)).toBe(1);
  });

  it('does not infer a prior write from memory content equal to the proposal', async () => {
    const { agent, runId } = await reviewForMemory('记住这个约定');

    // 手工写入与提案相同的内容：没有日志，不能当成上次 apply 已落盘。
    const manual = await request(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/memory/MEMORY.md`,
      headers: auth(),
      payload: { content: '# 约定\n' },
    });
    expect(manual.statusCode, manual.body).toBe(200);

    expectProblem(await applyReview(runId), 'CONFLICT_STALE');
    expect(await reviewChangeCount(runId)).toBe(0);
    // 没有写入日志就不能认定内容已生效：拒绝照常允许，且不改写文件。
    const rejected = await rejectReview(runId);
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({ decision: 'rejected' });
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe('# 约定\n');
  });

  it('rejects a proposal identical to the unchanged baseline when nothing was written', async () => {
    const agent = await newAgent();
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', '# 约定\n');
    const conversationId = await newConversation(agent.id);
    const messageId = await seedMessage(conversationId, 'user', '记住这个约定');
    const created = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '# 约定\n', { messageId, quote: '记住这个约定' });

    // 基线、当前文件、提案三者相同，但从未 apply：拒绝成功且文件保持原样。
    const rejected = await rejectReview(runId);
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({ decision: 'rejected' });
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe('# 约定\n');
    expect(await reviewChangeCount(runId)).toBe(0);
  });

  it('removes the write journal after a successful apply and clears residue on repeat', async () => {
    const { agent, runId } = await reviewForMemory('记住这个约定');

    const applied = await applyReview(runId);
    expect(applied.statusCode, applied.body).toBe(200);
    expect(await journalExists(agent, runId)).toBe(false);

    // 提交成功但进程在删日志前退出：重复采纳仍要清掉残留。
    await writeMemoryJournal(root, agent.slug, {
      operation: 'review',
      operationId: runId,
      businessId: ADMIN_BUSINESS_ID,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      files: [
        {
          name: 'MEMORY.md',
          beforeSha256: memorySha256(null),
          afterSha256: memorySha256('# 约定\n'),
          beforeBase64: null,
        },
      ],
    });
    expect(await journalExists(agent, runId)).toBe(true);

    const repeated = await applyReview(runId);
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json<{ id: string }>().id).toBe(applied.json<{ id: string }>().id);
    expect(await journalExists(agent, runId)).toBe(false);
  });

  it('returns the committed change when journal cleanup fails after an all-after apply retry', async () => {
    const { agent, runId } = await reviewForMemory('记住这个约定');
    // 文件已落盘、账本未提交：重试按日志补账后，日志 unlink 失败不能推翻成功。
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', '# 约定\n');
    await writeMemoryJournal(root, agent.slug, {
      operation: 'review',
      operationId: runId,
      businessId: ADMIN_BUSINESS_ID,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      files: [
        {
          name: 'MEMORY.md',
          beforeSha256: memorySha256(null),
          afterSha256: memorySha256('# 约定\n'),
          beforeBase64: null,
        },
      ],
    });

    fsFaults.failUnlink = true;
    let applied: Awaited<ReturnType<typeof applyReview>>;
    try {
      applied = await applyReview(runId);
    } finally {
      fsFaults.failUnlink = false;
    }
    expect(applied.statusCode, applied.body).toBe(200);
    expect(await reviewChangeCount(runId)).toBe(1);
    expect((await getReview(runId)).json()).toMatchObject({
      decision: 'applied',
      appliedChangeId: applied.json<{ id: string }>().id,
    });
    // 删除失败，日志留待下次清理；账本仍只有一条。
    expect(await journalExists(agent, runId)).toBe(true);
  });

  it('returns the committed reverse when journal cleanup fails after an all-after rollback retry', async () => {
    const agent = await newAgent();
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', '旧内容');
    const change = await repo.memoryChanges.insert(app.db, {
      businessId: ADMIN_BUSINESS_ID,
      agentId: agent.id,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      before: { content: '旧内容', globs: null, index: null },
      after: { content: '新内容', globs: null, index: null },
    });
    // 回滚目标文件已落盘（旧内容），账本未提交。
    await writeMemoryJournal(root, agent.slug, {
      operation: 'rollback',
      operationId: change.id,
      businessId: ADMIN_BUSINESS_ID,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      files: [
        {
          name: 'MEMORY.md',
          beforeSha256: memorySha256('新内容'),
          afterSha256: memorySha256('旧内容'),
          beforeBase64: Buffer.from('新内容', 'utf8').toString('base64'),
        },
      ],
    });

    fsFaults.failUnlink = true;
    let reversed: Awaited<ReturnType<typeof rollbackChange>>;
    try {
      reversed = await rollbackChange(change.id);
    } finally {
      fsFaults.failUnlink = false;
    }
    expect(reversed.statusCode, reversed.body).toBe(200);
    expect(reversed.json()).toMatchObject({ reversesChangeId: change.id });
    const rows = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from memory_changes where reverses_change_id = $1',
      [change.id],
    );
    expect(rows[0]?.count).toBe(1);
    expect(await journalExists(agent, change.id)).toBe(true);
  });

  it('allows reject and clears the journal when the file is still the baseline', async () => {
    const agent = await newAgent();
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', '旧内容');
    const conversationId = await newConversation(agent.id);
    const messageId = await seedMessage(conversationId, 'user', '记住这个约定');
    const created = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '# 约定\n', { messageId, quote: '记住这个约定' });

    // 日志已写、rename 前进程退出：文件仍是基线，写入从未生效。
    await writeMemoryJournal(root, agent.slug, {
      operation: 'review',
      operationId: runId,
      businessId: ADMIN_BUSINESS_ID,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      files: [
        {
          name: 'MEMORY.md',
          beforeSha256: memorySha256('旧内容'),
          afterSha256: memorySha256('# 约定\n'),
          beforeBase64: Buffer.from('旧内容', 'utf8').toString('base64'),
        },
      ],
    });

    const rejected = await rejectReview(runId);
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({ decision: 'rejected' });
    expect(await journalExists(agent, runId)).toBe(false);
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe('旧内容');
    expect(await reviewChangeCount(runId)).toBe(0);
  });

  it('allows manual save and clears the journal when the file is still the baseline', async () => {
    const agent = await newAgent();
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', '旧内容');
    const conversationId = await newConversation(agent.id);
    const messageId = await seedMessage(conversationId, 'user', '记住这个约定');
    const created = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '# 约定\n', { messageId, quote: '记住这个约定' });
    await writeMemoryJournal(root, agent.slug, {
      operation: 'review',
      operationId: runId,
      businessId: ADMIN_BUSINESS_ID,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      files: [
        {
          name: 'MEMORY.md',
          beforeSha256: memorySha256('旧内容'),
          afterSha256: memorySha256('# 约定\n'),
          beforeBase64: Buffer.from('旧内容', 'utf8').toString('base64'),
        },
      ],
    });

    const saved = await request(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/memory/MEMORY.md`,
      headers: auth(),
      payload: { content: '# 手工\n' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe('# 手工\n');
    expect(await journalExists(agent, runId)).toBe(false);
    // 审核仍是 pending；文件已被手工改动，之后采纳按基线不匹配拒绝。
    expect((await getReview(runId)).json()).toMatchObject({ decision: 'pending' });
    expectProblem(await applyReview(runId), 'CONFLICT_STALE');
  });

  it('keeps blocking and keeps the journal when the file matches neither side of it', async () => {
    const agent = await newAgent();
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', '旧内容');
    const conversationId = await newConversation(agent.id);
    const messageId = await seedMessage(conversationId, 'user', '记住这个约定');
    const created = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '# 约定\n', { messageId, quote: '记住这个约定' });
    await writeMemoryJournal(root, agent.slug, {
      operation: 'review',
      operationId: runId,
      businessId: ADMIN_BUSINESS_ID,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      files: [
        {
          name: 'MEMORY.md',
          beforeSha256: memorySha256('旧内容'),
          afterSha256: memorySha256('# 约定\n'),
          beforeBase64: Buffer.from('旧内容', 'utf8').toString('base64'),
        },
      ],
    });
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', '第三方内容');

    const rejected = await rejectReview(runId);
    expectProblem(rejected, 'CONFLICT');
    expect(rejected.json<{ message: string }>().message).toBe(
      '目标写入未完成，请先重试采用或重新生成',
    );
    expect(await journalExists(agent, runId)).toBe(true);

    const saved = await request(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/memory/MEMORY.md`,
      headers: auth(),
      payload: { content: '# 手工\n' },
    });
    expectProblem(saved, 'CONFLICT');
    expect(await journalExists(agent, runId)).toBe(true);
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe('第三方内容');
  });

  it('blocks manual save, delete, and rollback while a landed review write is pending', async () => {
    const agent = await newAgent();
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', '旧内容');
    const conversationId = await newConversation(agent.id);
    const messageId = await seedMessage(conversationId, 'user', '记住这个约定');
    const created = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '# 约定\n', { messageId, quote: '记住这个约定' });

    // 日志已写、文件已替换但账本未提交（模拟进程在提交前退出）：内容可能已生效。
    await writeMemoryJournal(root, agent.slug, {
      operation: 'review',
      operationId: runId,
      businessId: ADMIN_BUSINESS_ID,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      files: [
        {
          name: 'MEMORY.md',
          beforeSha256: memorySha256('旧内容'),
          afterSha256: memorySha256('# 约定\n'),
          beforeBase64: Buffer.from('旧内容', 'utf8').toString('base64'),
        },
      ],
    });
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', '# 约定\n');
    const pendingMessage = '存在未完成的记忆写入，请先重试原操作或重新生成';

    const put = () =>
      request(app, {
        method: 'PUT',
        url: `/api/agents/${agent.id}/memory/MEMORY.md`,
        headers: auth(),
        payload: { content: '# 约定\n' },
      });
    const saved = await put();
    expectProblem(saved, 'CONFLICT');
    expect(saved.json<{ message: string }>().message).toBe(pendingMessage);

    const removed = await request(app, {
      method: 'DELETE',
      url: `/api/agents/${agent.id}/memory/MEMORY.md`,
      headers: auth(),
    });
    expectProblem(removed, 'CONFLICT');

    // 同目标的回滚同样被未完成日志挡住。
    const change = await repo.memoryChanges.insert(app.db, {
      businessId: ADMIN_BUSINESS_ID,
      agentId: agent.id,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
      before: { content: null, globs: null, index: null },
      after: { content: '旧内容', globs: null, index: null },
    });
    expectProblem(await rollbackChange(change.id), 'CONFLICT');

    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe('# 约定\n');
    expect(await journalExists(agent, runId)).toBe(true);

    // 之后重试原审核按日志分支继续，只补记账本并清日志。
    const retried = await applyReview(runId);
    expect(retried.statusCode, retried.body).toBe(200);
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe('# 约定\n');
    expect(await journalExists(agent, runId)).toBe(false);
    expect(await reviewChangeCount(runId)).toBe(1);
    expect((await getReview(runId)).json()).toMatchObject({ decision: 'applied' });
  });

  it('does not infer a rule write from stored content equal to the proposal', async () => {
    const model = await newAgent();
    const target = await newAgent();
    await repo.rules.upsertRule(app.db, target.id, {
      slug: 'style',
      content: '旧规则',
      globs: '',
    });
    const conversationId = await newConversation(target.id);
    const messageId = await seedMessage(conversationId, 'user', '新规则');
    const created = await postReview(
      reviewBody({
        modelAgentId: model.id,
        target: { kind: 'agent_rule', agentId: target.id, slug: 'style' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '新规则正文', { messageId, quote: '新规则' });

    // 规则没有文件窗口；绕过账本直接把正文改成提案内容也不会留下写入日志。
    await repo.rules.upsertRule(app.db, target.id, {
      slug: 'style',
      content: '新规则正文',
      globs: '',
    });
    expectProblem(await applyReview(runId), 'CONFLICT_STALE');
    expect(await reviewChangeCount(runId)).toBe(0);
    const rule = await app.client.unsafe<{ content: string }[]>(
      'select content from agent_rules where agent_id = $1 and slug = $2',
      [target.id, 'style'],
    );
    expect(rule[0]?.content).toBe('新规则正文');
  });

  it('holds the target lock across the file projection so reads stay free and admission waits', async () => {
    const { agent, runId } = await reviewForMemory('记住这个约定');

    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    fsFaults.gate = { entered, release: releasePromise };
    // 第 1 次 rename 写日志，暂停在第 2 次 MEMORY.md 投影上。
    fsFaults.gateAt = 2;

    let applied: Awaited<ReturnType<typeof applyReview>> | undefined;
    let admitted: Awaited<ReturnType<typeof repo.chat.admitChatRun>> | undefined;
    try {
      const applyPromise = applyReview(runId);
      await enteredPromise;

      // 版本列表只读，不取目标锁，不会被正在进行的 apply 挡住。
      expect(
        await Promise.race([
          request(app, {
            method: 'GET',
            url: `/api/agents/${agent.id}/memory/MEMORY.md/versions`,
            headers: auth(),
          }).then((response) => response.statusCode),
          sleep(500).then(() => 'waiting' as const),
        ]),
      ).toBe(200);

      const admission = repo.chat.admitChatRun(app.db, {
        agentId: agent.id,
        message: 'lock probe',
        subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
      });
      expect(
        await Promise.race([admission.then(() => 'done'), sleep(150).then(() => 'waiting')]),
      ).toBe('waiting');

      release();
      applied = await applyPromise;
      admitted = await admission;
    } finally {
      release();
      fsFaults.gate = null;
    }

    expect(applied?.statusCode, applied?.body).toBe(200);
    expect(admitted?.run.status).toBe('queued');
  });

  it('serializes apply and reject so only one decision wins', async () => {
    const { agent, runId } = await reviewForMemory('记住这个约定');

    const [applied, rejected] = await Promise.all([
      applyReview(runId),
      request(app, {
        method: 'PATCH',
        url: `/api/memory-reviews/${runId}`,
        headers: auth(),
        payload: { decision: 'rejected' },
      }),
    ]);
    expect([applied.statusCode, rejected.statusCode].sort((a, b) => a - b)).toEqual([200, 409]);

    const review = (await getReview(runId)).json<{ decision: string }>();
    if (applied.statusCode === 200) {
      expect(review.decision).toBe('applied');
      expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe('# 约定\n');
    } else {
      expect(review.decision).toBe('rejected');
      expect(await readMemoryFile(root, agent.slug, 'MEMORY.md')).toBeNull();
    }
  });

  async function themeReview(
    name: string,
    proposal: string | null,
    message = '记住这个约定',
  ): Promise<{ agent: AgentRef; model: AgentRef; runId: string; messageId: string }> {
    const model = await newAgent();
    const agent = await newAgent();
    const conversationId = await newConversation(agent.id);
    const messageId = await seedMessage(conversationId, 'user', message);
    const created = await postReview(
      reviewBody({
        modelAgentId: model.id,
        target: { kind: 'agent_memory', agentId: agent.id, name },
        sources: [{ conversationId }],
      }),
    );
    expect(created.statusCode, created.body).toBe(202);
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, proposal, { messageId, quote: message });
    return { agent, model, runId, messageId };
  }

  /** 先落好目标文件再创建审核：before 快照固定在这些真实文件上。 */
  async function themeReviewWithFiles(
    name: string,
    files: Record<string, string>,
    proposal: string,
  ): Promise<{ agent: AgentRef; model: AgentRef; runId: string; messageId: string }> {
    const model = await newAgent();
    const agent = await newAgent();
    for (const [file, content] of Object.entries(files)) {
      await writeMemoryFile(root, agent.slug, file, content);
    }
    const conversationId = await newConversation(agent.id);
    const message = '记住这个约定';
    const messageId = await seedMessage(conversationId, 'user', message);
    const created = await postReview(
      reviewBody({
        modelAgentId: model.id,
        target: { kind: 'agent_memory', agentId: agent.id, name },
        sources: [{ conversationId }],
      }),
    );
    expect(created.statusCode, created.body).toBe(202);
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, proposal, { messageId, quote: message });
    return { agent, model, runId, messageId };
  }

  it('applies a new theme and its index link as one change', async () => {
    const { agent, runId } = await themeReview('deploy.md', '# 部署\n使用蓝绿发布。');
    const applied = await applyReview(runId);
    expect(applied.statusCode, applied.body).toBe(200);
    const change = applied.json<{
      id: string;
      target: unknown;
      before: unknown;
      after: unknown;
    }>();
    expect(change.target).toEqual({
      kind: 'agent_memory',
      agentId: agent.id,
      name: 'deploy.md',
    });
    expect(change.before).toEqual({
      content: null,
      globs: null,
      index: { content: null },
    });
    expect(change.after).toEqual({
      content: '# 部署\n使用蓝绿发布。',
      globs: null,
      index: { content: '- [deploy.md](deploy.md)\n' },
    });
    expect((await readMemoryFile(root, agent.slug, 'deploy.md'))?.content).toBe(
      '# 部署\n使用蓝绿发布。',
    );
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe(
      '- [deploy.md](deploy.md)\n',
    );
    expect(await reviewChangeCount(runId)).toBe(1);

    const themeVersions = await request(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/memory/deploy.md/versions`,
      headers: auth(),
    });
    expect(themeVersions.json()).toMatchObject({ items: [{ id: change.id }] });
    // 改变伴随索引的主题变更也出现在 MEMORY.md 历史里。
    const indexVersions = await request(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/memory/MEMORY.md/versions`,
      headers: auth(),
    });
    expect(indexVersions.json()).toMatchObject({ items: [{ id: change.id }] });
  });

  it('updates an existing theme without rewriting its linked index', async () => {
    const index = '# 主题\n\n- [deploy.md](deploy.md)\n';
    const { agent, runId } = await themeReviewWithFiles(
      'deploy.md',
      { 'MEMORY.md': index, 'deploy.md': 'old body' },
      'new body',
    );
    const applied = await applyReview(runId);
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toMatchObject({
      before: { content: 'old body', index: { content: index } },
      after: { content: 'new body', index: { content: index } },
    });
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe(index);
    expect((await readMemoryFile(root, agent.slug, 'deploy.md'))?.content).toBe('new body');
  });

  it('rejects an apply when the snapshot already has the proposed content and link', async () => {
    const index = '- [ops.md](ops.md)\n';
    const { agent, runId } = await themeReviewWithFiles(
      'ops.md',
      { 'MEMORY.md': index, 'ops.md': 'ops body' },
      'ops body',
    );
    expectProblem(await applyReview(runId), 'CONFLICT');
    expect(await reviewChangeCount(runId)).toBe(0);
    expect((await getReview(runId)).json()).toMatchObject({
      decision: 'pending',
      appliedChangeId: null,
    });
    expect((await readMemoryFile(root, agent.slug, 'ops.md'))?.content).toBe('ops body');
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe(index);
  });

  it('restores both files when the index write or the ledger commit fails', async () => {
    const { agent, runId } = await themeReview('deploy.md', 'body');

    // 第 1 次 rename 写日志，第 2 次主题，第 3 次 MEMORY.md。
    fsFaults.failRenameAt = 3;
    const failed = await applyReview(runId);
    fsFaults.failRenameAt = 0;
    expect(failed.statusCode, failed.body).toBe(500);
    expect(await readMemoryFile(root, agent.slug, 'deploy.md')).toBeNull();
    expect(await readMemoryFile(root, agent.slug, 'MEMORY.md')).toBeNull();
    expect(await journalExists(agent, runId)).toBe(false);
    expect((await getReview(runId)).json()).toMatchObject({ decision: 'pending' });
    expect(await reviewChangeCount(runId)).toBe(0);

    const spy = spyOn(app.db, 'transaction').mockRejectedValueOnce(
      new Error('injected database commit failure') as never,
    );
    let commitFailed: Awaited<ReturnType<typeof applyReview>>;
    try {
      commitFailed = await applyReview(runId);
    } finally {
      spy.mockRestore();
    }
    expect(commitFailed.statusCode, commitFailed.body).toBe(500);
    expect(await readMemoryFile(root, agent.slug, 'deploy.md')).toBeNull();
    expect(await readMemoryFile(root, agent.slug, 'MEMORY.md')).toBeNull();
    expect(await journalExists(agent, runId)).toBe(false);

    const retried = await applyReview(runId);
    expect(retried.statusCode, retried.body).toBe(200);
    expect((await readMemoryFile(root, agent.slug, 'deploy.md'))?.content).toBe('body');
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe(
      '- [deploy.md](deploy.md)\n',
    );
  });

  it('restores a mixed journal and completes an all-after journal exactly once', async () => {
    const { agent, runId } = await themeReview('deploy.md', 'body');
    const indexBefore = '# 索引\n';
    const indexAfter = '# 索引\n- [deploy.md](deploy.md)\n';
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', indexBefore);

    // 创建审核时索引尚不存在；这里把基线改成手动写入的索引后再模拟半落盘。
    await app.client.unsafe('update memory_reviews set before = $2::jsonb where run_id = $1', [
      runId,
      JSON.stringify({ content: null, globs: null, index: { content: indexBefore } }),
    ]);
    await writeMemoryJournal(root, agent.slug, {
      operation: 'review',
      operationId: runId,
      businessId: ADMIN_BUSINESS_ID,
      target: { kind: 'agent_memory', agentId: agent.id, name: 'deploy.md' },
      files: [
        {
          name: 'deploy.md',
          beforeSha256: memorySha256(null),
          afterSha256: memorySha256('body'),
          beforeBase64: null,
        },
        {
          name: 'MEMORY.md',
          beforeSha256: memorySha256(indexBefore),
          afterSha256: memorySha256(indexAfter),
          beforeBase64: Buffer.from(indexBefore, 'utf8').toString('base64'),
        },
      ],
    });
    // 只写了索引，主题仍是基线：混合状态必须先恢复原字节再重写。
    await writeMemoryFile(root, agent.slug, 'MEMORY.md', indexAfter);
    const applied = await applyReview(runId);
    expect(applied.statusCode, applied.body).toBe(200);
    expect((await readMemoryFile(root, agent.slug, 'deploy.md'))?.content).toBe('body');
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe(indexAfter);
    expect(await reviewChangeCount(runId)).toBe(1);
    expect(await journalExists(agent, runId)).toBe(false);

    // 全部文件已落到 after、只差账本：重试只补记一次。
    const second = await themeReview('ops.md', 'ops');
    const opsIndexBefore = indexAfter;
    const opsIndexAfter = `${indexAfter}- [ops.md](ops.md)\n`;
    await writeMemoryJournal(root, second.agent.slug, {
      operation: 'review',
      operationId: second.runId,
      businessId: ADMIN_BUSINESS_ID,
      target: { kind: 'agent_memory', agentId: second.agent.id, name: 'ops.md' },
      files: [
        {
          name: 'ops.md',
          beforeSha256: memorySha256(null),
          afterSha256: memorySha256('ops'),
          beforeBase64: null,
        },
        {
          name: 'MEMORY.md',
          beforeSha256: memorySha256(opsIndexBefore),
          afterSha256: memorySha256(opsIndexAfter),
          beforeBase64: Buffer.from(opsIndexBefore, 'utf8').toString('base64'),
        },
      ],
    });
    await writeMemoryFile(root, second.agent.slug, 'MEMORY.md', opsIndexAfter);
    await writeMemoryFile(root, second.agent.slug, 'ops.md', 'ops');
    await app.client.unsafe('update memory_reviews set before = $2::jsonb where run_id = $1', [
      second.runId,
      JSON.stringify({
        content: null,
        globs: null,
        index: { content: opsIndexBefore },
      }),
    ]);
    const recovered = await applyReview(second.runId);
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(await reviewChangeCount(second.runId)).toBe(1);
    expect(await journalExists(second.agent, second.runId)).toBe(false);
    const repeated = await applyReview(second.runId);
    expect(repeated.json<{ id: string }>().id).toBe(recovered.json<{ id: string }>().id);
    expect(await reviewChangeCount(second.runId)).toBe(1);
  });

  it('does not overwrite an external theme edit made after the review', async () => {
    const { agent, runId } = await themeReview('deploy.md', 'body');
    await writeMemoryFile(root, agent.slug, 'deploy.md', 'external');
    expectProblem(await applyReview(runId), 'CONFLICT_STALE');
    expect((await readMemoryFile(root, agent.slug, 'deploy.md'))?.content).toBe('external');
    expect(await readMemoryFile(root, agent.slug, 'MEMORY.md')).toBeNull();
    expect(await reviewChangeCount(runId)).toBe(0);
    expect((await getReview(runId)).json()).toMatchObject({ decision: 'pending' });
  });

  it('re-validates persisted proposal evidence before applying', async () => {
    const { agent, runId, messageId } = await themeReview('deploy.md', 'body');
    await app.client.unsafe('update memory_reviews set proposal = $2::jsonb where run_id = $1', [
      runId,
      JSON.stringify({
        summary: '只有助手建议',
        proposedContent: 'body',
        evidence: [{ messageId, quote: '记住这个约定', kind: 'assistant_suggestion' }],
      }),
    ]);
    expectProblem(await applyReview(runId), 'INVALID_INPUT');
    expect(await readMemoryFile(root, agent.slug, 'deploy.md')).toBeNull();
    expect(await reviewChangeCount(runId)).toBe(0);

    await app.client.unsafe('update memory_reviews set proposal = $2::jsonb where run_id = $1', [
      runId,
      JSON.stringify({
        summary: '引用不连续',
        proposedContent: 'body',
        evidence: [{ messageId, quote: '不存在的原话', kind: 'user_fact' }],
      }),
    ]);
    expectProblem(await applyReview(runId), 'INVALID_INPUT');
    expect(await reviewChangeCount(runId)).toBe(0);
  });

  it('includes the target name in the idempotency hash and counts the index in the snapshot limit', async () => {
    const model = await newAgent();
    const target = await newAgent();
    const conversationId = await newConversation(target.id);
    await seedMessage(conversationId, 'user', '记住约定');
    const key = randomUUID();
    const first = await postReview(
      reviewBody({
        modelAgentId: model.id,
        target: { kind: 'agent_memory', agentId: target.id, name: 'deploy.md' },
        sources: [{ conversationId }],
      }),
      key,
    );
    expect(first.statusCode, first.body).toBe(202);
    const renamed = await postReview(
      reviewBody({
        modelAgentId: model.id,
        target: { kind: 'agent_memory', agentId: target.id, name: 'ops.md' },
        sources: [{ conversationId }],
      }),
      key,
    );
    expectProblem(renamed, 'CONFLICT');

    const big = await newAgent();
    const bigConversation = await newConversation(big.id);
    await seedMessage(bigConversation, 'user', 'x'.repeat(MEMORY_REVIEW_MAX_BYTES - 16 * 1024));
    await writeMemoryFile(root, big.slug, 'MEMORY.md', 'y'.repeat(32 * 1024));
    const oversized = await postReview(
      reviewBody({
        modelAgentId: big.id,
        target: { kind: 'agent_memory', agentId: big.id, name: 'deploy.md' },
        sources: [{ conversationId: bigConversation }],
      }),
    );
    expectProblem(oversized, 'PAYLOAD_TOO_LARGE');
  });

  it('does not let a committed manual journal block review apply', async () => {
    const agent = await newAgent();
    const saved = await saveMemory(agent, '# 手工\n');
    expect(saved.statusCode, saved.body).toBe(200);
    const changeId = await manualChangeId(agent);
    await writeCommittedManualJournal(agent, changeId, '# 手工\n');

    const conversationId = await newConversation(agent.id);
    const messageId = await seedMessage(conversationId, 'user', '记住这个约定');
    const created = await postReview(
      reviewBody({
        modelAgentId: agent.id,
        target: { kind: 'agent_memory', agentId: agent.id, name: 'MEMORY.md' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '# 约定\n', { messageId, quote: '记住这个约定' });

    const applied = await applyReview(runId);
    expect(applied.statusCode, applied.body).toBe(200);
    expect(await journalExists(agent, changeId)).toBe(false);
    expect((await readMemoryFile(root, agent.slug, 'MEMORY.md'))?.content).toBe('# 约定\n');
    expect(await reviewChangeCount(runId)).toBe(1);
  });

  it('does not let a committed manual journal block review reject or rollback', async () => {
    const rejectAgent = await newAgent();
    const rejectSaved = await saveMemory(rejectAgent, '# 手工\n');
    expect(rejectSaved.statusCode, rejectSaved.body).toBe(200);
    const rejectChangeId = await manualChangeId(rejectAgent);
    await writeCommittedManualJournal(rejectAgent, rejectChangeId, '# 手工\n');

    const conversationId = await newConversation(rejectAgent.id);
    const messageId = await seedMessage(conversationId, 'user', '记住这个约定');
    const created = await postReview(
      reviewBody({
        modelAgentId: rejectAgent.id,
        target: { kind: 'agent_memory', agentId: rejectAgent.id, name: 'MEMORY.md' },
        sources: [{ conversationId }],
      }),
    );
    const runId = created.json<{ runId: string }>().runId;
    await completeReview(runId, '# 约定\n', { messageId, quote: '记住这个约定' });

    const rejected = await rejectReview(runId);
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await journalExists(rejectAgent, rejectChangeId)).toBe(false);
    expect((await readMemoryFile(root, rejectAgent.slug, 'MEMORY.md'))?.content).toBe('# 手工\n');

    const rollbackAgent = await newAgent();
    const rollbackSaved = await saveMemory(rollbackAgent, '# 手工\n');
    expect(rollbackSaved.statusCode, rollbackSaved.body).toBe(200);
    const rollbackChangeId = await manualChangeId(rollbackAgent);
    await writeCommittedManualJournal(rollbackAgent, rollbackChangeId, '# 手工\n');

    const reversed = await rollbackChange(rollbackChangeId);
    expect(reversed.statusCode, reversed.body).toBe(200);
    expect(await journalExists(rollbackAgent, rollbackChangeId)).toBe(false);
    expect(await readMemoryFile(root, rollbackAgent.slug, 'MEMORY.md')).toBeNull();
  });
});
