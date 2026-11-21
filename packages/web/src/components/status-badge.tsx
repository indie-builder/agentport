import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { Badge } from './ui/badge.js';

const statusBadgeVariants = cva('rounded-tag px-1.5', {
  variants: {
    tone: {
      default: 'border-line bg-sunken text-fg',
      success: 'border-line bg-success-soft text-success',
      warn: 'border-line bg-warning-soft text-warning',
      brand: 'border-line bg-selected text-fg',
      danger: 'border-line bg-danger-soft text-danger',
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
