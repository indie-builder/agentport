import { afterAll, describe, expect, it } from 'bun:test';
import { createDb, newId, repo, schema } from '@agentport/db';
import type { ChatEvent } from '@agentport/shared';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { persistRunMessages } from '../src/messages.js';
import { testAccess } from './fixtures/access.js';

const { agentOwnership, TEST_BUSINESS_ID, userSubject } = testAccess(import.meta.url);

const { db, client } = createDb(process.env.DATABASE_URL ?? '');
const ready = await client.unsafe('select 1').then(
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
    await client.close();
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
    const [row] = await assistantRows(runId);
    expect(row?.content).toEqual({ type: 'text', text: 'hello', blockIndex: 0 });
  });

  it('logs OpenUI resolution diagnostics when a patch cannot be merged', async () => {
    const fixture = await newFixture();
    const runId = await seedRun(fixture);
    const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];

    const result = await persistRunMessages(db, {
      agentId: fixture.agentId,
      conversationId: fixture.conversationId,
      runId,
      events: [uiEvent(`不完整补丁：\n\n${FENCE('body = TextContent("缺根")')}`)],
      uiFormat: 'openui',
      logger: {
        warn(obj, msg) {
          warnings.push({ obj, msg });
        },
      },
    });

    expect(result.written).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toBe('openui response resolution diagnostics');
    expect(warnings[0]?.obj).toMatchObject({
      conversationId: fixture.conversationId,
      runId,
      diagnostics: [expect.objectContaining({ blockKey: 's0', code: 'missing-baseline' })],
    });
  });
});
