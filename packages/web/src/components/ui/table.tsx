import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

/** 表格容器：窄屏横向滚动，避免挤压列；label 让读屏知道这是什么表格。 */
export function TableWrap({
  className,
  label,
  ...props
}: ComponentProps<'section'> & { label: string }) {
  return <section className={cn('overflow-x-auto', className)} aria-label={label} {...props} />;
}

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return <table className={cn('w-full border-collapse text-sm', className)} {...props} />;
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return (
    <thead
      className={cn(
        'bg-surface-2/40 text-left text-[11px] uppercase tracking-wider text-subtle',
        className,
      )}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn('divide-y divide-line/70', className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr className={cn('group/row transition-colors hover:bg-surface-2/40', className)} {...props} />
  );
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      className={cn('whitespace-nowrap border-b border-line px-3 py-2 font-medium', className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-3 py-2.5 align-middle', className)} {...props} />;
}
