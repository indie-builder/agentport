import type { MemoryHealth } from '@agentport/shared';

export const HEALTH_TONE: Record<MemoryHealth['level'], 'success' | 'warn' | 'danger'> = {
  ok: 'success',
  warn: 'warn',
  danger: 'danger',
};

export const HEALTH_LABEL: Record<MemoryHealth['level'], string> = {
  ok: '正常',
  warn: '注意',
  danger: '异常',
};
