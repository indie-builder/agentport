import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, ChevronsUpDown, Columns3, GripVertical } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from 'react';
import { cn } from '../lib/cn.js';
import { Button } from './ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';
import { Skeleton } from './ui/skeleton.js';

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

/** 列偏好持久化到 localStorage：可见性 + 顺序。 */
interface ColumnPrefs {
  hidden: string[];
  order: string[];
}

function asIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function useColumnPrefs(storageKey: string | undefined, columns: DataColumn<unknown>[]) {
  const [prefs, setPrefs] = useState<ColumnPrefs>(() => {
    const fallback: ColumnPrefs = {
      hidden: columns.filter((c) => c.hiddenByDefault && !c.locked).map((c) => c.id),
      order: columns.map((c) => c.id),
    };
    if (!storageKey) return fallback;
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      // 旧格式是裸数组（只记隐藏列）；新格式是 { hidden, order }。
      if (Array.isArray(parsed)) return { ...fallback, hidden: asIds(parsed) };
      if (parsed && typeof parsed === 'object') {
        const { hidden, order } = parsed as Partial<ColumnPrefs>;
        return {
          hidden: Array.isArray(hidden) ? asIds(hidden) : fallback.hidden,
          order: asIds(order),
        };
      }
    } catch {
      // 损坏的偏好直接丢弃，回到默认。
    }
    return fallback;
  });

  const update = useCallback(
    (fn: (prev: ColumnPrefs) => ColumnPrefs) => {
      setPrefs((prev) => {
        const next = fn(prev);
        if (storageKey) {
          try {
            localStorage.setItem(storageKey, JSON.stringify(next));
          } catch {
            // 隐私模式下 localStorage 不可写，忽略。
          }
        }
        return next;
      });
    },
    [storageKey],
  );

  const toggle = useCallback(
    (id: string) => {
      update((prev) => ({
        ...prev,
        hidden: prev.hidden.includes(id)
          ? prev.hidden.filter((x) => x !== id)
          : [...prev.hidden, id],
      }));
    },
    [update],
  );

  const setOrder = useCallback(
    (next: string[]) => update((prev) => ({ ...prev, order: next })),
    [update],
  );

  return { hidden: prefs.hidden, order: prefs.order, toggle, setOrder };
}

/** 列设置里的一行：拖动手柄负责排序，复选框负责显隐。 */
function ColumnRow({
  column,
  checked,
  onToggle,
}: {
  column: { id: string; header: string };
  checked: boolean;
  onToggle: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: column.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('flex items-center gap-1', isDragging && 'opacity-40')}
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        variant="ghost"
        size="icon-xs"
        {...attributes}
        {...listeners}
        aria-label={`拖动调整「${column.header}」顺序`}
        className="cursor-grab touch-none rounded-tag border-0 p-1 text-subtle transition-none hover:bg-hover hover:text-fg active:cursor-grabbing active:not-aria-[haspopup]:translate-y-0 focus-visible:ring-2 focus-visible:ring-fg"
      >
        <GripVertical className="size-4" aria-hidden="true" />
      </Button>
      <label className="flex flex-1 cursor-pointer items-center gap-2 rounded-icon px-2 py-1.5 text-xs hover:bg-hover">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="size-4 accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg"
        />
        {column.header}
      </label>
    </div>
  );
}

