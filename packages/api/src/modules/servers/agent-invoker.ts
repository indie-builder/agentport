import { fail, notFound } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import { isActiveRunStatus, isTerminalRunStatus, runEnqueueOptions } from '@agentport/shared';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../../http/context.js';
import { getQueue } from '../../queue/producer.js';
import { cancelAgentRun } from '../runs/cancel-run.js';
import { requireRunQueueCapacity } from '../runs/capacity.js';
import { failQueuedRunEnqueue, failRunEnqueue } from '../runs/enqueue.js';
import { enforceContentPolicy } from '../security/policy-gate.js';
import type { AgentInvoker } from './agent-tools.js';

const writeAudit = repo.audit.writeAudit;

const POLL_MS = 2_000;
const MAX_CONCURRENT_INVOKES = 4;
let activeInvokes = 0;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return Bun.sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason);
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([Bun.sleep(ms), aborted]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

export function createInvoker(app: AppContext): AgentInvoker {
  return {
    async invoke({ slug, prompt, timeoutMs, signal }): Promise<string> {
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
        if (!agent) notFound('agent', `agent ${slug} not found`);
        if (!agent.enabled) fail('AGENT_DISABLED', `agent ${slug} is disabled`);
        if (repo.agentLifecycle.isAgentInactive(agent)) {
          fail('AGENT_DISABLED', `agent ${slug} is archived or deleted`);
        }
        await requireRunQueueCapacity('run queue is full');
        if (signal?.aborted) fail('UPSTREAM_FAILED', 'agent run cancelled');

        const requestId = crypto.randomUUID();
        const policyDecision = await enforceContentPolicy({
          db: app.db,
          log: app.log,
          requestId,
          actor: 'mcp',
          anthropicBaseUrl: app.config.ANTHROPIC_BASE_URL,
          agentId: agent.id,
          origin: 'mcp',
          sourceKind: 'run_prompt',
          sourceId: requestId,
          texts: [prompt],
          payload: ([text]) => ({ data: text, binding: { slug, prompt } }),
        });
        if (signal?.aborted) fail('UPSTREAM_FAILED', 'agent run cancelled');
        const message = policyDecision.payload;
        const agentVersion = agent.publishedVersion;
        const { run, conversationId } = await repo.chat.admitChatRun(app.db, {
          agentId: agent.id,
          message,
          title: `mcp: ${message.slice(0, 60)}`,
          trigger: 'mcp',
          subject: { kind: 'service', serviceId: 'mcp' },
          ...(agentVersion === null ? {} : { agentVersion }),
          ...(policyDecision.eventId === null ? {} : { policyEventId: policyDecision.eventId }),
        });
        const abortRun = async (
          input: { slug: string; promptLength: number } | { reason: 'deadline' },
          message: string,
        ): Promise<never> => {
          if ((await cancelAgentRun(app, run.id)) !== null) {
            await writeAudit(app.db, app.log, {
              actor: 'mcp',
              actorKind: 'service',
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
        if (signal?.aborted) await cancelled();

        try {
          await getQueue().add(
            'run',
            { runId: run.id, agentId: agent.id, conversationId, prompt: message },
            runEnqueueOptions(run.id),
          );
        } catch (err) {
          try {
            const failed = await failQueuedRunEnqueue(app.db, run.id);
            if (failed) {
              await getQueue()
                .getJob(run.id)
                .then((job) => job?.remove())
                .catch(() => undefined);
            }
          } catch {
            app.log.warn({ runId: run.id }, 'MCP enqueue failure cleanup failed');
          }
          failRunEnqueue(err);
        }
        await writeAudit(app.db, app.log, {
          actor: 'mcp',
          actorKind: 'service',
          action: 'agent.run.requested',
          target: run.id,
          input: { slug, agentId: agent.id, promptLength: prompt.length },
          status: 'ok',
        });

        const deadline = Date.now() + Math.min(timeoutMs ?? agent.timeoutMs, 30 * 60_000);
        let status: string = 'queued';
        while (Date.now() < deadline) {
          if (signal?.aborted) await cancelled();
          try {
            await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), signal);
          } catch (err) {
            if (signal?.aborted) await cancelled();
            throw err;
          }
          if (signal?.aborted) await cancelled();
          const current = await repo.chat.getRun(app.db, run.id);
          if (!current) notFound('run', 'run disappeared');
          status = current.status;
          if (isTerminalRunStatus(status)) {
            if (status !== 'succeeded') {
              fail(
                'UPSTREAM_FAILED',
                `agent run ${run.id} ended with ${status}${current.error ? `: ${current.error}` : ''}`,
              );
            }
            if (signal?.aborted) await cancelled();
            break;
          }
        }
        if (isActiveRunStatus(status)) {
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
