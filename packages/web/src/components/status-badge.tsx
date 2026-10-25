import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { Badge } from './ui/badge.js';

// 字号继承 Badge 的 xs：状态与普通徽章同一档，不再单独缩到 11px。
// 行高不覆盖：Badge 的 h-5 固定高度已保证垂直居中，leading-none 会让 12px 文本挤在 12px 行盒里。
const statusBadgeVariants = cva('rounded-tag px-1.5', {
  variants: {
    tone: {
      default: 'border-line bg-sunken text-muted-foreground',
      success: 'border-success-line bg-success-soft text-success',
      warn: 'border-warning-line bg-warning-soft text-warning',
      danger: 'border-danger-line bg-danger-soft text-danger',
      outline: 'border-line-strong bg-transparent text-muted-foreground',
      mono: 'border-code-line bg-code font-mono text-muted-foreground',
    },
  },
  defaultVariants: {
    tone: 'default',
  },
});

type StatusTone = NonNullable<VariantProps<typeof statusBadgeVariants>['tone']>;

export function StatusBadge({
  tone = 'default',
  className,
  ...props
}: Omit<ComponentProps<typeof Badge>, 'variant'> & { tone?: StatusTone }) {
  return (
    <Badge variant="outline" className={cn(statusBadgeVariants({ tone }), className)} {...props} />
  );
}
