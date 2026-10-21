import { Search, X } from 'lucide-react';
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
 * 分段视图切换。页面自己渲染面板、这里只负责触发按钮，所以是
 * aria-pressed 的按钮组，而不是 tablist —— Radix Tabs 的 aria-controls
 * 会指向不存在的 TabsContent。
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
    <fieldset
      aria-label={label}
      className={cn(
        'm-0 flex min-w-0 items-center gap-0.5 overflow-x-auto border-0 border-b border-line p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(item.value)}
            className={cn(
              '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-0',
              size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-base',
              active
                ? 'border-fg text-fg'
                : 'border-transparent text-muted hover:border-line-strong hover:text-fg',
            )}
          >
            {item.icon}
            {item.label}
            {item.count !== undefined ? (
              <span className="rounded bg-sunken px-1 text-2xs tabular-nums text-subtle">
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </fieldset>
  );
}
