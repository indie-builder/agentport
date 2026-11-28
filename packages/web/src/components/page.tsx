import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-slot="page" className={cn('flex h-full min-h-0 min-w-0 flex-col gap-4', className)}>
      {children}
    </div>
  );
}

export function PageTopbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-slot="page-topbar" className={cn('flex min-w-0 shrink-0 flex-col gap-3', className)}>
      {children}
    </div>
  );
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="page-body"
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto [&>*]:shrink-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  leading,
  eyebrow,
  subtitle,
  actions,
  className,
}: {
  title: string;
  description?: string;
  leading?: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const heading = (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <h1 className="min-w-0 break-words text-lg font-medium tracking-heading text-fg">{title}</h1>
      {eyebrow ? <div className="shrink-0">{eyebrow}</div> : null}
    </div>
  );

  return (
    <div
      data-slot="page-header"
      className={cn('flex min-h-12 flex-wrap items-center gap-4', className)}
    >
      {leading ? <div className="shrink-0">{leading}</div> : null}
      {subtitle == null ? (
        heading
      ) : (
        <div className="grid min-w-0 flex-1 gap-1">
          {heading}
          <div className="min-w-0 truncate text-sm text-muted-foreground">{subtitle}</div>
        </div>
      )}
      {description ? (
        <p className="min-w-0 max-w-[60ch] break-words text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-3">
        {actions ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2 [&>:last-child[data-variant=ghost][data-size=icon]]:-mr-2 [&>:last-child[data-variant=ghost][data-size=icon-sm]]:-mr-1.5">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function PageToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="page-toolbar"
      className={cn('flex min-w-0 flex-wrap items-center gap-2', className)}
    >
      {children}
    </div>
  );
}

export function PageSection({
  title,
  titleClassName,
  description,
  actions,
  children,
  className,
  divided = true,
}: {
  title?: string;
  titleClassName?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  divided?: boolean;
}) {
  return (
    <section
      data-slot="page-section"
      className={cn('flex min-w-0 flex-col gap-4', divided && 'border-t pt-5', className)}
    >
      {title || actions || description ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            {title ? (
              <h2 className={cn('text-base font-medium text-fg', titleClassName)}>{title}</h2>
            ) : null}
            {description ? (
              <p className="min-w-0 break-words text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-2 [&>:last-child[data-variant=ghost][data-size=icon]]:-mr-2 [&>:last-child[data-variant=ghost][data-size=icon-sm]]:-mr-1.5 [&>:last-child[data-variant=ghost][data-size=icon-xs]]:-mr-1.5 [&>:last-child[data-variant=ghost][data-size=sm]]:-mr-2.5 [&>:last-child[data-variant=ghost][data-size=default]]:-mr-2.5">
              {actions}
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function PageNote({
  title,
  description,
  action,
  icon,
  tone = 'default',
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  tone?: 'default' | 'danger';
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-y py-5 text-sm"
    >
      {icon ? (
        <span className={cn('shrink-0', tone === 'danger' ? 'text-danger' : 'text-subtle')}>
          {icon}
        </span>
      ) : null}
      <span className={cn('font-medium', tone === 'danger' ? 'text-danger' : 'text-fg')}>
        {title}
      </span>
      {description ? (
        <span className="min-w-0 break-words text-muted-foreground">{description}</span>
      ) : null}
      {action ? <div className="ml-auto shrink-0">{action}</div> : null}
    </div>
  );
}
