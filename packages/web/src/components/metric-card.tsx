import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.js';

export function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3">
          <span className="text-sm font-normal text-muted-foreground">{label}</span>
          {Icon ? (
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <span className="min-w-0 break-words text-3xl font-medium tabular-nums text-fg [overflow-wrap:anywhere]">
          {value}
        </span>
        {hint ? <CardDescription className="text-xs tabular-nums">{hint}</CardDescription> : null}
      </CardContent>
    </Card>
  );
}

const GRID_COLUMNS = {
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
} as const;

export function MetricGrid({
  children,
  columns,
  className,
}: {
  children: ReactNode;
  columns?: 2 | 3 | 4;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid min-w-0 gap-4',
        columns
          ? GRID_COLUMNS[columns]
          : 'grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))]',
        className,
      )}
    >
      {children}
    </div>
  );
}
