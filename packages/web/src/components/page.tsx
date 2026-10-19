import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-5 flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-[30px] tracking-tight text-fg">{title}</h1>
        {description ? (
          <p className="mt-1 text-[12.5px] leading-[18px] text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-3">
      <h2 className="text-[11px] font-medium uppercase tracking-wider text-subtle">{title}</h2>
      {actions}
    </div>
  );
}

export function KeyValue({
  label,
  children,
  mono,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-24 shrink-0 text-xs text-subtle">{label}</span>
      <span className={cn('min-w-0 break-all text-xs text-fg/90', mono && 'font-mono')}>
        {children}
      </span>
    </div>
  );
}
