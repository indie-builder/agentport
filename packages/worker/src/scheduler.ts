import { type createDb, newId, repo, schema } from '@agentport/db';
import { RUNS_QUEUE, runEnqueueOptions } from '@agentport/shared';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

/** 每 30s 扫描一次到期定时任务。单机场景足够，多个 worker 由 claim 的条件更新去重。 */
const TICK_MS = 30_000;

type Db = ReturnType<typeof createDb>['db'];

/**
 * 自主工作：到点的 agent_schedules 各起一条 trigger='schedule' 的运行。
 * 触发方式用的是平台已有的 BullMQ 运行队列，不引入新的调度执行引擎。
 */
export function startScheduleTicker(input: { db: Db; logger: Logger; redisUrl: string }): {
  stop: () => Promise<void>;
} {
  const queue = new Queue(RUNS_QUEUE, { connection: { url: input.redisUrl } });
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function fireSchedule(schedule: {
    id: string;
    agentId: string;
    name: string;
    prompt: string;
  }): Promise<void> {
    const [agent] = await input.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, schedule.agentId))
      .limit(1);
    if (!agent || !agent.enabled) {
      input.logger.warn({ scheduleId: schedule.id }, 'skip schedule: agent missing or disabled');
      return;
    }
    const conversation = await repo.chat.createConversation(input.db, {
      id: newId('conversation'),
      agentId: agent.id,
      title: `定时: ${schedule.name}`.slice(0, 80),
    });
    const agentVersion = await repo.agentVersions.latestAgentVersion(input.db, agent.id);
    const run = await repo.chat.createRun(input.db, {
      id: newId('run'),
      conversationId: conversation.id,
      agentId: agent.id,
      trigger: 'schedule',
      ...(agentVersion === null ? {} : { agentVersion }),
    });
    await repo.chat.appendMessage(input.db, {
      id: newId('message'),
      conversationId: conversation.id,
      role: 'user',
      content: { type: 'text', text: schedule.prompt },
      runId: run.id,
    });
    try {
      await queue.add(
        'run',
        {
          runId: run.id,
          agentId: agent.id,
          conversationId: conversation.id,
          prompt: schedule.prompt,
        },
        runEnqueueOptions(run.id),
      );
    } catch (err) {
      input.logger.error({ err, runId: run.id }, 'schedule enqueue failed');
      await input.db
        .update(schema.agentRuns)
        .set({
          status: 'failed',
          endedAt: new Date(),
          error: '定时任务入队失败',
          errorKind: 'infra',
        })
        .where(eq(schema.agentRuns.id, run.id));
      return;
    }
    await repo.audit.writeAudit(input.db, input.logger, {
      actor: 'worker',
      action: 'schedule.fired',
      target: schedule.id,
      input: { runId: run.id, agentId: agent.id },
      status: 'ok',
    });
    input.logger.info({ scheduleId: schedule.id, runId: run.id }, 'schedule fired');
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const due = await repo.ops.claimDueSchedules(input.db);
      for (const schedule of due) await fireSchedule(schedule);
    } catch (err) {
      input.logger.error({ err }, 'schedule tick failed');
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), TICK_MS);
      timer.unref();
    }
  }

  void tick();
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await queue.close();
    },
  };
}
