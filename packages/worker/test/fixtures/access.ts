import { fileURLToPath } from 'node:url';
import type { ExecutionSubject } from '@agentport/shared';

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
    agentOwnership: { createdBy: businessId, ownerBusinessId: businessId } as const,
    conversationSubject: { createdBy: businessId } as const,
    runSubjectFields: { subjectKind: 'user', initiatedBy: businessId } as const,
  };
}
