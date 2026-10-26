import { fail } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import { RUN_QUEUE_MAX_WAITING, runEnqueueOptions } from '@agentport/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../plugins/audit.js';
import { getQueue } from '../../queue/producer.js';
import { cancelAgentRun } from '../chat/cancel-run.js';
import type { AgentInvoker } from './agent-tools.js';

const POLL_MS = 2_000;
/** 每次 invoke 最长 30 分钟会占用连接池，必须有并发上限。 */
const MAX_CONCURRENT_INVOKES = 4;
let activeInvokes = 0;

/**
 * 外部 Host 调用智能体的执行器：复用同一套队列与沙盒，只是发起方不是浏览器。
 * 通过轮询 run 状态等待终态；不订阅 Redis，避免与 SSE 客户端竞争事件流。
 */
export function createInvoker(app: FastifyInstance): AgentInvoker {
  return {
    async invoke({ slug, prompt, timeoutMs, signal }): Promise<string> {
      // 非正/非有限超时会造出一个立即过期的 run，必须在任何读写之前拒绝。
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        fail('INVALID_INPUT', 'timeoutMs must be a positive finite number');
      }
      if (activeInvokes >= MAX_CONCURRENT_INVOKES) {
        fail('SERVICE_UNAVAILABLE', 'too many concurrent invokes');
      }
      activeInvokes++;
      try {
        const rows = await app.db
          .select()
          .from(schema.agents)
          .where(eq(schema.agents.slug, slug))
          .limit(1);
        const agent = rows[0];
        if (!agent) fail('AGENT_NOT_FOUND', `agent ${slug} not found`);
        if (!agent.enabled) fail('AGENT_DISABLED', `agent ${slug} is disabled`);
        if ((await getQueue().getWaitingCount()) > RUN_QUEUE_MAX_WAITING) {
          fail('SERVICE_UNAVAILABLE', 'run queue is full');
        }
        // 已取消的调用不落任何 run/会话，避免为没人等的结果排队。
        if (signal?.aborted) fail('UPSTREAM_FAILED', 'agent run cancelled');

        const agentVersion = await repo.agentVersions.latestAgentVersion(app.db, agent.id);
        // 与浏览器入口共用同一准入事务：会话、run、用户消息一起提交或回滚。
        const { run, conversationId } = await repo.chat.admitChatRun(app.db, {
          agentId: agent.id,
          message: prompt,
          title: `mcp: ${prompt.slice(0, 60)}`,
          trigger: 'mcp',
          ...(agentVersion === null ? {} : { agentVersion }),
        });
        const abortRun = async (
          input: { slug: string; promptLength: number } | { reason: 'deadline' },
          message: string,
        ): Promise<never> => {
          if (await cancelAgentRun(app, run.id)) {
            await writeAudit(app.db, app.log, {
              actor: 'mcp',
              action: 'agent.run.cancelled',
              target: run.id,
              input,
              status: 'ok',
            });
          }
          fail('UPSTREAM_FAILED', message);
        };
        const cancelled = (): Promise<never> =>
          abortRun({ slug, promptLength: prompt.length }, 'agent run cancelled');
        // 取消可能发生在造 run 期间：信号已断就不要再入队。
        if (signal?.aborted) await cancelled();

        try {
          await getQueue().add(
            'run',
            { runId: run.id, agentId: agent.id, conversationId, prompt },
            runEnqueueOptions(run.id),
          );
        } catch (err) {
          // 只收口仍由本次调用持有的 queued run；worker 已领取或已终态时不得覆盖。
          try {
            const [failed] = await app.db
              .update(schema.agentRuns)
              .set({
                status: 'failed',
                endedAt: new Date(),
                error: '消息入队失败，请重新发送。',
                errorKind: 'infra',
              })
              .where(and(eq(schema.agentRuns.id, run.id), eq(schema.agentRuns.status, 'queued')))
              .returning({ id: schema.agentRuns.id });
            if (failed) {
              await getQueue()
                .getJob(run.id)
                .then((job) => job?.remove())
                .catch(() => undefined);
            }
          } catch {
            // 清理也失败时没有可安全回显的细节，仍然返回固定的入队失败。
          }
          // 不把 Redis 连接串/凭证回给 MCP 客户端；原始错误只作为 cause 留在本地。
          fail('SERVICE_UNAVAILABLE', '运行入队失败，请稍后重试', { cause: err });
        }
        await writeAudit(app.db, app.log, {
          actor: 'mcp',
          action: 'agent.run.requested',
          target: run.id,
          input: { slug, agentId: agent.id, promptLength: prompt.length },
          status: 'ok',
        });

        const deadline = Date.now() + Math.min(timeoutMs ?? agent.timeoutMs, 30 * 60_000);
        let status: string = 'queued';
        while (Date.now() < deadline) {
          if (signal?.aborted) await cancelled();
          // 别让一轮睡眠跨过截止时间，否则超时最多晚 POLL_MS。
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))),
          );
          // 读状态失败时不猜：cancelAgentRun 可能在 DB 不可用时造出错误的终态。
          const current = await repo.chat.getRun(app.db, run.id);
          if (!current) fail('RUN_NOT_FOUND', 'run disappeared');
          status = current.status;
          if (
            status === 'succeeded' ||
            status === 'failed' ||
            status === 'cancelled' ||
            status === 'timeout'
          ) {
            if (status !== 'succeeded') {
              fail(
                'UPSTREAM_FAILED',
                `agent run ${run.id} ended with ${status}${current.error ? `: ${current.error}` : ''}`,
              );
            }
            // 接受结果前最后一次检查取消：abort 可能刚好在上一轮睡眠/查询之后到达。
            if (signal?.aborted) await cancelled();
            break;
          }
        }
        // 停止信号仍然有效，worker 写入的终态优先保留。
        if (status === 'queued' || status === 'running') {
          await abortRun({ reason: 'deadline' }, `agent run ${run.id} timed out`);
        }

        const messages = await repo.chat.listMessages(app.db, conversationId);
        const text = messages
          .filter((message) => message.role === 'assistant')
          .map((message) => repo.chat.messageText(message.content) ?? '')
          .filter((part) => part.length > 0)
          .join('\n\n');
        return text.length > 0 ? text : '（智能体没有产生文本输出）';
      } finally {
        activeInvokes--;
      }
    },
  };
}
