import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { installProcessGuards } from '@agentport/core';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { closeProducer } from './queue/producer.js';

const config = loadConfig();
const app = await buildApp(config);
installProcessGuards(app.log);

// 生产由 api 静态托管 web 构建产物；未设置 WEB_DIST 或目录不存在时保持纯 API。
const webDist = process.env.WEB_DIST ? resolve(process.env.WEB_DIST) : undefined;
if (webDist && existsSync(webDist)) {
  const { default: fastifyStatic } = await import('@fastify/static');
  // wildcard: false：静态插件不抢 `/*`，由下面的 SPA 兜底统一处理。
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.get('/*', async (request, reply) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    // 未命中的 API/MCP 路由仍应返回 JSON 404，而不是 index.html。
    if (/^\/(api|mcp|health)(\/|$)/.test(pathname)) return reply.callNotFound();
    // static 会自己校验路径穿越；这里只判断「是不是一个真实文件」以决定回退 index。
    const file = join(webDist, pathname);
    const exists =
      file.startsWith(webDist) &&
      (await stat(file)
        .then((s) => s.isFile())
        .catch(() => false));
    return reply.sendFile(exists ? pathname : 'index.html');
  });
}

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await closeProducer();
  const closing = app.close();
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closing,
      new Promise<void>((resolveClose) => {
        graceTimer = setTimeout(() => {
          app.server.closeAllConnections();
          resolveClose();
        }, 2_000);
      }),
    ]);
    await closing;
    process.exit(0);
  } finally {
    clearTimeout(graceTimer);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: '0.0.0.0' });
