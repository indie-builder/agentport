import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@agentport/db';
import type { AgentMemoryAssembly, AgentMemoryOverview } from '@agentport/shared';
import { createAccount, createRole, grants } from './access-helpers.js';
import {
  acquireMemoryLock,
  cleanup,
  createAgent,
  createTestAccount,
  expectProblem,
  infraReady,
  loginAs,
  loginCookie,
  request,
  setAgentMember,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

const TOPIC_NAMES = ['topic-a.md', 'topic-b.md', 'topic-c.md', 'topic-d.md'];
const PERSONAL_CONTENT = '管理员偏好中文。';

describe.skipIf(!ready)('agent memory overview', () => {
  let app: TestApp;
  let cookie: string;
  let root: string;
  let overviewId: string;
  let overviewSlug: string;
  let policyId: string;
  let policySlug: string;
  let limitId: string;
  let limitSlug: string;
  let recentId: string;
  let recentSlug: string;
  let releaseLock: (() => Promise<void>) | undefined;
  const agentSlugs: string[] = [];

  const memoryDir = (slug: string) => join(root, slug, 'agent-memory');

  /** 直接落文件模拟 SDK 原生写入：不经过平台账本，用于派生 unlinked/stale/unaccounted。 */
  const writeFile = async (slug: string, name: string, content: string): Promise<void> => {
    const dir = memoryDir(slug);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(join(dir, name), content);
  };

  const getOverview = async (agentId: string) =>
    request(app, {
      url: `/api/agents/${agentId}/memory/overview`,
      headers: { cookie },
    });

  const getAssembly = async (agentId: string) =>
    request(app, {
      url: `/api/agents/${agentId}/memory/assembly`,
      headers: { cookie },
    });

  const putPolicy = async (agentId: string, policy: Record<string, unknown>) =>
    request(app, {
      method: 'PUT',
      url: `/api/agents/${agentId}/memory/policy`,
      headers: { cookie },
      payload: { policy },
    });

  /** 主题 PUT 会按确定规则给索引补链接，断言以真实索引字节为准。 */
  const indexBytesFor = async (agentId: string): Promise<number> => {
    const file = await request(app, {
      url: `/api/agents/${agentId}/memory/MEMORY.md`,
      headers: { cookie },
    });
    expect(file.statusCode, file.body).toBe(200);
    return Buffer.byteLength(file.json<{ content: string }>().content);
  };

  beforeAll(async () => {
    root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'memory-overview-'));
    app = await startApp({ WORKSPACES_DIR: root });
    // 本文件写入的记忆账本与个人记忆都以管理员身份为键，与 memory-changes / memory-reviews 共用同一份数据；
    // 那两个文件会在 beforeEach/afterAll 里按 businessId 清空，必须同一把锁串起来，否则中途被清空。
    releaseLock = await acquireMemoryLock(app.client);
    cookie = await loginCookie(app);
    overviewSlug = unique('memory-overview');
    overviewId = (await createAgent(app, cookie, { slug: overviewSlug, track: agentSlugs })).json<{
      id: string;
    }>().id;
    policySlug = unique('memory-policy');
    policyId = (await createAgent(app, cookie, { slug: policySlug, track: agentSlugs })).json<{
      id: string;
    }>().id;
    limitSlug = unique('memory-limit');
    limitId = (await createAgent(app, cookie, { slug: limitSlug, track: agentSlugs })).json<{
      id: string;
    }>().id;
    recentSlug = unique('memory-recent');
    recentId = (await createAgent(app, cookie, { slug: recentSlug, track: agentSlugs })).json<{
      id: string;
    }>().id;

    // overview 专家：索引只链接 topic-a，其余主题未链接；topic-d 超过 60 天未更新。
    await writeFile(overviewSlug, 'MEMORY.md', '- [topic-a.md](topic-a.md)\n');
    for (const name of TOPIC_NAMES) {
      await writeFile(overviewSlug, name, `# ${name}\n`);
    }
    const stale = new Date(Date.now() - 61 * 86_400_000);
    await fs.utimes(join(memoryDir(overviewSlug), 'topic-d.md'), stale, stale);

    // limit 专家：3 个主题 + 规则，用于验证上限与装配。
    for (const name of TOPIC_NAMES.slice(0, 3)) {
      await writeFile(limitSlug, name, `# ${name}\n`);
    }
    const rule = await request(app, {
      method: 'PUT',
      url: `/api/agents/${limitId}/rules/style`,
      headers: { cookie },
      payload: { content: '# 规则\n保持简洁。\n', globs: 'src/**' },
    });
    expect(rule.statusCode, rule.body).toBe(200);
    // policy 专家通过公开 PUT 建立索引与主题，走平台账本路径。
    const index = await request(app, {
      method: 'PUT',
      url: `/api/agents/${policyId}/memory/MEMORY.md`,
      headers: { cookie },
      payload: { content: '# 记忆索引\n' },
    });
    expect(index.statusCode, index.body).toBe(200);
    const topic = await request(app, {
      method: 'PUT',
      url: `/api/agents/${policyId}/memory/notes.md`,
      headers: { cookie },
      payload: { content: '# 笔记\n用户偏好中文回答。\n' },
    });
    expect(topic.statusCode, topic.body).toBe(200);
    const policyRule = await request(app, {
      method: 'PUT',
      url: `/api/agents/${policyId}/rules/style`,
      headers: { cookie },
      payload: { content: '# 规则\n用中文回复。\n', globs: '' },
    });
    expect(policyRule.statusCode, policyRule.body).toBe(200);

    // recent 专家：6 次平台写入，用于验证最近变更只回摘要、真实总数不被 LIMIT 截断。
    for (let index = 1; index <= 6; index += 1) {
      const firstLine = index === 6 ? 'R'.repeat(150) : `# 主题 ${index}`;
      const recent = await request(app, {
        method: 'PUT',
        url: `/api/agents/${recentId}/memory/recent-${index}.md`,
        headers: { cookie },
        payload: { content: `${firstLine}\n第 ${index} 条变更正文不应回传\n` },
      });
      expect(recent.statusCode, recent.body).toBe(200);
    }
    // 等锁可能要排在另外两个记忆文件的整套用例之后。
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanup(app, { agentSlugs });
      await fs.rm(root, { recursive: true, force: true });
    } finally {
      await releaseLock?.();
      await app.close();
    }
  });

  it('rejects callers without agents.memory.read', async () => {
    const account = await createTestAccount(app, cookie);
    const response = await request(app, {
      url: `/api/agents/${overviewId}/memory/overview`,
      headers: { cookie: account.cookie },
    });
    expectProblem(response, 'FORBIDDEN');
  });

  it('returns 404 for agents outside the caller scope', async () => {
    // 有读取/写入权限但不是该专家的成员：范围不符按对象不存在处理，不泄露存在性。
    const outsider = await createTestAccount(app, cookie, { systemKeys: ['maintainer'] });
    expectProblem(
      await request(app, {
        url: `/api/agents/${overviewId}/memory/overview`,
        headers: { cookie: outsider.cookie },
      }),
      'NOT_FOUND',
    );
    expectProblem(
      await request(app, {
        method: 'PUT',
        url: `/api/agents/${overviewId}/memory/policy`,
        headers: { cookie: outsider.cookie },
        payload: { policy: { topicLimit: 20 } },
      }),
      'NOT_FOUND',
    );
  });

  it('rejects policy updates when the caller can read but not write memory', async () => {
    const role = await createRole(
      app,
      cookie,
      unique('memory-reader'),
      grants(['agents.read', 'maintained_agents'], ['agents.memory.read', 'maintained_agents']),
    );
    const readerPassword = 'test-password-123';
    const created = await createAccount(app, cookie, {
      roleIds: [role.id],
      password: readerPassword,
    });
    await setAgentMember(app, cookie, policyId, created.account.businessId, {
      canUse: false,
      canMaintain: true,
    });
    const readerCookie = await loginAs(app, created.account.username, readerPassword);
    expect(
      (
        await request(app, {
          url: `/api/agents/${policyId}/memory/overview`,
          headers: { cookie: readerCookie },
        })
      ).statusCode,
    ).toBe(200);
    expectProblem(
      await request(app, {
        method: 'PUT',
        url: `/api/agents/${policyId}/memory/policy`,
        headers: { cookie: readerCookie },
        payload: { policy: { topicLimit: 20 } },
      }),
      'FORBIDDEN',
    );
  });

  it('derives overview stats and health from the memory directory', async () => {
    const response = await getOverview(overviewId);
    expect(response.statusCode, response.body).toBe(200);
    const overview = response.json<AgentMemoryOverview>();
    expect(overview.policy).toEqual({
      enabled: true,
      writeMode: 'native_auto',
      injectPersonalMemory: true,
      injectRules: true,
      topicLimit: 20,
    });
    expect(overview.index).toEqual({
      present: true,
      lines: 1,
      bytes: Buffer.byteLength('- [topic-a.md](topic-a.md)\n'),
      maxLines: 200,
      maxBytes: 25600,
    });
    expect(overview.topics.count).toBe(4);
    expect(overview.topics.unlinked).toEqual(['topic-b.md', 'topic-c.md', 'topic-d.md']);
    expect(overview.topics.stale).toEqual(['topic-d.md']);
    expect(overview.rules).toEqual({ count: 0, bytes: 0 });
    expect(overview.personal).toEqual({ chars: 0, maxChars: 9000 });
    // 五个文件都是直接落盘，账本里没有记录。
    expect(overview.unaccounted.count).toBe(5);
    expect(overview.unaccounted.names).toContain('MEMORY.md');
    expect(overview.recentChanges).toEqual([]);
    expect(overview.changesTotal).toBe(0);
    expect(overview.health.map((entry) => [entry.code, entry.level])).toEqual([
      ['topics_unlinked', 'danger'],
      ['topics_stale', 'warn'],
      ['unaccounted_changes', 'warn'],
    ]);
    expect(overview.health[0]?.detail).toContain('topic-b.md、topic-c.md、topic-d.md');
  });

  it('projects recent changes as summaries and keeps the real total', async () => {
    const response = await getOverview(recentId);
    expect(response.statusCode, response.body).toBe(200);
    const overview = response.json<AgentMemoryOverview>();
    expect(overview.changesTotal).toBe(6);
    expect(overview.recentChanges).toHaveLength(5);
    const latest = overview.recentChanges[0];
    // 摘要只取变更后正文的首个非空行，并截断到 120 个字符。
    expect(latest).toEqual({
      name: 'recent-6.md',
      createdAt: expect.any(String),
      summary: 'R'.repeat(120),
    });
    expect(Object.keys(latest ?? {}).sort()).toEqual(['createdAt', 'name', 'summary']);
    // 标题行的 Markdown 符号不进摘要：其余 4 条都以 `# 主题 N` 开头。
    expect(overview.recentChanges.map((change) => change.summary)).toEqual([
      'R'.repeat(120),
      '主题 5',
      '主题 4',
      '主题 3',
      '主题 2',
    ]);
    expect(overview.recentChanges.every((change) => !change.summary.startsWith('#'))).toBe(true);
    // 正文第二行与 before/after 全文都不出现在投影里。
    expect(response.body).not.toContain('第 6 条变更正文不应回传');
    expect(response.body).not.toContain('"before"');
    expect(overview.unaccounted.count).toBe(0);
  });

  it('strips multi-level markdown headings from the change summary', async () => {
    const created = await createAgent(app, cookie, {
      slug: unique('memory-heading'),
      track: agentSlugs,
    });
    const agentId = created.json<{ id: string }>().id;
    const write = await request(app, {
      method: 'PUT',
      url: `/api/agents/${agentId}/memory/heading.md`,
      headers: { cookie },
      payload: { content: '\n## 禁用表达\n\n正文保留在文件里。\n' },
    });
    expect(write.statusCode, write.body).toBe(200);

    const overview = (await getOverview(agentId)).json<AgentMemoryOverview>();
    const summary = overview.recentChanges[0]?.summary ?? '';
    // 只影响展示：摘要去掉标题符号，文件正文原样保留。
    expect(summary).toBe('禁用表达');
    expect(summary).not.toContain('#');
    const file = await request(app, {
      url: `/api/agents/${agentId}/memory/heading.md`,
      headers: { cookie },
    });
    expect(file.json<{ content: string }>().content).toBe('\n## 禁用表达\n\n正文保留在文件里。\n');
  });

  it('keeps a file accounted when its ledger entry is older than the newest 200 rows', async () => {
    const created = await createAgent(app, cookie, {
      slug: unique('memory-deep-ledger'),
      track: agentSlugs,
    });
    const agentId = created.json<{ id: string }>().id;
    const write = await request(app, {
      method: 'PUT',
      url: `/api/agents/${agentId}/memory/old.md`,
      headers: { cookie },
      payload: { content: '# 旧主题\n' },
    });
    expect(write.statusCode, write.body).toBe(200);

    // 该文件最近一次记账会落到 201 条更新记录之外；按最近 200 条归并会误判为未记账。
    const [agent] = await app.client.unsafe<{ owner_business_id: string }[]>(
      'select owner_business_id from agents where id = $1',
      [agentId],
    );
    if (!agent) throw new Error('agent row disappeared');
    const noise = Array.from({ length: 201 }, (_, index) => ({
      id: newId('memoryChange'),
      name: `noise-${index}.md`,
    }));
    await app.client.unsafe(
      `insert into memory_changes (id, business_id, agent_id, target, before, after)
       select item.id, $1, $2,
         jsonb_build_object('kind', 'agent_memory', 'agentId', $2::text, 'name', item.name),
         '{"content":null,"globs":null,"index":null}'::jsonb,
         '{"content":null,"globs":null,"index":null}'::jsonb
       from jsonb_to_recordset($3::jsonb) as item(id text, name text)`,
      [agent.owner_business_id, agentId, JSON.stringify(noise)],
    );

    const overview = (await getOverview(agentId)).json<AgentMemoryOverview>();
    expect(overview.unaccounted.names).not.toContain('old.md');
    expect(overview.unaccounted.count).toBe(0);
    expect(overview.changesTotal).toBe(202);
  });

  it('assembles personal, index, rules and topics in a fixed order', async () => {
    const personal = await request(app, {
      method: 'PUT',
      url: '/api/me/memory',
      headers: { cookie },
      payload: { content: PERSONAL_CONTENT, expectedRevision: 0 },
    });
    expect(personal.statusCode, personal.body).toBe(200);
    const response = await getAssembly(policyId);
    expect(response.statusCode, response.body).toBe(200);
    const assembly = response.json<AgentMemoryAssembly>();
    expect(assembly.blocks.map((block) => [block.kind, block.name, block.trigger])).toEqual([
      ['personal', 'CLAUDE.md', 'every-run'],
      ['index', 'MEMORY.md', 'every-run'],
      ['rule', 'style', 'every-run'],
      ['topic', 'notes.md', 'on-demand'],
    ]);
    expect(assembly.blocks[0]?.reason).toBeNull();
    expect(assembly.blocks[0]?.chars).toBe([...PERSONAL_CONTENT].length);
    expect(assembly.blocks[2]?.path).toBe('/workspace/.claude/rules/style.md');
    expect(assembly.blocks[2]?.globs).toBe('');
    expect(assembly.blocks[3]?.path).toBe('/mnt/agent-memory/notes.md');
    expect(assembly.blocks[3]?.lines).toBeNull();
    const ruleBytes = Buffer.byteLength('# 规则\n用中文回复。\n');
    const topicBytes = Buffer.byteLength('# 笔记\n用户偏好中文回答。\n');
    expect(assembly.totals).toEqual({
      personalChars: [...PERSONAL_CONTENT].length,
      indexBytes: await indexBytesFor(policyId),
      rulesBytes: ruleBytes,
      topicBytes,
    });
    expect(assembly.notes).toEqual(['频道与服务主体由运行期固定不注入个人记忆。']);
  });

  it('persists the policy and rejects limits below the current topic count', async () => {
    const saved = await putPolicy(policyId, { writeMode: 'proposal_only', topicLimit: 3 });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toEqual({
      policy: {
        enabled: true,
        writeMode: 'proposal_only',
        injectPersonalMemory: true,
        injectRules: true,
        topicLimit: 3,
      },
    });
    // 策略写入留审计：只记目标与摘要，不落任何记忆正文。
    const [audit] = await app.client.unsafe<
      { action: string; target: string; input_digest: string | null }[]
    >(
      "select action, target, input_digest from audit_log where action = 'agent.memory.policy.updated' and target = $1 order by created_at desc limit 1",
      [policyId],
    );
    expect(audit).toMatchObject({ action: 'agent.memory.policy.updated', target: policyId });
    expect(audit?.input_digest).toBeTruthy();
    const overview = (await getOverview(policyId)).json<AgentMemoryOverview>();
    expect(overview.policy.writeMode).toBe('proposal_only');
    expect(overview.policy.topicLimit).toBe(3);

    const conflict = await putPolicy(overviewId, { topicLimit: 3 });
    expectProblem(conflict, 'CONFLICT');
    expect(conflict.json<{ message: string }>().message).toContain(
      '现有 4 个主题超过上限 3，请先合并或删除',
    );

    for (const body of [{ topicLimit: 2 }, { topicLimit: 20, unknown: true }]) {
      const invalid = await putPolicy(overviewId, body);
      expectProblem(invalid, 'INVALID_INPUT');
    }
  });

  it('skips injected blocks when the policy turns them off', async () => {
    const saved = await putPolicy(policyId, {
      injectPersonalMemory: false,
      injectRules: false,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const assembly = (await getAssembly(policyId)).json<AgentMemoryAssembly>();
    expect(assembly.blocks.map((block) => [block.kind, block.trigger, block.reason])).toEqual([
      ['personal', 'skipped', '策略未注入个人记忆'],
      ['index', 'every-run', null],
      ['rule', 'skipped', '该专家运行时不渲染项目规则'],
      ['topic', 'on-demand', null],
    ]);
    expect(assembly.totals).toEqual({
      personalChars: 0,
      indexBytes: await indexBytesFor(policyId),
      rulesBytes: 0,
      topicBytes: Buffer.byteLength('# 笔记\n用户偏好中文回答。\n'),
    });
  });

  it('stops loading expert memory when the policy is disabled', async () => {
    const saved = await putPolicy(policyId, { enabled: false });
    expect(saved.statusCode, saved.body).toBe(200);
    const overview = (await getOverview(policyId)).json<AgentMemoryOverview>();
    expect(overview.health).toEqual([
      {
        code: 'policy_disabled',
        level: 'ok',
        title: '专家记忆已停用',
        detail: '该专家主会话运行时不挂载、不加载主会话记忆；子智能体记忆不受此开关约束。',
      },
    ]);
    const assembly = (await getAssembly(policyId)).json<AgentMemoryAssembly>();
    // 个人记忆由 injectPersonalMemory 独立控制：专家记忆停用后仍按 every-run 投影。
    // 项目规则只由 injectRules 决定：运行期不读 enabled，停用记忆后规则仍照常渲染。
    expect(assembly.blocks.map((block) => [block.trigger, block.reason])).toEqual([
      ['every-run', null],
      ['skipped', '专家记忆已停用'],
      ['every-run', null],
      ['skipped', '专家记忆已停用'],
    ]);
    const rulesBytes = Buffer.byteLength('# 规则\n用中文回复。\n');
    expect(rulesBytes).toBeGreaterThan(0);
    expect(assembly.totals).toEqual({
      personalChars: [...PERSONAL_CONTENT].length,
      indexBytes: 0,
      rulesBytes,
      topicBytes: 0,
    });
  });

  it('rejects new topics at the limit through proposals and manual writes', async () => {
    const saved = await putPolicy(limitId, { topicLimit: 3 });
    expect(saved.statusCode, saved.body).toBe(200);

    const updated = await request(app, {
      method: 'PUT',
      url: `/api/agents/${limitId}/memory/topic-a.md`,
      headers: { cookie },
      payload: { content: '# 更新后的主题\n' },
    });
    expect(updated.statusCode, updated.body).toBe(200);

    const manual = await request(app, {
      method: 'PUT',
      url: `/api/agents/${limitId}/memory/fresh.md`,
      headers: { cookie },
      payload: { content: '# 新主题\n' },
    });
    expectProblem(manual, 'CONFLICT');
    expect(manual.json<{ message: string }>().message).toContain('主题数量已达上限 3');

    const proposal = await request(app, {
      method: 'POST',
      url: '/api/memory-reviews',
      headers: { cookie, 'idempotency-key': randomUUID() },
      payload: {
        modelAgentId: limitId,
        target: { kind: 'agent_memory', agentId: limitId, name: 'fresh.md' },
        sources: [{ conversationId: 'conversation-not-loaded' }],
        instruction: '',
      },
    });
    expectProblem(proposal, 'CONFLICT');
    expect(proposal.json<{ message: string }>().message).toContain('主题数量已达上限 3');

    // 被拒绝的写入不能留下文件。
    await expect(fs.readFile(join(memoryDir(limitSlug), 'fresh.md'), 'utf8')).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });
});
