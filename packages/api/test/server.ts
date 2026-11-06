export interface TestServer {
  url: string;
  close(): Promise<void>;
}

export interface Listenable {
  app: {
    fetch: (request: Request, env?: never, executionCtx?: never) => Response | Promise<Response>;
  };
}

/** 只有 SSE、MCP StreamableHTTP 这类依赖真实连接的用例才需要监听端口。 */
export async function listen(target: Listenable): Promise<TestServer> {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: target.app.fetch.bind(target.app) as (request: Request) => Response | Promise<Response>,
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    close: async () => {
      await server.stop(true);
    },
  };
}
