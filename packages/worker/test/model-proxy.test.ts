import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { startModelProxy } from '../src/model-proxy.js';

const logger = pino({ level: 'silent' });
const RUN_ID = 'run_test';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  cleanups.push(
    () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeAllConnections();
      }),
  );
  return (server.address() as AddressInfo).port;
}

async function startProxy(upstreamPort: number): Promise<number> {
  const proxy = await startModelProxy({
    logger,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: 'upstream-secret',
    resolveRun: async (token) => (token === RUN_ID ? { runId: RUN_ID } : null),
  });
  if (!proxy) throw new Error('proxy did not start');
  proxy.issueToken(RUN_ID);
  cleanups.push(() => proxy.close());
  return Number(new URL(proxy.url).port);
}

/** 发一个带合法 token 的请求；返回的 ClientRequest 由调用方 end/destroy。 */
function proxyRequest(port: number) {
  const req = request({
    host: '127.0.0.1',
    port,
    path: '/v1/messages',
    method: 'POST',
    headers: {
      authorization: `Bearer ${RUN_ID}`,
      'content-type': 'application/json',
    },
  });
  req.on('error', () => {
    // 提前断连的用例会主动销毁连接，忽略客户端侧的错误事件。
  });
  return req;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('model proxy streaming', () => {
  it('stops reading upstream when the downstream client is slow', async () => {
    const CHUNK = Buffer.alloc(1024 * 1024, 0x61);
    const TOTAL_CHUNKS = 64;
    let flushedBytes = 0;

    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.on('error', () => {
        // 客户端中断后上游写会失败，这里只记录已刷出的字节数。
      });
      // 上游是快生产者：故意不等待 write 的返回值，代理必须自己施加背压。
      for (let i = 0; i < TOTAL_CHUNKS; i += 1) {
        res.write(CHUNK, () => {
          flushedBytes += CHUNK.length;
        });
      }
      res.end();
    });
    const upstreamPort = await listen(upstream);
    const proxyPort = await startProxy(upstreamPort);

    const client = proxyRequest(proxyPort);
    const response = new Promise<import('node:http').IncomingMessage>((resolvePromise) => {
      client.once('response', resolvePromise);
    });
    client.end(JSON.stringify({ model: 'claude-test' }));

    const downstream = await response;
    downstream.on('error', () => {});
    // 下游暂停读取：没有背压时代理会把上游 64MB 全部读进内存。
    downstream.pause();

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));
    const flushedWhilePaused = flushedBytes;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
    const flushedLater = flushedBytes;

    downstream.destroy();

    expect(flushedWhilePaused).toBeLessThan(TOTAL_CHUNKS * CHUNK.length);
    // 暂停后上游应基本停在原处，而不是继续被代理抽干。
    expect(flushedLater - flushedWhilePaused).toBeLessThan(4 * CHUNK.length);
  }, 20_000);

  it('aborts the upstream request when the downstream client disconnects early', async () => {
    const upstreamClosed = deferred();

    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.on('error', () => {});
      const timer = setInterval(() => {
        if (!res.destroyed) res.write('data: ping\n\n');
      }, 20);
      res.once('close', () => {
        clearInterval(timer);
        upstreamClosed.resolve();
      });
    });
    const upstreamPort = await listen(upstream);
    const proxyPort = await startProxy(upstreamPort);

    const client = proxyRequest(proxyPort);
    const firstChunk = new Promise<void>((resolvePromise, rejectPromise) => {
      client.once('response', (res) => {
        res.once('data', () => resolvePromise());
        res.on('error', () => {});
      });
      client.once('error', rejectPromise);
    });
    client.end(JSON.stringify({ model: 'claude-test' }));

    await firstChunk;
    client.destroy();

    await expect(
      Promise.race([
        upstreamClosed.promise.then(() => 'closed' as const),
        new Promise<'open'>((resolvePromise) => {
          setTimeout(() => resolvePromise('open'), 1000);
        }),
      ]),
    ).resolves.toBe('closed');
  }, 20_000);
});
