import { randomUUID } from 'node:crypto';
import { DbError } from '@agentport/core';
import { newId, repo } from '@agentport/db';
import type { Agent } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleEvalJobFailed } from '../../worker/src/eval-job.js';
import { EVAL_FAILURE_PUBLIC_MESSAGE, executeEvalRun } from '../../worker/src/eval-runner.js';
import {
  ADMIN_BUSINESS_ID,
  cleanup,
  createAgent,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

interface RunBody {
  id: string;
  error: string | null;
  status: string;
}

/**
 * 真实 PostgreSQL 故障携带 secret 与 SQL 参数，经生产收口后：
 * eval_runs.error 必须是固定公开文案，list/detail/compare/export 的成功响应不得带出原文。
 */
describe.skipIf(!ready)('eval error redaction', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents });
    await app.close();
  });

  const newAgent = async (): Promise<Agent> =>
    (
      await createAgent(app, cookie, { slug: unique('eval-redaction'), track: createdAgents })
    ).json<Agent>();

  function expectNoSqlLeak(text: string, secret: string): void {
    expect(text).not.toContain(secret);
    expect(text).not.toMatch(/Failed query/i);
    expect(text).not.toMatch(/params:/i);
    expect(text).not.toContain('eval_results');
  }

  it('serves a fixed public message after a real PG failure with a secret parameter', async () => {
    const agent = await newAgent();
    const secret = `sk-live-eval-wire-${randomUUID()}`;
    const testCase = await repo.evalRepo.createCase(app.db, newId('evalCase'), {
      agentId: agent.id,
      name: 'wire-secret',
      prompt: 'prompt',
      expectation: 'expectation',
      createdBy: ADMIN_BUSINESS_ID,
    });
    // 同一 agent 只允许一个 running：先创建并收口 head，再创建本次故障 run。
    const head = await repo.evalRepo.createEvalRun(app.db, {
      id: newId('evalRun'),
      agentId: agent.id,
      total: 1,
      createdBy: ADMIN_BUSINESS_ID,
    });
    await repo.evalRepo.finishEvalRun(app.db, head.id, { status: 'succeeded', passed: 0 });
    const run = await repo.evalRepo.createEvalRun(app.db, {
      id: newId('evalRun'),
      agentId: agent.id,
      total: 1,
      createdBy: ADMIN_BUSINESS_ID,
    });

    const functionName = `eval_result_secret_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    await app.pool.query(`
      create or replace function ${functionName}() returns trigger language plpgsql as $fn$
      begin
        if new.eval_run_id = '${run.id}' then
          raise exception 'forced eval result failure %', '${secret}';
        end if;
        return new;
      end;
      $fn$
    `);
    await app.pool.query(`
      create trigger ${functionName}
      before insert on eval_results
      for each row execute function ${functionName}()
    `);

    let fault: unknown;
    try {
      await repo.evalRepo.addResult(app.db, {
        id: newId('evalResult'),
        evalRunId: run.id,
        caseId: testCase.id,
        runId: null,
        passed: true,
        output: secret,
      });
    } catch (error) {
      fault = error;
    } finally {
      await app.pool.query(`drop trigger if exists ${functionName} on eval_results`);
      await app.pool.query(`drop function if exists ${functionName}()`);
    }

    expect(fault, 'the injected PostgreSQL failure must really happen').toBeTruthy();
    const raw = new DbError((fault as Error).message, fault);
    // 证明故障对象确实带着 SQL、参数和 secret，修复必须发生在写入/日志边界。
    expect(raw.message).toContain(secret);
    expect(raw.message).toMatch(/Failed query/);
    expect(raw.message).toMatch(/params:/);

    await handleEvalJobFailed({
      db: app.db,
      logger,
      job: { data: { evalRunId: run.id } },
      error: raw,
    });

    const stored = await app.pool.query<{ error: string | null }>(
      'select error from eval_runs where id = $1',
      [run.id],
    );
    expect(stored.rows[0]?.error).toBe(EVAL_FAILURE_PUBLIC_MESSAGE);

    const list = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs?agentId=${agent.id}`,
      headers: { cookie },
    });
    expect(list.statusCode, list.body).toBe(200);
    expectNoSqlLeak(list.body, secret);
    expect(list.json<{ items: RunBody[] }>().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: run.id, error: EVAL_FAILURE_PUBLIC_MESSAGE }),
      ]),
    );

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs/${run.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expectNoSqlLeak(detail.body, secret);
    expect(detail.json<{ evalRun: RunBody }>().evalRun.error).toBe(EVAL_FAILURE_PUBLIC_MESSAGE);

    const compare = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs/${run.id}/compare?head=${head.id}`,
      headers: { cookie },
    });
    expect(compare.statusCode, compare.body).toBe(200);
    expectNoSqlLeak(compare.body, secret);
    expect(compare.json<{ baseRun: RunBody }>().baseRun.error).toBe(EVAL_FAILURE_PUBLIC_MESSAGE);

    const exported = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs/${run.id}/export`,
      headers: { cookie },
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expectNoSqlLeak(exported.body, secret);
    expect(exported.json<{ evalRun: RunBody }>().evalRun.error).toBe(EVAL_FAILURE_PUBLIC_MESSAGE);
  });

  it('redacts a case-level messages insert failure from results, compare and export', async () => {
    const agent = await newAgent();
    const secret = `sk-live-eval-case-${randomUUID()}`;
    const prompt = `prompt-case-${secret}`;
    const testCase = await repo.evalRepo.createCase(app.db, newId('evalCase'), {
      agentId: agent.id,
      name: 'case-message-secret',
      prompt,
      expectation: 'expectation',
      createdBy: ADMIN_BUSINESS_ID,
    });
    // 同一 agent 只允许一个 running：先创建并收口 head，再创建本次故障 run。
    const head = await repo.evalRepo.createEvalRun(app.db, {
      id: newId('evalRun'),
      agentId: agent.id,
      total: 0,
      createdBy: ADMIN_BUSINESS_ID,
      caseSnapshot: [],
    });
    await repo.evalRepo.finishEvalRun(app.db, head.id, { status: 'succeeded', passed: 0 });
    const run = await repo.evalRepo.createEvalRun(app.db, {
      id: newId('evalRun'),
      agentId: agent.id,
      total: 1,
      createdBy: ADMIN_BUSINESS_ID,
      caseSnapshot: [
        {
          id: testCase.id,
          name: testCase.name,
          prompt: testCase.prompt,
          expectation: testCase.expectation,
        },
      ],
    });

    const functionName = `eval_message_secret_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    await app.pool.query(`
      create or replace function ${functionName}() returns trigger language plpgsql as $fn$
      begin
        if new.content->>'text' = '${prompt}' then
          raise exception 'forced message insert failure';
        end if;
        return new;
      end;
      $fn$
    `);
    await app.pool.query(`
      create trigger ${functionName}
      before insert on messages
      for each row execute function ${functionName}()
    `);
    try {
      await executeEvalRun({ db: app.db, logger, redisUrl: 'redis://unused', evalRunId: run.id });
    } finally {
      await app.pool.query(`drop trigger if exists ${functionName} on messages`);
      await app.pool.query(`drop function if exists ${functionName}()`);
    }

    // 真实写入边界已把数据库异常原文收敛，持久化输出本身就是公开文案。
    const stored = await app.pool.query<{ output: string }>(
      'select output from eval_results where eval_run_id = $1',
      [run.id],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.output).toBe(EVAL_FAILURE_PUBLIC_MESSAGE);
    expectNoSqlLeak(stored.rows[0]?.output ?? '', secret);

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs/${run.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const detailResults = detail.json<{ results: Array<{ output: string }> }>().results;
    expect(detailResults).toHaveLength(1);
    expect(detailResults[0]?.output).toBe(EVAL_FAILURE_PUBLIC_MESSAGE);
    expectNoSqlLeak(detailResults[0]?.output ?? '', secret);

    const compare = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs/${run.id}/compare?head=${head.id}`,
      headers: { cookie },
    });
    expect(compare.statusCode, compare.body).toBe(200);
    const row = compare.json<{ rows: Array<{ base: { output: string } | null }> }>().rows[0];
    expect(row?.base?.output).toBe(EVAL_FAILURE_PUBLIC_MESSAGE);
    expectNoSqlLeak(row?.base?.output ?? '', secret);

    const exported = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs/${run.id}/export`,
      headers: { cookie },
    });
    expect(exported.statusCode, exported.body).toBe(200);
    const exportedResults = exported.json<{ results: Array<{ output: string }> }>().results;
    expect(exportedResults).toHaveLength(1);
    expect(exportedResults[0]?.output).toBe(EVAL_FAILURE_PUBLIC_MESSAGE);
    expectNoSqlLeak(exportedResults[0]?.output ?? '', secret);
  });
});
