import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import type { AppContext } from '../../http/context.js';
import { isRunCancelRequested, publishChannelEventSafely } from '../../queue/producer.js';
import { evaluateLockedApproval, getRunApprovalTool } from './approval-policy.js';
import { summarizeToolArguments } from './tool-arguments.js';

export async function requestToolApproval(
  app: AppContext,
  runId: string,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  expected: { decisionHash: string },
) {
  if (await isRunCancelRequested(runId)) fail('CONFLICT', '运行已取消，调用未执行');
  const approval = await app.db.transaction(async (tx) => {
    const run = await repo.runs.lockRunForApproval(tx, runId);
    if (run?.status !== 'running' && run?.status !== 'queued') return null;
    const tool = await getRunApprovalTool(tx, runId, serverId, toolName);
    if (tool === null) return null;
    const decision = await evaluateLockedApproval(tx, runId, serverId, tool);
    if (decision?.effectiveMode !== 'ask' || decision.decisionHash !== expected.decisionHash)
      return null;
    const approval = await repo.runs.requestApproval(tx, {
      runId,
      serverId,
      toolName,
      decisionHash: decision.decisionHash,
      expiresAt: new Date(Date.now() + app.config.APPROVAL_WAIT_MS),
      argumentsSummary: summarizeToolArguments(args),
    });
    if (approval.approvedAt !== null || approval.deniedAt !== null) return approval;
    const webhookOwner = await repo.runs.getRunInitiator(tx, runId);
    if (webhookOwner === null) return approval;
    const server = await repo.servers.getServer(tx, serverId);
    await repo.integrations.enqueueWebhookEvent(tx, {
      eventType: 'approval.requested',
      sourceId: `approval:${runId}:${approval.id}`,
      ownerBusinessId: webhookOwner,
      payload: JSON.stringify({
        runId,
        approvalId: approval.id,
        serverId,
        serverName: server?.name ?? null,
        toolName: approval.toolName,
        channelId: approval.channelId,
        matchedRuleIds: decision.matchedRuleIds,
        expiresAt: approval.expiresAt?.toISOString() ?? null,
      }),
    });
    return approval;
  });
  if (approval === null) fail('CONFLICT', '工具审批判定已变更，调用未执行');
  if (approval.approvedAt !== null || approval.deniedAt !== null) return approval;
  if (approval.channelId === null) {
    const recipient = await repo.runs.getRunInitiator(app.db, runId).catch((err: unknown) => {
      app.log.warn({ err, runId, approvalId: approval.id }, 'approval recipient lookup failed');
      return null;
    });
    if (recipient !== null) {
      await repo.notifications
        .createNotification(app.db, {
          businessId: recipient,
          kind: 'approval',
          title: '工具调用等待审批',
          body: `工具 ${approval.toolName} 正在等待你的批准`,
          link: `/runs/${runId}`,
          sourceId: `approval:${runId}:${approval.id}`,
        })
        .catch((err: unknown) => {
          app.log.warn({ err, runId, approvalId: approval.id }, 'approval notification failed');
        });
    }
    return approval;
  }
  const approvers = await repo.channels
    .listChannelApproverBusinessIds(app.db, approval.channelId)
    .catch((err: unknown) => {
      app.log.warn(
        { err, channelId: approval.channelId, approvalId: approval.id },
        'channel approver lookup failed',
      );
      return [];
    });
  await Promise.all(
    approvers.map((businessId) =>
      repo.notifications
        .createNotification(app.db, {
          businessId,
          kind: 'approval',
          title: '频道工具调用等待审批',
          body: `工具 ${approval.toolName} 正在等待你批准`,
          link: `/channels/${approval.channelId}`,
          sourceId: `channel-approval:${approval.id}`,
        })
        .catch((err: unknown) => {
          app.log.warn(
            { err, businessId, approvalId: approval.id },
            'channel approval notification failed',
          );
        }),
    ),
  );
  await publishChannelEventSafely(
    app.log,
    approval.channelId,
    {
      type: 'approval.requested',
      channelId: approval.channelId,
      runId,
      approvalId: approval.id,
      toolName: approval.toolName,
    },
    { runId, approvalId: approval.id },
  );
  return approval;
}
