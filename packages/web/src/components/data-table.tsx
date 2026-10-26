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
import {
  type ColumnDef,
  type ColumnOrderState,
  type ColumnVisibilityState,
  columnOrderingFeature,
  columnVisibilityFeature,
  createSortedRowModel,
  functionalUpdate,
  type RowData,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Columns3,
  GripVertical,
} from 'lucide-react';
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';
import { cn } from '../lib/cn.js';
import { Collapsible, CollapsibleContent } from './motion-collapsible.js';
import { Button } from './ui/button.js';
import { Checkbox } from './ui/checkbox.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';
import { Skeleton } from './ui/skeleton.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';

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

interface ColumnPrefs {
  hidden: string[];
  order: string[];
}

const features = tableFeatures({
  columnOrderingFeature,
  columnVisibilityFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

type Features = typeof features;

function asIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

/** 兼容旧格式（裸数组只记隐藏列）与 { hidden, order }。 */
function readPrefs(
  storageKey: string | undefined,
  columns: { id: string; locked?: boolean; hiddenByDefault?: boolean }[],
): { visibility: ColumnVisibilityState; order: ColumnOrderState } {
  const locked = new Set(columns.filter((c) => c.locked).map((c) => c.id));
  let hidden = columns.filter((c) => c.hiddenByDefault && !c.locked).map((c) => c.id);
  let order = columns.map((c) => c.id);

  if (storageKey) {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (Array.isArray(parsed)) {
        hidden = asIds(parsed);
      } else if (parsed && typeof parsed === 'object') {
        const prefs = parsed as Partial<ColumnPrefs>;
        hidden = Array.isArray(prefs.hidden) ? asIds(prefs.hidden) : hidden;
        order = asIds(prefs.order);
      }
    } catch {
      // 损坏的偏好（或 SSR 没有 localStorage）直接丢弃，回到默认。
    }
  }

  return {
    // 锁定列永远可见，旧偏好里记录了也忽略。
    visibility: Object.fromEntries(hidden.filter((id) => !locked.has(id)).map((id) => [id, false])),
    order,
  };
}

function compareValues(av: string | number | null, bv: string | number | null): number {
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return typeof av === 'number' && typeof bv === 'number'
    ? av - bv
    : String(av).localeCompare(String(bv));
}

/** 列设置里的一行：拖动手柄负责排序，复选框负责显隐。 */
function ColumnRow({
  column,
  checked,
  onToggle,
  onMoveUp,
  onMoveDown,
}: {
  column: { id: string; header: string };
  checked: boolean;
  onToggle: () => void;
  onMoveUp: (() => void) | undefined;
  onMoveDown: (() => void) | undefined;
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
        // Keep the subdued drag handle, 6px corners, translucent hover, and focus ring.
        className="cursor-grab touch-none rounded-tag border-0 p-1 text-muted-foreground transition-none hover:bg-hover active:cursor-grabbing active:not-aria-[haspopup]:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <GripVertical className="size-4" aria-hidden="true" />
      </Button>
      <label className="flex flex-1 cursor-pointer items-center gap-2 rounded-icon px-2 py-1.5 text-xs hover:bg-hover">
        <Checkbox checked={checked} onCheckedChange={() => onToggle()} />
        {column.header}
      </label>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`上移「${column.header}」`}
        disabled={!onMoveUp}
        onClick={onMoveUp}
      >
        <ArrowUp aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`下移「${column.header}」`}
        disabled={!onMoveDown}
        onClick={onMoveDown}
      >
        <ArrowDown aria-hidden="true" />
      </Button>
    </div>
  );
}

