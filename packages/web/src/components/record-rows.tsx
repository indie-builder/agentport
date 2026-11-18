import { Fragment, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export function RecordRows({
  rows,
  className,
}: {
  rows: { label: string; value: ReactNode; mono?: boolean; title?: string }[];
  className?: string;
}) {
  return (
    <dl
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 text-sm',
        className,
      )}
    >
      {rows.map((row) => (
        <Fragment key={row.label}>
          <dt className="text-xs text-muted-foreground">{row.label}</dt>
          <dd
            title={row.title}
            className={cn(
              'min-w-0 break-words text-right text-fg tabular-nums',
              row.mono && 'font-mono text-xs',
            )}
          >
            {row.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
