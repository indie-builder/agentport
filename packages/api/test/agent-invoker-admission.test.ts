import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvoker } from '../src/features/servers/agent-invoker.js';
import {
  cleanup,
  createAgent,
  infraReady,
  loginCookie,
  queueIdle,
  startApp,
  unique,
} from './helpers.js';

// MCP invoke 的准入与聊天入口共用事务；有 worker 消费时 run 会被真实执行，状态断言失去意义。
const ready = (await infraReady) && (await queueIdle);

async function rejectionOf(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error('expected promise to reject');
}

describe.skipIf(!ready)('agent invoker admission', () => {
  let app: FastifyInstance;
  let cookie: string;
  const agentSlugs: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    const { getQueue } = await import('../src/queue/producer.js');
    for (const runId of runIds) {
      await getQueue()
        .getJob(runId)
        .then((job) => job?.remove())
        .catch(() => undefined);
    }
    await cleanup(app, { agentSlugs, runIds });
    await app.close();
  });

  const newAgent = async (prefix: string): Promise<{ id: string; slug: string }> => {
    const slug = unique(prefix);
    const res = await createAgent(app, cookie, { slug, track: agentSlugs });
    return { slug, id: res.json<{ id: string }>().id };
  };

  it('persists MCP title, trigger, agent version and audit through the shared admission', async () => {
    const agent = await newAgent('mcp-admission');
    const prompt = `mcp admission ${randomBytes(6).toString('hex')} ${'x'.repeat(80)}`;

    const err = await rejectionOf(
      createInvoker(app).invoke({ slug: agent.slug, prompt, timeoutMs: 50 }),
    );
    expect(err.code).toBe('UPSTREAM_FAILED');
    expect(err.message).toMatch(/timed out/);

    const rows = await app.pool.query<{
      title: string;
      trigger: string;
      agent_version: number;
      run_id: string;
      content: { text?: string };
      sdk_message_uuid: string | null;
    }>(
      `select c.title, r.trigger, r.agent_version, m.run_id, m.content, m.sdk_message_uuid
         from agent_runs r
         join conversations c on c.id = r.conversation_id
         join messages m on m.run_id = r.id
        where r.agent_id = $1 and m.role = 'user'`,
      [agent.id],
    );
    expect(rows.rowCount).toBe(1);
    const run = rows.rows[0];
    if (!run) throw new Error('run was not admitted');
    runIds.push(run.run_id);
    expect(run.title).toBe(`mcp: ${prompt.slice(0, 60)}`);
    expect(run.trigger).toBe('mcp');
    expect(run.agent_version).toBe(1);
    expect(run.content.text).toBe(prompt);
    expect(run.sdk_message_uuid).toMatch(/^[0-9a-f-]{36}$/);

    const audits = await app.pool.query<{ action: string; actor: string }>(
      'select action, actor from audit_log where target = $1 order by action',
      [run.run_id],
    );
    expect(audits.rows).toEqual([
      { action: 'agent.run.cancelled', actor: 'mcp' },
      { action: 'agent.run.requested', actor: 'mcp' },
    ]);
  });

  it('rolls back the conversation, run and message when admission fails mid-transaction', async () => {
    const agent = await newAgent('mcp-rollback');
    const marker = `rollback-${randomBytes(8).toString('hex')}`;
    const fn = `test_mcp_rollback_${randomBytes(4).toString('hex')}`;

    await app.pool.query(`
      create function ${fn}() returns trigger language plpgsql as $$
      begin
        if new.content->>'text' = '${marker}' then
          raise exception 'forced message insert failure';
        end if;
        return new;
      end
      $$;
      create trigger ${fn}_trg before insert on messages
      for each row execute function ${fn}();
    `);

    try {
      const err = await rejectionOf(
        createInvoker(app).invoke({ slug: agent.slug, prompt: marker }),
      );
      // Drizzle 包装了原始错误；能定位到失败语句即可，关键是下面的原子性。
      expect(err.message).toContain('insert into "messages"');

      const counts = await app.pool.query<{
        conversations: string;
        runs: string;
        messages: string;
      }>(
        `select
           (select count(*) from conversations where agent_id = $1) as conversations,
           (select count(*) from agent_runs where agent_id = $1) as runs,
           (select count(*) from messages where content->>'text' = $2) as messages`,
        [agent.id, marker],
      );
      expect(counts.rows[0]).toEqual({ conversations: '0', runs: '0', messages: '0' });
    } finally {
      await app.pool.query(`
        drop trigger if exists ${fn}_trg on messages;
        drop function if exists ${fn}();
      `);
    }
  });
});
