import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-sunken', className)}
      {...props}
    />
  );
}
