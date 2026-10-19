import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium leading-none',
  {
    variants: {
      variant: {
        default: 'border-line-strong/70 bg-surface-2 text-muted',
        accent: 'border-accent/30 bg-accent-soft text-accent',
        success: 'border-success/30 bg-success/10 text-success',
        warn: 'border-warning/30 bg-warning/10 text-warning',
        danger: 'border-danger/30 bg-danger/10 text-danger',
        outline: 'border-line-strong text-muted',
        mono: 'rounded border-line bg-code font-mono text-subtle',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
