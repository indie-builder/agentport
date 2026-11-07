import { z } from 'zod';

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
]);

export type RunStatus = z.infer<typeof runStatusSchema>;

/** 与聊天流一致的终态集合；queued/running 不是 run.finished。 */
export const terminalRunStatusSchema = runStatusSchema.extract([
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
]);

export type TerminalRunStatus = z.infer<typeof terminalRunStatusSchema>;

/** 失败分类：infra=平台/沙箱基础设施，agent=模型或工具，sandbox=容器异常退出。 */
export const runErrorKindSchema = z.enum(['cancelled', 'timeout', 'sandbox', 'agent', 'infra']);

export type RunErrorKind = z.infer<typeof runErrorKindSchema>;

export const wireFailureKindSchema = runErrorKindSchema.extract(['agent', 'infra', 'cancelled']);

export type WireFailureKind = z.infer<typeof wireFailureKindSchema>;
