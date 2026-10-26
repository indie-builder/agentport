import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/client.js';
import { newId } from '../src/id.js';
import * as chat from '../src/repo/chat.js';
import {
  agentRuns,
  agents,
  approvalRequests,
  conversations,
  messages,
  servers,
} from '../src/schema.js';

/**
 * 准入的用户消息内容必须与 run、继承审批同一次提交：
 * 动作内容直接写在 appendMessage 里，不允许先落纯文本再补写（补写失败会留下没有 job 的 queued run）。
 */
const { db, pool } = createDb(process.env.DATABASE_URL ?? '');
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
    slug: `admit-content-${id.slice(4)}`,
    name: 'admit-content',
    model: 'test',
  });
  return id;
}

async function newServer(): Promise<string> {
  const id = newId('server');
  serverIds.push(id);
  await db.insert(servers).values({
    id,
    name: `admit-content-${id.slice(4)}`,
    kind: 'http',
    config: { url: 'https://example.com/mcp' },
  });
  return id;
}

async function newConversation(agentId: string): Promise<string> {
  const id = newId('conversation');
  await chat.createConversation(db, { id, agentId, title: 'admission' });
  return id;
}

/** 上一轮已结束的 run 及其已批准工具；下一次准入应把批准继承过来。 */
async function previousApprovedRun(
  conversationId: string,
  agentId: string,
  serverId: string,
  toolName: string,
): Promise<{ runId: string; approvedAt: Date }> {
  const runId = newId('run');
  await chat.createRun(db, { id: runId, conversationId, agentId });
  await db
    .update(agentRuns)
    .set({ status: 'succeeded', endedAt: new Date() })
    .where(eq(agentRuns.id, runId));
  const approvedAt = new Date('2026-10-20T00:00:00Z');
  await db
    .insert(approvalRequests)
    .values({ id: newId('approval'), runId, serverId, toolName, approvedAt });
  return { runId, approvedAt };
}

const userMessages = (conversationId: string) =>
  db.select().from(messages).where(eq(messages.conversationId, conversationId));

const runsOf = (conversationId: string) =>
  db.select().from(agentRuns).where(eq(agentRuns.conversationId, conversationId));

describe.skipIf(!ready)('admitChatRun user content', () => {
  afterAll(async () => {
    // agents 级联清会话、消息、run 与审批；servers 单独删。
    for (const agentId of agentIds) await db.delete(agents).where(eq(agents.id, agentId));
    for (const serverId of serverIds) await db.delete(servers).where(eq(servers.id, serverId));
    await pool.end();
  });

  it('persists the full action content as the only user message', async () => {
    const agentId = await newAgent();
    const message = 'Plan a trip to Paris';
    const userContent = [
      { type: 'text', text: message },
      {
        type: 'openui_action',
        params: { card: 'paris', filters: { nights: [2, 5] } },
        context: { card: 'paris', source: 'card' },
        formState: { budget: 2500, nested: { days: 3 } },
        formName: 'trip-planner',
        messageId: newId('message'),
        blockKey: 's0',
      },
    ];

    const admitted = await chat.admitChatRun(db, { agentId, message, userContent });
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, admitted.conversationId));

    expect(conversation?.title).toBe(message);
    expect(admitted.run.status).toBe('queued');

    const rows = await userMessages(admitted.conversationId);
    expect(rows).toHaveLength(1);
    // 完整 context/params/formState 原样落库，且没有中间那条纯文本行。
    expect(rows[0]?.content).toEqual(userContent);
    expect(rows[0]?.runId).toBe(admitted.run.id);
    expect(rows[0]?.sdkMessageUuid).toBe(admitted.userMessageUuid);
  });

  it('keeps text-only callers unchanged when userContent is omitted', async () => {
    const agentId = await newAgent();
    const admitted = await chat.admitChatRun(db, { agentId, message: 'plain hello' });

    const rows = await userMessages(admitted.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toEqual({ type: 'text', text: 'plain hello' });
  });

  it('inherits approved tools in the same commit as the run and message', async () => {
    const agentId = await newAgent();
    const serverId = await newServer();
    const conversationId = await newConversation(agentId);
    const previous = await previousApprovedRun(conversationId, agentId, serverId, 'create-user');

    const admitted = await chat.admitChatRun(db, {
      agentId,
      message: '继续',
      conversationId,
    });

    expect(admitted.inherited).toEqual(['create-user']);
    const inherited = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.runId, admitted.run.id));
    expect(inherited.map((row) => row.toolName)).toEqual(['create-user']);
    expect(inherited[0]?.approvedAt).toEqual(previous.approvedAt);
    expect(await userMessages(conversationId)).toHaveLength(1);
  });

  it('rolls back the run and inherited approvals when the message write fails', async () => {
    const agentId = await newAgent();
    const serverId = await newServer();
    const conversationId = await newConversation(agentId);
    const previous = await previousApprovedRun(conversationId, agentId, serverId, 'create-user');

    await expect(
      chat.admitChatRun(db, {
        agentId,
        message: '坏内容',
        conversationId,
        userContent: [
          { type: 'text', text: 'x' },
          { type: 'openui_action', context: { n: 1n } },
        ],
      }),
    ).rejects.toThrow();

    expect(await runsOf(conversationId)).toHaveLength(1);
    expect(await userMessages(conversationId)).toHaveLength(0);
    // 原有 run 的批准仍在；失败事务没给新 run 留下任何行。
    const approvals = await db
      .select()
      .from(approvalRequests)
      .where(inArray(approvalRequests.runId, [previous.runId]));
    expect(approvals).toHaveLength(1);
  });
});
