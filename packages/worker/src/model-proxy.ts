import { CONTENT_BLOCKED_MESSAGE, readCappedBytes } from '@agentport/core';
import type { repo } from '@agentport/db';
import {
  PROVIDER_NETWORK_MESSAGE,
  PROVIDER_TIMEOUT_MESSAGE,
  type ProviderErrorKind,
  providerErrorKindForStatus,
} from '@agentport/shared';
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
  upstreamBaseUrl: string;
  apiKey?: string;
  authToken?: string;
  port?: number;
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
  url: string;
  localUrl: string;
  issueToken: (runId: string) => string;
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

function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function startModelProxy(options: ModelProxyOptions): Promise<ModelProxy | null> {
  const { logger, upstreamBaseUrl } = options;
  const upstreamCredential = options.apiKey ?? options.authToken;
  if (!upstreamCredential && !options.resolveProviders) return null;

  const activeRuns = new Set<string>();
  const upstream = new URL(upstreamBaseUrl);

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: '0.0.0.0',
    idleTimeout: 0,
    fetch(request) {
      const ctx: ProxyRequestContext = {};
      return handle(request, ctx).catch((err: unknown) => {
        logger.error({ err, ...ctx }, 'model proxy request failed');
        return errorResponse(500, 'proxy_error', 'proxy failed');
      });
    },
  });

  async function handle(request: Request, ctx: ProxyRequestContext): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const messageRequest = MESSAGE_PATHS.has(url.pathname);
    const generates = request.method === 'POST' && url.pathname === MESSAGE_PATH;
    if (
      !messageRequest &&
      url.pathname !== MODELS_PATH &&
      !url.pathname.startsWith(`${MODELS_PATH}/`)
    ) {
      logger.warn({ path: url.pathname, status: 404 }, 'model proxy rejected path');
      return errorResponse(404, 'not_found', 'path not proxied');
    }

    const token = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) {
      logger.warn({ path: url.pathname, status: 401 }, 'model proxy rejected token: missing');
      return errorResponse(401, 'unauthorized', 'missing token');
    }

    const run = await options.resolveRun(token);
    if (!run || !activeRuns.has(run.runId)) {
      logger.warn(
        { path: url.pathname, status: 401, ...(run ? { runId: run.runId } : {}) },
        'model proxy rejected token: invalid or revoked',
      );
      return errorResponse(401, 'unauthorized', 'invalid token');
    }
    ctx.runId = run.runId;

    let body: Buffer;
    try {
      body = await readCappedBytes(request, MAX_BODY_BYTES, 'model proxy request');
    } catch {
      return errorResponse(413, 'payload_too_large', 'body too large');
    }

    ctx.startedAt = startedAt;
    const validatesModel = messageRequest && (options.resolveProviders || options.checkOutbound);
    ctx.model = validatesModel ? modelOf(body) : undefined;
    if (validatesModel && ctx.model === undefined) {
      return errorResponse(400, 'invalid_request_error', 'missing or invalid model');
    }
    if (messageRequest && options.checkOutbound) {
      const checked = await options.checkOutbound({
        runId: run.runId,
        ...(run.agentId === undefined ? {} : { agentId: run.agentId }),
        ...(ctx.model === undefined ? {} : { model: ctx.model }),
        body,
      });
      if (checked.blocked || (!checked.body.equals(body) && modelOf(checked.body) !== ctx.model)) {
        return errorResponse(403, 'content_blocked', CONTENT_BLOCKED_MESSAGE);
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
      return errorResponse(502, 'proxy_error', message);
    }

    const abort = new AbortController();
    request.signal.addEventListener('abort', () => abort.abort());
    if (request.signal.aborted) return new Response(null, { status: 499 });

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
        if (abort.signal.aborted) return new Response(null, { status: 499 });
        const { providerId } = attempt;
        const target = new URL(attempt.baseUrl);
        target.pathname = target.pathname.replace(/\/+$/, '') + url.pathname;
        target.search = url.search;
        target.hash = '';
        const headers: Record<string, string> = {
          'content-type': request.headers.get('content-type') ?? 'application/json',
          accept: request.headers.get('accept') ?? 'application/json',
          'x-api-key': attempt.credential,
          authorization: `Bearer ${attempt.credential}`,
          'anthropic-version': request.headers.get('anthropic-version') ?? '2023-06-01',
        };
        const beta = request.headers.get('anthropic-beta');
        if (beta !== null) headers['anthropic-beta'] = beta;
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
            method: request.method,
            headers,
            redirect: 'manual',
            signal: AbortSignal.any([abort.signal, startAbort.signal]),
            ...(body.length > 0 && request.method !== 'GET' && request.method !== 'HEAD'
              ? { body }
              : {}),
          });
        } catch {
          clearTimeout(startTimer);
          if (abort.signal.aborted) return new Response(null, { status: 499 });
          const timedOut = startAbort.signal.aborted;
          lastError = timedOut ? 'timeout' : 'network';
          await recordAttempt({
            errorKind: lastError,
            error: timedOut ? PROVIDER_TIMEOUT_MESSAGE : PROVIDER_NETWORK_MESSAGE,
          });
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
          if (abort.signal.aborted) return new Response(null, { status: 499 });
          if (firstEvent === undefined || firstEvent === 'error') {
            const timedOut = startAbort.signal.aborted;
            lastStatus = statusCode;
            lastError = timedOut ? 'timeout' : readFailed ? 'network' : 'upstream';
            await upstreamBody?.cancel().catch(() => undefined);
            await recordAttempt({
              statusCode,
              upstreamRequestId,
              errorKind: lastError,
              error: timedOut
                ? PROVIDER_TIMEOUT_MESSAGE
                : readFailed
                  ? '上游响应中断'
                  : '上游未能开始流式响应',
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
            if (abort.signal.aborted) return new Response(null, { status: 499 });
            return errorResponse(502, 'proxy_error', 'provider attribution unavailable');
          }
          if (abort.signal.aborted) return new Response(null, { status: 499 });
        }
        const responseHeaders: Record<string, string> = {
          'content-type': contentType,
          ...(upstreamRequestId ? { 'request-id': upstreamRequestId } : {}),
        };
        const finalize = async (): Promise<void> => {
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
        };
        if (!upstreamBody) {
          await finalize();
          return new Response(null, { status: statusCode, headers: responseHeaders });
        }
        const reader = upstreamBody.getReader();
        let downstreamCancelled = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of prefix) controller.enqueue(chunk);
          },
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                if (!downstreamCancelled) {
                  await finalize();
                  controller.close();
                }
                return;
              }
              if (sse) inspectChunk(value);
              if (!downstreamCancelled) controller.enqueue(value);
            } catch (err) {
              if (downstreamCancelled) return;
              if (abort.signal.aborted) {
                controller.close();
                return;
              }
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
              controller.error(err);
            }
          },
          cancel() {
            downstreamCancelled = true;
            abort.abort();
            void reader.cancel().catch(() => undefined);
          },
        });
        return new Response(stream, { status: statusCode, headers: responseHeaders });
      }
      logger.warn(
        { runId: ctx.runId, status: 502, lastStatus, lastError },
        'model proxy all providers failed',
      );
      return errorResponse(502, 'proxy_error', 'proxy failed');
    } catch (err) {
      if (!abort.signal.aborted) throw err;
      return new Response(null, { status: 499 });
    }
  }

  const url = `http://host.docker.internal:${server.port}`;
  const localUrl = `http://127.0.0.1:${server.port}`;
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
      await server.stop();
    },
  };
}
