import { z } from 'zod';
import { chatEventSchema, sandboxTaskSchema } from './chat.js';
import { sandboxInputCommandSchema } from './questions.js';

/**
 * 会话容器内 supervisor 与 worker 之间的 NDJSON 协议。
 * 输入复用 runner 的 task/command schema，输出里的事件复用 ChatEvent；
 * 控制消息只在这里出现，不塞进 ChatEvent。
 */
export const SUPERVISOR_INPUT_MAX_BYTES = 8 * 1024 * 1024;

const runIdSchema = z.string().min(1);

export const supervisorInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    runId: runIdSchema,
    task: sandboxTaskSchema,
    /** 本轮凭证与模型代理地址；supervisor 不自己补任何运行期 token。 */
    env: z.record(z.string(), z.string()),
  }),
  z.object({
    type: z.literal('input'),
    runId: runIdSchema,
    command: sandboxInputCommandSchema,
  }),
  z.object({
    type: z.literal('cancel'),
    runId: runIdSchema,
  }),
]);

export type SupervisorInput = z.infer<typeof supervisorInputSchema>;
/** 宿主持有的发送形状：defaults 由 supervisor 解析时补齐，发送方可以省略。 */
export type SupervisorInputFrame = z.input<typeof supervisorInputSchema>;

export const supervisorOutputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('started'), runId: runIdSchema }),
  z.object({ type: z.literal('event'), runId: runIdSchema, event: chatEventSchema }),
  z.object({ type: z.literal('stderr'), runId: runIdSchema, text: z.string() }),
  z.object({
    type: z.literal('settled'),
    runId: runIdSchema,
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    /** false 表示无法确认子进程已停稳，宿主必须销毁容器，不能复用。 */
    stopped: z.boolean(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('rejected'),
    runId: z.string(),
    code: z.enum(['BUSY', 'NOT_ACTIVE', 'INVALID_COMMAND', 'SPAWN_FAILED']),
    message: z.string(),
  }),
]);

export type SupervisorOutput = z.infer<typeof supervisorOutputSchema>;

/**
 * API → worker 的会话容器关闭信道。请求只含会话与已持久化的容器身份，
 * 不带凭据、宿主路径或任意 Docker 命令；响应按 requestId 单独回一条 ACK。
 */
export const SESSION_CLEANUP_REQUEST_CHANNEL = 'session-cleanup:requests';
export const SESSION_CLEANUP_ACK_PREFIX = 'session-cleanup:ack:';
/** 删除事务内等待关闭确认的上限；超过后回滚 DB 删除，保留目录可重试。 */
export const SESSION_CLEANUP_TIMEOUT_MS = 10_000;

export function sessionCleanupAckChannel(requestId: string): string {
  return `${SESSION_CLEANUP_ACK_PREFIX}${requestId}`;
}

export const sessionCleanupTargetSchema = z.object({
  conversationId: z.string().min(1),
  /** 该会话所有运行落库过的容器名；重启后 worker 没有条目时按它清理。 */
  sandboxIds: z.array(z.string().min(1)),
});

export type SessionCleanupTarget = z.infer<typeof sessionCleanupTargetSchema>;

export const sessionCleanupRequestSchema = z.object({
  requestId: z.string().min(1),
  /** epoch 毫秒；worker 在开始前和每个目标前都检查，过期请求不再关闭新容器。 */
  deadline: z.number().int().positive(),
  targets: z.array(sessionCleanupTargetSchema).min(1),
});

export type SessionCleanupRequest = z.infer<typeof sessionCleanupRequestSchema>;

export const sessionCleanupAckSchema = z.discriminatedUnion('ok', [
  z.object({ requestId: z.string().min(1), ok: z.literal(true) }),
  z.object({ requestId: z.string().min(1), ok: z.literal(false), error: z.string() }),
]);

export type SessionCleanupAck = z.infer<typeof sessionCleanupAckSchema>;

/** supervisor 对一轮结束的停稳判定；代码与信号来自被等待的 runner 进程。 */
export type ExecutionSettlement =
  | { state: 'stopped'; code: number | null; signal: string | null }
  | { state: 'unconfirmed'; error: string };
