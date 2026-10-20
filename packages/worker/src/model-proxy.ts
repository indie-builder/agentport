import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { Logger } from 'pino';

/**
 * 模型凭证代理（D-17）。
 *
 * 沙盒里的任何进程都能读到容器 env。把真实模型密钥放进去，等于把长期凭证
 * 交给模型可以执行的代码。这里改成：
 * - 真实密钥只存在于 worker 进程内存；
 * - 沙盒拿到 `MODEL_PROXY_URL` 与按 run 签发的短期 token；
 * - 请求由 worker 转发到上游，并在转发时注入真实凭证。
 *
 * 只转发白名单路径：代理一旦能转发任意 URL，就会变成开放代理，
 * 沙盒可以借它访问内网而绕过 SSRF 防护。
 */

/** 上游允许的路径前缀。Anthropic API 的模型调用都在 /v1 下。 */
const ALLOWED_PREFIXES = ['/v1/messages', '/v1/messages/count_tokens', '/v1/models'];
/** 单次请求体上限；模型请求可能带大段上下文，但不能无限。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface ModelProxyOptions {
  logger: Logger;
  /** 上游基址，例如 https://api.anthropic.com；未配置时不做代理。 */
  upstreamBaseUrl: string;
  /** 真实凭证；优先 apiKey，其次 authToken。 */
  apiKey?: string;
  authToken?: string;
  /** 监听端口；0 表示随机可用端口。 */
  port?: number;
  /**
   * 回调：按 token 解析出 run，并确认该 run 仍然有效。
   * token 即 runId（TypeID 含时间戳但不可预测），DB 里存的是它的 sha256。
   */
  resolveRun: (token: string) => Promise<{ runId: string } | null>;
}

export interface ModelProxy {
  /** 沙盒应使用的基址。 */
  url: string;
  /** 为一次 run 签发短期 token。 */
  issueToken: (runId: string) => string;
  /** run 结束时吊销。 */
  revokeToken: (runId: string) => void;
  close: () => Promise<void>;
}

function pathAllowed(pathname: string): boolean {
  return ALLOWED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * 启动代理。未配置上游或凭证时返回 null，调用方回退到直接注入凭证
 * （旧部署可继续跑，但启动日志会警告）。
 */
export async function startModelProxy(options: ModelProxyOptions): Promise<ModelProxy | null> {
  const { logger, upstreamBaseUrl } = options;
  const credential = options.apiKey ?? options.authToken;
  if (!credential) return null;
  const upstreamCredential: string = credential;

  // 进程内的 run 集合只用于快速吊销；token 本身由 DB 校验，重启后仍有效。
  const activeRuns = new Set<string>();
  const upstream = new URL(upstreamBaseUrl);

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      logger.error({ err }, 'model proxy request failed');
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'proxy_error', message: 'proxy failed' } }));
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://proxy.local');
    if (!pathAllowed(url.pathname)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'not_found', message: 'path not proxied' } }));
      return;
    }

    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'unauthorized', message: 'missing token' } }));
      return;
    }

    const run = await options.resolveRun(token);
    if (!run || (activeRuns.size > 0 && !activeRuns.has(run.runId))) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'unauthorized', message: 'invalid token' } }));
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'payload_too_large', message: 'body too large' } }));
      return;
    }

    const target = new URL(url.pathname + url.search, upstream);
    const headers: Record<string, string> = {
      'content-type': req.headers['content-type'] ?? 'application/json',
      accept: req.headers.accept ?? 'application/json',
      // 上游凭证在这里注入；沙盒永远看不到它。
      'x-api-key': upstreamCredential,
      authorization: `Bearer ${upstreamCredential}`,
      'anthropic-version': String(req.headers['anthropic-version'] ?? '2023-06-01'),
    };
    if (typeof req.headers['anthropic-beta'] === 'string') {
      headers['anthropic-beta'] = req.headers['anthropic-beta'];
    }

    const upstreamRes = await fetch(target, {
      method: req.method ?? 'POST',
      headers,
      ...(body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
    });

    res.writeHead(upstreamRes.status, {
      'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
      ...(upstreamRes.headers.get('request-id')
        ? { 'request-id': String(upstreamRes.headers.get('request-id')) }
        : {}),
    });
    if (!upstreamRes.body) {
      res.end();
      return;
    }
    // 流式（SSE）必须边读边写：一次性 await text() 会让流式输出退化成阻塞。
    const reader = upstreamRes.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(options.port ?? 0, '0.0.0.0', () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const url = `http://host.docker.internal:${port}`;
  logger.info({ url, upstream: upstream.origin }, 'model proxy listening');

  return {
    url,
    issueToken(runId: string): string {
      activeRuns.add(runId);
      return runId;
    },
    revokeToken(runId: string): void {
      activeRuns.delete(runId);
    },
    async close(): Promise<void> {
      activeRuns.clear();
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    },
  };
}
