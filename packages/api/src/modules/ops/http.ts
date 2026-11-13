import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { HonoAdapter } from '@bull-board/hono';
import { type Context, Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import type { AppContext, HttpEnv } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import {
  getEvalQueue,
  getKnowledgeQueue,
  getMonitoringQueues,
  getQueue,
  getRuntimeEnvironmentBuildQueue,
} from '../../queue/producer.js';
import { getScheduleQueue } from './schedule-sync.js';

const BASE_PATH = '/api/ops/queues';

function createBoard(context: AppContext): Hono<HttpEnv> {
  const serverAdapter = new HonoAdapter(serveStatic).setBasePath(BASE_PATH);
  createBullBoard({
    queues: [
      getQueue(),
      getEvalQueue(),
      getKnowledgeQueue(),
      getRuntimeEnvironmentBuildQueue(),
      getScheduleQueue(context.config.REDIS_URL),
      ...getMonitoringQueues(),
    ].map((queue) => new BullMQAdapter(queue, { readOnlyMode: true })),
    serverAdapter,
  });
  return new Hono<HttpEnv>({ strict: false })
    .onError((error) => {
      throw error;
    })
    .route(BASE_PATH, serverAdapter.registerPlugin());
}

export function registerOpsQueuesHttp(app: Hono<HttpEnv>, context: AppContext): void {
  let board: Hono<HttpEnv> | undefined;
  const handle = (c: Context<HttpEnv>) => {
    board ??= createBoard(context);
    return board.fetch(c.req.raw, c.env);
  };
  const check = access({ kind: 'permission', permissionId: 'operations.read' });
  app.all(BASE_PATH, check, handle);
  app.all(`${BASE_PATH}/*`, check, handle);
}
