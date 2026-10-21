import { Search, X } from 'lucide-react';
import * as TabsPrimitive from 'radix-ui/tabs';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.js';
import { Button } from './button.js';
import { Input } from './input.js';

export function SearchInput({
  value,
  onChange,
  placeholder = '搜索…',
  label,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
      <Input
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-icon pl-8 pr-8 focus-visible:ring-fg/30 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="清除搜索"
          className="absolute right-1.5 top-1/2 size-auto -translate-y-1/2 rounded p-1 text-subtle hover:bg-transparent hover:text-fg"
          onClick={() => onChange('')}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

export interface TabItem<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  count?: number;
}

/**
 * shadcn/ui Tabs（radix 版）。键盘导航、aria-selected、tab/panel 关联
 * 都由 Radix 处理；之前手写版只支持左右键，也不处理 disabled 项。
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
  size = 'default',
}: {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  size?: 'default' | 'sm';
}) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={(next) => onChange(next as T)}>
      <TabsPrimitive.List
        aria-label={label}
        className={cn(
          // 窄屏可横向滚动，但不显示滚动条：它是布局兜底，不是内容。
          'flex items-center gap-0.5 overflow-x-auto border-b border-line [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          className,
        )}
      >
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            className={cn(
              '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-0',
              size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-base',
              'border-transparent text-muted hover:border-line-strong hover:text-fg',
              'data-[state=active]:border-fg data-[state=active]:text-fg',
            )}
          >
            {item.icon}
            {item.label}
            {item.count !== undefined ? (
              <span className="rounded bg-sunken px-1 text-2xs tabular-nums text-subtle">
                {item.count}
              </span>
            ) : null}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}
