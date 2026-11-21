import { workflowsContract } from '@agentport/contract/workflows';
import { fail, NOT_FOUND_MESSAGES, parseWorkflowMeta } from '@agentport/core';
import { repo as allRepo } from '@agentport/db';
import { implement } from '@orpc/server';
import { actorOf } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { rethrowConflict } from '../../http/errors.js';
import { authorizedAgent } from '../agents/access.js';
import { toApi, toWorkflowWrite } from './api.js';

const repo = allRepo.workflows;
function assertRootAgent(agent: { parentId: string | null }): void {
  if (agent.parentId !== null) {
    fail('INVALID_INPUT', '子智能体不能拥有工作流；工作流是 project 级能力，请在主智能体上配置');
  }
}
const os = implement(workflowsContract).$context<RequestContext>();
export const workflowsRouter = os.router({
  list: os.list.handler(async ({ context, input: routeInput }) => {
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.workflows.read');
    assertRootAgent(agent);
    const rows = await repo.listWorkflows(context.db, agent.id);
    return rows.map(toApi);
  }),
  create: os.create.handler(async ({ context, input: routeInput }) => {
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.workflows.write');
    assertRootAgent(agent);
    const input = toWorkflowWrite(routeInput.body.slug, routeInput.body.content);
    try {
      const row = await allRepo.agentVersions.retryOnVersionConflict(() =>
        context.db.transaction(async (tx) => {
          const created = await repo.createWorkflow(tx, agent.id, input);
          await allRepo.agentDefinitions.recordDraftVersionTx(tx, agent.id, null);
          return created;
        }),
      );
      await allRepo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'agent.workflow.created',
        target: row.id,
        input: { agentId: agent.id, slug: row.slug },
        status: 'ok',
        requestId: context.requestId,
      });
      return toApi(row);
    } catch (err) {
      rethrowConflict(err, '该 slug 已被其他工作流占用，请换一个');
    }
  }),
  update: os.update.handler(async ({ context, input: routeInput }) => {
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.workflows.write');
    assertRootAgent(agent);
    const meta = parseWorkflowMeta(routeInput.body.content);
    const row = await allRepo.agentVersions.retryOnVersionConflict(() =>
      context.db.transaction(async (tx) => {
        const updated = await repo.updateWorkflow(
          tx,
          agent.id,
          routeInput.params.workflowId,
          { ...meta, content: routeInput.body.content },
          routeInput.body.expectedUpdatedAt === undefined
            ? undefined
            : new Date(routeInput.body.expectedUpdatedAt),
        );
        if (!updated) return null;
        await allRepo.agentDefinitions.recordDraftVersionTx(tx, agent.id, null);
        return updated;
      }),
    );
    if (!row) return fail('NOT_FOUND', NOT_FOUND_MESSAGES.workflow);
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'agent.workflow.updated',
      target: row.id,
      input: { agentId: agent.id, slug: row.slug },
      status: 'ok',
      requestId: context.requestId,
    });
    return toApi(row);
  }),
  delete: os.delete.handler(async ({ context, input: routeInput }) => {
    const agent = await authorizedAgent(context, routeInput.params.id, 'agents.workflows.write');
    assertRootAgent(agent);
    const ok = await allRepo.agentVersions.retryOnVersionConflict(() =>
      context.db.transaction(async (tx) => {
        const deleted = await repo.deleteWorkflow(tx, agent.id, routeInput.params.workflowId);
        if (!deleted) return false;
        await allRepo.agentDefinitions.recordDraftVersionTx(tx, agent.id, null);
        return true;
      }),
    );
    if (!ok) return fail('NOT_FOUND', NOT_FOUND_MESSAGES.workflow);
    await allRepo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'agent.workflow.deleted',
      target: routeInput.params.workflowId,
      input: { agentId: agent.id },
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
});
