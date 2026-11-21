import { maskUrlCredentials, SECRET_MASK, type Server } from '@agentport/shared';

export { decryptSecrets, encryptSecrets } from '@agentport/core';
export { SECRET_MASK } from '@agentport/shared';

export function maskServer(s: Server): Server {
  if (s.kind === 'knowledge' || s.kind === 'data_domain') return s;
  const keys = Object.keys(s.kind === 'stdio' ? s.env : s.headers);
  const masked = Object.fromEntries(keys.map((k) => [k, SECRET_MASK]));
  if (s.kind === 'stdio') return { ...s, env: masked };
  if (s.kind === 'http') return { ...s, url: maskUrlCredentials(s.url), headers: masked };
  return { ...s, baseUrl: maskUrlCredentials(s.baseUrl), headers: masked };
}
