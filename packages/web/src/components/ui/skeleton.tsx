import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-[2px] bg-sunken', className)}
      {...props}
    />
  );
}
