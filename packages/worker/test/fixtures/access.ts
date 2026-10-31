import type { ExecutionSubject } from '@agentport/shared';

/** 测试用稳定业务身份；worker 身份判定在需要真实授权时另行 mock 或建角色数据。 */
export const TEST_BUSINESS_ID = 'worker-test-user';

export const userSubject: ExecutionSubject = { kind: 'user', businessId: TEST_BUSINESS_ID };

/** agents.createdBy / ownerBusinessId 两个 NOT NULL 字段。 */
export const agentOwnership = {
  createdBy: TEST_BUSINESS_ID,
  ownerBusinessId: TEST_BUSINESS_ID,
} as const;

export const conversationSubject = { createdBy: TEST_BUSINESS_ID } as const;

export const runSubjectFields = {
  subjectKind: 'user',
  initiatedBy: TEST_BUSINESS_ID,
} as const;
