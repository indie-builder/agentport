import { repo } from '@agentport/db';

/** 审计写入只有一处实现（db 层），API 与 worker 共用；保留旧导入路径。 */
export const writeAudit = repo.audit.writeAudit;
