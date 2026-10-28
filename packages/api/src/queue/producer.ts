import type { AgentRunJob, ChatEvent, EvalRunJob } from '@agentport/shared';
import {
  chatEventSchema,
  EVAL_RUNS_QUEUE,
  KNOWLEDGE_CANCEL_PAYLOAD,
  KNOWLEDGE_JOBS_QUEUE,
  knowledgeCancelKey,
  RUN_CANCEL_PAYLOAD,
  RUN_STREAM_MAXLEN,
  RUNS_QUEUE,
  runCancelKey,
  runEventsConnectionName,
  runStreamKey,
} from '@agentport/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * 事件通道用 Redis Stream 而不是 pub/sub：
 * pub/sub 在订阅建立前发出的事件会永久丢失（客户端从 POST 到建连之间常见）。
 * Stream 允许从 0 回放，且由 TTL 清理，不需要额外维护。
 */
const STREAM_TTL_SECONDS = 3600;

/** 首次回放只补发最近的 8MiB，晚加入的观众不会把整条流拉进内存。 */
const REPLAY_MAX_BYTES = 8 * 1024 * 1024;
/**
 * 每次 XREVRANGE/XREAD 的条数上限。批量摊薄往返：40 条约 21 次而不是 41 次。
 * runner 转发的单条事件受 worker 的 8MiB NDJSON 行预算：单页最多 2 × 8MiB = 16MiB，
 * 叠加累计回放的 8MiB，慢观众峰值约 24MiB（仅此路径，且不含 JSON.parse 副本等，非绝对 RSS）。
 * worker/API 自行合成的事件（如 run_finished 的 uiProgram）不走行预算，不受上述上界约束。
 */
const READ_PAGE_SIZE = 2;

type StreamEntry = [string, string[]];

function payloadOf(fields: string[]): string | undefined {
  const index = fields.indexOf('payload');
  return index >= 0 ? fields[index + 1] : undefined;
}

/**
 * 从最新一条往前分页读，直到 8MiB 或流头；返回按时间正序的事件。
 * 触发上限时 truncated 为真，由调用方补一条截断标记。
 */
async function readLatest(
  redis: Redis,
  key: string,
): Promise<{ entries: StreamEntry[]; newestId: string | undefined; truncated: boolean }> {
  const newestFirst: StreamEntry[] = [];
  let newestId: string | undefined;
  let cursor = '+';
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const page = (await redis.xrevrange(
      key,
      cursor,
      '-',
      'COUNT',
      READ_PAGE_SIZE,
    )) as StreamEntry[];
    newestId ??= page[0]?.[0];
    for (const entry of page) {
      bytes += Buffer.byteLength(payloadOf(entry[1]) ?? '');
      if (bytes > REPLAY_MAX_BYTES) {
        truncated = true;
        break;
      }
      newestFirst.push(entry);
    }
    if (truncated || page.length < READ_PAGE_SIZE) break;
    const oldest = page.at(-1)?.[0];
    if (oldest === undefined) break;
    cursor = `(${oldest}`;
  }
  return { entries: newestFirst.reverse(), newestId, truncated };
}

/**
 * XINFO STREAM 返回交替的字段/值数组；只取本模块需要的两个数值。
 * entries-added 是累计写入数，length 是当前条数，前者更大说明流头已被裁掉。
 */
function infoNumber(info: unknown[], field: string): number {
  const index = info.indexOf(field);
  return Number(index >= 0 ? info[index + 1] : 0);
}

/** 流在读取与查询之间过期属于正常竞态；其他 Redis 错误照常抛出。 */
function isMissingStream(err: unknown): boolean {
  return err instanceof Error && /no such key/i.test(err.message);
}

async function trimmedBeforeReplay(
  redis: Redis,
  key: string,
  entries: StreamEntry[],
): Promise<boolean> {
  // 空流没有可回放的内容，也就不用为可能不存在的 key 付一次 XINFO。
  if (entries.length === 0) return false;
  let info: unknown[];
  try {
    info = (await redis.xinfo('STREAM', key)) as unknown[];
  } catch (err) {
    if (isMissingStream(err)) return false;
    throw err;
  }
  return infoNumber(info, 'entries-added') > infoNumber(info, 'length');
}

