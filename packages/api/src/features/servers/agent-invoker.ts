import { newId, repo, schema } from '@agentport/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getQueue } from '../../queue/producer.js';
import type { AgentInvoker } from './agent-tools.js';

const POLL_MS = 500;

/**
 * 外部 Host 调用智能体的执行器：复用同一套队列与沙盒，只是发起方不是浏览器。
 * 通过轮询 run 状态等待终态；不订阅 Redis，避免与 SSE 客户端竞争事件流。
 */
export function createInvoker(app: FastifyInstance): AgentInvoker {
  return {
    async invoke({ slug, prompt, timeoutMs }): Promise<string> {
      const rows = await app.db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.slug, slug))
        .limit(1);
      const agent = rows[0];
      if (!agent) throw new Error(`agent ${slug} not found`);
      if (!agent.enabled) throw new Error(`agent ${slug} is disabled`);

      const conversation = await repo.chat.createConversation(app.db, {
        id: newId('conversation'),
        agentId: agent.id,
        title: `mcp: ${prompt.slice(0, 60)}`,
      });
      const run = await repo.chat.createRun(app.db, {
        id: newId('run'),
        conversationId: conversation.id,
        agentId: agent.id,
      });
      await repo.chat.appendMessage(app.db, {
        id: newId('message'),
        conversationId: conversation.id,
        role: 'user',
        content: { type: 'text', text: prompt },
        runId: run.id,
      });
      await getQueue().add(
        'run',
        { runId: run.id, agentId: agent.id, conversationId: conversation.id, prompt },
        { jobId: run.id, attempts: 2, backoff: { type: 'exponential', delay: 5_000 } },
      );

      const deadline = Date.now() + Math.min(timeoutMs ?? agent.timeoutMs, 30 * 60_000);
      let status: string = 'queued';
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const current = await repo.chat.getRun(app.db, run.id);
        if (!current) throw new Error('run disappeared');
        status = current.status;
        if (
          status === 'succeeded' ||
          status === 'failed' ||
          status === 'cancelled' ||
          status === 'timeout'
        ) {
          if (status !== 'succeeded') {
            throw new Error(
              `agent run ${run.id} ended with ${status}${current.error ? `: ${current.error}` : ''}`,
            );
          }
          break;
        }
      }
      if (status === 'queued' || status === 'running') {
        throw new Error(`agent run ${run.id} timed out`);
      }

      const messages = await repo.chat.listMessages(app.db, conversation.id);
      const text = messages
        .filter((message) => message.role === 'assistant')
        .map((message) => {
          const content = message.content;
          if (typeof content === 'object' && content !== null && 'text' in content) {
            return typeof content.text === 'string' ? content.text : '';
          }
          return '';
        })
        .filter((part) => part.length > 0)
        .join('\n\n');
      return text.length > 0 ? text : '（智能体没有产生文本输出）';
    },
  };
}
