import { repo } from '@agentport/db';
import type { PermissionId } from '@agentport/shared';

/** 审计写入只有一处实现（db 层），API 与 worker 共用；保留旧导入路径。 */
export const writeAudit = repo.audit.writeAudit;

interface WarnLogger {
  warn: (obj: object, msg: string) => void;
}

/**
 * 平台管理员跨用户访问对象时统一写审计：只记目标业务身份 / 对象 ID / 叶与请求 ID，
 * 不落正文、密码或凭据。由 authorize 在 P grant 命中他人对象时调用。
 * 叶拼进 action，审计查询按 action 前缀即可定位到具体权限。
 */
export async function writeCrossUserAudit(
  db: Parameters<typeof writeAudit>[0],
  logger: WarnLogger,
  input: {
    actor: string;
    permissionId: PermissionId;
    subjectBusinessId: string;
    target?: string;
    requestId: string;
  },
): Promise<void> {
  await writeAudit(db, logger, {
    actor: input.actor,
    actorKind: 'user',
    subjectBusinessId: input.subjectBusinessId,
    action: `access.cross_user.${input.permissionId}`,
    ...(input.target === undefined ? {} : { target: input.target }),
    status: 'ok',
    requestId: input.requestId,
  });
}