function ColumnPicker({
  columns,
  hidden,
  toggle,
  move,
}: {
  columns: { id: string; header: string }[];
  hidden: Set<string>;
  toggle: (id: string) => void;
  move: (from: number, to: number) => void;
}) {
  return (
    <SortableContext items={columns.map((c) => c.id)} strategy={verticalListSortingStrategy}>
      <fieldset aria-label="列顺序" className="m-0 min-w-0 border-0 p-0">
        {columns.map((column, index) => (
          <ColumnRow
            key={column.id}
            column={column}
            checked={!hidden.has(column.id)}
            onToggle={() => toggle(column.id)}
            onMoveUp={index > 0 ? () => move(index, index - 1) : undefined}
            onMoveDown={index < columns.length - 1 ? () => move(index, index + 1) : undefined}
          />
        ))}
      </fieldset>
    </SortableContext>
  );
}

export function reorderColumns(
  columns: { id: string; locked?: boolean }[],
  from: number,
  to: number,
): string[] {
  const ids = columns.filter((c) => !c.locked).map((c) => c.id);
  if (from < 0 || to < 0 || from >= ids.length || to >= ids.length) {
    return columns.map((c) => c.id);
  }
  const next = arrayMove(ids, from, to);
  let i = 0;
  // 锁定列保持原位；拖动和上下移动共用同一顺序。
  return columns.map((c) => (c.locked ? c.id : (next[i++] ?? c.id)));
}