function logRedisError(err: Error): void {
  process.stderr.write(`[queue] redis error: ${err.message}\n`);
}

let queue: Queue<AgentRunJob> | undefined;
let evalQueue: Queue<EvalRunJob> | undefined;
let knowledgeQueue: Queue<{ jobId: string }> | undefined;
let client: Redis | undefined;

export function getQueue(): Queue<AgentRunJob> {
  if (!queue) {
    queue = new Queue<AgentRunJob>(RUNS_QUEUE, { connection: { url: REDIS_URL } });
    queue.on('error', logRedisError);
  }
  return queue;
}

export function getEvalQueue(): Queue<EvalRunJob> {
  if (!evalQueue) {
    evalQueue = new Queue<EvalRunJob>(EVAL_RUNS_QUEUE, { connection: { url: REDIS_URL } });
    evalQueue.on('error', logRedisError);
  }
  return evalQueue;
}

/** 知识任务独立队列：与聊天 run 分开消费，不占 run 并发、不进运行历史。 */
export function getKnowledgeQueue(): Queue<{ jobId: string }> {
  if (!knowledgeQueue) {
    knowledgeQueue = new Queue<{ jobId: string }>(KNOWLEDGE_JOBS_QUEUE, {
      connection: { url: REDIS_URL },
    });
    knowledgeQueue.on('error', logRedisError);
  }
  return knowledgeQueue;
}

function getClient(): Redis {
  if (!client) {
    client = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    client.on('error', logRedisError);
  }
  return client;
}

/** 运行中的知识任务：worker 每秒轮询该键，非空即 abort；键由 worker 收尾时删除。 */
export async function publishKnowledgeCancel(jobId: string): Promise<void> {
  await getClient().set(
    knowledgeCancelKey(jobId),
    KNOWLEDGE_CANCEL_PAYLOAD,
    'EX',
    STREAM_TTL_SECONDS,
  );
}

function parseEvent(payload: string): ChatEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = chatEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * pipeline.exec() 不会因单条命令失败而 reject，只逐命令返回 [error, result]；
 * 这里必须检查每一条，否则写入失败会被当成成功。
 */
function throwOnCommandError(results: [Error | null, unknown][] | null): void {
  for (const [err] of results ?? []) {
    if (err) throw err;
  }
}

export async function publishRun(runId: string, event: ChatEvent): Promise<void> {
  const redis = getClient();
  const key = runStreamKey(runId);
  // 事件流不会被读取者删除（可回放），单独给 TTL 兜底；两条命令合成一次往返。
  throwOnCommandError(
    await redis
      .pipeline()
      .xadd(key, 'MAXLEN', '~', RUN_STREAM_MAXLEN, '*', 'payload', JSON.stringify(event))
      .expire(key, STREAM_TTL_SECONDS)
      .exec(),
  );
}

/**
 * running 运行的取消信号：只发通知，终态由 worker 停止容器、写完消息与产出后落库。
 * 键本身也是信号（worker 订阅后先查一次），`publish` 负责唤醒已订阅的 worker；
 * NX 让重复点击只写一条审计。
 */
export async function requestRunCancel(runId: string): Promise<boolean> {
  const redis = getClient();
  const key = runCancelKey(runId);
  const replies = await redis
    .pipeline()
    .set(key, RUN_CANCEL_PAYLOAD, 'EX', STREAM_TTL_SECONDS, 'NX')
    .publish(key, RUN_CANCEL_PAYLOAD)
    .exec();
  throwOnCommandError(replies);
  // SET NX 已有键时返回 null：这次没有真正发出新信号。
  const setResult = replies?.[0]?.[1];
  return setResult !== null && setResult !== undefined;
}

/** 挂起的工具调用据此在 worker 收尾前就停止等待。 */
export async function isRunCancelRequested(runId: string): Promise<boolean> {
  return (await getClient().exists(runCancelKey(runId))) === 1;
}

export interface RunSubscription {
  /** 从第一条事件开始回放，并在有新事件时继续推送。 */
  close: () => void;
}

/** 每个订阅独占连接；close() 时断开，避免一条连接的退出影响其他观众。 */
const subscriptions = new Map<Redis, () => void>();

