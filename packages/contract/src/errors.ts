import { problemSchema } from '@agentport/shared';

export { problemSchema } from '@agentport/shared';

export const contractErrors = {
  INVALID_INPUT: { status: 400, data: problemSchema },
  UNAUTHORIZED: { status: 401, data: problemSchema },
  FORBIDDEN: { status: 403, data: problemSchema },
  NOT_FOUND: { status: 404, data: problemSchema },
  CONFLICT: { status: 409, data: problemSchema },
  CONFLICT_STALE: { status: 409, data: problemSchema },
  PAYLOAD_TOO_LARGE: { status: 413, data: problemSchema },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, data: problemSchema },
  RATE_LIMITED: { status: 429, data: problemSchema },
  INTERNAL_ERROR: { status: 500, data: problemSchema },
  RESPONSE_INVALID: { status: 500, data: problemSchema },
  SERVICE_UNAVAILABLE: { status: 503, data: problemSchema },
  UPSTREAM_FAILED: { status: 502, data: problemSchema },
};
