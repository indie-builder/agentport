import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

/**
 * 项目自定义层：状态标签。
 *
 * 底座 Badge 只有 default/secondary/destructive/outline/ghost/link 六种，
 * 本项目的成功/警告/危险需要用设计系统的「小面积彩色」令牌。
 * 独立成文件，底座重装不会丢。
 */
const statusStyles = {
  default: 'border-line bg-sunken text-muted',
  accent: 'border-line-strong bg-hover text-fg',
  success: 'border-success-line bg-success-soft text-success',
  warn: 'border-warning-line bg-warning-soft text-warning',
  danger: 'border-danger-line bg-danger-soft text-danger',
  outline: 'border-line-strong bg-transparent text-muted',
  mono: 'border-code-line bg-code font-mono text-muted',
} as const;

export type StatusTone = keyof typeof statusStyles;

export function StatusBadge({
  tone = 'default',
  className,
  ...props
}: ComponentProps<'span'> & { tone?: StatusTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-tag border px-1.5 py-0.5 text-2xs font-medium leading-none',
        statusStyles[tone],
        className,
      )}
      {...props}
    />
  );
}
