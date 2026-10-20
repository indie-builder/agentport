import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

/**
 * 页面骨架（参考页实测版，2026-10-21）。
 *
 * 结构由 1px 线与留白承担，而不是卡片：
 * - 页头一行 44px，与外壳顶行同高；名称 + 右侧读数/操作。
 * - 区块之间 28px 留白，顶部分隔线；标题用小字号 + 颜色分层。
 * - 页面自身不写外边距，节奏由外壳的 12px 内边距提供。
 */

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-7', className)}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
  meta,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** 读数区：页头右侧的测量值。 */
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-11 flex-wrap items-center gap-x-4 gap-y-2', className)}>
      <h1 className="shrink-0 text-[16px] font-medium leading-6 tracking-[-0.01em] text-fg">
        {title}
      </h1>
      {description ? (
        <p className="hidden min-w-0 max-w-[60ch] truncate text-sm text-muted md:block">
          {description}
        </p>
      ) : null}
      <div className="ml-auto flex items-center gap-6">
        {meta ? <div className="flex flex-wrap items-center gap-6">{meta}</div> : null}
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/** 工具条：筛选、搜索。与内容同宽，不画边框，靠页头下方的留白分隔。 */
export function PageToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('-mt-3 flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

/** 区块：顶部分隔线 + 28px 留白；内容不带卡片。 */
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
      className={cn('flex flex-col gap-4', divided && 'border-t border-line pt-7', className)}
    >
      {title || actions || description ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            {title ? <h2 className="text-sm font-medium text-fg">{title}</h2> : null}
            {description ? (
              <p className="min-w-0 truncate text-sm text-subtle">{description}</p>
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-y border-line py-6 text-sm">
      {icon ? (
        <span className={cn('shrink-0', tone === 'danger' ? 'text-danger' : 'text-subtle')}>
          {icon}
        </span>
      ) : null}
      <span className={cn('font-medium', tone === 'danger' ? 'text-danger' : 'text-fg')}>
        {title}
      </span>
      {description ? <span className="min-w-0 text-muted">{description}</span> : null}
      {action ? <div className="ml-auto shrink-0">{action}</div> : null}
    </div>
  );
}
