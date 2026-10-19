import { Search, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useId } from 'react';
import { cn } from '../../lib/cn.js';

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
      <input
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border border-line bg-surface-2 pl-8 pr-8 text-sm text-fg transition-colors placeholder:text-subtle hover:border-line-strong focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          aria-label="清除搜索"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          onClick={() => onChange('')}
        >
          <X className="size-3.5" />
        </button>
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

/** 受控标签页：左右箭头 / Home / End 在标签间移动。 */
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
  const baseId = useId();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = items.findIndex((item) => item.value === value);
    if (index < 0) return;
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    const target = items[next];
    if (!target) return;
    onChange(target.value);
    document.getElementById(`${baseId}-tab-${target.value}`)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('flex items-center gap-0.5 border-b border-line', className)}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            id={`${baseId}-tab-${item.value}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`${baseId}-panel-${item.value}`}
            tabIndex={active ? 0 : -1}
            className={cn(
              '-mb-px inline-flex items-center gap-1.5 border-b-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-0',
              size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-[13px]',
              active
                ? 'border-accent text-fg'
                : 'border-transparent text-muted hover:border-line-strong hover:text-fg',
            )}
            onClick={() => onChange(item.value)}
          >
            {item.icon}
            {item.label}
            {item.count !== undefined ? (
              <span className="rounded bg-surface-2 px-1 text-[10px] tabular-nums text-subtle">
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  id,
  children,
  className,
}: {
  id: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div role="tabpanel" id={id} className={className}>
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong bg-surface-2 px-1 py-0.5 font-mono text-[10px] text-muted">
      {children}
    </kbd>
  );
}
