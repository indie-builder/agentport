import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';
import { Badge } from './badge.js';

// Project tones stay separate so registry updates preserve the status palette.
const statusBadgeVariants = cva('rounded-tag px-1.5 text-2xs leading-none', {
  variants: {
    tone: {
      default: 'border-line bg-sunken text-muted-foreground',
      accent: 'border-line-strong bg-hover text-fg',
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

export type StatusTone = NonNullable<VariantProps<typeof statusBadgeVariants>['tone']>;

export function StatusBadge({
  tone = 'default',
  className,
  ...props
}: Omit<ComponentProps<typeof Badge>, 'variant'> & { tone?: StatusTone }) {
  return (
    <Badge variant="outline" className={cn(statusBadgeVariants({ tone }), className)} {...props} />
  );
}
