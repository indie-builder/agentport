import {
  useGetFieldValue,
  useIsStreaming,
  useSetFieldValue,
  useTriggerAction,
} from '@openuidev/react-lang';
import { Fragment, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Calendar } from '../../components/ui/calendar.js';
import { Input } from '../../components/ui/input.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { cn } from '../../lib/cn.js';
import {
  asArray,
  BlockCard,
  CardBlockGrid,
  childProps,
  type RenderProps,
  withItemContext,
} from './shared.js';

// ─── Table ───────────────────────────────────────────────────────────────────

type ColType = 'string' | 'number' | 'action';

export function TableRenderer({ props, renderNode }: RenderProps<{ columns: unknown[] }>) {
  const columns = (props.columns ?? [])
    .map((column) => childProps<{ label: string; data: unknown; type?: ColType }>(column))
    .filter((column): column is { label: string; data: unknown; type?: ColType } => !!column);
  if (columns.length === 0) return null;

  const rows = columns.map((column) => asArray(column.data ?? []));
  const rowCount = Math.max(...rows.map((row) => row.length), 0);
  if (rowCount === 0) return null;

  return (
    <Table className="text-sm">
      <TableHeader>
        <TableRow>
          {columns.map((column) => {
            return (
              // 列名即列身份；模型保证同一张表里的表头不同。
              <TableHead
                key={column.label}
                className={cn(
                  'text-xs text-muted-foreground',
                  column.type === 'number' && 'text-right',
                )}
              >
                {column.label}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: rowCount }, (_, rowIndex) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 行由模型按顺序生成
          <TableRow key={rowIndex}>
            {columns.map((column, columnIndex) => {
              const cell = rows[columnIndex]?.[rowIndex];
              return (
                <TableCell
                  // biome-ignore lint/suspicious/noArrayIndexKey: 单元格位置即身份
                  key={columnIndex}
                  // §8：数字列右对齐 + 等宽且不折行；其余列可换行，长词才断（不逐字拆短值）。
                  className={cn(
                    column.type === 'number'
                      ? 'text-right font-mono tabular-nums whitespace-nowrap'
                      : 'break-words whitespace-normal',
                  )}
                >
                  {typeof cell === 'object' && cell !== null
                    ? renderNode(cell)
                    : String(cell ?? '')}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** 虚拟组件：`Col` 的数据由 `Table` 读取；单独出现时不渲染。 */
export function ColRenderer() {
  return null;
}

// ─── EditableTable ───────────────────────────────────────────────────────────

type EditableColumn = {
  type: 'text' | 'number' | 'date-single' | 'select' | 'url';
  key: string;
  header: string;
  width?: number;
  options?: Array<{ value: string; label: string }>;
};

type EditableRow = { id: string; values: Array<string | number> };

/** 编辑草稿：首次编辑时从当前来源冻结列顺序、单元格值与 baseline，来源更新不再覆盖。 */
type EditableDraft = {
  tableName: string;
  keys: string[];
  rows: Array<{ id: string; values: string[] }>;
  baseline: string[][];
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 日期按本地年月日读写，避免 toISOString 的 UTC 偏移把日子挪一天。 */
function toDateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDateString(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
}

function EditableCell({
  column,
  rowIndex,
  value,
  disabled,
  onChange,
}: {
  column: EditableColumn;
  rowIndex: number;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const label = `${column.header} 第 ${rowIndex + 1} 行`;

  if (column.type === 'select') {
    const options = column.options ?? [];
    return (
      <Select
        value={value === '' ? null : value}
        items={options}
        disabled={disabled}
        onValueChange={(next) => onChange(typeof next === 'string' ? next : '')}
      >
        <SelectTrigger aria-label={label} className="h-8 w-full border-transparent bg-transparent">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    );
  }

  if (column.type === 'date-single') {
    const date = parseDateString(value);
    return (
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={label}
              disabled={disabled}
              className="h-8 w-full justify-start border-transparent bg-transparent font-normal"
            >
              {value || '选择日期'}
            </Button>
          }
        />
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            mode="single"
            {...(date ? { defaultMonth: date } : {})}
            selected={date}
            onSelect={(date) => onChange(date ? toDateString(date) : '')}
          />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Input
      aria-label={label}
      type={column.type === 'number' ? 'number' : column.type === 'url' ? 'url' : 'text'}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        'h-8 border-transparent bg-transparent',
        column.type === 'number' && 'text-right font-mono tabular-nums',
      )}
    />
  );
}

export function EditableTableRenderer({
  props,
}: RenderProps<{ name: string; columns: EditableColumn[]; data: EditableRow[] }>) {
  const trigger = useTriggerAction();
  const streaming = useIsStreaming();
  const setFieldValue = useSetFieldValue();
  const getFieldValue = useGetFieldValue();
  const columns = props.columns ?? [];
  const tableName = props.name;
  const columnKeys = columns.map((column) => column.key);

  // 官方表字段按 tableName 命名空间读写；干净态直接渲染最新来源，流式补行与 initialState 恢复随之生效。
  const stored = getFieldValue(tableName, tableName) as EditableRow[] | undefined;
  const source = stored ?? props.data ?? [];
  const [draft, setDraft] = useState<EditableDraft | null>(null);
  // 同一渲染节点换成另一张表：草稿属于旧表，渲染期同步丢弃，避免旧值显示或被存进新表。
  if (draft !== null && draft.tableName !== tableName) setDraft(null);
  const activeDraft = draft?.tableName === tableName ? draft : null;

  if (columns.length === 0) return null;

  const fromSource = (): EditableDraft => {
    const rows = source.map((row) => ({
      id: row.id,
      values: columnKeys.map((_, index) => String(row.values[index] ?? '')),
    }));
    return { tableName, keys: columnKeys, rows, baseline: rows.map((row) => [...row.values]) };
  };

  const draftOrSource = activeDraft ?? fromSource();
  const cellValue = (rowIndex: number, column: EditableColumn): string => {
    const row = draftOrSource.rows[rowIndex];
    const index = draftOrSource.keys.indexOf(column.key);
    return index === -1 ? '' : (row?.values[index] ?? '');
  };

  const dirtyCount = activeDraft
    ? activeDraft.rows.reduce(
        (total, row, rowIndex) =>
          total +
          row.values.filter(
            (value, index) => value !== (activeDraft.baseline[rowIndex]?.[index] ?? ''),
          ).length,
        0,
      )
    : 0;

  const update = (rowId: string, columnKey: string, value: string) => {
    setDraft((previous) => {
      const current = previous?.tableName === tableName ? previous : fromSource();
      const rows = current.rows.map((row) =>
        row.id === rowId
          ? {
              ...row,
              values: row.values.map((cell, index) =>
                current.keys[index] === columnKey ? value : cell,
              ),
            }
          : row,
      );
      const dirty = rows.some((row, rowIndex) =>
        row.values.some((cell, index) => cell !== (current.baseline[rowIndex]?.[index] ?? '')),
      );
      return dirty ? { ...current, rows } : null;
    });
  };

  const save = () => {
    const current = draftOrSource;
    const rows: EditableRow[] = current.rows.map((row) => ({
      id: row.id,
      values: columns.map((column) => {
        const index = current.keys.indexOf(column.key);
        const cell = index === -1 ? '' : (row.values[index] ?? '');
        if (column.type !== 'number') return cell;
        const parsed = Number(cell);
        return Number.isNaN(parsed) ? 0 : parsed;
      }),
    }));
    setFieldValue(tableName, 'EditableTable', tableName, rows, true);
    void trigger('Save Changes', tableName);
    setDraft(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="min-w-0 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line">
              {columns.map((column) => (
                <th
                  key={column.key}
                  className="px-2 py-2 text-left text-xs font-normal text-muted-foreground"
                  style={column.width ? { width: column.width } : undefined}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {draftOrSource.rows.map((row, rowIndex) => (
              <tr key={row.id} className="border-b border-line">
                {columns.map((column) => (
                  <td key={column.key} className="p-1 align-middle">
                    <EditableCell
                      column={column}
                      rowIndex={rowIndex}
                      value={cellValue(rowIndex, column)}
                      disabled={streaming}
                      onChange={(value) => update(row.id, column.key, value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-end gap-2">
        {dirtyCount > 0 ? (
          <span className="text-xs text-muted-foreground" role="status">
            {dirtyCount} 处修改
          </span>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={streaming || dirtyCount === 0}
          onClick={() => setDraft(null)}
        >
          Reset
        </Button>
        <Button size="sm" variant="outline" disabled={streaming || dirtyCount === 0} onClick={save}>
          Save Changes
        </Button>
      </div>
    </div>
  );
}

// ─── Metric indicators ───────────────────────────────────────────────────────

type Trend = { direction: 'up' | 'down'; value: number };

function TrendLabel({ trend }: { trend?: Trend | undefined }) {
  if (!trend) return null;
  // 上升不必然是好事（如流失率），所以趋势只用中性色 + 箭头，不借状态色。
  return (
    <span className="font-mono text-xs tabular-nums text-muted-foreground">
      {trend.direction === 'up' ? '↑' : '↓'} {Math.abs(trend.value)}%
    </span>
  );
}

export function MetricIndicatorInlineRenderer({
  props,
}: RenderProps<{ value: string; subtext?: string; trend?: Trend }>) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="font-mono text-lg font-semibold tabular-nums text-fg">{props.value}</span>
      <TrendLabel trend={props.trend} />
      {props.subtext ? (
        <span className="min-w-0 text-sm text-muted-foreground">{props.subtext}</span>
      ) : null}
    </div>
  );
}

export function MetricIndicatorWithStrikethroughRenderer({
  props,
}: RenderProps<{
  value: string;
  subtext?: string;
  previousValue?: string;
  trend?: Trend;
}>) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="font-mono text-lg font-semibold tabular-nums text-fg">{props.value}</span>
      {props.previousValue ? (
        <span className="font-mono text-sm tabular-nums text-muted-foreground line-through">
          {props.previousValue}
        </span>
      ) : null}
      <TrendLabel trend={props.trend} />
      {props.subtext ? (
        <span className="min-w-0 text-sm text-muted-foreground">{props.subtext}</span>
      ) : null}
    </div>
  );
}

// ─── Card blocks ─────────────────────────────────────────────────────────────

/** 卡片块共享的点击句柄：把点中的卡片信息附加到块级动作上。 */
function useBlockAction(action: unknown) {
  const trigger = useTriggerAction();
  const streaming = useIsStreaming();
  const clickable = action != null && !streaming;
  return {
    clickable,
    activate: (label: string, context: Record<string, unknown>) => {
      if (!clickable) return;
      void trigger(
        label || 'Open',
        undefined,
        withItemContext(action, context) as Parameters<typeof trigger>[2],
      );
    },
  };
}

type LayoutProps = {
  layout: 'grid' | 'carousel';
  responsive: boolean;
  action?: unknown;
  gap?: number | string;
};

export function SnippetCardBlockRenderer({
  props,
  renderNode,
}: RenderProps<LayoutProps & { items: unknown[] }>) {
  const items = props.items ?? [];
  const { clickable, activate } = useBlockAction(props.action);
  if (items.length === 0) return null;
  return (
    <CardBlockGrid
      layout={props.layout ?? 'grid'}
      responsive={props.responsive !== false}
      gap={props.gap}
      count={items.length}
    >
      {items.map((item, index) => {
        const itemProps = childProps<{ id?: string; lhs?: unknown; rhs?: unknown }>(item);
        const lhs = childProps<{ title?: string; subtitle?: string }>(itemProps?.lhs);
        const title = lhs?.title ?? itemProps?.id ?? `Item ${index + 1}`;
        return (
          <BlockCard
            key={itemProps?.id ?? index}
            clickable={clickable}
            onActivate={() =>
              activate(title, {
                itemIndex: index,
                itemId: itemProps?.id,
                itemTitle: lhs?.title,
                itemSubtitle: lhs?.subtitle,
              })
            }
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="min-w-0">{renderNode(itemProps?.lhs)}</div>
              {itemProps?.rhs ? (
                <div className="shrink-0 text-right">{renderNode(itemProps.rhs)}</div>
              ) : null}
            </div>
          </BlockCard>
        );
      })}
    </CardBlockGrid>
  );
}

export function OverviewCardBlockRenderer({
  props,
  renderNode,
}: RenderProps<LayoutProps & { items: unknown[] }>) {
  const items = props.items ?? [];
  const { clickable, activate } = useBlockAction(props.action);
  if (items.length === 0) return null;
  return (
    <CardBlockGrid
      layout={props.layout ?? 'grid'}
      responsive={props.responsive !== false}
      gap={props.gap}
      count={items.length}
      size="overview"
    >
      {items.map((item, index) => {
        const itemProps = childProps<{ id?: string; top?: unknown; bottom?: unknown }>(item);
        const title =
          childProps<{ title?: string }>(itemProps?.top)?.title ??
          childProps<{ value?: string }>(itemProps?.top)?.value ??
          itemProps?.id ??
          `Item ${index + 1}`;
        return (
          <BlockCard
            key={itemProps?.id ?? index}
            clickable={clickable}
            onActivate={() =>
              activate(title, { itemIndex: index, itemId: itemProps?.id, itemTitle: title })
            }
          >
            {renderNode(itemProps?.top)}
            {/* bottom 是元素节点（MetricIndicatorInline），必须交给渲染器，不能读字段。 */}
            {itemProps?.bottom ? (
              <div className="mt-auto min-w-0">{renderNode(itemProps.bottom)}</div>
            ) : null}
          </BlockCard>
        );
      })}
    </CardBlockGrid>
  );
}

export function ContextCardBlockRenderer({
  props,
  renderNode,
}: RenderProps<LayoutProps & { items: unknown[] }>) {
  const items = props.items ?? [];
  const { clickable, activate } = useBlockAction(props.action);
  if (items.length === 0) return null;
  return (
    <CardBlockGrid
      layout={props.layout ?? 'grid'}
      responsive={props.responsive !== false}
      gap={props.gap}
      count={items.length}
    >
      {items.map((item, index) => {
        const itemProps = childProps<{
          id?: string;
          title?: string | unknown;
          body?: string;
          bgImageSrc?: string;
          bgImageAlt?: string;
        }>(item);
        const title =
          typeof itemProps?.title === 'string'
            ? itemProps.title
            : (itemProps?.id ?? `Item ${index + 1}`);
        return (
          <BlockCard
            key={itemProps?.id ?? index}
            clickable={clickable}
            onActivate={() =>
              activate(title, {
                itemIndex: index,
                itemId: itemProps?.id,
                itemTitle: title,
                itemBody: itemProps?.body,
              })
            }
            className="relative overflow-hidden bg-sunken"
          >
            {itemProps?.bgImageSrc ? (
              <img
                src={itemProps.bgImageSrc}
                alt={itemProps.bgImageAlt ?? ''}
                loading="lazy"
                className="absolute inset-0 h-full w-full object-cover opacity-20"
              />
            ) : null}
            <div className="relative flex min-w-0 flex-col gap-1">
              {typeof itemProps?.title === 'string' ? (
                <span className="text-base font-semibold break-words text-fg">
                  {itemProps.title}
                </span>
              ) : itemProps?.title ? (
                renderNode(itemProps.title)
              ) : null}
              {itemProps?.body ? (
                <span className="text-sm break-words text-muted-foreground">{itemProps.body}</span>
              ) : null}
            </div>
          </BlockCard>
        );
      })}
    </CardBlockGrid>
  );
}

export function VisualCardBlockRenderer({
  props,
  renderNode,
}: RenderProps<LayoutProps & { items: unknown[] }>) {
  const items = props.items ?? [];
  const { clickable, activate } = useBlockAction(props.action);
  if (items.length === 0) return null;
  return (
    <CardBlockGrid
      layout={props.layout ?? 'grid'}
      responsive={props.responsive !== false}
      gap={props.gap}
      count={items.length}
      size="medium"
    >
      {items.map((item, index) => {
        const itemProps = childProps<{
          id?: string;
          body?: unknown;
          tag?: unknown;
          bgImageSrc?: string;
          bgImageAlt?: string;
        }>(item);
        const bodyProps = childProps<{ value?: string; subtext?: string }>(itemProps?.body);
        const tagProps = childProps<{ text?: string }>(itemProps?.tag);
        const label = bodyProps?.value ?? tagProps?.text ?? itemProps?.id ?? `Item ${index + 1}`;
        return (
          <BlockCard
            key={itemProps?.id ?? index}
            clickable={clickable}
            onActivate={() =>
              activate(label, {
                itemIndex: index,
                itemId: itemProps?.id,
                itemBody: bodyProps?.value,
                itemBodySubtext: bodyProps?.subtext,
                itemTag: tagProps?.text,
              })
            }
            className="relative isolate min-h-40 justify-end overflow-hidden bg-sunken p-0"
          >
            {itemProps?.bgImageSrc ? (
              <img
                src={itemProps.bgImageSrc}
                alt={itemProps.bgImageAlt ?? ''}
                loading="lazy"
                className="absolute inset-0 -z-10 h-full w-full object-cover"
              />
            ) : null}
            <div className="flex min-w-0 flex-col gap-1.5 p-3">
              {itemProps?.tag ? <div className="relative">{renderNode(itemProps.tag)}</div> : null}
              {itemProps?.body ? (
                <div className="relative">{renderNode(itemProps.body)}</div>
              ) : null}
            </div>
          </BlockCard>
        );
      })}
    </CardBlockGrid>
  );
}

export function CompositeCardBlockRenderer({
  props,
  renderNode,
}: RenderProps<LayoutProps & { items: unknown[] }>) {
  const items = props.items ?? [];
  const { clickable, activate } = useBlockAction(props.action);
  if (items.length === 0) return null;
  return (
    <CardBlockGrid
      layout={props.layout ?? 'grid'}
      responsive={props.responsive !== false}
      gap={props.gap}
      count={items.length}
      size="medium"
    >
      {items.map((item, index) => {
        const itemProps = childProps<{
          id?: string;
          header?: unknown;
          body?: unknown[];
          footer?: { price?: unknown; button?: unknown };
        }>(item);
        const label =
          childProps<{ title?: string }>(itemProps?.header)?.title ??
          itemProps?.id ??
          `Item ${index + 1}`;
        return (
          <BlockCard
            key={itemProps?.id ?? index}
            clickable={clickable}
            onActivate={() =>
              activate(label, { itemIndex: index, itemId: itemProps?.id, itemTitle: label })
            }
          >
            {itemProps?.header ? (
              <div className="min-w-0">{renderNode(itemProps.header)}</div>
            ) : null}
            {itemProps?.body ? (
              <div className="flex min-w-0 flex-col gap-2">
                {itemProps.body.map((node, bodyIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 卡片内容由模型按顺序生成
                  <Fragment key={bodyIndex}>{renderNode(withCardChartHeight(node))}</Fragment>
                ))}
              </div>
            ) : null}
            {itemProps?.footer ? (
              <div className="mt-auto flex min-w-0 flex-col gap-2 border-t border-line pt-2">
                <div className="min-w-0">{renderNode(itemProps.footer.price)}</div>
                {itemProps.footer.button ? (
                  <div className="min-w-0">{renderNode(itemProps.footer.button)}</div>
                ) : null}
              </div>
            ) : null}
          </BlockCard>
        );
      })}
    </CardBlockGrid>
  );
}

/**
 * 卡内图表未显式给 height 时补 192；官方做法就是复制节点再补默认 props，不改 schema。
 * 主图尺寸由 charts 自己决定，这里只处理卡内 body。
 */
const CARD_CHART_TYPES = new Set(['BarChart', 'LineChart', 'AreaChart']);

export function withCardChartHeight(node: unknown) {
  if (typeof node !== 'object' || node === null) return node;
  const element = node as { type?: unknown; typeName?: unknown; props?: Record<string, unknown> };
  if (element.type !== 'element' || !CARD_CHART_TYPES.has(String(element.typeName))) return node;
  const props = element.props ?? {};
  return { ...element, props: { ...props, height: props.height ?? 192 } };
}
