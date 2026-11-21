import { fail } from '@agentport/core';

export const CHANNEL_MEMBER_MISSING = '频道不存在或你不是频道成员';

export function notFound(message = '频道不存在'): never {
  return fail('NOT_FOUND', message);
}
export function forbidden(message: string): never {
  return fail('FORBIDDEN', message);
}
export function conflict(message: string): never {
  return fail('CONFLICT', message);
}
