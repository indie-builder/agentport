import { createDb, newId, repo, schema } from '@agentport/db';
import type { ChatEvent, RunQuestion } from '@agentport/shared';
import { type PublicRunQuestion, publicRunQuestion } from '@agentport/shared';
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import * as messages from '../src/messages.js';

/**
 * persistRunMessages 必须在 run 仍为 running 时才能写：取消抢先、终态已写、
 * 重试重放、以及 agent 删除都必须让它整笔跳过，不能留下迟到的输出。
 * 这里用真实 Postgres 行锁构造竞争，不 mock 任何锁行为。
 */
const { db, pool } = createDb(process.env.DATABASE_URL ?? '');
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

const agentIds: string[] = [];
const TERMINAL = ['cancelled', 'succeeded', 'failed', 'timeout', 'queued'] as const;

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
    slug: `persist-${agentId.slice(4)}`,
    name: 'persist',
    model: 'test',
  });
  await repo.chat.createConversation(db, { id: conversationId, agentId, title: 'persist' });
  return { agentId, conversationId };
}

async function seedRun(input: Fixture, status?: (typeof TERMINAL)[number]): Promise<string> {
  const runId = newId('run');
  await repo.chat.createRun(db, {
    id: runId,
    conversationId: input.conversationId,
    agentId: input.agentId,
  });
  // 不传 status 即进入 running：这是 persistRunMessages 唯一允许写入的状态。
  await db
    .update(schema.agentRuns)
    .set({
      status: status ?? 'running',
      startedAt: new Date(),
      ...(status === undefined || status === 'queued' ? {} : { endedAt: new Date() }),
    })
    .where(eq(schema.agentRuns.id, runId));
  await repo.chat.appendMessage(db, {
    id: newId('message'),
    conversationId: input.conversationId,
    role: 'user',
    content: { type: 'text', text: 'ask' },
    runId,
  });
  return runId;
}

function persist(
  fixture: Fixture,
  runId: string,
  events: ChatEvent[],
  overrides: Partial<Fixture> = {},
): Promise<boolean> {
  return (
    messages
      .persistRunMessages(db, {
        agentId: overrides.agentId ?? fixture.agentId,
        conversationId: overrides.conversationId ?? fixture.conversationId,
        runId,
        events,
      })
      // 这些用例只关心「有没有写进去」；落库消息 id 由 openui 相关用例覆盖。
      .then((result) => result.written)
  );
}

const text = (value: string): ChatEvent => ({ type: 'assistant_text', text: value });

async function outputOf(runId: string) {
  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.runId, runId), ne(schema.messages.role, 'user')));
  return rows.map((row) => row.content as { type?: string; text?: string });
}

async function userCount(runId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.messages)
    .where(and(eq(schema.messages.runId, runId), eq(schema.messages.role, 'user')));
  return row?.n ?? 0;
}

async function conversationOutputCount(conversationId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.messages)
    .where(
      and(eq(schema.messages.conversationId, conversationId), ne(schema.messages.role, 'user')),
    );
  return row?.n ?? 0;
}

/**
 * 排在给定后端后面的等待者数量。PostgreSQL 把第二个等待者的 blocker 记成第一个
 * 等待者，所以要顺着 blocker 链判断，而不是直接看持锁会话。
 */
async function waitersBehind(pid: number): Promise<number> {
  const { rows } = await pool.query<{ pid: number; blockers: number[] }>(
    `select pid, pg_blocking_pids(pid) as blockers
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and wait_event_type = 'Lock'`,
  );
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const behind = (row: { blockers: number[] }, seen = new Set<number>()): boolean =>
    row.blockers.some((blocker) => {
      if (blocker === pid) return true;
      if (seen.has(blocker)) return false;
      seen.add(blocker);
      const next = byPid.get(blocker);
      return next !== undefined && behind(next, seen);
    });
  return rows.filter((row) => behind(row)).length;
}

/** pool.connect 有回调重载，ReturnType 取不到 PoolClient；锁场景只用 query。 */
type LockClient = { query: (sql: string, values?: unknown[]) => Promise<unknown> };

