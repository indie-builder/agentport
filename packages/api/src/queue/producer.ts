import { appendStreamEvent } from '@agentport/core';
import { logEvent } from '@agentport/core/logger';
import type {
  AgentRunJob,
  ChannelEvent,
  ChatEvent,
  DataDomainBuildJob,
  DataDomainEnrichmentJob,
  EvalRunJob,
  KnowledgeJobQueuePayload,
  MonitoredQueueName,
  RuntimeEnvironmentBuildJob,
} from '@agentport/shared';
import {
  channelEventSchema,
  channelEventsConnectionName,
  channelStreamKey,
  chatEventSchema,
  DATA_DOMAIN_BUILDS_QUEUE,
  DATA_DOMAIN_ENRICHMENTS_QUEUE,
  EVAL_RUNS_QUEUE,
  KNOWLEDGE_CANCEL_PAYLOAD,
  KNOWLEDGE_JOBS_QUEUE,
  knowledgeCancelKey,
  parseJsonAs,
  RUN_CANCEL_PAYLOAD,
  RUNS_QUEUE,
  RUNTIME_ENVIRONMENT_BUILDS_QUEUE,
  runCancelKey,
  runEventsConnectionName,
  runStreamKey,
  SERVER_SHUTDOWN_MESSAGE,
  STREAM_INTERRUPTED_MESSAGE,
  STREAM_TTL_SECONDS,
} from '@agentport/shared';
import { createBunRedisClient, Queue } from 'bullmq';
import { RedisClient } from 'bun';
import type { Logger } from 'pino';

let redisUrl: string | undefined;
let logger: Logger | undefined;

export function configureQueueProducer(url: string, log?: Logger): void {
  redisUrl ??= url;
  logger ??= log;
}

function requireRedisUrl(): string {
  if (redisUrl === undefined) {
    throw new Error('Queue producer used before configureQueueProducer(redisUrl)');
  }
  return redisUrl;
}

const READ_PAGE_SIZE = 2;

type StreamEntry = [string, string[]];

function payloadOf(fields: string[]): string | undefined {
  const index = fields.indexOf('payload');
  return index >= 0 ? fields[index + 1] : undefined;
}

function logRedisError(queue: string) {
  return (err: Error): void => {
    if (logger !== undefined) logEvent(logger, 'queue error', { queue }, 'error', { err });
  };
}

let queue: Queue<AgentRunJob> | undefined;
let evalQueue: Queue<EvalRunJob> | undefined;
let knowledgeQueue: Queue<KnowledgeJobQueuePayload> | undefined;
let runtimeEnvironmentBuildQueue: Queue<RuntimeEnvironmentBuildJob> | undefined;
let dataDomainBuildQueue: Queue<DataDomainBuildJob> | undefined;
let dataDomainEnrichmentQueue: Queue<DataDomainEnrichmentJob> | undefined;
const monitoringQueues = new Map<MonitoredQueueName, Queue>();
let client: RedisClient | undefined;
let channelClient: RedisClient | undefined;
let queueConnection: ReturnType<typeof createBunRedisClient> | undefined;

function getQueueConnection() {
  queueConnection ??= createBunRedisClient(new RedisClient(requireRedisUrl()));
  return queueConnection;
}

export function getQueue(): Queue<AgentRunJob> {
  if (!queue) {
    queue = new Queue<AgentRunJob>(RUNS_QUEUE, { connection: getQueueConnection() });
    queue.on('error', logRedisError(RUNS_QUEUE));
  }
  return queue;
}

export function getEvalQueue(): Queue<EvalRunJob> {
  if (!evalQueue) {
    evalQueue = new Queue<EvalRunJob>(EVAL_RUNS_QUEUE, { connection: getQueueConnection() });
    evalQueue.on('error', logRedisError(EVAL_RUNS_QUEUE));
  }
  return evalQueue;
}

export function getKnowledgeQueue(): Queue<KnowledgeJobQueuePayload> {
  if (!knowledgeQueue) {
    knowledgeQueue = new Queue<KnowledgeJobQueuePayload>(KNOWLEDGE_JOBS_QUEUE, {
      connection: getQueueConnection(),
    });
    knowledgeQueue.on('error', logRedisError(KNOWLEDGE_JOBS_QUEUE));
  }
  return knowledgeQueue;
}

export function getRuntimeEnvironmentBuildQueue(): Queue<RuntimeEnvironmentBuildJob> {
  if (!runtimeEnvironmentBuildQueue) {
    runtimeEnvironmentBuildQueue = new Queue<RuntimeEnvironmentBuildJob>(
      RUNTIME_ENVIRONMENT_BUILDS_QUEUE,
      { connection: getQueueConnection() },
    );
    runtimeEnvironmentBuildQueue.on('error', logRedisError(RUNTIME_ENVIRONMENT_BUILDS_QUEUE));
  }
  return runtimeEnvironmentBuildQueue;
}

