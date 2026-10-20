import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('border-y border-line bg-surface', className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center gap-2 border-b border-line px-4 py-2.5', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('text-base font-semibold text-fg', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-4 py-3.5', className)} {...props} />;
}
