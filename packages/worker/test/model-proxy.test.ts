import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { type ModelProxy, startModelProxy } from '../src/model-proxy.js';

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quiet,
} as unknown as Logger;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function closeServer(server: Server): Promise<void> {
  // 失败用例里上游仍挂着连接；先断开再 close，清理才不会等满 hook 超时。
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startProxy(upstreamPort: number): Promise<ModelProxy> {
  const proxy = await startModelProxy({
    logger: quiet,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: 'fake-upstream-credential',
    port: 0,
    resolveRun: async () => ({ runId: 'run_model_proxy_test' }),
  });
  if (!proxy) throw new Error('model proxy did not start');
  cleanups.push(() => proxy.close());
  return proxy;
}

function proxyPort(proxy: ModelProxy): number {
  // 返回的 url 是给沙盒用的 host.docker.internal；同机测试走回环地址。
  return Number(new URL(proxy.url).port);
}

describe('model proxy streaming', () => {
  it('aborts the upstream request when the client disconnects mid-stream', async () => {
    let aborted = false;
    let upstreamClosed!: () => void;
    const upstreamClose = new Promise<undefined>((resolve) => {
      upstreamClosed = resolve;
    });
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      // 客户端断开时代理应取消上游；没有取消时这里不会触发。
      res.on('close', () => {
        aborted = !res.writableEnded;
        upstreamClosed();
      });
    });
    const upstreamPort = await listen(upstream);
    cleanups.push(() => closeServer(upstream));

    const proxy = await startProxy(upstreamPort);
    const client = request(
      {
        host: '127.0.0.1',
        port: proxyPort(proxy),
        path: '/v1/messages',
        method: 'POST',
        headers: {
          authorization: 'Bearer run_model_proxy_test',
          'content-type': 'application/json',
        },
      },
      (res) => {
        res.once('data', () => client.destroy());
        res.on('error', () => undefined);
      },
    );
    client.on('error', () => undefined);
    client.end(JSON.stringify({ model: 'test-model', stream: true, messages: [] }));

    const outcome = await Promise.race([
      upstreamClose.then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
    ]);
    expect(outcome).toBe('closed');
    expect(aborted).toBe(true);
  });

  it('streams the whole body when the client stays connected', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => res.end('data: two\n\n'), 10);
    });
    const upstreamPort = await listen(upstream);
    cleanups.push(() => closeServer(upstream));

    const proxy = await startProxy(upstreamPort);
    const body = await new Promise<string>((resolve, reject) => {
      const client = request(
        {
          host: '127.0.0.1',
          port: proxyPort(proxy),
          path: '/v1/messages',
          method: 'POST',
          headers: {
            authorization: 'Bearer run_model_proxy_test',
            'content-type': 'application/json',
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => resolve(text));
          res.on('error', reject);
        },
      );
      client.on('error', reject);
      client.end(JSON.stringify({ model: 'test-model', stream: true, messages: [] }));
    });

    expect(body).toBe('data: one\n\ndata: two\n\n');
  });
});
