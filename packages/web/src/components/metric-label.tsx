import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export function Metric({
  label,
  value,
  danger,
}: {
  label: string;
  value: ReactNode;
  danger?: boolean;
}) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-1.5">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <span className={cn('font-mono tabular-nums', danger ? 'text-danger' : 'text-fg')}>
        {value}
      </span>
    </span>
  );
}
