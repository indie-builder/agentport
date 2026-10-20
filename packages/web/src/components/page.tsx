import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

/**
 * 页面骨架。
 *
 * 之前每个页面自己拼 `mb-4` / `mb-5` / `mt-8` / `space-y-4`，于是同样逻辑的
 * 「页头 → 工具栏 → 内容」在不同页面有不同的间距。这里把节奏固定成三档：
 *
 * - 页头与工具栏：20px
 * - 工具栏与内容：20px
 * - 区块之间：32px
 *
 * 页面只声明结构，不再各写间距。
 */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-5', className)}>{children}</div>;
}

/** 工具栏：筛选、搜索、批量操作。与内容贴得比页头更近。 */
export function PageToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

/** 区块：标题 + 内容，区块之间固定 32px。 */
export function PageSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            {title ? (
              <h2 className="text-[13px] font-semibold tracking-tight text-fg">{title}</h2>
            ) : null}
            {description ? (
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-subtle">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** 页面标题区。整个应用只有这一处 h1。 */
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
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold leading-7 tracking-tight text-fg">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-[72ch] text-[12.5px] leading-[18px] text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** 键值对：详情面板里的统一排版。 */
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

/** 兼容旧调用：区块小标题。新代码用 PageSection 的 title。 */
export function SectionHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-subtle">{title}</h2>
      {actions}
    </div>
  );
}
