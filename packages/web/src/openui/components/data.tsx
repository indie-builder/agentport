import {
  useGetFieldValue,
  useIsStreaming,
  useSetFieldValue,
  useTriggerAction,
} from '@openuidev/react-lang';
import { Fragment, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
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

export function EditableTableRenderer({
  props,
}: RenderProps<{ name: string; columns: EditableColumn[]; data: EditableRow[] }>) {
  const trigger = useTriggerAction();
  const streaming = useIsStreaming();
  const setFieldValue = useSetFieldValue();
  const getFieldValue = useGetFieldValue();
  const columns = props.columns ?? [];
  const tableName = props.name;

  const toValues = (data: EditableRow[]) => data.map((row) => [...row.values]);
  const stored = getFieldValue(undefined, tableName) as EditableRow[] | undefined;
  // 初始值只取一次：之后的编辑由本地 state 持有，避免每次父级重渲染覆盖用户输入。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 同上，刻意不跟随 stored/data 变化。
  const initial = useMemo(() => toValues(stored ?? props.data ?? []), []);
  const [values, setValues] = useState<string[][]>(() => initial.map((row) => row.map(String)));
  const dirty = useRef(false);

  const update = (rowIndex: number, columnIndex: number, value: string) => {
    dirty.current = true;
    setValues((previous) =>
      previous.map((row, index) =>
        index === rowIndex
          ? row.map((cell, cellIndex) => (cellIndex === columnIndex ? value : cell))
          : row,
      ),
    );
  };

  if (columns.length === 0) return null;

  const save = () => {
    const next: EditableRow[] = (props.data ?? []).map((row, rowIndex) => ({
      id: row.id,
      values: (values[rowIndex] ?? []).map((cell, columnIndex) => {
        const column = columns[columnIndex];
        return column?.type === 'number' ? Number(cell) || 0 : cell;
      }),
    }));
    setFieldValue(undefined, 'EditableTable', tableName, next, true);
    void trigger('Save Changes', tableName);
    dirty.current = false;
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
            {values.map((row, rowIndex) => (
              <tr
                key={(props.data ?? [])[rowIndex]?.id ?? rowIndex}
                className="border-b border-line"
              >
                {columns.map((column, columnIndex) => (
                  <td key={column.key} className="p-1 align-middle">
                    <Input
                      aria-label={`${column.header} 第 ${rowIndex + 1} 行`}
                      type={column.type === 'number' ? 'number' : 'text'}
                      value={row[columnIndex] ?? ''}
                      disabled={streaming}
                      onChange={(event) => update(rowIndex, columnIndex, event.target.value)}
                      className={cn(
                        'h-8 border-transparent bg-transparent',
                        column.type === 'number' && 'text-right font-mono tabular-nums',
                      )}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="outline" disabled={streaming} onClick={save}>
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
