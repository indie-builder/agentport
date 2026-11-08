import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 去掉宿主机代理变量：测试链路只应走环回地址，绝不能落到外部代理。 */
function withoutAmbientProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]) {
    delete next[key];
  }
  return next;
}

/** 在既有 NO_PROXY 上补齐环回地址，保留用户原本的绕过项。 */
function loopbackNoProxy(existing: string | undefined): string {
  const entries = (existing ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    if (!entries.includes(host)) entries.push(host);
  }
  return entries.join(',');
}

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
if (existsSync('.env')) process.loadEnvFile('.env');

const { default: setup } = await import('../packages/worker/test/global-setup.js');
const args = process.argv.slice(2);
let child: ReturnType<typeof Bun.spawn> | undefined;
let interrupted: 'SIGINT' | 'SIGTERM' | undefined;
const interrupt = (signal: 'SIGINT' | 'SIGTERM') => {
  interrupted = signal;
  child?.kill(signal);
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

let code = 1;
try {
  const infra = await setup();
  try {
    if (!interrupted) {
      child = Bun.spawn(
        [process.execPath, 'test', '--isolate', '--parallel=2', '--timeout=20000', ...args],
        {
          cwd: root,
          env: {
            ...withoutAmbientProxy(process.env),
            ...infra.env,
            AGENTPORT_BACKEND_TEST: '1',
            // 后端测试只访问本机容器与桩服务器：若继承宿主机的 HTTP_PROXY，Bun 的 fetch
            // 会把 127.0.0.1 也当代理目标（请求行变成绝对 URL），桩服务器按路径匹配全部失效。
            NO_PROXY: loopbackNoProxy(process.env.NO_PROXY ?? process.env.no_proxy),
            no_proxy: loopbackNoProxy(process.env.no_proxy ?? process.env.NO_PROXY),
          },
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        },
      );
      code = await child.exited;
    }
  } finally {
    await infra.close();
  }
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : code;
