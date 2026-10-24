import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { Badge } from './ui/badge.js';

// Project tones stay separate so registry updates preserve the status palette.
const statusBadgeVariants = cva('rounded-tag px-1.5 text-2xs leading-none', {
  variants: {
    tone: {
      default: 'border-line bg-sunken text-muted-foreground',
      success: 'border-line bg-surface text-success',
      warn: 'border-line bg-warning-soft text-warning',
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
