import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

/**
 * 页面骨架（校准台版本）。
 *
 * 与前两版的差别不只是间距数字：
 * - 不再把内容装进卡片；区块之间用通栏 1px 线分隔，标题贴在线上。
 * - 页头右侧可以放读数（TelemetryReadout），而不是一排按钮。
 * - 节奏固定：页头下 24px，区块之间 28px，区块标题与内容 12px。
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
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold leading-7 tracking-[-0.01em] text-fg">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-[72ch] text-sm leading-[18px] text-muted">{description}</p>
        ) : null}
      </div>
      {meta ? <div className="flex shrink-0 items-start gap-8">{meta}</div> : null}
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** 工具条：筛选、搜索、视图切换。与内容同宽，贴在下一条分隔线上。 */
export function PageToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2 border-b border-line pb-3', className)}>
      {children}
    </div>
  );
}

/**
 * 区块：标题贴在分隔线上方，内容不带卡片。
 * 这是校准台的核心动作——用线组织，而不是用盒子。
 */
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
      className={cn('flex flex-col gap-3', divided && 'border-t border-line pt-5', className)}
    >
      {title || actions ? (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="min-w-0">
            {title ? (
              <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-fg">{title}</h2>
            ) : null}
            {description ? (
              <p className="mt-1 text-xs leading-relaxed text-subtle">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** 兼容旧调用。 */
export function SectionHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-fg">{title}</h2>
      {actions}
    </div>
  );
}

/** 键值对：右栏详情与检查器里的统一排版。 */
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
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-1.5 last:border-0">
      <span className="shrink-0 text-xs text-subtle">{label}</span>
      <span
        className={cn(
          'min-w-0 break-all text-right text-xs text-fg',
          mono && 'font-mono tabular-nums',
        )}
      >
        {children}
      </span>
    </div>
  );
}

/** 读数行：标签 + 等宽数值，用于摘要条与检查器。 */
export function Readout({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: 'default' | 'danger' | 'success' | 'signal';
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-2xs text-subtle">{label}</span>
      <span
        className={cn(
          'font-mono text-xs tabular-nums',
          tone === 'danger' && 'text-danger',
          tone === 'success' && 'text-success',
          tone === 'signal' && 'text-signal-text',
          (!tone || tone === 'default') && 'text-fg',
        )}
      >
        {value}
      </span>
    </div>
  );
}
