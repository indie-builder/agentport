import { setupServer } from 'msw/node';
import { expect } from 'vitest';

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

/**
 * 依序执行清理步骤：任一步失败也跑完后续，最后抛出第一个错误。
 * 用 failed 而非 error 判空，兼容 throw undefined。
 */
export async function runCleanup(steps: Array<() => unknown>) {
  let failed = false;
  let firstError: unknown;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  if (failed) throw firstError;
}

/** 每个测试文件自己的 MSW server：只记录清单与未配置请求，不内置任何路由。 */
export function createMsw() {
  const calls: RecordedCall[] = [];
  const unhandled: string[] = [];
  const bodyReads: Promise<void>[] = [];
  let readFailure: unknown;
  const server = setupServer();

  return {
    server,
    calls,
    listen() {
      server.events.on('request:start', ({ request }) => {
        const url = new URL(request.url);
        const call: RecordedCall = {
          method: request.method,
          path: url.pathname + url.search,
          body: undefined,
        };
        calls.push(call);
        if (request.body === null) return;
        const contentType = request.headers.get('content-type') ?? '';
        bodyReads.push(
          request
            .clone()
            .text()
            .then(
              (raw) => {
                try {
                  call.body = contentType.includes('json')
                    ? JSON.parse(raw)
                    : { __blob: contentType };
                } catch {
                  call.body = raw;
                }
              },
              // 先就地接住拒绝，避免无人 await 时变成 unhandled；由 waitForRequests 抛出。
              (error: unknown) => {
                readFailure ??= error;
              },
            ),
        );
      });
      server.events.on('request:unhandled', ({ request }) => {
        const url = new URL(request.url);
        unhandled.push(`${request.method} ${url.pathname}${url.search}`);
      });
      server.listen({ onUnhandledFrame: 'error' });
    },
    /** 等全部已记录请求体读完；只读 request clone，不等仍 pending 的 response。 */
    async waitForRequests() {
      while (bodyReads.length > 0) {
        await Promise.all(bodyReads.splice(0));
      }
      if (readFailure !== undefined) {
        const failure = readFailure;
        readFailure = undefined;
        throw failure;
      }
    },
    reset() {
      calls.length = 0;
      unhandled.length = 0;
    },
    /** 在卸载组件并 clear QueryClient 之后调用，避免上一用例的 server.use 泄漏。 */
    assertClean() {
      server.resetHandlers();
      // Query 会吞掉请求错误；这里直接检查未配置路由，避免漏配被当作空数据通过。
      expect(unhandled).toEqual([]);
    },
    close() {
      server.close();
    },
  };
}
