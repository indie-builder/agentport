import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { newId } from '../src/id.js';
import * as chat from '../src/repo/chat.js';
import { inheritApprovals } from '../src/repo/runs.js';
import { agents, approvalRequests, schema, servers } from '../src/schema.js';

/**
 * 继承查询把「找上一轮 run」和「读它的已批准工具」合成一条语句：
 * 无前轮/前轮无批准 1 SELECT，有批准再加 1 INSERT。
 * 事务走独立连接，pool.query 探针看不到，必须用 Drizzle logger 计数。
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? '',
  max: 4,
  statement_timeout: 15_000,
  connectionTimeoutMillis: 5_000,
});
const statements: string[] = [];
const db = drizzle(pool, { schema, logger: { logQuery: (query) => statements.push(query) } });
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

const agentIds: string[] = [];
const serverIds: string[] = [];

async function newAgent(): Promise<string> {
  const id = newId('agent');
  agentIds.push(id);
  await db.insert(agents).values({
    id,
    slug: `inherit-${id.slice(4)}`,
    name: 'inherit',
    model: 'test',
  });
  return id;
}

async function newServer(): Promise<string> {
  const id = newId('server');
  serverIds.push(id);
  await db.insert(servers).values({
    id,
    name: `inherit-${id.slice(4)}`,
    kind: 'http',
    config: { url: 'https://example.com/mcp' },
  });
  return id;
}

async function newConversation(agentId: string): Promise<string> {
  const id = newId('conversation');
  await chat.createConversation(db, { id, agentId, title: 'inherit approvals' });
  return id;
}

async function newRun(conversationId: string, agentId: string): Promise<string> {
  // TypeID 时间戳是毫秒级，同一毫秒内的 id 顺序随机；这里保证上一轮/本轮的先后稳定。
  await new Promise((resolve) => setTimeout(resolve, 2));
  const id = newId('run');
  await chat.createRun(db, { id, conversationId, agentId });
  return id;
}

async function approve(
  runId: string,
  serverId: string,
  toolName: string,
  approvedAt: Date | null,
): Promise<void> {
  await db
    .insert(approvalRequests)
    .values({ id: newId('approval'), runId, serverId, toolName, approvedAt });
}

/** seed 不计入语句数：只清空并统计目标调用。 */
async function measured<T>(call: () => Promise<T>) {
  statements.length = 0;
  const result = await call();
  const count = (pattern: RegExp) =>
    statements.filter((statement) => pattern.test(statement.trim())).length;
  return { result, selects: count(/^select\b/i), inserts: count(/^insert\b/i) };
}

const approvalsOf = (runId: string) =>
  db.select().from(approvalRequests).where(eq(approvalRequests.runId, runId));

