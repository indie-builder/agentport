import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

const badgeVariants = cva(
  'inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none',
  {
    variants: {
      variant: {
        default: 'border-zinc-700 bg-zinc-800 text-zinc-300',
        accent: 'border-emerald-700 bg-emerald-500/10 text-emerald-300',
        success: 'border-emerald-700 bg-emerald-500/10 text-emerald-300',
        warn: 'border-amber-700 bg-amber-500/10 text-amber-300',
        danger: 'border-red-800 bg-red-500/10 text-red-300',
        outline: 'border-zinc-700 text-zinc-400',
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
