import { SECRET_MASK, type Server } from '@agentport/shared';

export { decryptSecrets, encryptSecrets } from '@agentport/core';
export { SECRET_MASK } from '@agentport/shared';

/** env / headers 的值在接口上一律脱敏，只保留键名，页面据此渲染「已配置」。 */
export function maskServer(s: Server): Server {
  const keys = Object.keys(s.kind === 'stdio' ? s.env : s.headers);
  const masked = Object.fromEntries(keys.map((k) => [k, SECRET_MASK]));
  if (s.kind === 'stdio') return { ...s, env: masked };
  return { ...s, headers: masked };
}