export function getDataDomainBuildQueue(): Queue<DataDomainBuildJob> {
  if (!dataDomainBuildQueue) {
    dataDomainBuildQueue = new Queue<DataDomainBuildJob>(DATA_DOMAIN_BUILDS_QUEUE, {
      connection: getQueueConnection(),
    });
    dataDomainBuildQueue.on('error', logRedisError(DATA_DOMAIN_BUILDS_QUEUE));
  }
  return dataDomainBuildQueue;
}

export function getDataDomainEnrichmentQueue(): Queue<DataDomainEnrichmentJob> {
  if (!dataDomainEnrichmentQueue) {
    dataDomainEnrichmentQueue = new Queue<DataDomainEnrichmentJob>(DATA_DOMAIN_ENRICHMENTS_QUEUE, {
      connection: getQueueConnection(),
    });
    dataDomainEnrichmentQueue.on('error', logRedisError(DATA_DOMAIN_ENRICHMENTS_QUEUE));
  }
  return dataDomainEnrichmentQueue;
}

export function getMonitoringQueue(name: MonitoredQueueName): Queue {
  let monitored = monitoringQueues.get(name);
  if (!monitored) {
    monitored = new Queue(name, {
      connection: getQueueConnection(),
      skipMetasUpdate: true,
    });
    monitored.on('error', logRedisError(name));
    monitoringQueues.set(name, monitored);
  }
  return monitored;
}

function getClient(): RedisClient {
  if (!client) {
    client = new RedisClient(requireRedisUrl());
    client.onclose = logRedisError('redis');
  }
  return client;
}

function getChannelClient(): RedisClient {
  if (!channelClient) {
    channelClient = new RedisClient(requireRedisUrl(), {
      connectionTimeout: 1_000,
      idleTimeout: 1_000,
      autoReconnect: false,
    });
    channelClient.onclose = () => undefined;
  }
  return channelClient;
}

export async function publishKnowledgeCancel(jobId: string): Promise<void> {
  await getClient().set(
    knowledgeCancelKey(jobId),
    KNOWLEDGE_CANCEL_PAYLOAD,
    'EX',
    STREAM_TTL_SECONDS,
  );
}

const parseChatEvent = (payload: string): ChatEvent | null => parseJsonAs(payload, chatEventSchema);
const parseChannelEvent = (payload: string): ChannelEvent | null =>
  parseJsonAs(payload, channelEventSchema);

export async function publishRun(runId: string, event: ChatEvent): Promise<void> {
  await appendStreamEvent(getClient(), runStreamKey(runId), event);
}

export async function publishChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
  const redis = getChannelClient();
  if (!redis.connected) await redis.connect();
  await appendStreamEvent(redis, channelStreamKey(channelId), event);
}

export async function requestRunCancel(runId: string): Promise<boolean> {
  const redis = getClient();
  const key = runCancelKey(runId);
  const [setResult] = await Promise.all([
    redis.send('SET', [key, RUN_CANCEL_PAYLOAD, 'EX', String(STREAM_TTL_SECONDS), 'NX']),
    redis.publish(key, RUN_CANCEL_PAYLOAD),
  ]);
  return setResult !== null;
}

export async function isRunCancelRequested(runId: string): Promise<boolean> {
  return await getClient().exists(runCancelKey(runId));
}

export interface RunSubscription {
  close: () => void;
}

const subscriptions = new Map<RedisClient, () => void>();

