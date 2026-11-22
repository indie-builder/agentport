import { fail } from '@agentport/core';

export const CHANNEL_MEMBER_MISSING = '频道不存在或你不是频道成员';
export const RUN_MISSING = '运行不存在，可能已被删除';
export const RUN_NOT_IN_CHANNEL = '运行不存在或不属于该频道';
export const SOURCE_RUN_MISSING = '来源运行不存在，可能已被删除';
export const ANSWER_FORBIDDEN = '当前频道角色无权回答该提问';
export const AGENT_BINDING_FORBIDDEN = '当前频道角色无权管理智能体绑定';
export const MEMBER_FORBIDDEN = '当前频道角色无权管理成员';

export function notFound(message = '频道不存在'): never {
  return fail('NOT_FOUND', message);
}
export function forbidden(message: string): never {
  return fail('FORBIDDEN', message);
}
export function conflict(message: string): never {
  return fail('CONFLICT', message);
}
