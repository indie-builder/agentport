import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-8 w-full cursor-pointer rounded-md border border-line bg-surface-2 px-2 text-sm text-fg transition-colors hover:border-line-strong focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
