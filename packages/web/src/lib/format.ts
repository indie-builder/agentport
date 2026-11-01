import type { AuditStatus, EvalComparison, EvalRunStatus, RunStatus } from './api.js';

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)} 天前`;
  return dateFormatter.format(date);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(ratio === 0 ? 0 : 1)}%`;
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function formatCost(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(number)) return '—';
  return number === 0 ? '$0' : `$${number.toFixed(4)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export const runStatusLabel: Record<RunStatus, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  timeout: '超时',
};

export const runStatusVariant = {
  queued: 'default',
  running: 'brand',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'outline',
  timeout: 'danger',
} as const satisfies Record<
  RunStatus,
  'default' | 'warn' | 'brand' | 'success' | 'danger' | 'outline'
>;

/**
 * TypeID 形如 run_01m5bv0faceh4v4jtw00eta1sn：后缀是时间有序的随机段。
 * 表格里只保留后缀末 8 位——前缀每个单元格都一样，留着只占宽度。
 */
export function shortId(id: string): string {
  const underscore = id.indexOf('_');
  const body = underscore > 0 ? id.slice(underscore + 1) : id;
  return body.length > 8 ? body.slice(-8) : body;
}

export const evalStatusLabel: Record<EvalRunStatus, string> = {
  running: '运行中',
  succeeded: '全部通过',
  failed: '有失败',
  cancelled: '已取消',
};

export const evalStatusVariant = {
  running: 'warn',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'outline',
} as const satisfies Record<EvalRunStatus, 'warn' | 'success' | 'danger' | 'outline'>;

type EvalComparisonStatus = EvalComparison['rows'][number]['status'];

export const evalComparisonStatusLabel: Record<EvalComparisonStatus, string> = {
  improved: '改善',
  regressed: '退步',
  unchanged: '无变化',
  changed_inputs: '输入已变更',
  base_only: '仅基准',
  head_only: '仅对比',
  unverified: '无法核对历史输入',
};

export const evalComparisonStatusVariant = {
  improved: 'success',
  regressed: 'danger',
  unchanged: 'default',
  changed_inputs: 'warn',
  base_only: 'outline',
  head_only: 'outline',
  unverified: 'warn',
} as const satisfies Record<
  EvalComparisonStatus,
  'success' | 'danger' | 'default' | 'warn' | 'outline'
>;

export const auditStatusLabel: Record<AuditStatus, string> = {
  ok: '成功',
  error: '错误',
  denied: '拒绝',
};

export const auditStatusVariant = {
  ok: 'success',
  error: 'danger',
  denied: 'warn',
} as const satisfies Record<AuditStatus, 'success' | 'danger' | 'warn'>;
