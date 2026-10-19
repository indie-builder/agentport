import { typeid } from 'typeid-js';

/**
 * 所有实体 ID 都是 TypeID：`<prefix>_<uuidv7 base32>`。
 * 前缀让日志、审计、URL 中的 ID 自解释；uuidv7 保证 K-sortable。
 */
export const idPrefixes = {
  server: 'srv',
  tool: 'tool',
  agent: 'agt',
  agentVersion: 'av',
  skill: 'skl',
  conversation: 'conv',
  message: 'msg',
  run: 'run',
  audit: 'aud',
  evalCase: 'ec',
  evalRun: 'er',
  evalResult: 'evr',
} as const;

type Entity = keyof typeof idPrefixes;

export function newId(entity: Entity): string {
  return typeid(idPrefixes[entity]).toString();
}

/** 校验 ID 的类型前缀是否匹配，用于路由参数早失败。 */
export function isIdOfType(id: string, entity: Entity): boolean {
  return id.startsWith(`${idPrefixes[entity]}_`);
}
