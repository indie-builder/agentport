import { channelsContract } from '@agentport/contract/channels';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import { implement } from '@orpc/server';
import { actorOf, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { toIso } from '../../lib/iso.js';
import { recheckRunApproval } from '../servers/approval-policy.js';
import { CHANNEL_MEMBER_MISSING } from './errors.js';

const approvalsRepo = repo.channelApprovals;
function toItem(item: repo.channelApprovals.ChannelApprovalItem) {
  return {
    id: item.id,
    channelId: item.channelId,
    runId: item.runId,
    serverId: item.serverId,
    serverName: item.serverName,
    toolName: item.toolName,
    argumentsSummary: item.argumentsSummary,
    createdAt: item.createdAt.toISOString(),
    approvedAt: toIso(item.approvedAt),
    expiresAt: toIso(item.expiresAt),
  };
}
const CONFLICT_MESSAGE = {
  decided: '该审批请求已被其他成员处理，请刷新后重试',
  decision_changed: '工具审批判定已变更，请让智能体重新发起',
  expired: '该审批请求已过期，请让智能体重新发起',
  run_inactive: '运行已结束或尚未开始，无法批准；请刷新运行状态',
} as const;
const DENY_CONFLICT_MESSAGE = {
  ...CONFLICT_MESSAGE,
  run_inactive: '运行已结束或尚未开始，无法拒绝；请刷新运行状态',
} as const;
const os = implement(channelsContract).$context<RequestContext>();
export const channelsApprovalsRouter = {
  approvals: os.approvals.handler(async ({ input, context }) => {
    const result = await approvalsRepo.listChannelApprovals(context.db, {
      channelId: input.params.id,
      businessId: requireUser(context).businessId,
    });
    if (result.kind === 'not_found') {
      return fail('NOT_FOUND', CHANNEL_MEMBER_MISSING);
    }
    return { items: result.items.map(toItem) };
  }),
  approve: os.approve.handler(async ({ input, context }) => {
    const result = await approvalsRepo.approveChannelApproval(
      context.db,
      {
        channelId: input.params.id,
        approvalId: input.params.approvalId,
        businessId: requireUser(context).businessId,
      },
      recheckRunApproval(context.log),
    );
    switch (result.kind) {
      case 'not_found':
        return fail('NOT_FOUND', '审批请求不存在或不属于该频道');
      case 'forbidden':
        return fail('FORBIDDEN', '当前频道角色无权批准该请求');
      case 'conflict':
        return fail('CONFLICT', CONFLICT_MESSAGE[result.reason]);
      case 'ok': {
        await repo.notifications
          .markBySource(context.db, 'approval', `channel-approval:${result.approval.id}`)
          .catch((err: unknown) => {
            context.log.warn(
              { err, approvalId: result.approval.id },
              'approval notification mark-read failed',
            );
          });
        await repo.audit.writeAudit(context.db, context.log, {
          actor: actorOf(context),
          action: 'agent.run.approved',
          target: result.approval.runId,
          input: {
            approvalId: result.approval.id,
            serverId: result.approval.serverId,
            toolName: result.approval.toolName,
          },
          status: 'ok',
          requestId: context.requestId,
        });
        return toItem(result.approval);
      }
    }
  }),
  deny: os.deny.handler(async ({ input, context }) => {
    const result = await approvalsRepo.denyChannelApproval(
      context.db,
      {
        channelId: input.params.id,
        approvalId: input.params.approvalId,
        businessId: requireUser(context).businessId,
      },
      recheckRunApproval(context.log),
    );
    switch (result.kind) {
      case 'not_found':
        return fail('NOT_FOUND', '审批请求不存在或不属于该频道');
      case 'forbidden':
        return fail('FORBIDDEN', '当前频道角色无权拒绝该请求');
      case 'conflict':
        return fail('CONFLICT', DENY_CONFLICT_MESSAGE[result.reason]);
      case 'ok': {
        await repo.notifications
          .markBySource(context.db, 'approval', `channel-approval:${result.approval.id}`)
          .catch((err: unknown) => {
            context.log.warn(
              { err, approvalId: result.approval.id },
              'deny notification mark-read failed',
            );
          });
        await repo.audit.writeAudit(context.db, context.log, {
          actor: actorOf(context),
          action: 'agent.run.denied',
          target: result.approval.runId,
          input: {
            approvalId: result.approval.id,
            serverId: result.approval.serverId,
            toolName: result.approval.toolName,
          },
          status: 'ok',
          requestId: context.requestId,
        });
        return toItem(result.approval);
      }
    }
  }),
};