/** 独占一个连接跑锁场景；断言失败时也回滚，避免悬挂事务挡住级联清理。 */
async function withLockedTx(
  run: (client: LockClient, pid: number) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
    const pid = rows[0]?.pid;
    if (pid === undefined) throw new Error('lock client has no backend pid');
    await client.query('begin');
    await run(client, pid);
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

describe.skipIf(!ready)('buildMessageRows keeps assistant block identity', () => {
  it('stores one text row per block with its blockIndex and parent', () => {
    const rows = messages.buildMessageRows([
      { type: 'assistant_text', text: 'first', blockIndex: 0, sdkUuid: 'u1' },
      { type: 'assistant_text', text: 'child', blockIndex: 4, parentToolUseId: 'toolu_p' },
      { type: 'assistant_text', text: 'legacy' },
    ]);
    expect(rows).toEqual([
      {
        role: 'assistant',
        content: { type: 'text', text: 'first', blockIndex: 0 },
        sdkMessageUuid: 'u1',
      },
      {
        role: 'assistant',
        content: { type: 'text', text: 'child', blockIndex: 4, parentToolUseId: 'toolu_p' },
      },
      { role: 'assistant', content: { type: 'text', text: 'legacy' } },
    ]);
  });

  it('marks truncated blocks so the reader knows the text is incomplete', () => {
    const rows = messages.buildMessageRows([
      { type: 'assistant_text', text: 'cut', blockIndex: 2, truncated: true },
    ]);
    expect(rows[0]?.content).toEqual({ type: 'text', text: 'cut', blockIndex: 2, truncated: true });
  });

  it('does not let streamed deltas create duplicate rows', () => {
    const rows = messages.buildMessageRows([
      { type: 'assistant_block_start', blockIndex: 0, kind: 'text' },
      { type: 'text_delta', text: 'hel', blockIndex: 0 },
      { type: 'text_delta', text: 'lo', blockIndex: 0 },
      { type: 'assistant_block_stop', blockIndex: 0 },
      { type: 'assistant_text', text: 'hello', blockIndex: 0 },
    ]);
    expect(rows).toEqual([
      { role: 'assistant', content: { type: 'text', text: 'hello', blockIndex: 0 } },
    ]);
  });

  it('keeps the todo snapshot on the tool result and redacts both visible fields', () => {
    const rows = messages.buildMessageRows([
      { type: 'tool_start', toolUseId: 'tu1', name: 'TodoWrite' },
      { type: 'tool_input', toolUseId: 'tu1', json: '{"todos":[]}' },
      {
        type: 'tool_result',
        toolUseId: 'tu1',
        content: 'ok',
        todos: [
          {
            content: 'use sk-abcdefghijklmnopqrstuvwxyz',
            activeForm: 'using sk-abcdefghijklmnopqrstuvwxyz',
            status: 'in_progress',
          },
          { content: 'plain', activeForm: 'plain', status: 'completed' },
        ],
      },
    ]);

    // 工具卡片本身保持原样，快照只挂在结果行上。
    expect(rows[0]?.content).toEqual({
      type: 'tool_use',
      id: 'tu1',
      name: 'TodoWrite',
      input: { todos: [] },
    });
    expect(rows[1]?.content).toEqual({
      type: 'tool_result',
      toolUseId: 'tu1',
      name: 'TodoWrite',
      content: 'ok',
      todos: [
        {
          content: 'use sk-a***',
          activeForm: 'using sk-a***',
          status: 'in_progress',
        },
        { content: 'plain', activeForm: 'plain', status: 'completed' },
      ],
    });
  });

  it('persists an empty todo snapshot instead of dropping it', () => {
    const rows = messages.buildMessageRows([
      { type: 'tool_start', toolUseId: 'tu1', name: 'TodoWrite' },
      { type: 'tool_result', toolUseId: 'tu1', content: 'ok', todos: [] },
    ]);
    expect(rows[1]?.content).toMatchObject({ type: 'tool_result', todos: [] });
  });

  const questionFor = (overrides: Partial<RunQuestion> = {}): RunQuestion => ({
    requestId: 'req-1',
    runId: 'run-1',
    toolUseId: 'tu-q',
    questions: [
      {
        question: '用哪种语言？',
        header: '语言',
        options: [
          { label: 'TypeScript', description: '默认选择' },
          { label: 'Python', description: '数据脚本' },
        ],
        multiSelect: false,
      },
    ],
    status: 'pending',
    answers: null,
    createdAt: '2026-10-28T00:00:00.000Z',
    resolvedAt: null,
    expiresAt: '2026-10-28T00:10:00.000Z',
    closeReason: null,
    ...overrides,
  });

  const publicQuestionFor = (overrides: Partial<RunQuestion> = {}) =>
    publicRunQuestion(questionFor(overrides));
  const questionOf = (row: { content: unknown } | undefined): PublicRunQuestion | undefined =>
    row === undefined ? undefined : (row.content as { question?: PublicRunQuestion }).question;

  it('keeps the latest question snapshot on both tool halves, redacted for display', () => {
    const rows = messages.buildMessageRows([
      { type: 'tool_start', toolUseId: 'tu-q', name: 'AskUserQuestion' },
      { type: 'tool_input', toolUseId: 'tu-q', json: '{"questions":[]}' },
      { type: 'question_updated', question: publicQuestionFor() },
      { type: 'tool_result', toolUseId: 'tu-q', content: 'answered' },
      // 收尾阶段才写入的最终快照排在 tool_result 之后，也必须覆盖 pending。
      {
        type: 'question_updated',
        question: publicQuestionFor({
          status: 'answered',
          answers: { '用哪种语言？': 'sk-abcdefghijklmnopqrstuvwx' },
          resolvedAt: '2026-10-28T00:01:00.000Z',
        }),
      },
    ]);

    // 两份快照只留最新一份，答案与问题同样脱敏。
    const question = questionOf(rows[0]);
    expect(question).toMatchObject({
      status: 'answered',
      answers: { '0': 'sk-a***' },
    });
    expect(questionOf(rows[1])).toEqual(question);
  });

  it('uses a late cancellation snapshot for both halves of an existing tool result', () => {
    const cancelled = publicQuestionFor({ status: 'closed', closeReason: 'cancelled' });
    const rows = messages.buildMessageRows([
      { type: 'tool_start', toolUseId: 'tu-q', name: 'AskUserQuestion' },
      { type: 'question_updated', question: publicQuestionFor() },
      { type: 'tool_result', toolUseId: 'tu-q', content: 'User declined' },
      { type: 'question_updated', question: cancelled },
    ]);
    expect(rows).toHaveLength(2);
    expect(questionOf(rows[0])).toEqual(cancelled);
    expect(questionOf(rows[1])).toEqual(cancelled);
  });

  it('keeps a question snapshot even when the run ended without a tool_result', () => {
    const rows = messages.buildMessageRows([
      { type: 'tool_start', toolUseId: 'tu-q', name: 'AskUserQuestion' },
      { type: 'tool_input', toolUseId: 'tu-q', json: '{"questions":[]}' },
      {
        type: 'question_updated',
        question: publicQuestionFor({
          status: 'closed',
          closeReason: 'cancelled',
          resolvedAt: '2026-10-28T00:01:00.000Z',
        }),
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toMatchObject({
      type: 'tool_use',
      id: 'tu-q',
      name: 'AskUserQuestion',
      question: { requestId: 'req-1', status: 'closed', closeReason: 'cancelled' },
    });
  });
});

describe.skipIf(!ready)('persistRunMessages fence and lock order', () => {
  afterAll(async () => {
    // 删 agent 级联清掉会话、run、消息；被测试删除的 agent 已是 no-op。
    await db.delete(schema.agents).where(inArray(schema.agents.id, agentIds));
    await pool.end();
  });

  it('stores SDK session state and fork uuid mapping in the same transaction', async () => {
    const fixture = await newFixture();
    const runId = await seedRun(fixture);
    const from = '11111111-2222-4333-8444-555555555555';
    await repo.chat.appendMessage(db, {
      id: newId('message'),
      conversationId: fixture.conversationId,
      role: 'assistant',
      content: { type: 'text', text: 'branch point' },
      runId: null,
      sdkMessageUuid: from,
    });

    expect(
      (
        await messages.persistRunMessages(db, {
          agentId: fixture.agentId,
          conversationId: fixture.conversationId,
          runId,
          events: [text('answer')],
          sdkSessionId: '66666666-7777-4888-8999-000000000000',
          uuidMap: [{ from, to: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }],
        })
      ).written,
    ).toBe(true);

    expect(await repo.chat.getConversationSdkState(db, fixture.conversationId)).toMatchObject({
      sdkSessionId: '66666666-7777-4888-8999-000000000000',
      forkFromSdkMessageUuid: null,
    });
    const uuids = (await repo.chat.listMessages(db, fixture.conversationId))
      .map((row) => row.sdkMessageUuid)
      .filter((uuid) => uuid !== null);
    expect(uuids).toContain('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(uuids).not.toContain(from);
  });

  it('returns persisted assistant message ids keyed by block index', async () => {
    const fixture = await newFixture();
    const runId = await seedRun(fixture);

    const result = await messages.persistRunMessages(db, {
      agentId: fixture.agentId,
      conversationId: fixture.conversationId,
      runId,
      events: [
        { type: 'assistant_text', text: '第一段', blockIndex: 0 },
        { type: 'assistant_text', text: '第二段', blockIndex: 1 },
      ],
    });

    // 前端要靠这些 id 回填流式项，长度与块序号必须与落库行一致。
    expect(result.written).toBe(true);
    expect(result.messages.map((m) => m.blockIndex)).toEqual([0, 1]);
    const rows = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.runId, runId));
    for (const message of result.messages) {
      expect(rows.some((row) => row.id === message.id)).toBe(true);
    }
  });

  it('snapshots the agent uiFormat on assistant rows only', async () => {
    const fixture = await newFixture();
    const runId = await seedRun(fixture);
    expect(
      (
        await messages.persistRunMessages(db, {
          agentId: fixture.agentId,
          conversationId: fixture.conversationId,
          runId,
          events: [text('ui answer'), { type: 'tool_start', toolUseId: 't1', name: 'X' }],
          uiFormat: 'openui',
        })
      ).written,
    ).toBe(true);

    const rows = await db
      .select({ role: schema.messages.role, uiFormat: schema.messages.uiFormat })
      .from(schema.messages)
      .where(eq(schema.messages.runId, runId));
    expect(
      rows.filter((row) => row.role === 'assistant').every((r) => r.uiFormat === 'openui'),
    ).toBe(true);
    // 用户消息保持准入时的默认值，不被本轮开关覆盖。
    expect(rows.find((row) => row.role === 'user')?.uiFormat).toBe('markdown');
  });

  it('replaces output idempotently while keeping the user message and redacting secrets', async () => {
    const fixture = await newFixture();
    const runId = await seedRun(fixture);
    const events = [
      text('key sk-ant-abcdefghijklmnopqrstuvwxyz012345'),
      { type: 'tool_start' as const, toolUseId: 'tu1', name: 'Search' },
      { type: 'tool_input' as const, toolUseId: 'tu1', json: '{"q":"x"}' },
      { type: 'tool_result' as const, toolUseId: 'tu1', content: 'ok' },
    ];

    expect(await persist(fixture, runId, events)).toBe(true);
    expect(await persist(fixture, runId, events)).toBe(true);

    const output = await outputOf(runId);
    expect(output).toHaveLength(3);
    expect(output[0]?.text).toBe('key sk-a***');
    // 重放只删本 run 的输出；用户消息带同一个 run_id，必须保留且不重复。
    expect(await userCount(runId)).toBe(1);
  });

  it('stores the redacted todo snapshot with its tool result row', async () => {
    const fixture = await newFixture();
    const runId = await seedRun(fixture);
    expect(
      await persist(fixture, runId, [
        { type: 'tool_start', toolUseId: 'tu1', name: 'TodoWrite' },
        {
          type: 'tool_result',
          toolUseId: 'tu1',
          content: 'ok',
          todos: [
            {
              content: 'use sk-abcdefghijklmnopqrstuvwxyz',
              activeForm: 'using sk-abcdefghijklmnopqrstuvwxyz',
              status: 'in_progress',
            },
          ],
        },
      ]),
    ).toBe(true);

    const stored = (await outputOf(runId)).find((row) => row.type === 'tool_result') as
      | { todos?: unknown }
      | undefined;
    expect(stored?.todos).toEqual([
      { content: 'use sk-a***', activeForm: 'using sk-a***', status: 'in_progress' },
    ]);
  });

  it('persists the messages collected before a byte overflow without choking on a huge token', async () => {
    const fixture = await newFixture();
    const runId = await seedRun(fixture);
    // runner 的 32MiB 落库额度最多保留 4 条 7MB 消息；它们必须能真正写进库。
    const chunk = 'x'.repeat(7_000_000);
    const events = [0, 1, 2, 3].map((blockIndex) => ({
      type: 'assistant_text' as const,
      text: chunk,
      blockIndex,
    }));

    expect(await persist(fixture, runId, events)).toBe(true);
    expect(await outputOf(runId)).toHaveLength(4);
  });

  for (const status of TERMINAL) {
    it(`does not write or delete anything for a ${status} run`, async () => {
      const fixture = await newFixture();
      const runId = await seedRun(fixture, status);
      await repo.chat.appendMessage(db, {
        id: newId('message'),
        conversationId: fixture.conversationId,
        role: 'assistant',
        content: { type: 'text', text: 'existing output' },
        runId,
      });

      expect(await persist(fixture, runId, [text('late output')])).toBe(false);

      expect((await outputOf(runId)).map((row) => row.text)).toEqual(['existing output']);
      expect(await userCount(runId)).toBe(1);
    });
  }

  it('skips missing or mismatched agent, conversation and run without writing', async () => {
    const fixture = await newFixture();
    const otherConversation = newId('conversation');
    await repo.chat.createConversation(db, {
      id: otherConversation,
      agentId: fixture.agentId,
      title: 'other',
    });
    const runId = await seedRun(fixture);

    expect(await persist(fixture, runId, [text('late')], { agentId: newId('agent') })).toBe(false);
    expect(
      await persist(fixture, runId, [text('late')], { conversationId: otherConversation }),
    ).toBe(false);
    expect(await persist(fixture, newId('run'), [text('late')])).toBe(false);
    expect(
      await persist(fixture, runId, [text('late')], { conversationId: newId('conversation') }),
    ).toBe(false);

    expect(await conversationOutputCount(fixture.conversationId)).toBe(0);
    expect(await conversationOutputCount(otherConversation)).toBe(0);
  });

  it('cancel wins: a cancel committed while persist waits makes the late flush skip', async () => {
    const fixture = await newFixture();
    const runId = await seedRun(fixture);
    await repo.chat.appendMessage(db, {
      id: newId('message'),
      conversationId: fixture.conversationId,
      role: 'assistant',
      content: { type: 'text', text: 'existing output' },
      runId,
    });

    await withLockedTx(async (locker, lockerPid) => {
      await locker.query(
        "update agent_runs set status = 'cancelled', ended_at = now() where id = $1",
        [runId],
      );

      const flushing = persist(fixture, runId, [text('late output')]);
      await expect.poll(() => waitersBehind(lockerPid)).toBe(1);

      await locker.query('commit');
      await expect(flushing).resolves.toBe(false);
    });

    expect((await outputOf(runId)).map((row) => row.text)).toEqual(['existing output']);
  });

  it('flush wins: a flush already queued for the run lock lands before cancel', async () => {
    const fixture = await newFixture();
    const runId = await seedRun(fixture);

    await withLockedTx(async (locker, lockerPid) => {
      await locker.query('select id from agent_runs where id = $1 for update', [runId]);

      const flushing = persist(fixture, runId, [text('flushed answer')]);
      await expect.poll(() => waitersBehind(lockerPid)).toBe(1);

      // PostgreSQL 按等待顺序授予行锁：flush 先排队，cancel 只能排在 flush 后面。
      const cancelling = repo.chat.cancelRun(db, runId);
      await expect.poll(() => waitersBehind(lockerPid)).toBe(2);

      await locker.query('commit');
      // flush 先拿到 run 行锁时状态仍是 running：这条断言证明它排在 cancel 之前。
      await expect(flushing).resolves.toBe(true);
      expect(await cancelling).not.toBeNull();
    });

    const output = await outputOf(runId);
    expect(output.map((row) => row.text)).toEqual(['flushed answer']);
    expect(await userCount(runId)).toBe(1);
    expect((await repo.chat.getRun(db, runId))?.status).toBe('cancelled');
  });

  it('takes the agent lock first, so an agent delete cannot deadlock with the flush', async () => {
    const fixture = await newFixture();
    const runId = await seedRun(fixture);

    await withLockedTx(async (locker, lockerPid) => {
      await locker.query('select id from agents where id = $1 for update', [fixture.agentId]);

      const flushing = persist(fixture, runId, [text('late output')]);
      await expect.poll(() => waitersBehind(lockerPid)).toBe(1);

      // flush 还被 agent 锁挡住，尚未轮到 conversation 锁；删除因此不会反向等待。
      await expect(
        pool.query('select id from conversations where id = $1 for update nowait', [
          fixture.conversationId,
        ]),
      ).resolves.toBeDefined();

      await locker.query('delete from agents where id = $1', [fixture.agentId]);
      await locker.query('commit');
      await expect(flushing).resolves.toBe(false);
    });

    const remaining = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.id, fixture.agentId));
    expect(remaining).toHaveLength(0);
  });
});
