import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-8 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100 focus-visible:border-emerald-500 focus-visible:outline-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
