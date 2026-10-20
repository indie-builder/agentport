import { ArrowDown, ArrowUp, ChevronsUpDown, Columns3 } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '../lib/cn.js';
import { Button } from './ui/button.js';

export interface DataColumn<T> {
  id: string;
  header: string;
  /** 单元格渲染；默认取 row[id]。 */
  cell?: (row: T) => ReactNode;
  /** 数字列：右对齐、等宽。 */
  numeric?: boolean;
  /** 参与排序时提供取值；不提供则该列不可排序。 */
  sortValue?: (row: T) => string | number | null;
  /** 列宽，例如 '180px' 或 '1fr'。用于 grid 模板。 */
  width?: string;
  /** 默认隐藏，用户可在列设置里打开。 */
  hiddenByDefault?: boolean;
  /** 不可在列设置里关闭。 */
  locked?: boolean;
}

interface DataTableProps<T> {
  rows: T[];
  columns: DataColumn<T>[];
  rowKey: (row: T) => string;
  /** 表格的无障碍名称。 */
  label: string;
  loading?: boolean;
  empty?: ReactNode;
  /** 行内展开内容；返回 null 表示该行不可展开。 */
  renderExpanded?: (row: T) => ReactNode | null;
  storageKey?: string;
  onRowClick?: (row: T) => void;
  className?: string;
}

