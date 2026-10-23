import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-slot="page" className={cn('flex min-w-0 flex-col gap-5', className)}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  leading,
  eyebrow,
  actions,
  className,
}: {
  title: string;
  description?: string;
  leading?: ReactNode;
  /** 标题旁的小标签，如角色名、状态；单行、弱色。 */
  eyebrow?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="page-header"
      className={cn('flex min-h-11 flex-wrap items-center gap-4 pt-3', className)}
    >
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h1 className="min-w-0 break-words text-[16px] font-medium leading-6 tracking-[-0.01em] text-fg">
          {title}
        </h1>
        {eyebrow ? <div className="shrink-0">{eyebrow}</div> : null}
      </div>
      {description ? (
        <p className="min-w-0 max-w-[60ch] break-words text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-3">
        {actions ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}

export function PageToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="page-toolbar"
      className={cn('flex min-w-0 flex-wrap items-center gap-3', className)}
    >
      {children}
    </div>
  );
}

export function PageSection({
  title,
  description,
  actions,
  children,
  className,
  divided = true,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 顶层区块默认带上分隔线；嵌套区块不需要。 */
  divided?: boolean;
}) {
  return (
    <section
      data-slot="page-section"
      className={cn('flex min-w-0 flex-col gap-4', divided && 'border-t pt-5', className)}
    >
      {title || actions || description ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            {title ? <h2 className="text-sm font-medium text-fg">{title}</h2> : null}
            {description ? (
              <p className="min-w-0 break-words text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** 行内状态：空、加载失败或说明。放在线上，不装进卡片。 */
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-y py-5 text-sm">
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
