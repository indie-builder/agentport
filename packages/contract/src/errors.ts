import { ERROR_META, type ErrorCode, problemSchema } from '@agentport/shared';
import { z } from 'zod';

const errorFor = <const T extends ErrorCode>(code: T) => ({
  status: ERROR_META[code].status,
  data: problemSchema.extend({ code: z.literal(code) }),
});

type ContractError = ReturnType<typeof errorFor>;

export const contractErrors = {
  INVALID_INPUT: errorFor('INVALID_INPUT'),
  UNAUTHORIZED: errorFor('UNAUTHORIZED'),
  FORBIDDEN: errorFor('FORBIDDEN'),
  NOT_FOUND: errorFor('NOT_FOUND'),
  PAYLOAD_TOO_LARGE: errorFor('PAYLOAD_TOO_LARGE'),
  UNSUPPORTED_MEDIA_TYPE: errorFor('UNSUPPORTED_MEDIA_TYPE'),
  RATE_LIMITED: errorFor('RATE_LIMITED'),
  INTERNAL_ERROR: errorFor('INTERNAL_ERROR'),
  RESPONSE_INVALID: errorFor('RESPONSE_INVALID'),
  SERVICE_UNAVAILABLE: errorFor('SERVICE_UNAVAILABLE'),
  UPSTREAM_FAILED: errorFor('UPSTREAM_FAILED'),
} satisfies Record<string, ContractError>;

type ContractErrorCode = keyof typeof contractErrors;
export type DomainErrorCode =
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
  | 'VERSION_NOT_CURRENT'
  | 'CONFLICT'
  | 'CONFLICT_STALE';
type MissingErrorCodes = Exclude<ErrorCode, ContractErrorCode | DomainErrorCode>;
type AssertNoMissingErrorCodes<T extends never> = T;
type _ErrorsCoverage = AssertNoMissingErrorCodes<MissingErrorCodes>;

export function domainErrors<T extends readonly ErrorCode[]>(...codes: T) {
  return Object.fromEntries(codes.map((code) => [code, errorFor(code)])) as {
    [K in T[number]]: ContractError;
  };
}

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
