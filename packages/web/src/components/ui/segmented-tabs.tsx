import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn.js';

/**
 * 项目自定义层：分段切换器。
 *
 * 底座 Tabs 是 Root/List/Trigger/Content 复合结构，适合「内容面板随 tab 切换」。
 * 本项目的两处用法只是切换一个受控值（配置/完整文件、三个工作区文件），
 * 面板由页面自己渲染，用复合结构反而要额外包一层无意义的 Content。
 * 这里保留声明式 items API，语义用 aria-pressed 表达。
 */
export function SegmentedTabs<T extends string>({
  value,
  onChange,
  items,
  label,
  size = 'default',
  className,
}: {
  value: T;
  onChange: (next: T) => void;
  items: ReadonlyArray<{ value: T; label: string; icon?: LucideIcon }>;
  label: string;
  size?: 'sm' | 'default';
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: 分段切换是 button + aria-pressed，无对应原生元素
    <div role="group" aria-label={label} className={cn('flex items-center gap-1', className)}>
      {items.map((item) => {
        const active = item.value === value;
        const Icon = item.icon;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(item.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-item px-2.5 font-medium transition-colors duration-150',
              size === 'sm' ? 'h-7 text-xs' : 'h-8 text-sm',
              active ? 'bg-sunken text-fg' : 'text-muted hover:bg-hover hover:text-fg',
            )}
          >
            {Icon ? <Icon className="size-3.5" aria-hidden="true" /> : null}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
