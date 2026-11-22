import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';

import { CONTENT_BLOCKED_MESSAGE } from '@agentport/core';
import type { repo } from '@agentport/db';
import { type ProviderErrorKind, providerErrorKindForStatus } from '@agentport/shared';
import type { Logger } from 'pino';
import { z } from 'zod';

const MESSAGE_PATH = '/v1/messages';
const MODELS_PATH = '/v1/models';
const MESSAGE_PATHS = new Set([MESSAGE_PATH, `${MESSAGE_PATH}/count_tokens`]);
const modelRequestSchema = z.object({ model: z.string() });
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_SSE_PREFIX_BYTES = 32 * 1024 * 1024;
const UPSTREAM_START_TIMEOUT_MS = 60_000;

type ProxyAttempt = { baseUrl: URL; credential: string; providerId?: string };
type ProxyProviderUpstream = ProxyAttempt & { providerId: string };

export type ProviderResolution =
  | { routed: false }
  | { routed: true; blocked: true }
  | {
      routed: true;
      blocked: false;
      providers: [ProxyProviderUpstream, ...ProxyProviderUpstream[]];
    };

type ProviderAttemptRecord = repo.modelProviders.ProviderRequestRecord;

interface ModelProxyOptions {
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
  resolveRun: (token: string) => Promise<{
    runId: string;
    conversationId?: string;
    agentId?: string;
  } | null>;
  checkOutbound?: (input: {
    runId: string;
    agentId?: string;
    model?: string;
    body: Buffer;
  }) => Promise<{ blocked: boolean; body: Buffer }>;
  resolveProviders?: (
    run: { runId: string; conversationId?: string },
    model: string | undefined,
  ) => Promise<ProviderResolution>;
  recordProviderServed?: (input: { runId: string; providerId: string }) => Promise<void> | void;
  recordProviderResult?: (input: ProviderAttemptRecord) => Promise<void> | void;
}

export interface ModelProxy {
  /** 沙盒应使用的基址。 */
  url: string;
  localUrl: string;
  /** 为一次 run 签发短期 token。 */
  issueToken: (runId: string) => string;
  /** run 结束时吊销。 */
  revokeToken: (runId: string) => void;
  close: () => Promise<void>;
}

interface ProxyRequestContext {
  runId?: string | undefined;
  model?: string | undefined;
  providerId?: string | undefined;
  upstreamRequestId?: string | undefined;
  startedAt?: number | undefined;
}