export async function subscribeRun(
  runId: string,
  cb: (event: ChatEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<RunSubscription> {
  return subscribeStream(
    runStreamKey(runId),
    runEventsConnectionName(runId),
    parseChatEvent,
    { type: 'error', message: SERVER_SHUTDOWN_MESSAGE },
    { type: 'error', message: STREAM_INTERRUPTED_MESSAGE },
    cb,
    signal,
  );
}

export async function subscribeChannel(
  channelId: string,
  cb: (event: ChannelEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<RunSubscription> {
  return subscribeStream(
    channelStreamKey(channelId),
    channelEventsConnectionName(channelId),
    parseChannelEvent,
    { type: 'error', message: SERVER_SHUTDOWN_MESSAGE },
    { type: 'error', message: STREAM_INTERRUPTED_MESSAGE },
    cb,
    signal,
    getChannelClient(),
  );
}

async function subscribeStream<T>(
  key: string,
  connectionName: string,
  parse: (payload: string) => T | null,
  shutdownEvent: T,
  errorEvent: T,
  cb: (event: T) => void | Promise<void>,
  signal?: AbortSignal,
  replayClient?: RedisClient,
): Promise<RunSubscription> {
  if (signal?.aborted) return { close: () => undefined };
  let closed = false;
  let redis = new RedisClient(requireRedisUrl());
  redis.onclose = (err) => {
    if (!closed) logRedisError('redis')(err);
  };
  let lastId = '0-0';

  const release = (): void => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    subscriptions.delete(redis);
    // QUIT 会排在阻塞中的 XREAD 后面等它返回，所以关闭必须直接断开连接。
    redis.onclose = () => undefined;
    redis.close();
  };
  const onAbort = (): void => release();
  signal?.addEventListener('abort', onAbort, { once: true });
  const shutdown = () => {
    void Promise.resolve(cb(shutdownEvent)).catch((err: unknown) => {
      logRedisError('redis')(err instanceof Error ? err : new Error(String(err)));
    });
    release();
  };
  subscriptions.set(redis, shutdown);

  try {
    await redis.send('CLIENT', ['SETNAME', connectionName]);
    let cursor = '0-0';
    for (;;) {
      if (closed) break;
      if (replayClient && !replayClient.connected) await replayClient.connect();
      const page: StreamEntry[] = await (replayClient ?? getClient()).send('XRANGE', [
        key,
        cursor,
        '+',
        'COUNT',
        String(READ_PAGE_SIZE),
      ]);
      for (const [id, fields] of page) {
        if (closed) break;
        lastId = id;
        const event = parse(payloadOf(fields) ?? '');
        if (event) await cb(event);
      }
      if (closed || page.length < READ_PAGE_SIZE) break;
      const newest = page.at(-1)?.[0];
      if (newest === undefined) break;
      cursor = `(${newest}`;
    }
  } catch (err) {
    release();
    throw err;
  }

  if (closed) return { close: release };

  void (async () => {
    try {
      while (!closed) {
        let reply: Record<string, StreamEntry[]> | null;
        try {
          if (!redis.connected) {
            await redis.connect();
            await redis.send('CLIENT', ['SETNAME', connectionName]);
          }
          reply = await redis.send('XREAD', [
            'COUNT',
            String(READ_PAGE_SIZE),
            'BLOCK',
            '0',
            'STREAMS',
            key,
            lastId,
          ]);
        } catch (err) {
          if (closed) return;
          if (err instanceof Error && 'code' in err && err.code === 'ERR_REDIS_SERVER_ERROR')
            throw err;
          logRedisError('redis')(err instanceof Error ? err : new Error(String(err)));
          subscriptions.delete(redis);
          redis.onclose = () => undefined;
          redis.close();
          redis = new RedisClient(requireRedisUrl());
          redis.onclose = logRedisError('redis');
          subscriptions.set(redis, shutdown);
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        for (const batch of Object.values(reply ?? {})) {
          for (const [id, fields] of batch) {
            if (closed) return;
            lastId = id;
            const event = parse(payloadOf(fields) ?? '');
            if (event) await cb(event);
          }
        }
      }
    } catch (err) {
      if (!closed) {
        logRedisError('redis')(err instanceof Error ? err : new Error(String(err)));
        try {
          await cb(errorEvent);
        } finally {
          release();
        }
      }
    }
  })().catch(logRedisError('redis'));

  return { close: release };
}

export async function closeProducer(): Promise<void> {
  if (channelClient) channelClient.onclose = () => undefined;
  channelClient?.close();
  channelClient = undefined;
  const closing = [
    queue,
    evalQueue,
    knowledgeQueue,
    runtimeEnvironmentBuildQueue,
    dataDomainBuildQueue,
    dataDomainEnrichmentQueue,
    [...monitoringQueues.values()],
    client,
  ] as const;
  queue = undefined;
  evalQueue = undefined;
  knowledgeQueue = undefined;
  runtimeEnvironmentBuildQueue = undefined;
  dataDomainBuildQueue = undefined;
  dataDomainEnrichmentQueue = undefined;
  monitoringQueues.clear();
  client = undefined;
  await Promise.allSettled([
    closing[0]?.close(),
    closing[1]?.close(),
    closing[2]?.close(),
    closing[3]?.close(),
    closing[4]?.close(),
    closing[5]?.close(),
    ...closing[6].map((monitored) => monitored.close()),
    ...[...subscriptions.values()].map((close) => close()),
  ]);
  if (closing[7]) closing[7].onclose = () => undefined;
  closing[7]?.close();
  await queueConnection?.quit();
  queueConnection = undefined;
  subscriptions.clear();
}
