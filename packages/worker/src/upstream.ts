import { existsSync } from 'node:fs';

/**
 * worker 自己访问模型网关的地址。
 *
 * 只有 worker 进程本身在容器里时，才需要把 loopback 改写成宿主别名；宿主上直跑
 * （`pnpm dev`）时 `127.0.0.1` 就是网关地址，改写反而连不上。
 * 沙盒的地址由 `sandboxEnv` 单独处理，始终走 `host.docker.internal`。
 */
export function modelProxyUpstream(
  baseUrl: string | undefined,
  inContainer: boolean = existsSync('/.dockerenv'),
): string {
  const value = baseUrl ?? 'https://api.anthropic.com';
  if (!inContainer) return value;
  return value.replace(
    /\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(?=[:/]|$)/,
    '//host.docker.internal',
  );
}
