import { repo } from '@agentport/db';
import type { AppContext } from '../../http/context.js';
import { publishChannelEventSafely } from '../channels/publish.js';
import { summarizeToolArguments } from './tool-arguments.js';

export async function requestToolApproval(
  app: AppContext,
  runId: string,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
) {
  const approval = await app.db.transaction(async (tx) => {
    const approval = await repo.runs.requestApproval(tx, {
      runId,
      serverId,
      toolName,
      expiresAt: new Date(Date.now() + app.config.APPROVAL_WAIT_MS),
      argumentsSummary: summarizeToolArguments(args),
    });
    if (approval.approvedAt !== null || approval.deniedAt !== null) return approval;
    const webhookOwner = await repo.runs.getRunInitiator(tx, runId);
    if (webhookOwner === null) return approval;
    const server = await repo.servers.getServer(tx, serverId);
    await repo.integrations.enqueueWebhookEvent(tx, {
      eventType: 'approval.requested',
      sourceId: `approval:${runId}:${serverId}:${approval.toolName}`,
      ownerBusinessId: webhookOwner,
      payload: JSON.stringify({
        runId,
        serverId,
        serverName: server?.name ?? null,
        toolName: approval.toolName,
        channelId: approval.channelId,
        expiresAt: approval.expiresAt?.toISOString() ?? null,
      }),
    });
    return approval;
  });
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
          sourceId: `approval:${runId}:${serverId}:${approval.toolName}`,
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
