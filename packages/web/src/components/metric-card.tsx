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
    <Card size="sm">
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

export function MetricGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))]',
        className,
      )}
    >
      {children}
    </div>
  );
}
