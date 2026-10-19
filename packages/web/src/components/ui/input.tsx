import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-emerald-500 focus-visible:outline-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