function ColumnPicker({
  columns,
  hidden,
  toggle,
}: {
  columns: { id: string; header: string }[];
  hidden: Set<string>;
  toggle: (id: string) => void;
}) {
  return (
    <SortableContext items={columns.map((c) => c.id)} strategy={verticalListSortingStrategy}>
      <fieldset aria-label="列顺序" className="m-0 min-w-0 border-0 p-0">
        {columns.map((column) => (
          <ColumnRow
            key={column.id}
            column={column}
            checked={!hidden.has(column.id)}
            onToggle={() => toggle(column.id)}
          />
        ))}
      </fieldset>
    </SortableContext>
  );
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
  const { hidden, order, toggle, setOrder } = useColumnPrefs(
    storageKey,
    columns as DataColumn<unknown>[],
  );
  const [sort, setSort] = useState<{ id: string; dir: 'asc' | 'desc' } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragging, setDragging] = useState<{ id: string; keyboard: boolean } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 存储的顺序只记列 id；新增列（或旧顺序里没有的列）排到末尾。
  const orderedColumns = useMemo(() => {
    const byId = new Map(columns.map((c) => [c.id, c]));
    const saved = order.flatMap((id) => byId.get(id) ?? []);
    const seen = new Set(saved.map((c) => c.id));
    return [...saved, ...columns.filter((c) => !seen.has(c.id))];
  }, [columns, order]);

  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const visible = orderedColumns.filter((c) => !hiddenSet.has(c.id));
  const draggable = orderedColumns.filter((c) => !c.locked);

  const onDragEnd = (event: DragEndEvent): void => {
    setDragging(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = draggable.map((c) => c.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    let i = 0;
    // 锁定列不参与拖动，保持原位；其余列按新顺序填回去。
    setOrder(orderedColumns.map((c) => (c.locked ? c.id : (next[i++] ?? c.id))));
  };

  const draggingColumn = orderedColumns.find((c) => c.id === dragging?.id);

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

  // 行用方向键上下移动；Enter/Space 由原生 button 激活，不重复处理。
  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = Array.from(
      event.currentTarget.parentElement?.parentElement?.querySelectorAll<HTMLButtonElement>(
        'button[data-row]',
      ) ?? [],
    );
    const index = buttons.indexOf(event.currentTarget);
    buttons[event.key === 'ArrowDown' ? index + 1 : index - 1]?.focus();
  };

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="flex h-8 items-center justify-between">
        <div className="text-xs text-subtle">{loading ? '加载中…' : `${rows.length} 行`}</div>
        <div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={(event) =>
              setDragging({
                id: String(event.active.id),
                // 原生 KeyboardEvent：dnd-kit 的 activatorEvent 是 DOM 事件。
                keyboard: event.activatorEvent instanceof globalThis.KeyboardEvent,
              })
            }
            onDragCancel={() => setDragging(null)}
            onDragEnd={onDragEnd}
          >
            <Popover
              open={pickerOpen}
              onOpenChange={(open, eventDetails) => {
                // 保留弹层并放行 Escape，让 document 上的 dnd-kit 取消键盘拖动。
                if (!open && eventDetails.reason === 'escape-key' && dragging?.keyboard) {
                  eventDetails.cancel();
                  eventDetails.allowPropagation();
                  return;
                }
                setPickerOpen(open);
                if (!open) setDragging(null);
              }}
            >
              <PopoverTrigger
                render={
                  <Button variant="ghost" size="sm" className="rounded-icon" aria-label="列设置">
                    <Columns3 className="size-4" aria-hidden="true" />列
                  </Button>
                }
              />
              <PopoverContent align="end" aria-label="列设置" className="w-48 p-2">
                <ColumnPicker columns={draggable} hidden={hiddenSet} toggle={toggle} />
              </PopoverContent>
            </Popover>
            {/* 浮层必须挂在弹层之外：Popper 容器的 transform 会成为 fixed 的包含块。 */}
            <DragOverlay>
              {draggingColumn ? (
                <div className="rounded-icon border border-line bg-surface px-2 py-1.5 text-xs shadow-overlay">
                  {draggingColumn.header}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      </div>
      <section className="overflow-x-auto" aria-label={label}>
        <div style={{ minWidth }}>
          <div
            className="grid items-center gap-3 border-b border-line px-3 pb-2 text-xs text-subtle"
            style={{ gridTemplateColumns: template }}
          >
            {visible.map((col) => (
              <div key={col.id}>
                <button
                  type="button"
                  onClick={() => toggleSort(col)}
                  disabled={!col.sortValue}
                  aria-label={
                    col.sortValue
                      ? `${col.header}，按此列排序${sort?.id === col.id ? `（当前${sort.dir === 'asc' ? '升序' : '降序'}）` : ''}`
                      : col.header
                  }
                  className={cn(
                    'flex w-full items-center gap-1 text-left',
                    col.numeric && 'justify-end',
                    col.sortValue && 'cursor-pointer hover:text-fg',
                  )}
                >
                  {col.header}
                  {col.sortValue &&
                    (sort?.id === col.id ? (
                      sort.dir === 'asc' ? (
                        <ArrowUp className="size-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="size-3" aria-hidden="true" />
                      )
                    ) : (
                      <ChevronsUpDown className="size-3 opacity-40" aria-hidden="true" />
                    ))}
                </button>
              </div>
            ))}
          </div>

          {loading && rows.length === 0 ? (
            <div>
              {Array.from({ length: 5 }, (_, i) => `skeleton-${i}`).map((key) => (
                <Skeleton key={key} className="h-14 border-b border-line" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              {empty ?? '暂无数据'}
            </div>
          ) : (
            <div>
              {sorted.map((row) => {
                const key = rowKey(row);
                const expandedContent = renderExpanded?.(row) ?? null;
                const isOpen = expanded === key && expandedContent !== null;
                const interactive = Boolean(renderExpanded || onRowClick);
                const panelId = `row-panel-${key}`;
                // 非交互行渲染成 div：button 的子元素在 disabled 时不可聚焦、也不可点击，
                // 会连带废掉单元格里的链接，并且是无效的嵌套 HTML。
                const cells = visible.map((col) => (
                  <div
                    key={col.id}
                    className={cn(
                      'truncate py-2',
                      col.numeric && 'text-right font-mono tabular-nums text-muted-foreground',
                    )}
                  >
                    {col.cell
                      ? col.cell(row)
                      : String((row as Record<string, unknown>)[col.id] ?? '')}
                  </div>
                ));
                const rowClass = cn(
                  'grid min-h-14 w-full items-center gap-3 px-3 text-left text-base transition-colors duration-150',
                  'rounded-item hover:bg-hover',
                  interactive ? 'cursor-pointer' : 'cursor-default',
                  isOpen && 'bg-hover',
                );
                return (
                  <div key={key} className="group border-b border-line last:border-b-0">
                    {interactive ? (
                      <button
                        type="button"
                        data-row=""
                        aria-expanded={expandedContent !== null ? isOpen : undefined}
                        aria-controls={expandedContent !== null ? panelId : undefined}
                        onKeyDown={onRowKeyDown}
                        onClick={() => {
                          if (renderExpanded) setExpanded(isOpen ? null : key);
                          onRowClick?.(row);
                        }}
                        className={rowClass}
                        style={{ gridTemplateColumns: template }}
                      >
                        {cells}
                      </button>
                    ) : (
                      <div className={rowClass} style={{ gridTemplateColumns: template }}>
                        {cells}
                      </div>
                    )}
                    {isOpen && (
                      <div id={panelId} className="border-t border-line px-3 py-4">
                        {expandedContent}
                      </div>
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
