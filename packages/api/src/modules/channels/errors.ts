import { fail } from '@agentport/core';

export function notFound(message = '频道不存在'): never {
  return fail('NOT_FOUND', message);
}
export function forbidden(message: string): never {
  return fail('FORBIDDEN', message);
}
export function conflict(message: string): never {
  return fail('CONFLICT', message);
}
