import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { installProcessGuards } from '@agentport/core';
import * as Bun from 'bun';
import { serveStatic } from 'hono/bun';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { startChannelWakeSweeper } from './modules/channels/wakes.js';
import { closeProducer, getQueue } from './queue/producer.js';

const config = loadConfig();
const runtime = await buildApp(config, {
  timeout: (request, seconds) => server.timeout(request, seconds),
});
installProcessGuards(runtime.log);
const stopChannelWakeSweeper = startChannelWakeSweeper({
  db: runtime.db,
  log: runtime.log,
  queue: getQueue(),
});
const { app } = runtime;
const webDist = process.env.WEB_DIST ? resolve(process.env.WEB_DIST) : undefined;
if (webDist && existsSync(webDist)) {
  app.get('*', async (c, next) => {
    if (/^\/(api|mcp|health)(\/|$)/.test(c.req.path)) return c.notFound();
    return serveStatic({ root: webDist })(c, next);
  });
  app.get('*', async (c, next) => {
    if (/^\/(api|mcp|health)(\/|$)/.test(c.req.path)) return c.notFound();
    return serveStatic({ root: webDist, path: 'index.html' })(c, next);
  });
}

const server = Bun.serve({
  port: config.PORT,
  hostname: '0.0.0.0',
  idleTimeout: 0,
  fetch: (request, server) => {
    const remoteAddress = server.requestIP(request)?.address;
    return app.fetch(request, remoteAddress === undefined ? {} : { remoteAddress });
  },
});
runtime.log.info({ port: server.port }, 'server listening');

const HTTP_DRAIN_MS = 10_000;
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  runtime.log.info({ signal }, 'shutting down');
  const closing = server.stop(false);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    closing,
    new Promise<void>((resolveClose) => {
      graceTimer = setTimeout(() => {
        void server.stop(true).then(resolveClose);
      }, HTTP_DRAIN_MS);
    }),
  ]);
  clearTimeout(graceTimer);
  await closing;
  await stopChannelWakeSweeper();
  let code = 0;
  try {
    await closeProducer();
  } catch (err) {
    code = 1;
    runtime.log.error({ err }, 'queue shutdown failed');
  }
  try {
    await runtime.close();
  } catch (err) {
    code = 1;
    runtime.log.error({ err }, 'runtime shutdown failed');
  }
  process.exit(code);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
