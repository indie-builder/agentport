import { ArrowDown, ArrowUp, ChevronsUpDown, Columns3 } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
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

  const toggleSort = (col: DataColumn<T>): void => {
    if (!col.sortValue) return;
    setSort((prev) =>
      prev?.id === col.id
        ? { id: col.id, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { id: col.id, dir: 'desc' },
    );
  };

  return (
    <div className={cn('rounded-[10px] border border-line bg-surface', className)}>
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <div className="text-[12px] text-subtle">{loading ? '加载中…' : `${rows.length} 行`}</div>
        <div className="relative">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPickerOpen((v) => !v)}
            aria-expanded={pickerOpen}
            aria-label="列设置"
          >
            <Columns3 className="size-3.5" />列
          </Button>
          {pickerOpen && (
            <div className="absolute right-0 z-20 mt-1 w-52 rounded-lg border border-line bg-surface-2 p-2 shadow-lg">
              {columns
                .filter((c) => !c.locked)
                .map((c) => (
                  <label
                    key={c.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12.5px] text-muted hover:bg-surface"
                  >
                    <input
                      type="checkbox"
                      className="accent-accent"
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

      <div
        className="grid items-center gap-3 border-b border-line px-4 py-2 text-[11px] font-medium uppercase tracking-[0.06em] text-subtle"
        style={{ gridTemplateColumns: template }}
      >
        {visible.map((col) => (
          <button
            key={col.id}
            type="button"
            onClick={() => toggleSort(col)}
            disabled={!col.sortValue}
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
                  <ArrowUp className="size-3" />
                ) : (
                  <ArrowDown className="size-3" />
                )
              ) : (
                <ChevronsUpDown className="size-3 opacity-40" />
              ))}
          </button>
        ))}
      </div>

      {loading && rows.length === 0 ? (
        <div className="space-y-px">
          {Array.from({ length: 5 }, (_, i) => `skeleton-${i}`).map((key) => (
            <div key={key} className="h-10 animate-pulse border-b border-line/60 bg-surface-2/40" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-14 text-center text-[13px] text-muted">{empty ?? '暂无数据'}</div>
      ) : (
        <div>
          {sorted.map((row) => {
            const key = rowKey(row);
            const expandedContent = renderExpanded?.(row) ?? null;
            const isOpen = expanded === key && expandedContent !== null;
            return (
              <div key={key} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  disabled={!renderExpanded}
                  aria-expanded={renderExpanded ? isOpen : undefined}
                  onClick={() => {
                    if (renderExpanded) setExpanded(isOpen ? null : key);
                    onRowClick?.(row);
                  }}
                  className={cn(
                    'grid w-full items-center gap-3 px-4 py-0 text-left text-[13px] transition-colors',
                    'min-h-10 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60',
                    renderExpanded ? 'cursor-pointer' : 'cursor-default',
                    isOpen && 'bg-surface-2',
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
                  <div className="border-t border-line/60 bg-canvas/60 px-4 py-4">
                    {expandedContent}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
