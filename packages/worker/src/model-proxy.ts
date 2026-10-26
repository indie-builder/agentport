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
  /**
   * 监听端口。必须固定：compose 把它发布到宿主，沙盒通过 host.docker.internal:<port> 访问。
   * 0 只适合宿主机直跑的 worker（沙盒与 worker 同网络栈）。
   */
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

/** 单个请求的日志上下文：成功、失败、token 拒绝都带同一组字段。 */
interface ProxyRequestContext {
  runId?: string | undefined;
  model?: string | undefined;
  upstreamRequestId?: string | undefined;
  startedAt?: number | undefined;
}

/** 只从请求体开头找 model：完整 JSON.parse 会把 32MB 上下文再复制一份。 */
function modelOf(body: Buffer): string | undefined {
  return /"model"\s*:\s*"([^"]+)"/.exec(body.subarray(0, 4096).toString('utf8'))?.[1];
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
    // 每个请求一行上下文，错误路径也能带上 runId / model，不再只剩一条堆栈。
    const ctx: ProxyRequestContext = {};
    void handle(req, res, ctx).catch((err: unknown) => {
      logger.error({ err, ...ctx }, 'model proxy request failed');
      // 客户端已断开时不能再写响应，否则会再抛一次 stream destroyed。
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'proxy_error', message: 'proxy failed' } }));
      } else {
        res.end();
      }
    });
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: ProxyRequestContext,
  ): Promise<void> {
    const startedAt = Date.now();
    const url = new URL(req.url ?? '/', 'http://proxy.local');
    if (!pathAllowed(url.pathname)) {
      logger.warn({ path: url.pathname, status: 404 }, 'model proxy rejected path');
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'not_found', message: 'path not proxied' } }));
      return;
    }

    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) {
      // token 本身不落日志；这里只记「没带凭证」这一事实。
      logger.warn({ path: url.pathname, status: 401 }, 'model proxy rejected token: missing');
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'unauthorized', message: 'missing token' } }));
      return;
    }

    const run = await options.resolveRun(token);
    if (!run || (activeRuns.size > 0 && !activeRuns.has(run.runId))) {
      // 已结束 / 未签发的 run token：沙盒仍在发请求时，这条日志就是唯一线索。
      logger.warn(
        { path: url.pathname, status: 401, ...(run ? { runId: run.runId } : {}) },
        'model proxy rejected token: invalid or revoked',
      );
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'unauthorized', message: 'invalid token' } }));
      return;
    }
    ctx.runId = run.runId;

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'payload_too_large', message: 'body too large' } }));
      return;
    }

    ctx.startedAt = startedAt;
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

    ctx.model = modelOf(body);
    const upstreamController = new AbortController();
    // 客户端提前断开（沙盒取消/进程退出）时中止上游并取消 reader，避免挂到上游超时。
    const onClientClose = () => {
      if (!res.writableEnded) upstreamController.abort();
    };
    res.on('close', onClientClose);

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let completed = false;
    try {
      const upstreamRes = await fetch(target, {
        method: req.method ?? 'POST',
        headers,
        ...(body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
        signal: upstreamController.signal,
      });

      const upstreamRequestId = upstreamRes.headers.get('request-id') ?? undefined;
      ctx.upstreamRequestId = upstreamRequestId;
      // 每次请求一行：runId + 上游 request-id 能把沙盒里的报错对回上游账单与日志。
      // 不记请求体、不记响应体。
      logger.info(
        {
          runId: ctx.runId,
          model: ctx.model,
          status: upstreamRes.status,
          durationMs: Date.now() - startedAt,
          upstreamRequestId,
        },
        'model proxy request',
      );

      res.writeHead(upstreamRes.status, {
        'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
        ...(upstreamRequestId ? { 'request-id': upstreamRequestId } : {}),
      });
      if (!upstreamRes.body) {
        res.end();
        completed = true;
        return;
      }
      // 流式（SSE）必须边读边写：一次性 await text() 会让流式输出退化成阻塞。
      reader = upstreamRes.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
      completed = true;
    } catch (err) {
      // 客户端断开导致的中止是预期路径；其余错误交给外层统一返回 500。
      if (!upstreamController.signal.aborted) throw err;
    } finally {
      res.off('close', onClientClose);
      if (!completed) await reader?.cancel().catch(() => undefined);
    }
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(options.port ?? 0, '0.0.0.0', () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  // compose 里这个端口会发布到宿主，所以沙盒侧永远用 host.docker.internal。
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
