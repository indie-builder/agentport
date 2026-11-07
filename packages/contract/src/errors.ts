import { type ErrorCode, errorCode, problemSchema } from '@agentport/shared';

export { problemSchema } from '@agentport/shared';

export const contractErrors = {
  INVALID_INPUT: { status: errorCode.INVALID_INPUT, data: problemSchema },
  UNAUTHORIZED: { status: errorCode.UNAUTHORIZED, data: problemSchema },
  FORBIDDEN: { status: errorCode.FORBIDDEN, data: problemSchema },
  NOT_FOUND: { status: errorCode.NOT_FOUND, data: problemSchema },
  CONFLICT: { status: errorCode.CONFLICT, data: problemSchema },
  CONFLICT_STALE: { status: errorCode.CONFLICT_STALE, data: problemSchema },
  PAYLOAD_TOO_LARGE: { status: errorCode.PAYLOAD_TOO_LARGE, data: problemSchema },
  UNSUPPORTED_MEDIA_TYPE: { status: errorCode.UNSUPPORTED_MEDIA_TYPE, data: problemSchema },
  RATE_LIMITED: { status: errorCode.RATE_LIMITED, data: problemSchema },
  INTERNAL_ERROR: { status: errorCode.INTERNAL_ERROR, data: problemSchema },
  RESPONSE_INVALID: { status: errorCode.RESPONSE_INVALID, data: problemSchema },
  SERVICE_UNAVAILABLE: { status: errorCode.SERVICE_UNAVAILABLE, data: problemSchema },
  UPSTREAM_FAILED: { status: errorCode.UPSTREAM_FAILED, data: problemSchema },
};

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
  defaultErrorCodes.map((code) => [errorCode[code], code]),
);

export function errorCodeForStatus(status: number): ErrorCode {
  return statusCodes.get(status) ?? 'INTERNAL_ERROR';
}
