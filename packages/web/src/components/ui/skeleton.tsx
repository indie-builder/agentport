import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded bg-zinc-800', className)} {...props} />;
}