describe.skipIf(!ready)('inheritApprovals', () => {
  afterAll(async () => {
    for (const agentId of agentIds) await db.delete(agents).where(eq(agents.id, agentId));
    for (const serverId of serverIds) await db.delete(servers).where(eq(servers.id, serverId));
    await pool.end();
  });

  it('uses one select and returns nothing without a previous run', async () => {
    const agentId = await newAgent();
    const conversationId = await newConversation(agentId);
    const runId = await newRun(conversationId, agentId);

    const { result, selects, inserts } = await measured(() =>
      inheritApprovals(db, { conversationId, runId }),
    );

    expect(result).toEqual([]);
    expect(selects).toBe(1);
    expect(inserts).toBe(0);
  });

  it('uses one select when the previous run has no approval (was two)', async () => {
    const agentId = await newAgent();
    const serverId = await newServer();
    const conversationId = await newConversation(agentId);
    const previous = await newRun(conversationId, agentId);
    await approve(previous, serverId, 'pending-tool', null);
    const runId = await newRun(conversationId, agentId);

    const { result, selects, inserts } = await measured(() =>
      inheritApprovals(db, { conversationId, runId }),
    );

    expect(result).toEqual([]);
    expect(selects).toBe(1);
    expect(inserts).toBe(0);
    expect(await approvalsOf(runId)).toHaveLength(0);
  });

  it('inherits approved tools in one select plus one insert and keeps approvedAt (was three)', async () => {
    const agentId = await newAgent();
    const serverId = await newServer();
    const conversationId = await newConversation(agentId);
    const previous = await newRun(conversationId, agentId);
    const approvedAt = new Date('2026-10-20T00:00:00Z');
    await approve(previous, serverId, 'create-user', approvedAt);
    await approve(previous, serverId, 'still-pending', null);
    const runId = await newRun(conversationId, agentId);

    const { result, selects, inserts } = await measured(() =>
      inheritApprovals(db, { conversationId, runId }),
    );

    expect(result).toEqual(['create-user']);
    expect(selects).toBe(1);
    expect(inserts).toBe(1);
    const inherited = await approvalsOf(runId);
    expect(inherited.map((row) => row.toolName)).toEqual(['create-user']);
    expect(inherited[0]?.approvedAt).toEqual(approvedAt);
  });

  it('looks only at the latest previous run even when an older one has approvals', async () => {
    const agentId = await newAgent();
    const serverId = await newServer();
    const conversationId = await newConversation(agentId);
    const older = await newRun(conversationId, agentId);
    await approve(older, serverId, 'old-approval', new Date('2026-10-01T00:00:00Z'));
    await newRun(conversationId, agentId);
    const runId = await newRun(conversationId, agentId);

    const { result, selects, inserts } = await measured(() =>
      inheritApprovals(db, { conversationId, runId }),
    );

    expect(result).toEqual([]);
    expect(selects).toBe(1);
    expect(inserts).toBe(0);
    expect(await approvalsOf(runId)).toHaveLength(0);
  });

  it('excludes the current run and only inherits from the previous one', async () => {
    const agentId = await newAgent();
    const serverId = await newServer();
    const conversationId = await newConversation(agentId);
    const previous = await newRun(conversationId, agentId);
    await approve(previous, serverId, 'from-previous', new Date('2026-10-20T00:00:00Z'));
    const runId = await newRun(conversationId, agentId);
    await approve(runId, serverId, 'from-current', new Date('2026-10-21T00:00:00Z'));

    const { result } = await measured(() => inheritApprovals(db, { conversationId, runId }));

    expect(result).toEqual(['from-previous']);
  });

  it('does not inherit across conversations', async () => {
    const agentId = await newAgent();
    const serverId = await newServer();
    const otherConversation = await newConversation(agentId);
    const otherRun = await newRun(otherConversation, agentId);
    await approve(otherRun, serverId, 'other-conversation', new Date('2026-10-20T00:00:00Z'));
    const conversationId = await newConversation(agentId);
    const runId = await newRun(conversationId, agentId);

    const { result, selects, inserts } = await measured(() =>
      inheritApprovals(db, { conversationId, runId }),
    );

    expect(result).toEqual([]);
    expect(selects).toBe(1);
    expect(inserts).toBe(0);
  });

  it('returns the same tool name twice when it was approved on two servers', async () => {
    const agentId = await newAgent();
    const firstServer = await newServer();
    const secondServer = await newServer();
    const conversationId = await newConversation(agentId);
    const previous = await newRun(conversationId, agentId);
    await approve(previous, firstServer, 'shared-tool', new Date('2026-10-20T00:00:00Z'));
    await approve(previous, secondServer, 'shared-tool', new Date('2026-10-21T00:00:00Z'));
    const runId = await newRun(conversationId, agentId);

    const { result, selects, inserts } = await measured(() =>
      inheritApprovals(db, { conversationId, runId }),
    );

    expect(result.sort()).toEqual(['shared-tool', 'shared-tool']);
    expect(selects).toBe(1);
    expect(inserts).toBe(1);
    expect(await approvalsOf(runId)).toHaveLength(2);
  });

  it('still returns the original tools on a repeated call without adding rows', async () => {
    const agentId = await newAgent();
    const firstServer = await newServer();
    const secondServer = await newServer();
    const conversationId = await newConversation(agentId);
    const previous = await newRun(conversationId, agentId);
    await approve(previous, firstServer, 'dup', new Date('2026-10-20T00:00:00Z'));
    await approve(previous, secondServer, 'dup', new Date('2026-10-21T00:00:00Z'));
    const runId = await newRun(conversationId, agentId);

    const first = await inheritApprovals(db, { conversationId, runId });
    const second = await measured(() => inheritApprovals(db, { conversationId, runId }));

    expect(first.sort()).toEqual(['dup', 'dup']);
    expect(second.result.sort()).toEqual(['dup', 'dup']);
    expect(second.selects).toBe(1);
    expect(second.inserts).toBe(1);
    expect(await approvalsOf(runId)).toHaveLength(2);
  });

  it('rolls back inherited rows when the surrounding transaction throws', async () => {
    const agentId = await newAgent();
    const serverId = await newServer();
    const conversationId = await newConversation(agentId);
    const previous = await newRun(conversationId, agentId);
    await approve(previous, serverId, 'rolled-back', new Date('2026-10-20T00:00:00Z'));
    const runId = await newRun(conversationId, agentId);

    await expect(
      db.transaction(async (tx) => {
        await inheritApprovals(tx, { conversationId, runId });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await approvalsOf(runId)).toHaveLength(0);
    expect(await approvalsOf(previous)).toHaveLength(1);
  });
});
