import { Check, ChevronDown, Search } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../lib/cn.js';
import { Badge } from './badge.js';
import { Input } from './input.js';

export interface MultiSelectOption {
  id: string;
  label: string;
  hint?: string;
  tag?: string;
}

/**
 * 可搜索多选：触发器显示已选 chips，弹层内过滤 + 复选。
 * 用原生 button/checkbox，Tab 可达，Esc 关闭并把焦点还给触发器。
 */
export function MultiSelect({
  options,
  value,
  onChange,
  label,
  placeholder = '选择…',
  emptyText = '没有可选项',
}: {
  options: MultiSelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  label: string;
  placeholder?: string;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onPointer = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      setQuery('');
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = options.filter((option) => value.includes(option.id));
  const needle = query.trim().toLowerCase();
  const filtered = options.filter(
    (option) =>
      !needle ||
      option.label.toLowerCase().includes(needle) ||
      option.hint?.toLowerCase().includes(needle),
  );

  const toggle = (id: string): void => {
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLInputElement);
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
    items[Math.max(0, Math.min(items.length - 1, next))]?.focus();
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'flex min-h-8 w-full items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-left text-sm transition-colors hover:border-line-strong focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25',
        )}
      >
        <span className="flex min-w-0 flex-1 flex-wrap gap-1">
          {selected.length === 0 ? (
            <span className="text-subtle">{placeholder}</span>
          ) : (
            selected.map((option) => (
              <Badge key={option.id} variant="default" className="max-w-40 py-1">
                <span className="truncate">{option.label}</span>
              </Badge>
            ))
          )}
        </span>
        <ChevronDown
          className={cn('size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-180')}
        />
      </button>

      {open ? (
        <div
          id={listId}
          className="absolute left-0 right-0 top-9 z-40 overflow-hidden rounded-lg border border-line bg-surface shadow-overlay"
        >
          <div className="relative border-b border-line p-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // 打开后焦点在搜索框，方向键应直接进入选项。
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                const items =
                  containerRef.current?.querySelectorAll<HTMLInputElement>(
                    'input[type="checkbox"]',
                  );
                if (!items?.length) return;
                event.preventDefault();
                items[event.key === 'ArrowDown' ? 0 : items.length - 1]?.focus();
              }}
              placeholder="搜索…"
              aria-label={`搜索${label}`}
              className="h-7 pl-7 text-xs"
            />
          </div>
          {/* 列表用 div 承载键盘导航：内部是可聚焦的 label/input，事件冒泡到这里。 */}
          <fieldset
            className="max-h-60 overflow-y-auto p-1"
            onKeyDown={onListKeyDown}
            aria-label={`${label}选项`}
          >
            {filtered.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-subtle">{emptyText}</p>
            ) : (
              filtered.map((option) => {
                const checked = value.includes(option.id);
                return (
                  <label
                    key={option.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg transition-colors hover:bg-sunken focus-within:bg-sunken"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(option.id)}
                      className="size-3.5 shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{option.label}</span>
                      {option.hint ? (
                        <span className="block truncate font-mono text-[10px] text-subtle">
                          {option.hint}
                        </span>
                      ) : null}
                    </span>
                    {option.tag ? <Badge variant="mono">{option.tag}</Badge> : null}
                    {checked ? <Check className="size-3.5 shrink-0 text-accent" /> : null}
                  </label>
                );
              })
            )}
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}
