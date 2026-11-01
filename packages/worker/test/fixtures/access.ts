import { fileURLToPath } from 'node:url';
import type { ExecutionSubject } from '@agentport/shared';

/**
 * 测试业务身份按测试文件派生：同文件内稳定，不同文件并行时互不共享业务记录，
 * 避免一个文件落的 agents/run 数据让另一个文件的 createTestAccount(restore:false) 撞 409。
 */
export function testAccess(fileUrl: string) {
  const fileName =
    fileURLToPath(fileUrl)
      .split('/')
      .pop()
      ?.replace(/\.test\.ts$/, '') ?? 'unknown';
  const businessId = `worker-${fileName}`;

  return {
    TEST_BUSINESS_ID: businessId,
    userSubject: { kind: 'user', businessId } as ExecutionSubject,
    /** agents.createdBy / ownerBusinessId 两个 NOT NULL 字段。 */
    agentOwnership: { createdBy: businessId, ownerBusinessId: businessId } as const,
    conversationSubject: { createdBy: businessId } as const,
    runSubjectFields: { subjectKind: 'user', initiatedBy: businessId } as const,
  };
}
