import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-[7px] border px-1.5 py-0.5 text-2xs font-medium leading-none',
  {
    variants: {
      variant: {
        default: 'border-line bg-sunken text-muted',
        accent: 'border-line-strong bg-hover text-fg',
        success: 'border-success-line bg-success-soft text-success',
        warn: 'border-warning-line bg-warning-soft text-warning',
        danger: 'border-danger-line bg-danger-soft text-danger',
        outline: 'border-line-strong bg-transparent text-muted',
        mono: 'rounded border border-code-line bg-code font-mono text-muted',
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
