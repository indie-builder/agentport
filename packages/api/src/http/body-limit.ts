import { fail } from '@agentport/core';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { HttpEnv } from './context.js';
import { PAYLOAD_TOO_LARGE_MESSAGE } from './errors.js';

export function requestBodyLimit(maxSize: number): MiddlewareHandler<HttpEnv> {
  const limit = bodyLimit({
    maxSize,
    onError: () => fail('PAYLOAD_TOO_LARGE', PAYLOAD_TOO_LARGE_MESSAGE),
  });
  return async (c, next) => {
    c.set('bodyLimitApplied', true);
    return limit(c, next);
  };
}
