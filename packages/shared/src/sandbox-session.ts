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

/** supervisor 对一轮结束的停稳判定；代码与信号来自被等待的 runner 进程。 */
export type ExecutionSettlement =
  | { state: 'stopped'; code: number | null; signal: string | null }
  | { state: 'unconfirmed'; error: string };
