import { agentRunJobSchema } from '@agentport/shared';
import { Worker } from 'bullmq';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

const worker = new Worker(
  'agent-runs',
  async (job) => {
    const parsed = agentRunJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(`invalid job payload: ${parsed.error.message}`);
    }
    // M4 在此接入沙盒：创建容器 → 挂载工作区 → 跑 runner → 转发事件
    logger.info({ runId: parsed.data.runId }, 'agent run received (sandbox not wired yet)');
    throw new Error('agent execution not implemented yet');
  },
  { connection: { url: redisUrl }, concurrency: Number(process.env.AGENT_MAX_CONCURRENT ?? 2) },
);

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'job failed');
});

logger.info('worker started');

const shutdown = async () => {
  await worker.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
