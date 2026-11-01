import { repo } from '@agentport/db';
import { idParams } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { actorOf, userPrincipal } from '../access.js';

const approvalParams = z.object({ id: z.string().min(1), approvalId: z.string().min(1) });

const approvalsRepo = repo.channelApprovals;

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toItem(item: repo.channelApprovals.ChannelApprovalItem) {
  return {
    id: item.id,
    channelId: item.channelId,
    runId: item.runId,
    serverId: item.serverId,
    serverName: item.serverName,
    toolName: item.toolName,
    createdAt: item.createdAt.toISOString(),
    approvedAt: toIso(item.approvedAt),
    expiresAt: toIso(item.expiresAt),
  };
}

const CONFLICT_MESSAGE = {
  decided: '该审批请求已被其他成员处理，请刷新后重试',
  expired: '该审批请求已过期，请让智能体重新发起',
  run_inactive: '运行已结束或尚未开始，无法批准；请刷新运行状态',
} as const;

/** 频道工具审批：列表只对真实成员开放；批准只给 owner/admin 或触发该 run 的 member。 */
export function registerChannelApprovalRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);

  app.get(
    '/api/channels/:id/approvals',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: idParams },
    },
    async (request, reply) => {
      const result = await approvalsRepo.listChannelApprovals(app.db, {
        channelId: request.params.id,
        businessId: userPrincipal(request).businessId,
      });
      if (result.kind === 'not_found') {
        return reject(reply, 'NOT_FOUND', '频道不存在或你不是频道成员');
      }
      return reply.send({ items: result.items.map(toItem) });
    },
  );

  app.post(
    '/api/channels/:id/approvals/:approvalId/approve',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: approvalParams },
    },
    async (request, reply) => {
      const result = await approvalsRepo.approveChannelApproval(app.db, {
        channelId: request.params.id,
        approvalId: request.params.approvalId,
        businessId: userPrincipal(request).businessId,
      });
      switch (result.kind) {
        case 'not_found':
          return reject(reply, 'NOT_FOUND', '审批请求不存在或不属于该频道');
        case 'forbidden':
          return reject(reply, 'FORBIDDEN', '当前频道角色无权批准该请求');
        case 'conflict':
          return reject(reply, 'CONFLICT', CONFLICT_MESSAGE[result.reason]);
        case 'ok': {
          // 只有 CAS 赢家写审计：并发输家不会留下第二条批准记录。
          await writeAudit(app.db, request.log, {
            actor: actorOf(request),
            action: 'agent.run.approved',
            target: result.approval.runId,
            input: {
              approvalId: result.approval.id,
              serverId: result.approval.serverId,
              toolName: result.approval.toolName,
            },
            status: 'ok',
            requestId: request.id,
          });
          return reply.send(toItem(result.approval));
        }
      }
    },
  );
}