export function DataTable<T extends RowData>({
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
  const tableId = useId();
  const [prefs, setPrefs] = useState(() => readPrefs(storageKey, columns));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragging, setDragging] = useState<{ id: string; keyboard: boolean } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const sourceById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);

  const tableColumns = useMemo(
    () =>
      columns.map((col): ColumnDef<Features, T> => {
        const sortValue = col.sortValue;
        return {
          id: col.id,
          header: col.header,
          enableHiding: !col.locked,
          ...(sortValue
            ? {
                // null 用 undefined 表达，交给 TanStack 的 sortUndefined，升降序都排在最后。
                accessorFn: (row: T) => sortValue(row) ?? undefined,
                enableSorting: true,
                sortUndefined: 'last' as const,
                sortFn: (a, b) => compareValues(sortValue(a.original), sortValue(b.original)),
              }
            : { enableSorting: false }),
          cell: ({ row }) =>
            col.cell
              ? col.cell(row.original)
              : String((row.original as Record<string, unknown>)[col.id] ?? ''),
        };
      }),
    [columns],
  );

  const table = useTable<Features, T>({
    features,
    columns: tableColumns,
    data: rows,
    getRowId: rowKey,
    initialState: { columnVisibility: prefs.visibility, columnOrder: prefs.order },
    state: { columnVisibility: prefs.visibility, columnOrder: prefs.order },
    onColumnVisibilityChange: (updater) =>
      setPrefs((prev) => ({
        ...prev,
        visibility: functionalUpdate(updater, prev.visibility),
      })),
    onColumnOrderChange: (updater) =>
      setPrefs((prev) => ({ ...prev, order: functionalUpdate(updater, prev.order) })),
  });

  useEffect(() => {
    if (!storageKey) return;
    const hidden = Object.entries(prefs.visibility)
      .filter(([, visible]) => !visible)
      .map(([id]) => id);
    try {
      localStorage.setItem(storageKey, JSON.stringify({ hidden, order: prefs.order }));
    } catch {
      // 隐私模式下 localStorage 不可写，忽略。
    }
  }, [storageKey, prefs]);

  const orderedColumns = table
    .getAllLeafColumns()
    .flatMap((column) => sourceById.get(column.id) ?? []);
  const draggable = orderedColumns.filter((c) => !c.locked);
  const visible = table.getVisibleLeafColumns();
  const hiddenSet = new Set(
    Object.entries(prefs.visibility)
      .filter(([, isVisible]) => !isVisible)
      .map(([id]) => id),
  );

  const moveColumn = (from: number, to: number): void => {
    table.setColumnOrder(reorderColumns(orderedColumns, from, to));
  };

  const onDragEnd = (event: DragEndEvent): void => {
    setDragging(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    moveColumn(
      draggable.findIndex((c) => c.id === String(active.id)),
      draggable.findIndex((c) => c.id === String(over.id)),
    );
  };

  const draggingColumn = orderedColumns.find((c) => c.id === dragging?.id);

  const template = visible
    .map((column) => sourceById.get(column.id)?.width ?? 'minmax(120px,1fr)')
    .join(' ');

  // 窄屏保底宽度，让容器横向滚动而不是把文字截成省略号。
  const minWidth =
    visible.reduce((sum, column) => {
      const match = sourceById.get(column.id)?.width?.match(/^(minmax\()?(\d+)px/);
      return sum + (match?.[2] ? Number(match[2]) : 140);
    }, 0) +
    visible.length * 12 +
    32;

  // 行用方向键上下移动；Enter/Space 由原生 button 激活，不重复处理。
  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = Array.from(
      event.currentTarget
        .closest('tbody')
        ?.querySelectorAll<HTMLButtonElement>('button[data-row]') ?? [],
    );
    const index = buttons.indexOf(event.currentTarget);
    buttons[event.key === 'ArrowDown' ? index + 1 : index - 1]?.focus();
  };

  return (
    <div className={cn('flex min-w-0 max-w-full flex-col', className)}>
      <div className="flex h-8 items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {loading ? '加载中…' : rows.length > 0 ? `${rows.length} 行` : null}
        </div>
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
                  <Button variant="ghost" size="sm" aria-label="列设置">
                    <Columns3 className="size-4" aria-hidden="true" />列
                  </Button>
                }
              />
              <PopoverContent align="end" aria-label="列设置" className="w-64 p-2">
                <ColumnPicker
                  columns={draggable}
                  hidden={hiddenSet}
                  toggle={(id) => table.getColumn(id)?.toggleVisibility()}
                  move={moveColumn}
                />
              </PopoverContent>
            </Popover>
            {/* 浮层必须挂在弹层之外：Popper 容器的 transform 会成为 fixed 的包含块。 */}
            <DragOverlay>
              {draggingColumn ? (
                <div className="rounded-icon border bg-surface px-2 py-1.5 text-xs shadow-overlay">
                  {draggingColumn.header}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      </div>
      {/* Explicit roles preserve table semantics when CSS grid supplies the existing column widths. */}
      <Table
        role="table"
        aria-label={label}
        aria-busy={loading}
        className="block"
        style={{ minWidth }}
      >
        <TableHeader role="rowgroup" className="block">
          <TableRow
            role="row"
            className="grid items-center gap-3 px-3 pb-2 hover:bg-transparent"
            style={{ gridTemplateColumns: template }}
          >
            {visible.map((column) => {
              const source = sourceById.get(column.id);
              const dir = column.getIsSorted();
              return (
                <TableHead
                  key={column.id}
                  role="columnheader"
                  scope="col"
                  aria-sort={
                    dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined
                  }
                  className={cn(
                    'h-auto min-w-0 p-0 text-xs font-normal whitespace-normal text-muted-foreground',
                    source?.numeric && 'text-right',
                  )}
                >
                  {column.getCanSort() ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => column.toggleSorting(dir !== 'desc')}
                      aria-label={`${source?.header ?? column.id}，按此列排序`}
                      className={cn(
                        'h-auto w-full justify-start gap-1 rounded-none border-0 p-0 text-xs font-normal whitespace-normal',
                        source?.numeric && 'justify-end',
                      )}
                    >
                      {source?.header ?? column.id}
                      {dir === 'asc' ? (
                        <ArrowUp aria-hidden="true" />
                      ) : dir === 'desc' ? (
                        <ArrowDown aria-hidden="true" />
                      ) : (
                        <ChevronsUpDown className="opacity-40" aria-hidden="true" />
                      )}
                    </Button>
                  ) : (
                    (source?.header ?? column.id)
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody role="rowgroup" className="block">
          {loading && rows.length === 0 ? (
            Array.from({ length: 5 }, (_, i) => `skeleton-${i}`).map((key) => (
              <TableRow key={key} role="row" className="block">
                <TableCell role="cell" colSpan={visible.length} className="block p-0">
                  <Skeleton className="h-14" />
                </TableCell>
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow role="row" className="block hover:bg-transparent">
              <TableCell
                role="cell"
                colSpan={visible.length}
                className="block py-16 text-center text-sm whitespace-normal text-muted-foreground"
              >
                {empty ?? '暂无数据'}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => {
              const key = row.id;
              const expandedContent = renderExpanded?.(row.original) ?? null;
              const isOpen = expanded === key && expandedContent !== null;
              const interactive = expandedContent !== null || Boolean(onRowClick);
              const panelId = `${tableId}-row-panel-${key}`;
              const activate = () => {
                if (expandedContent !== null) setExpanded(isOpen ? null : key);
                onRowClick?.(row.original);
              };
              return (
                <Fragment key={key}>
                  {/* Row clicks supplement the keyboard-accessible action button in the first cell. */}
                  <TableRow
                    role="row"
                    onClick={
                      interactive
                        ? (event) => {
                            if (
                              (event.target as Element).closest(
                                'a, button, input, select, textarea, label, [role="button"], [role="checkbox"], [contenteditable], [tabindex]',
                              )
                            )
                              return;
                            activate();
                          }
                        : undefined
                    }
                    className={cn(
                      'grid min-h-14 w-full items-center gap-3 rounded-item px-3 text-left text-base duration-150 hover:bg-hover has-aria-expanded:bg-transparent',
                      interactive ? 'cursor-pointer' : 'cursor-default',
                      isOpen && 'bg-hover has-aria-expanded:bg-hover',
                    )}
                    style={{ gridTemplateColumns: template }}
                  >
                    {row.getVisibleCells().map((cell, index) => {
                      const source = sourceById.get(cell.column.id);
                      return (
                        <TableCell
                          key={cell.id}
                          role="cell"
                          className={cn(
                            'min-w-0 px-0 py-2 whitespace-normal wrap-anywhere [&_.truncate]:overflow-visible [&_.truncate]:whitespace-normal [&_.truncate]:text-clip',
                            source?.numeric &&
                              'text-right font-mono tabular-nums text-muted-foreground',
                          )}
                        >
                          <div
                            className={cn(index === 0 && interactive && 'flex items-center gap-1')}
                          >
                            {index === 0 && interactive && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                data-row=""
                                aria-label={`${expandedContent !== null ? (isOpen ? '收起' : '展开') : '打开'} ${key}`}
                                aria-expanded={expandedContent !== null ? isOpen : undefined}
                                aria-controls={expandedContent !== null ? panelId : undefined}
                                onKeyDown={onRowKeyDown}
                                onClick={activate}
                              >
                                {expandedContent !== null ? (
                                  isOpen ? (
                                    <ChevronDown aria-hidden="true" />
                                  ) : (
                                    <ChevronRight aria-hidden="true" />
                                  )
                                ) : (
                                  <ArrowUpRight aria-hidden="true" />
                                )}
                              </Button>
                            )}
                            <div className="min-w-0">
                              <table.FlexRender cell={cell} />
                            </div>
                          </div>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                  {expandedContent !== null && (
                    <TableRow
                      role="row"
                      aria-hidden={isOpen ? undefined : true}
                      className={cn('block border-0 hover:bg-transparent', isOpen && 'border-b')}
                    >
                      <TableCell
                        id={panelId}
                        role="cell"
                        colSpan={visible.length}
                        className="block p-0 whitespace-normal"
                      >
                        {/* 收起时 Panel 不挂载内容，展开详情仍保持首次打开的懒查询。 */}
                        <Collapsible open={isOpen}>
                          <CollapsibleContent animated>
                            <div className="px-3 py-4">{expandedContent}</div>
                          </CollapsibleContent>
                        </Collapsible>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
