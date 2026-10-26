import { createDb, newId, repo, schema } from '@agentport/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * 分支复制的是已合并的 canonical 程序与段状态。blockKey 是段序号（s0/s1），
 * 与消息 id 无关，所以新消息 id 下无需重写 key。
 */
const { db, pool } = createDb(process.env.DATABASE_URL ?? '');
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

const agentIds: string[] = [];
const BRANCH_POINT = '11111111-2222-4333-8444-555555555555';
const PROGRAM = '```openui-lang\nroot = Card([a])\na = TextContent("行程")\n```';
const STATE = { version: 1, blocks: { s0: { budget: 2500 }, s1: { tab: 'b' } } };

describe.skipIf(!ready)('branch copies OpenUI snapshots', () => {
  afterAll(async () => {
    if (agentIds.length > 0) {
      await db.delete(schema.agents).where(inArray(schema.agents.id, agentIds));
    }
    await pool.end();
  });

  it('keeps uiProgram and per-segment state under the new message id', async () => {
    const agentId = newId('agent');
    agentIds.push(agentId);
    const conversationId = newId('conversation');
    await db.insert(schema.agents).values({
      id: agentId,
      slug: `ui-branch-${agentId.slice(4)}`,
      name: 'ui-branch',
      model: 'test',
    });
    await repo.chat.createConversation(db, { id: conversationId, agentId, title: 'source' });
    await db
      .update(schema.conversations)
      .set({ sdkSessionId: '66666666-7777-4888-8999-000000000000' })
      .where(eq(schema.conversations.id, conversationId));

    const sourceId = newId('message');
    await repo.chat.appendMessage(db, {
      id: sourceId,
      conversationId,
      role: 'assistant',
      content: { type: 'text', text: 'ui answer' },
      sdkMessageUuid: BRANCH_POINT,
    });
    await db
      .update(schema.messages)
      .set({ uiFormat: 'openui', uiProgram: PROGRAM, uiState: STATE })
      .where(eq(schema.messages.id, sourceId));

    const branchId = newId('conversation');
    const branched = await repo.chat.branchConversation(db, {
      id: branchId,
      conversationId,
      fromMessageId: sourceId,
    });
    expect(branched?.copied).toBe(1);

    const copy = (await repo.chat.listMessages(db, branchId)).find((row) => row.uiProgram !== null);
    expect(copy?.id).not.toBe(sourceId);
    expect(copy?.uiFormat).toBe('openui');
    expect(copy?.uiProgram).toBe(PROGRAM);
    // copy 的 state 原样保留：sN 是段序号，不需要按新消息 id 重映射。
    expect(copy?.uiState).toEqual(STATE);
  });
});