function modelOf(body: Buffer): string | undefined {
  if (body.length === 0) return undefined;
  try {
    const parsed = modelRequestSchema.safeParse(JSON.parse(body.toString('utf8')));
    return parsed.data?.model;
  } catch {
    return undefined;
  }
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
  const upstreamCredential = options.apiKey ?? options.authToken;
  if (!upstreamCredential && !options.resolveProviders) return null;

  const activeRuns = new Set<string>();
  const upstream = new URL(upstreamBaseUrl);

  const server = createServer((req, res) => {
    const ctx: ProxyRequestContext = {};
    void handle(req, res, ctx).catch((err: unknown) => {
      logger.error({ err, ...ctx }, 'model proxy request failed');
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
    const messageRequest = MESSAGE_PATHS.has(url.pathname);
    const generates = req.method === 'POST' && url.pathname === MESSAGE_PATH;
    if (
      !messageRequest &&
      url.pathname !== MODELS_PATH &&
      !url.pathname.startsWith(`${MODELS_PATH}/`)
    ) {
      logger.warn({ path: url.pathname, status: 404 }, 'model proxy rejected path');
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'not_found', message: 'path not proxied' } }));
      return;
    }

    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) {
      logger.warn({ path: url.pathname, status: 401 }, 'model proxy rejected token: missing');
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'unauthorized', message: 'missing token' } }));
      return;
    }

    const run = await options.resolveRun(token);
    if (!run || !activeRuns.has(run.runId)) {
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
    const validatesModel = messageRequest && (options.resolveProviders || options.checkOutbound);
    ctx.model = validatesModel ? modelOf(body) : undefined;
    if (validatesModel && ctx.model === undefined) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { type: 'invalid_request_error', message: 'missing or invalid model' },
        }),
      );
      return;
    }
    if (messageRequest && options.checkOutbound) {
      const checked = await options.checkOutbound({
        runId: run.runId,
        ...(run.agentId === undefined ? {} : { agentId: run.agentId }),
        ...(ctx.model === undefined ? {} : { model: ctx.model }),
        body,
      });
      if (checked.blocked || (!checked.body.equals(body) && modelOf(checked.body) !== ctx.model)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { type: 'content_blocked', message: CONTENT_BLOCKED_MESSAGE },
          }),
        );
        return;
      }
      body = checked.body;
    }
    const resolved = await options.resolveProviders?.(run, ctx.model);
    const attempts: ProxyAttempt[] = resolved?.routed
      ? resolved.blocked
        ? []
        : resolved.providers
      : upstreamCredential
        ? [{ baseUrl: upstream, credential: upstreamCredential }]
        : [];
    if (attempts.length === 0) {
      const blocked = resolved?.routed === true && resolved.blocked;
      const message = blocked
        ? 'Matching model providers are unavailable: monthly budget exhausted, endpoint validation failed, or credential unavailable'
        : 'no provider';
      logger.warn(
        { runId: ctx.runId, model: ctx.model, status: 502, blocked },
        'model proxy has no upstream provider',
      );
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'proxy_error', message } }));
      return;
    }

    if (res.destroyed) return;
    const abort = new AbortController();
    const abortIfUnfinished = () => {
      if (!res.writableFinished) abort.abort();
    };
    res.once('close', abortIfUnfinished);

    const record = async (input: ProviderAttemptRecord): Promise<void> => {
      try {
        await options.recordProviderResult?.(input);
      } catch (err) {
        logger.warn({ err, ...ctx }, 'model proxy provider record failed');
      }
    };

    let failoverFrom: string | undefined;
    let lastStatus: number | undefined;
    let lastError: ProviderErrorKind | undefined;

    try {
      for (const attempt of attempts) {
        if (abort.signal.aborted) return;
        const { providerId } = attempt;
        const target = new URL(attempt.baseUrl);
        target.pathname = target.pathname.replace(/\/+$/, '') + url.pathname;
        target.search = url.search;
        target.hash = '';
        const headers: Record<string, string> = {
          'content-type': req.headers['content-type'] ?? 'application/json',
          accept: req.headers.accept ?? 'application/json',
          'x-api-key': attempt.credential,
          authorization: `Bearer ${attempt.credential}`,
          'anthropic-version': String(req.headers['anthropic-version'] ?? '2023-06-01'),
        };
        if (typeof req.headers['anthropic-beta'] === 'string') {
          headers['anthropic-beta'] = req.headers['anthropic-beta'];
        }
        const attemptStarted = Date.now();
        const recordAttempt = async (
          result: Pick<
            ProviderAttemptRecord,
            'statusCode' | 'errorKind' | 'upstreamRequestId' | 'error'
          >,
        ) => {
          if (providerId === undefined) return;
          ctx.providerId = providerId;
          await record({
            providerId,
            runId: generates ? run.runId : null,
            logOnly: !generates,
            model: ctx.model ?? null,
            durationMs: Date.now() - attemptStarted,
            failoverFromProviderId: failoverFrom ?? null,
            ...result,
          });
        };
        const startAbort = new AbortController();
        const startTimer = setTimeout(() => startAbort.abort(), UPSTREAM_START_TIMEOUT_MS);
        let upstreamRes: Response;
        try {
          upstreamRes = await fetch(target, {
            method: req.method ?? 'POST',
            headers,
            redirect: 'manual',
            signal: AbortSignal.any([abort.signal, startAbort.signal]),
            ...(body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
          });
        } catch {
          clearTimeout(startTimer);
          if (abort.signal.aborted) return;
          const timedOut = startAbort.signal.aborted;
          lastError = timedOut ? 'timeout' : 'network';
          await recordAttempt({ errorKind: lastError, error: timedOut ? '请求超时' : '网络错误' });
          failoverFrom = providerId;
          continue;
        }
        const upstreamRequestId = upstreamRes.headers.get('request-id');
        ctx.upstreamRequestId = upstreamRequestId ?? undefined;
        const statusCode = upstreamRes.status;
        const retryable =
          providerId !== undefined &&
          (statusCode === 401 ||
            statusCode === 403 ||
            statusCode === 408 ||
            statusCode === 429 ||
            (statusCode >= 300 && statusCode < 400) ||
            statusCode >= 500);
        if (retryable) {
          clearTimeout(startTimer);
          lastStatus = statusCode;
          lastError = providerErrorKindForStatus(statusCode);
          await recordAttempt({ statusCode, errorKind: lastError, upstreamRequestId });
          failoverFrom = providerId;
          await upstreamRes.body?.cancel().catch(() => undefined);
          continue;
        }

        const contentType = upstreamRes.headers.get('content-type') ?? 'application/json';
        const sse =
          generates &&
          providerId !== undefined &&
          upstreamRes.ok &&
          contentType.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
        let firstEvent: string | undefined;
        let messageStopped = false;
        let streamError = false;
        const decoder = sse ? new TextDecoder() : undefined;
        let partialLine = '';
        let previousCR = false;
        let event = '';
        let hasData = false;
        const inspectChunk = (chunk: Uint8Array) => {
          const text = decoder?.decode(chunk, { stream: true });
          if (!text) return;
          const lines = (previousCR ? text.replace(/^\n/, '') : text).split(/\r\n?|\n/);
          previousCR = text.endsWith('\r');
          const tail = lines.pop() ?? '';
          for (const segment of lines) {
            const line = partialLine + segment;
            partialLine = '';
            if (line === '') {
              if (hasData || event === 'error') {
                if (
                  event === 'error' ||
                  event === 'content_block_start' ||
                  event === 'content_block_delta' ||
                  event === 'message_delta' ||
                  event === 'message_stop'
                ) {
                  firstEvent ??= event;
                }
                if (event === 'message_stop') messageStopped = true;
                if (event === 'error') streamError = true;
              }
              event = '';
              hasData = false;
            } else if (line === 'event' || line.startsWith('event:')) {
              event = line.slice(6).replace(/^ /, '');
            } else if (line === 'data' || line.startsWith('data:')) {
              hasData = true;
            }
          }
          partialLine = (partialLine + tail).slice(0, 32);
        };
        const upstreamBody = upstreamRes.body;
        const prefix: Uint8Array[] = [];
        if (sse) {
          const reader = upstreamBody?.getReader();
          let prefixBytes = 0;
          let readFailed = false;
          if (reader) {
            try {
              while (firstEvent === undefined && prefixBytes < MAX_SSE_PREFIX_BYTES) {
                const { done, value } = await reader.read();
                if (done) break;
                prefix.push(value);
                prefixBytes += value.byteLength;
                inspectChunk(value);
              }
            } catch {
              readFailed = true;
            } finally {
              reader.releaseLock();
            }
          }
          clearTimeout(startTimer);
          if (abort.signal.aborted) return;
          if (firstEvent === undefined || firstEvent === 'error') {
            const timedOut = startAbort.signal.aborted;
            lastStatus = statusCode;
            lastError = timedOut ? 'timeout' : readFailed ? 'network' : 'upstream';
            await upstreamBody?.cancel().catch(() => undefined);
            await recordAttempt({
              statusCode,
              upstreamRequestId,
              errorKind: lastError,
              error: timedOut ? '请求超时' : readFailed ? '上游响应中断' : '上游未能开始流式响应',
            });
            failoverFrom = providerId;
            continue;
          }
        } else {
          clearTimeout(startTimer);
        }
        if (
          generates &&
          providerId !== undefined &&
          upstreamRes.ok &&
          options.recordProviderServed
        ) {
          try {
            await options.recordProviderServed({ runId: run.runId, providerId });
          } catch (err) {
            logger.warn({ err, ...ctx, providerId }, 'model proxy served provider record failed');
            await upstreamBody?.cancel().catch(() => undefined);
            await recordAttempt({
              statusCode,
              upstreamRequestId,
              errorKind: 'upstream',
              error: '供应商归属写回失败',
            });
            if (abort.signal.aborted) return;
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: { type: 'proxy_error', message: 'provider attribution unavailable' },
              }),
            );
            return;
          }
          if (abort.signal.aborted) return;
        }
        res.writeHead(statusCode, {
          'content-type': contentType,
          ...(upstreamRequestId ? { 'request-id': upstreamRequestId } : {}),
        });
        if (upstreamBody) {
          let upstreamFailed = false;
          try {
            await pipeline(async function* () {
              try {
                yield* prefix;
                for await (const chunk of upstreamBody) {
                  if (sse) inspectChunk(chunk);
                  yield chunk;
                }
              } catch (err) {
                upstreamFailed = !abort.signal.aborted;
                throw err;
              }
            }, res);
          } catch (err) {
            if (upstreamFailed) {
              await recordAttempt({
                statusCode,
                upstreamRequestId,
                errorKind: 'network',
                error: '上游响应中断',
              });
              logger.warn(
                { err, ...ctx, providerId, status: statusCode },
                'model upstream response interrupted',
              );
            } else if (!abort.signal.aborted) {
              throw err;
            }
            return;
          }
        } else {
          res.end();
        }
        const incompleteStream = sse && (streamError || !messageStopped);
        await recordAttempt({
          statusCode,
          upstreamRequestId,
          errorKind:
            upstreamRes.ok && !incompleteStream ? null : providerErrorKindForStatus(statusCode),
          ...(incompleteStream ? { error: '上游未完成流式响应' } : {}),
        });
        logger.info(
          {
            runId: ctx.runId,
            model: ctx.model,
            providerId,
            status: statusCode,
            durationMs: Date.now() - startedAt,
            upstreamRequestId,
          },
          'model proxy request',
        );
        return;
      }
      logger.warn(
        { runId: ctx.runId, status: 502, lastStatus, lastError },
        'model proxy all providers failed',
      );
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'proxy_error', message: 'proxy failed' } }));
    } catch (err) {
      if (!abort.signal.aborted) throw err;
    } finally {
      res.off('close', abortIfUnfinished);
    }
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(options.port ?? 0, '0.0.0.0', () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const url = `http://host.docker.internal:${port}`;
  const localUrl = `http://127.0.0.1:${port}`;
  logger.info({ url, upstream: upstream.origin }, 'model proxy listening');

  return {
    url,
    localUrl,
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
