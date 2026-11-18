import { fail } from '@agentport/core';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { HttpEnv } from './context.js';

export function requestBodyLimit(maxSize: number): MiddlewareHandler<HttpEnv> {
  const limit = bodyLimit({
    maxSize,
    onError: () => fail('PAYLOAD_TOO_LARGE', '请求体超出大小限制，请减少内容后重试'),
  });
  return async (c, next) => {
    c.set('bodyLimitApplied', true);
    return limit(c, next);
  };
}
