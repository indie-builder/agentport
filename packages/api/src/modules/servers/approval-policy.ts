import { evaluateToolApproval, fail } from '@agentport/core';
import { type DbHandle, repo, type Transaction } from '@agentport/db';
import {
  type ApiTool,
  apiToolApprovalModeSchema,
  apiToolParamsInSchema,
  toolApprovalMethodSchema,
} from '@agentport/shared';
import type { RequestContext } from '../../http/context.js';
import { isRunCancelRequested } from '../../queue/producer.js';
import { str } from './repo.js';
import { summarizeToolArguments } from './tool-arguments.js';

type ApprovalTool = Pick<
  ApiTool,
  'id' | 'name' | 'method' | 'pathTemplate' | 'approvalMode' | 'paramsIn'
> & { baseUrl: string };

export function createApprovalEvaluator({
  db,
  runId,
  serverId,
}: {
  db: DbHandle;
  runId: string;
  serverId: string;
}) {
  return async (tool: Omit<ApprovalTool, 'baseUrl'>) => {
    const decision = await db.transaction(async (tx) => {
      if (!(await repo.runs.lockRunForApproval(tx, runId))) return null;
      const currentTool = await getRunApprovalTool(tx, runId, serverId, tool.name);
      if (currentTool === null) {
        await repo.runs.supersedeMismatchedApprovals(tx, {
          runId,
          serverId,
          toolName: tool.name,
          decisionHash: null,
        });
        return null;
      }
      const current = await evaluateLockedApproval(tx, runId, serverId, currentTool);
      return currentTool.id === tool.id &&
        currentTool.method === tool.method &&
        currentTool.pathTemplate === tool.pathTemplate &&
        currentTool.approvalMode === tool.approvalMode &&
        currentTool.paramsIn === tool.paramsIn
        ? current
        : null;
    });
    return decision ?? fail('FORBIDDEN', '无法确认运行发起者的工具审批身份');
  };
}

export async function evaluateLockedApproval(
  tx: Transaction,
  runId: string,
  serverId: string,
  tool: ApprovalTool,
) {
  const scope = { runId, serverId, toolName: tool.name };
  const subject = (await repo.runs.isRunBoundToServer(tx, runId, serverId))
    ? await repo.runs.getRunApprovalSubject(tx, runId)
    : null;
  if (subject === null) {
    await repo.runs.supersedeMismatchedApprovals(tx, { ...scope, decisionHash: null });
    return null;
  }
  const selected = {
    serverId,
    agentId: subject.agentId,
    toolId: tool.id,
    method: tool.method,
    pathTemplate: tool.pathTemplate,
  };
  const rules = await repo.toolApprovalPolicies.listEnabledForTool(tx, selected);
  const decision = evaluateToolApproval(apiToolApprovalModeSchema.parse(tool.approvalMode), rules, {
    ...selected,
    baseUrl: tool.baseUrl,
    paramsIn: tool.paramsIn,
    roles: subject.roles,
  });
  const key = { ...scope, decisionHash: decision.decisionHash };
  await repo.runs.supersedeMismatchedApprovals(tx, key);
  const approval =
    decision.effectiveMode === 'ask' ? await repo.runs.getCurrentApproval(tx, key) : null;
  return {
    ...decision,
    matchedRuleIds: decision.matchedRules.map((rule) => rule.id),
    approved: approval?.approvedAt != null,
    approval,
  };
}

export async function getRunApprovalTool(
  db: DbHandle,
  runId: string,
  serverId: string,
  toolName: string,
): Promise<ApprovalTool | null> {
  const snapshot = await repo.runs.getRunServerSnapshot(db, runId, serverId);
  if (snapshot !== null && snapshot.kind !== 'generated') return null;
  const [server, currentTool] = await Promise.all([
    repo.servers.getServer(db, serverId),
    repo.servers.getApiToolByName(db, serverId, toolName),
  ]);
  if (server?.kind !== 'generated' || !currentTool?.enabled) return null;
  const current: ApprovalTool = {
    id: currentTool.id,
    name: currentTool.name,
    method: toolApprovalMethodSchema.parse(currentTool.method),
    pathTemplate: currentTool.pathTemplate,
    approvalMode: apiToolApprovalModeSchema.parse(currentTool.approvalMode),
    paramsIn: apiToolParamsInSchema.parse(currentTool.paramsIn),
    baseUrl: str(snapshot !== null ? snapshot.config.baseUrl : server.config.baseUrl),
  };
  if (snapshot?.tools === undefined) return current;
  const snapshotTool = snapshot.tools.find((tool) => tool.enabled && tool.name === toolName);
  if (!snapshotTool) return null;
  return snapshotTool.id === current.id &&
    snapshotTool.method === current.method &&
    snapshotTool.pathTemplate === current.pathTemplate &&
    snapshotTool.approvalMode === current.approvalMode &&
    snapshotTool.paramsIn === current.paramsIn
    ? current
    : null;
}

export function recheckRunApproval(log: RequestContext['log']): repo.runs.RecheckApproval {
  return async (db, { runId, serverId, toolName }) => {
    try {
      if (await isRunCancelRequested(runId)) return null;
      const tool = await getRunApprovalTool(db, runId, serverId, toolName);
      if (tool === null) return null;
      const decision = await evaluateLockedApproval(db, runId, serverId, tool);
      return decision?.effectiveMode === 'ask' ? decision.decisionHash : null;
    } catch (err) {
      log.warn({ err, runId, serverId, toolName }, 'tool approval decision recheck failed');
      return null;
    }
  };
}

export async function auditToolPolicyDenial(
  context: Pick<RequestContext, 'db' | 'log'>,
  input: {
    runId: string | null;
    serverId: string;
    toolName: string;
    args?: Record<string, unknown>;
    matchedRuleIds?: readonly string[];
  },
) {
  await repo.audit.writeAudit(context.db, context.log, {
    action: 'mcp.tool.denied',
    target: input.serverId,
    input: {
      toolName: input.toolName,
      runId: input.runId,
      ...(input.args === undefined ? {} : { args: summarizeToolArguments(input.args) }),
    },
    ...(input.matchedRuleIds?.length
      ? { detail: { matchedRuleIds: JSON.stringify(input.matchedRuleIds) } }
      : {}),
    status: 'denied',
  });
}
