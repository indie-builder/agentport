import { ERROR_META, type ErrorCode, problemSchema } from '@agentport/shared';

export { problemSchema } from '@agentport/shared';

type ContractError = { status: number; data: typeof problemSchema };

export const contractErrors = {
  INVALID_INPUT: { status: ERROR_META.INVALID_INPUT.status, data: problemSchema },
  UNAUTHORIZED: { status: ERROR_META.UNAUTHORIZED.status, data: problemSchema },
  FORBIDDEN: { status: ERROR_META.FORBIDDEN.status, data: problemSchema },
  NOT_FOUND: { status: ERROR_META.NOT_FOUND.status, data: problemSchema },
  CONFLICT: { status: ERROR_META.CONFLICT.status, data: problemSchema },
  CONFLICT_STALE: { status: ERROR_META.CONFLICT_STALE.status, data: problemSchema },
  PAYLOAD_TOO_LARGE: { status: ERROR_META.PAYLOAD_TOO_LARGE.status, data: problemSchema },
  UNSUPPORTED_MEDIA_TYPE: { status: ERROR_META.UNSUPPORTED_MEDIA_TYPE.status, data: problemSchema },
  RATE_LIMITED: { status: ERROR_META.RATE_LIMITED.status, data: problemSchema },
  INTERNAL_ERROR: { status: ERROR_META.INTERNAL_ERROR.status, data: problemSchema },
  RESPONSE_INVALID: { status: ERROR_META.RESPONSE_INVALID.status, data: problemSchema },
  SERVICE_UNAVAILABLE: { status: ERROR_META.SERVICE_UNAVAILABLE.status, data: problemSchema },
  UPSTREAM_FAILED: { status: ERROR_META.UPSTREAM_FAILED.status, data: problemSchema },
} satisfies Record<string, ContractError>;

type ContractErrorCode = keyof typeof contractErrors;
type DomainErrorCode =
  | 'INVALID_URL'
  | 'INVALID_REFERENCE'
  | 'AGENT_DISABLED'
  | 'AGENT_BUDGET_EXCEEDED'
  | 'BUDGET_EXCEEDED'
  | 'CONTENT_BLOCKED'
  | 'CONTENT_APPROVAL_REQUIRED'
  | 'EVAL_RUN_IN_PROGRESS'
  | 'BASE_MISMATCH'
  | 'BASE_DISABLED'
  | 'DOCUMENT_NOT_FOUND'
  | 'WIKI_NOT_FOUND'
  | 'VERSION_NOT_CURRENT';
type MissingErrorCodes = Exclude<ErrorCode, ContractErrorCode | DomainErrorCode>;
type AssertNoMissingErrorCodes<T extends never> = T;
type _ErrorsCoverage = AssertNoMissingErrorCodes<MissingErrorCodes>;

const defaultErrorCodes = [
  'INVALID_INPUT',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'UPSTREAM_FAILED',
  'SERVICE_UNAVAILABLE',
] as const satisfies readonly ErrorCode[];
const statusCodes = new Map<number, ErrorCode>(
  defaultErrorCodes.map((code) => [ERROR_META[code].status, code]),
);

export function errorCodeForStatus(status: number): ErrorCode {
  return statusCodes.get(status) ?? 'INTERNAL_ERROR';
}
