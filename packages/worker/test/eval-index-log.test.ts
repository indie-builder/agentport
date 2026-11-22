import { describe, expect, it, mock } from 'bun:test';
import { inspect } from 'node:util';
import { DbError } from '@agentport/core';
import type { Database } from '@agentport/db';
import type { Logger } from 'pino';
import { createEvalFailedHandler } from '../src/handlers.js';

const failedSecret = `sk-live-eval-failed-${crypto.randomUUID()}`;
const settleSecret = `sk-live-eval-settle-${crypto.randomUUID()}`;
const failedError = new DbError(
  `Failed query: update "eval_runs" set "claimed_at" = $1 params: ${failedSecret}`,
  { code: 'P0001', message: `forced failure ${failedSecret}` },
);
const settlementError = new DbError(
  `Failed query: update "eval_runs" set "status" = $1 params: ${settleSecret}`,
  { code: '42P01', message: `forced failure ${settleSecret}` },
);

describe('createEvalFailedHandler', () => {
  it('logs only jobId/errorName/errorCode, never the SQL error text or params', async () => {
    const errors: unknown[][] = [];
    const logger = {
      error: (...args: unknown[]) => {
        errors.push(args);
      },
      info: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
    } as unknown as Logger;
    const handleFailed = mock(async () => {
      throw settlementError;
    });
    const db = {} as unknown as Database;

    const failed = createEvalFailedHandler({ db, logger, handleFailed });
    const job = { id: 'eval-job-1', data: undefined };
    failed(job, failedError);

    await Promise.resolve();
    await Promise.resolve();

    expect(errors.length).toBe(2);
    const failedLog = errors.find((args) => args[1] === 'eval job failed');
    expect(failedLog?.[0]).toEqual({
      jobId: 'eval-job-1',
      errorName: 'DbError',
      errorCode: 'P0001',
    });
    const settleLog = errors.find((args) => args[1] === 'eval job failure settlement failed');
    expect(settleLog?.[0]).toEqual({
      jobId: 'eval-job-1',
      errorName: 'DbError',
      errorCode: '42P01',
    });

    expect(handleFailed).toHaveBeenCalledWith({
      db,
      logger,
      job,
      error: failedError,
    });

    const serialized = inspect(errors, { depth: 8 });
    expect(serialized).not.toContain(failedSecret);
    expect(serialized).not.toContain(settleSecret);
    expect(serialized).not.toMatch(/Failed query|params:/);
  });
});
