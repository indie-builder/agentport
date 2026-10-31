import { createDb, newId, repo, schema } from '@agentport/db';
import type { ChatEvent } from '@agentport/shared';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { persistRunMessages } from '../src/messages.js';
import { agentOwnership, TEST_BUSINESS_ID, userSubject } from './fixtures/access.js';

/**
 * 跨轮 UI 编辑的落库语义：基线必须在本 run 输出删除之前取，纯文本/子智能体/截断不能伪造完整程序，
 * 多段各有自己的命名空间（blockKey s0/s1）。
 */
const { db, pool } = createDb(process.env.DATABASE_URL ?? '');
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

const agentIds: string[] = [];

const FENCE = (program: string) => `\`\`\`openui-lang\n${program}\n\`\`\``;
const BASE_PROGRAM = [
  'root = Card([title, body])',
  'title = TextContent("行程")',
  'body = TextContent("原计划")',
].join('\n');
const BASE_CANONICAL = `这是上一轮的回答。\n\n${FENCE(BASE_PROGRAM)}\n`;

interface Fixture {
  agentId: string;
  conversationId: string;
}

async function newFixture(): Promise<Fixture> {
  const agentId = newId('agent');
  const conversationId = newId('conversation');
  agentIds.push(agentId);
  await db.insert(schema.agents).values({
    id: agentId,
    slug: `ui-persist-${agentId.slice(4)}`,
    name: 'ui-persist',
    model: 'test',
    uiFormat: 'openui',
    ...agentOwnership,
  });
  await repo.chat.createConversation(db, {
    id: conversationId,
    agentId,
    title: 'ui',
    subject: userSubject,
  });
  return { agentId, conversationId };
}

async function seedRun(fixture: Fixture): Promise<string> {
  const runId = newId('run');
  await repo.chat.createRun(db, {
    id: runId,
    conversationId: fixture.conversationId,
    agentId: fixture.agentId,
    subject: userSubject,
  });
  await db
    .update(schema.agentRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(schema.agentRuns.id, runId));
  await repo.chat.appendMessage(db, {
    id: newId('message'),
    conversationId: fixture.conversationId,
    role: 'user',
    content: { type: 'text', text: '继续' },
    runId,
    senderBusinessId: TEST_BUSINESS_ID,
  });
  return runId;
}

/** 上一轮已合并的主助手消息；跨轮补丁要拿它当基线。 */
async function seedPreviousTurn(
  fixture: Fixture,
  uiProgram: string | null = BASE_CANONICAL,
): Promise<string> {
  const id = newId('message');
  await repo.chat.appendMessage(db, {
    id,
    conversationId: fixture.conversationId,
    role: 'assistant',
    content: { type: 'text', text: '上一轮' },
  });
  await db
    .update(schema.messages)
    .set({ uiFormat: 'openui', uiProgram })
    .where(eq(schema.messages.id, id));
  return id;
}

function uiEvent(text: string, overrides: Partial<ChatEvent> = {}): ChatEvent {
  return { type: 'assistant_text', text, blockIndex: 0, ...overrides } as ChatEvent;
}

async function assistantRows(runId: string) {
  return db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.runId, runId), ne(schema.messages.role, 'user')));
}

