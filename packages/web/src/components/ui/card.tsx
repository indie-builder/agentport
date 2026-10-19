import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('rounded-lg border border-zinc-800 bg-zinc-900/60', className)} {...props} />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('text-sm font-medium text-zinc-100', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-4', className)} {...props} />;
}
