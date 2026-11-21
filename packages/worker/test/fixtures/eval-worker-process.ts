import { createDb, newId, schema } from '@agentport/db';
import { type AgentRunJob, RUNS_QUEUE } from '@agentport/shared';
import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { runEvalJob } from '../../src/eval-job.js';
import { bunRedisConnection } from './bun-redis.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const evalRunId = process.env.EVAL_RUN_ID;
const evalQueueName = process.env.EVAL_QUEUE_NAME;
if (!databaseUrl || !redisUrl || !evalRunId || !evalQueueName) {
  process.stderr.write(
    'eval-worker-process: missing DATABASE_URL/REDIS_URL/EVAL_RUN_ID/EVAL_QUEUE_NAME\n',
  );
  process.exit(2);
}

const dbHandle = createDb(databaseUrl);
const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

const runRedis = bunRedisConnection(redisUrl);
const runWorker = new Worker<AgentRunJob>(
  RUNS_QUEUE,
  async (job) => {
    const { runId, conversationId, prompt } = job.data;
    if (prompt === 'first') {
      await dbHandle.db
        .update(schema.agentRuns)
        .set({ status: 'succeeded', startedAt: new Date(), endedAt: new Date() })
        .where(eq(schema.agentRuns.id, runId));
      await dbHandle.db.insert(schema.messages).values({
        id: newId('message'),
        conversationId,
        role: 'assistant',
        content: { type: 'text', text: 'first-ok' },
        runId,
      });
      return;
    }
    process.send?.({ type: 'ready' });
    await new Promise<void>(() => undefined);
  },
  { connection: runRedis.connection, lockDuration: 1_000 },
);

const evalRedis = bunRedisConnection(redisUrl);
const evalWorker = new Worker(
  evalQueueName,
  (job) => runEvalJob({ db: dbHandle.db, logger, redisUrl, job }),
  {
    connection: evalRedis.connection,
    concurrency: 1,
    lockDuration: 1_000,
    stalledInterval: 500,
  },
);

for (const worker of [runWorker, evalWorker]) {
  worker.on('error', () => undefined);
  worker.on('failed', (_job, err) => {
    process.stderr.write(`eval-worker-process: job failed: ${err.message}\n`);
  });
}

process.on('disconnect', () => {
  void runRedis.close();
  void evalRedis.close();
  process.exit(0);
});
