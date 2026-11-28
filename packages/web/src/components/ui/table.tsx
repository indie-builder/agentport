'use client';

import type * as React from 'react';
import { cn } from '@/lib/cn';

function Table({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<'table'> & { size?: 'default' | 'sm' | 'xs' }) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        data-size={size}
        className={cn('w-full caption-bottom', size === 'xs' ? 'text-2xs' : 'text-sm', className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return (
    <thead
      data-slot="table-header"
      className={cn(
        '[&_tr]:border-b-[length:var(--hairline)] [&_tr]:hover:bg-transparent',
        className,
      )}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}

function TableRow({
  hover = 'row',
  variant = 'default',
  bordered = true,
  active = false,
  muted = false,
  className,
  ...props
}: React.ComponentProps<'tr'> & {
  hover?: 'row' | 'none';
  variant?: 'default' | 'grid' | 'gridHeader';
  bordered?: boolean;
  active?: boolean;
  muted?: boolean;
}) {
  return (
    <tr
      data-slot="table-row"
      data-hover={hover}
      data-variant={variant}
      className={cn(
        'transition-colors duration-150 ease-out-soft',
        variant === 'default' && 'has-aria-expanded:bg-hover data-[state=selected]:bg-selected',
        variant === 'grid' && 'gap-3 rounded-item px-3 data-[state=selected]:bg-selected',
        variant === 'gridHeader' && 'gap-3 px-3 pb-2',
        bordered ? 'border-b-[length:var(--hairline)]' : 'border-0',
        hover === 'row' && 'hover:bg-hover',
        active && 'bg-hover',
        muted && 'opacity-60',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({
  bordered = false,
  className,
  ...props
}: React.ComponentProps<'th'> & { bordered?: boolean }) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-10 px-2 text-start align-middle font-medium whitespace-nowrap text-xs text-muted-foreground [&:has([role=checkbox])]:pe-0',
        bordered && 'border-r border-line',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn('p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pe-0', className)}
      {...props}
    />
  );
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
