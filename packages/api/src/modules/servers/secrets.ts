import { maskUrlCredentials, SECRET_MASK, type Server } from '@agentport/shared';

export { decryptSecrets, encryptSecrets } from '@agentport/core';
export { SECRET_MASK } from '@agentport/shared';

/**
 * env / headers 的值在接口上一律脱敏，只保留键名，页面据此渲染「已配置」。
 * 旧数据可能把账号密码写在 URL 里，也一并遮掉。
 */
export function maskServer(s: Server): Server {
  if (s.kind === 'knowledge') return s;
  const keys = Object.keys(s.kind === 'stdio' ? s.env : s.headers);
  const masked = Object.fromEntries(keys.map((k) => [k, SECRET_MASK]));
  if (s.kind === 'stdio') return { ...s, env: masked };
  if (s.kind === 'http') return { ...s, url: maskUrlCredentials(s.url), headers: masked };
  return { ...s, baseUrl: maskUrlCredentials(s.baseUrl), headers: masked };
}