/** 列可见性持久化到 localStorage：这是 LangSmith 式表格的核心交互。 */
function useColumnVisibility(storageKey: string | undefined, columns: DataColumn<unknown>[]) {
  const [hidden, setHidden] = useState<Set<string>>(() => {
    const initial = new Set(columns.filter((c) => c.hiddenByDefault && !c.locked).map((c) => c.id));
    if (!storageKey) return initial;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return initial;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((x): x is string => typeof x === 'string'));
      }
    } catch {
      // 损坏的偏好直接丢弃，回到默认。
    }
    return initial;
  });

  const toggle = useCallback(
    (id: string) => {
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        if (storageKey) {
          try {
            localStorage.setItem(storageKey, JSON.stringify([...next]));
          } catch {
            // 隐私模式下 localStorage 不可写，忽略。
          }
        }
        return next;
      });
    },
    [storageKey],
  );

  return { hidden, toggle };
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  label,
  loading = false,
  empty,
  renderExpanded,
  storageKey,
  onRowClick,
  className,
}: DataTableProps<T>) {
  const { hidden, toggle } = useColumnVisibility(storageKey, columns as DataColumn<unknown>[]);
  const [sort, setSort] = useState<{ id: string; dir: 'asc' | 'desc' } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);

  // 点击外部或按 Esc 关闭列设置，并把焦点还给按钮。
  useEffect(() => {
    if (!pickerOpen) return;
    const onPointer = (event: MouseEvent): void => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setPickerOpen(false);
      pickerButtonRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  const visible = columns.filter((c) => !hidden.has(c.id));

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.id === sort.id);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sort, columns]);

  const template = visible.map((c) => c.width ?? 'minmax(120px,1fr)').join(' ');

  // 窄屏保底宽度，让容器横向滚动而不是把文字截成省略号。
  const minWidth =
    visible.reduce((sum, c) => {
      const match = c.width?.match(/^(minmax\()?(\d+)px/);
      return sum + (match?.[2] ? Number(match[2]) : 140);
    }, 0) +
    visible.length * 12 +
    32;

  const toggleSort = (col: DataColumn<T>): void => {
    if (!col.sortValue) return;
    setSort((prev) =>
      prev?.id === col.id
        ? { id: col.id, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { id: col.id, dir: 'desc' },
    );
  };

  // 行是按钮承载的 grid：方向键上下移动、Enter/Space 展开。
  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, row: T, isOpen: boolean): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const buttons = Array.from(
        event.currentTarget.parentElement?.parentElement?.querySelectorAll<HTMLButtonElement>(
          'button[data-row]',
        ) ?? [],
      );
      const index = buttons.indexOf(event.currentTarget);
      buttons[event.key === 'ArrowDown' ? index + 1 : index - 1]?.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (renderExpanded) setExpanded(isOpen ? null : rowKey(row));
      onRowClick?.(row);
    }
  };

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="flex h-8 items-center justify-between">
        <div className="text-xs text-subtle">{loading ? '加载中…' : `${rows.length} 行`}</div>
        <div className="relative">
          <Button
            ref={pickerButtonRef}
            variant="ghost"
            size="sm"
            className="rounded-[7px]"
            onClick={() => setPickerOpen((v) => !v)}
            aria-expanded={pickerOpen}
            aria-label="列设置"
          >
            <Columns3 className="size-4" strokeWidth={1.75} aria-hidden="true" />列
          </Button>
          {pickerOpen && (
            <div
              ref={pickerRef}
              className="absolute right-0 z-20 mt-1 w-52 rounded-[12px] border border-line bg-surface p-2 shadow-overlay"
            >
              {columns
                .filter((c) => !c.locked)
                .map((c) => (
                  <label
                    key={c.id}
                    className="flex cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1.5 text-sm text-muted hover:bg-hover"
                  >
                    <input
                      type="checkbox"
                      className="accent-ink"
                      checked={!hidden.has(c.id)}
                      onChange={() => toggle(c.id)}
                    />
                    {c.header}
                  </label>
                ))}
            </div>
          )}
        </div>
      </div>
      <section className="overflow-x-auto" aria-label={label}>
        <div style={{ minWidth }}>
          <div
            className="grid items-center gap-3 border-b border-line px-3 pb-2 text-xs text-subtle"
            style={{ gridTemplateColumns: template }}
          >
            {visible.map((col) => (
              <button
                key={col.id}
                type="button"
                onClick={() => toggleSort(col)}
                disabled={!col.sortValue}
                aria-label={
                  col.sortValue
                    ? `${col.header}，按此列排序${sort?.id === col.id ? `（当前${sort.dir === 'asc' ? '升序' : '降序'}）` : ''}`
                    : col.header
                }
                className={cn(
                  'flex items-center gap-1 text-left',
                  col.numeric && 'justify-end',
                  col.sortValue && 'cursor-pointer hover:text-fg',
                )}
              >
                {col.header}
                {col.sortValue &&
                  (sort?.id === col.id ? (
                    sort.dir === 'asc' ? (
                      <ArrowUp className="size-3" strokeWidth={1.75} aria-hidden="true" />
                    ) : (
                      <ArrowDown className="size-3" strokeWidth={1.75} aria-hidden="true" />
                    )
                  ) : (
                    <ChevronsUpDown
                      className="size-3 opacity-40"
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                  ))}
              </button>
            ))}
          </div>

          {loading && rows.length === 0 ? (
            <div>
              {Array.from({ length: 5 }, (_, i) => `skeleton-${i}`).map((key) => (
                <div key={key} className="h-14 animate-pulse border-b border-line bg-chip/70" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted">{empty ?? '暂无数据'}</div>
          ) : (
            <div>
              {sorted.map((row) => {
                const key = rowKey(row);
                const expandedContent = renderExpanded?.(row) ?? null;
                const isOpen = expanded === key && expandedContent !== null;
                return (
                  <div key={key} className="group border-b border-line last:border-b-0">
                    <button
                      type="button"
                      data-row=""
                      disabled={!renderExpanded}
                      aria-expanded={renderExpanded ? isOpen : undefined}
                      onKeyDown={(event) => onRowKeyDown(event, row, isOpen)}
                      onClick={() => {
                        if (renderExpanded) setExpanded(isOpen ? null : key);
                        onRowClick?.(row);
                      }}
                      className={cn(
                        'grid min-h-14 w-full items-center gap-3 px-3 text-left text-base transition-colors duration-150',
                        'rounded-[9px] hover:bg-hover',
                        renderExpanded ? 'cursor-pointer' : 'cursor-default',
                        isOpen && 'bg-hover',
                      )}
                      style={{ gridTemplateColumns: template }}
                    >
                      {visible.map((col) => (
                        <div
                          key={col.id}
                          className={cn(
                            'truncate py-2',
                            col.numeric && 'text-right font-mono tabular-nums text-muted',
                          )}
                        >
                          {col.cell
                            ? col.cell(row)
                            : String((row as Record<string, unknown>)[col.id] ?? '')}
                        </div>
                      ))}
                    </button>
                    {isOpen && (
                      <div className="border-t border-line px-3 py-4">{expandedContent}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