/**
 * 从流头回放并持续跟进。首次只回放最近 8MiB（超出时补一条截断标记），
 * 随后用阻塞 XREAD 从最后一条真实 ID 继续：不用消费组（多观众各自回放），
 * 也不用 `$`（会跳过阻塞前到达的事件）。
 * 回调可以返回 Promise：写端背压时循环会停下等待，而不是在内存里堆事件。
 * 客户端断开时只需 close()（或 abort signal），不删除流（其他客户端还能回放）。
 *
 * shortcut: 回调慢到未读期间写入超过 MAXLEN 时，被裁掉的事件会静默丢失且不再补
 * replay_truncated；需要强一致时改为在每次 await cb() 后探测流头并按 id 补提示。
 */
export async function subscribeRun(
  runId: string,
  cb: (event: ChatEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<RunSubscription> {
  if (signal?.aborted) return { close: () => undefined };
  const key = runStreamKey(runId);
  let closed = false;
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    connectionName: runEventsConnectionName(runId),
  });
  redis.on('error', (err) => {
    // 主动断开会打断在途的 XREAD，连接关闭后的 EPIPE 属于预期。
    if (!closed) logRedisError(err);
  });
  let lastId = '0-0';

  const release = (): void => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    subscriptions.delete(redis);
    // QUIT 会排在阻塞中的 XREAD 后面等它返回，所以关闭必须直接断开连接。
    redis.disconnect();
  };
  const onAbort = (): void => release();
  signal?.addEventListener('abort', onAbort, { once: true });
  subscriptions.set(redis, () => {
    // Shutdown must not wait for a stalled viewer to drain.
    void Promise.resolve(cb({ type: 'error', message: 'Server shutting down' })).catch(
      (err: unknown) => {
        logRedisError(err instanceof Error ? err : new Error(String(err)));
      },
    );
    release();
  });

  try {
    const { entries, newestId, truncated } = await readLatest(getClient(), key);
    if (newestId !== undefined) lastId = newestId;
    // 两种截断只报一条：保留上限裁掉流头比 8MiB 回放上限更值得先告诉观众。
    const reason = (await trimmedBeforeReplay(getClient(), key, entries))
      ? 'retention'
      : truncated
        ? 'bytes'
        : undefined;
    if (reason && !closed) await cb({ type: 'replay_truncated', reason });
    for (const [, fields] of entries) {
      if (closed) break;
      const event = parseEvent(payloadOf(fields) ?? '');
      if (event) await cb(event);
    }
  } catch (err) {
    release();
    throw err;
  }

  // 回放完成后调用方不再等这个函数；跟读阶段的错误只能记录并释放，不能抛出。
  // 终端错误（握手/鉴权失败等）向观众发一条 error，让 SSE 正常收尾而不是静默卡住；
  // 闪断由 ioredis 自动重连并从 lastId 续读，不会进这里。
  void (async () => {
    try {
      while (!closed) {
        const reply = (await redis.xread(
          'COUNT',
          READ_PAGE_SIZE,
          'BLOCK',
          0,
          'STREAMS',
          key,
          lastId,
        )) as Array<[string, StreamEntry[]]> | null;
        for (const [, batch] of reply ?? []) {
          for (const [id, fields] of batch) {
            if (closed) return;
            lastId = id;
            const event = parseEvent(payloadOf(fields) ?? '');
            if (event) await cb(event);
          }
        }
      }
    } catch (err) {
      // close() 主动断开连接会让在途的 XREAD 失败，属于预期。
      if (!closed) {
        logRedisError(err instanceof Error ? err : new Error(String(err)));
        try {
          await cb({ type: 'error', message: '事件流中断，请刷新页面或重试' });
        } catch {
          // 观众写入失败时仍要释放连接。
        }
        release();
      }
    }
  })();

  return { close: release };
}

export async function closeProducer(): Promise<void> {
  const closing = [queue, evalQueue, knowledgeQueue, client] as const;
  queue = undefined;
  evalQueue = undefined;
  knowledgeQueue = undefined;
  client = undefined;
  await Promise.allSettled([
    closing[0]?.close(),
    closing[1]?.close(),
    closing[2]?.close(),
    closing[3]?.quit(),
    ...[...subscriptions.values()].map((close) => close()),
  ]);
  subscriptions.clear();
}
