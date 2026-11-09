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

export const ACTIVE_RUN_STATUSES = ['queued', 'running'] as const;

export type ActiveRunStatus = (typeof ACTIVE_RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = terminalRunStatusSchema.options;

export function isActiveRunStatus(status: string | null | undefined): status is ActiveRunStatus {
  return status === 'queued' || status === 'running';
}

export function isTerminalRunStatus(
  status: string | null | undefined,
): status is TerminalRunStatus {
  return status != null && (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/** 失败分类：infra=平台/沙箱基础设施，agent=模型或工具，sandbox=容器异常退出。 */
export const runErrorKindSchema = z.enum(['cancelled', 'timeout', 'sandbox', 'agent', 'infra']);

export type RunErrorKind = z.infer<typeof runErrorKindSchema>;

export const wireFailureKindSchema = runErrorKindSchema.extract(['agent', 'infra', 'cancelled']);

export type WireFailureKind = z.infer<typeof wireFailureKindSchema>;