describe.skipIf(!ready)('persistRunMessages OpenUI programs', () => {
  afterAll(async () => {
    await db.delete(schema.agents).where(inArray(schema.agents.id, agentIds));
    await pool.end();
  });

  it('reads the previous main-assistant program before deleting this run and merges a patch', async () => {
    const fixture = await newFixture();
    const previousId = await seedPreviousTurn(fixture);
    const runId = await seedRun(fixture);

    const result = await persistRunMessages(db, {
      agentId: fixture.agentId,
      conversationId: fixture.conversationId,
      runId,
      events: [uiEvent(`补丁：\n\n${FENCE('body = TextContent("新计划")')}\n`)],
      uiFormat: 'openui',
    });

    expect(result.written).toBe(true);
    const [row] = await assistantRows(runId);
    expect(row?.uiProgram).toContain('新计划');
    // 上一轮未变：先删本 run 不能把基线一起删掉。
    expect(row?.uiProgram).toContain('title = TextContent("行程")');
    expect(row?.uiProgram).not.toContain('原计划');
    expect(result.messages[0]).toMatchObject({
      id: row?.id,
      blockIndex: 0,
      uiFormat: 'openui',
      uiProgram: row?.uiProgram,
    });
    const [previous] = await db
      .select({ uiProgram: schema.messages.uiProgram })
      .from(schema.messages)
      .where(eq(schema.messages.id, previousId));
    expect(previous?.uiProgram).toBe(BASE_CANONICAL);
  });

  it('does not overwrite the baseline with a text-only reply', async () => {
    const fixture = await newFixture();
    await seedPreviousTurn(fixture);
    const runId = await seedRun(fixture);

    const result = await persistRunMessages(db, {
      agentId: fixture.agentId,
      conversationId: fixture.conversationId,
      runId,
      events: [uiEvent('就是一段普通文字。')],
      uiFormat: 'openui',
    });

    expect(result.messages[0]?.uiProgram).toBeNull();
    const [row] = await assistantRows(runId);
    expect(row?.uiProgram).toBeNull();
  });

  it('keeps sub-agent and truncated blocks out of the main UI program', async () => {
    const fixture = await newFixture();
    await seedPreviousTurn(fixture);
    const runId = await seedRun(fixture);

    const subAgent = FENCE('root = Card([x])\nx = TextContent("子任务")');
    const truncated = FENCE('root = Card([y])\ny = TextContent("半截")');
    const result = await persistRunMessages(db, {
      agentId: fixture.agentId,
      conversationId: fixture.conversationId,
      runId,
      events: [
        uiEvent(subAgent, { blockIndex: 0, parentToolUseId: 'toolu_parent' }),
        uiEvent(truncated, { blockIndex: 1, truncated: true }),
        uiEvent(`主回答：\n\n${FENCE('body = TextContent("最终")')}`, { blockIndex: 2 }),
      ],
      uiFormat: 'openui',
    });

    expect(result.messages.map((message) => message.uiProgram === null)).toEqual([
      true,
      true,
      false,
    ]);
    // 子智能体与截断块不推进基线：主回答仍基于上一轮合并。
    expect(result.messages[2]?.uiProgram).toContain('title = TextContent("行程")');
    expect(result.messages[2]?.uiProgram).toContain('最终');
    expect(result.messages[2]?.uiProgram).not.toContain('子任务');
  });

  it('keeps each UI block in output order so a later block builds on the earlier one', async () => {
    const fixture = await newFixture();
    await seedPreviousTurn(fixture);
    const runId = await seedRun(fixture);

    const result = await persistRunMessages(db, {
      agentId: fixture.agentId,
      conversationId: fixture.conversationId,
      runId,
      events: [
        uiEvent(`先改标题：\n\n${FENCE('title = TextContent("新标题")')}`),
        uiEvent('中间一句普通文字'),
        uiEvent(`再改正文：\n\n${FENCE('body = TextContent("新正文")')}`),
      ],
      uiFormat: 'openui',
    });

    const programs = result.messages.map((message) => message.uiProgram);
    expect(programs[0]).toContain('新标题');
    expect(programs[1]).toBeNull();
    // 第三块基于第二块之前的合并结果，两处改动都在。
    expect(programs[2]).toContain('新标题');
    expect(programs[2]).toContain('新正文');
  });

  it('returns the stable stream block id with each persisted assistant block', async () => {
    const fixture = await newFixture();
    const runId = await seedRun(fixture);
    const event = {
      type: 'assistant_text',
      text: 'hello',
      blockIndex: 0,
      streamBlockId: 'b0',
    } as unknown as ChatEvent;

    const result = await persistRunMessages(db, {
      agentId: fixture.agentId,
      conversationId: fixture.conversationId,
      runId,
      events: [event],
      uiFormat: 'openui',
    });

    expect(result.messages[0]).toMatchObject({ blockIndex: 0, streamBlockId: 'b0' });
    // streamBlockId 是运行内身份，不写进消息内容。
    const [row] = await assistantRows(runId);
    expect(row?.content).toEqual({ type: 'text', text: 'hello', blockIndex: 0 });
  });
});
