import { isSafeOpenUrl } from '@agentport/shared';
import {
  useGetFieldValue,
  useIsQueryLoading,
  useIsStreaming,
  useSetFieldValue,
  useTriggerAction,
} from '@openuidev/react-lang';
import { ExternalLink } from 'lucide-react';
import { type CSSProperties, Fragment, useState } from 'react';
import { Markdown } from '../../components/markdown.js';
import { Button } from '../../components/ui/button.js';
import {
  DatePicker,
  DatePickerClear,
  DatePickerContent,
  DatePickerGroup,
  DatePickerInput,
  DatePickerTrigger,
} from '../../components/ui/date-picker.js';
import { Input } from '../../components/ui/input.js';
import {
  NumberInput,
  NumberInputControl,
  NumberInputGroup,
} from '../../components/ui/number-input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Skeleton } from '../../components/ui/skeleton.js';
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

type ColType = 'string' | 'number' | 'action';

export function TableRenderer({ props, renderNode }: RenderProps<{ columns: unknown[] }>) {
  const isQueryLoading = useIsQueryLoading();
  const columns = (props.columns ?? [])
    .map((column) => childProps<{ label: string; data: unknown; type?: ColType }>(column))
    .filter((column): column is { label: string; data: unknown; type?: ColType } => !!column);
  const rows = columns.map((column) => asArray(column.data ?? []));
  const rowCount = Math.max(...rows.map((row) => row.length), 0);

  if (rowCount === 0) {
    if (!isQueryLoading) return null;
    const skeletonCols = Math.max(columns.length, 3);
    const skeletonColKeys = Array.from({ length: skeletonCols }, (_, col) => `col-${col}`);
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="表格数据加载中"
        className="flex min-w-0 flex-col gap-2"
      >
        {['row-0', 'row-1', 'row-2'].map((rowKey) => (
          <div
            key={rowKey}
            className="grid grid-cols-(--table-cols) gap-2"
            style={{ '--table-cols': `repeat(${skeletonCols}, minmax(0, 1fr))` } as CSSProperties}
          >
            {skeletonColKeys.map((colKey) => (
              <Skeleton key={colKey} className="h-6 w-full" />
            ))}
          </div>
        ))}
      </div>
    );
  }

  const seenHeaders = new Map<string, number>();
  const columnKeys = columns.map((column) => {
    const base = column.label || 'col';
    const count = (seenHeaders.get(base) ?? 0) + 1;
    seenHeaders.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });

  return (
    <div
      aria-busy={isQueryLoading || undefined}
      className={cn('min-w-0', isQueryLoading && 'opacity-70 transition-opacity')}
    >
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((column, columnIndex) => (
              <TableHead
                key={columnKeys[columnIndex]}
                className={cn(
                  'text-xs text-muted-foreground',
                  column.type === 'number' && 'text-right',
                )}
              >
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rowCount }, (_, rowIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 行由模型按顺序生成
            <TableRow key={rowIndex} hover="none">
              {columns.map((column, columnIndex) => {
                const cell = rows[columnIndex]?.[rowIndex];
                return (
                  <TableCell
                    key={columnKeys[columnIndex]}
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
    </div>
  );
}

export function ColRenderer() {
  return null;
}

type EditableColumn = {
  type: 'text' | 'number' | 'date-single' | 'select' | 'url';
  key?: string;
  header: string;
  width?: number;
  options?: Array<{ value: string; label: string }>;
};

type EditableRow = { id: string; values: Array<string | number> };

type EditableDraft = {
  keys: string[];
  rows: Array<{ id: string; values: string[] }>;
  baseline: string[][];
};

function formatDateParts(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = new Date(year, month - 1, day);
  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDateValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|T|\s)/.exec(trimmed);
  if (isoMatch) {
    return formatDateParts(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }
  const slashMatch = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:$|\s)/.exec(trimmed);
  if (slashMatch) {
    return formatDateParts(Number(slashMatch[1]), Number(slashMatch[2]), Number(slashMatch[3]));
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDateParts(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
}

function uniqueColumnKeys(columns: EditableColumn[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((column, index) => {
    const base = column.key?.trim() || `col-${index}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}__${count}`;
  });
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
        <SelectTrigger aria-label={label} variant="bare" className="w-full">
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
    const date = parseDateValue(value);
    return (
      <DatePicker
        value={date}
        disabled={disabled}
        onValueChange={(next) => onChange(typeof next === 'string' ? next : '')}
      >
        <DatePickerGroup variant="bare">
          <DatePickerInput aria-label={label} placeholder="选择日期" />
          <DatePickerClear aria-label={`清除${label}`} />
          <DatePickerTrigger aria-label={`选择${label}`} />
        </DatePickerGroup>
        <DatePickerContent />
      </DatePicker>
    );
  }

  if (column.type === 'number') {
    const trimmed = value.trim();
    const parsed = trimmed === '' ? Number.NaN : Number(trimmed);
    return (
      <NumberInput
        value={Number.isFinite(parsed) ? parsed : null}
        format={{ useGrouping: false, maximumFractionDigits: 12 }}
        disabled={disabled}
        onValueChange={(next, details) => {
          if (details.reason === 'input-commit') {
            details.cancel();
            return;
          }
          onChange(next === null ? '' : String(next));
        }}
      >
        <NumberInputGroup variant="bare">
          <NumberInputControl aria-label={label} mono className="text-right" />
        </NumberInputGroup>
      </NumberInput>
    );
  }

  if (column.type === 'url') {
    const trimmed = value.trim();
    const validUrl = trimmed !== '' && isSafeOpenUrl(trimmed);
    const invalidUrl = trimmed !== '' && !validUrl;
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1">
          <Input
            aria-label={label}
            aria-invalid={invalidUrl || undefined}
            type="url"
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            variant="ghost"
          />
          {validUrl ? (
            <a
              href={trimmed}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`打开${label}`}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-icon text-muted-foreground transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          ) : null}
        </div>
        {invalidUrl ? (
          <span role="alert" className="px-2 text-xs text-danger">
            请输入有效的 http(s) 链接
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <Input
      aria-label={label}
      type="text"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      variant="ghost"
    />
  );
}

type EditableTableProps = {
  name: string;
  columns: EditableColumn[];
  data: EditableRow[];
};

function EditableTableBody({ props }: { props: EditableTableProps }) {
  const trigger = useTriggerAction();
  const streaming = useIsStreaming();
  const setFieldValue = useSetFieldValue();
  const getFieldValue = useGetFieldValue();
  const columns = props.columns ?? [];
  const tableName = props.name;
  const columnKeys = uniqueColumnKeys(columns);

  const stored = getFieldValue(tableName, tableName) as EditableRow[] | undefined;
  const source = stored ?? props.data ?? [];
  const [draft, setDraft] = useState<EditableDraft | null>(null);

  if (columns.length === 0) return null;

  const fromSource = (): EditableDraft => {
    const rows = source.map((row) => ({
      id: row.id,
      values: columnKeys.map((_, index) => String(row.values[index] ?? '')),
    }));
    return { keys: columnKeys, rows, baseline: rows.map((row) => [...row.values]) };
  };

  const draftOrSource = draft ?? fromSource();
  const cellValue = (rowIndex: number, columnKey: string, columnIndex: number): string => {
    const row = draftOrSource.rows[rowIndex];
    const index = draftOrSource.keys.indexOf(columnKey);
    const resolved = index === -1 ? columnIndex : index;
    return row?.values[resolved] ?? '';
  };

  const dirtyCount = draft
    ? draft.rows.reduce(
        (total, row, rowIndex) =>
          total +
          row.values.filter((value, index) => value !== (draft.baseline[rowIndex]?.[index] ?? ''))
            .length,
        0,
      )
    : 0;

  const update = (rowId: string, columnKey: string, value: string) => {
    setDraft((previous) => {
      const current = previous ?? fromSource();
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
      values: columns.map((column, columnIndex) => {
        const columnKey = columnKeys[columnIndex] ?? '';
        const index = current.keys.indexOf(columnKey);
        const resolved = index === -1 ? columnIndex : index;
        const cell = row.values[resolved] ?? '';
        if (column.type !== 'number') return cell;
        const trimmed = cell.trim();
        if (trimmed === '') return '';
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : '';
      }),
    }));
    setFieldValue(tableName, 'EditableTable', tableName, rows, true);
    void trigger('Save Changes', tableName);
    setDraft(null);
  };

  return (
    <section aria-label={tableName || '可编辑表格'} className="flex min-w-0 flex-col gap-2">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((column, columnIndex) => (
              <TableHead
                key={columnKeys[columnIndex]}
                className={cn(
                  'px-2 py-2 text-left text-xs font-normal text-muted-foreground',
                  column.width && 'w-(--col-w)',
                )}
                style={
                  column.width ? ({ '--col-w': `${column.width}px` } as CSSProperties) : undefined
                }
              >
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {draftOrSource.rows.map((row, rowIndex) => (
            <TableRow key={row.id} hover="none">
              {columns.map((column, columnIndex) => {
                const columnKey = columnKeys[columnIndex] ?? `col-${columnIndex}`;
                return (
                  <TableCell key={columnKey} className="p-1 align-middle whitespace-normal">
                    <EditableCell
                      column={column}
                      rowIndex={rowIndex}
                      value={cellValue(rowIndex, columnKey, columnIndex)}
                      disabled={streaming}
                      onChange={(value) => update(row.id, columnKey, value)}
                    />
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex items-center justify-end gap-2">
        {dirtyCount > 0 ? (
          <span className="text-xs text-muted-foreground" role="status">
            {dirtyCount} 处修改
          </span>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          aria-label={tableName ? `Reset ${tableName}` : 'Reset'}
          disabled={streaming || dirtyCount === 0}
          onClick={() => setDraft(null)}
        >
          Reset
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-label={tableName ? `Save Changes ${tableName}` : 'Save Changes'}
          disabled={streaming || dirtyCount === 0}
          onClick={save}
        >
          Save Changes
        </Button>
      </div>
    </section>
  );
}

export function EditableTableRenderer({ props }: RenderProps<EditableTableProps>) {
  return <EditableTableBody key={props.name} props={props} />;
}

type Trend = { direction: 'up' | 'down'; value: number };

function TrendLabel({ trend }: { trend?: Trend | undefined }) {
  if (!trend) return null;
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

function withElementProps(node: unknown, overrides: Record<string, unknown>) {
  if (typeof node !== 'object' || node === null) return node;
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (element.type !== 'element') return node;
  return { ...element, props: { ...(element.props ?? {}), ...overrides } };
}

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
        const rhs = childProps<{ value?: string; subtext?: string }>(itemProps?.rhs);
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
                itemValue: rhs?.value,
              })
            }
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="min-w-0">{renderNode(itemProps?.lhs)}</div>
              {itemProps?.rhs ? (
                <div className="shrink-0 text-right">
                  {renderNode(withElementProps(itemProps.rhs, { size: 'xs' }))}
                </div>
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
        const top = childProps<{
          title?: string;
          value?: string;
          subtitle?: string;
          subtext?: string;
        }>(itemProps?.top);
        const bottom = childProps<{ value?: string }>(itemProps?.bottom);
        const title = top?.title ?? top?.value ?? itemProps?.id ?? `Item ${index + 1}`;
        return (
          <BlockCard
            key={itemProps?.id ?? index}
            clickable={clickable}
            onActivate={() =>
              activate(title, {
                itemIndex: index,
                itemId: itemProps?.id,
                itemTitle: title,
                itemSubtitle: top?.subtitle ?? top?.subtext,
                itemMetricValue: bottom?.value,
              })
            }
          >
            {renderNode(itemProps?.top)}
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
  const streaming = useIsStreaming();
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
          bgColor?: string;
          bgImageSrc?: string;
          bgImageAlt?: string;
        }>(item);
        const rawTitle = itemProps?.title;
        const extractedTitle =
          typeof rawTitle === 'string' ? rawTitle : childProps<{ text?: string }>(rawTitle)?.text;
        const title = extractedTitle ?? itemProps?.id ?? `Item ${index + 1}`;
        const tinted = itemProps?.bgColor === 'gray' || Boolean(itemProps?.bgImageSrc);
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
                itemBgColor: itemProps?.bgColor,
                itemBgImageSrc: itemProps?.bgImageSrc,
                itemBgImageAlt: itemProps?.bgImageAlt,
              })
            }
            className={cn('relative overflow-hidden', tinted && 'bg-sunken')}
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
              {typeof rawTitle === 'string' ? (
                <span className="text-base font-medium break-words text-fg">{rawTitle}</span>
              ) : rawTitle ? (
                renderNode(rawTitle)
              ) : null}
              {itemProps?.body ? (
                <div className="min-w-0 text-sm break-words text-muted-foreground">
                  <Markdown text={itemProps.body} streaming={streaming} presentation="inherit" />
                </div>
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
        const hasImage = Boolean(itemProps?.bgImageSrc);
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
                itemBgImageSrc: itemProps?.bgImageSrc,
                itemBgImageAlt: itemProps?.bgImageAlt,
              })
            }
            className="relative isolate min-h-40 justify-end overflow-hidden bg-sunken p-0"
          >
            {itemProps?.bgImageSrc ? (
              <>
                <img
                  src={itemProps.bgImageSrc}
                  alt={itemProps.bgImageAlt ?? ''}
                  loading="lazy"
                  className="absolute inset-0 -z-20 h-full w-full object-cover"
                />
                <div
                  aria-hidden="true"
                  data-slot="visual-card-scrim"
                  className="pointer-events-none absolute inset-0 -z-10 bg-linear-to-t from-fg/75 via-fg/35 to-transparent"
                />
              </>
            ) : null}
            <div className="flex min-w-0 flex-col gap-1.5 p-3">
              {itemProps?.tag ? <div className="relative">{renderNode(itemProps.tag)}</div> : null}
              {itemProps?.body ? (
                <div
                  className={cn(
                    'relative',
                    hasImage &&
                      'text-primary-foreground [&_.text-fg]:text-primary-foreground [&_.text-muted-foreground]:text-primary-foreground/85',
                  )}
                >
                  {renderNode(itemProps.body)}
                </div>
              ) : null}
            </div>
          </BlockCard>
        );
      })}
    </CardBlockGrid>
  );
}

const INTERACTIVE_BODY_TYPES = new Set([
  'AreaChart',
  'BarChart',
  'Button',
  'Buttons',
  'EditableTable',
  'FollowUpBlock',
  'Form',
  'IconButton',
  'LineChart',
]);

function hasInteractiveNode(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasInteractiveNode);
  if (typeof node !== 'object' || node === null) return false;
  const element = node as { type?: unknown; typeName?: unknown; props?: Record<string, unknown> };
  if (element.type !== 'element') return false;
  const typeName = String(element.typeName ?? '');
  if (INTERACTIVE_BODY_TYPES.has(typeName)) return true;
  if (typeName === 'ListItem') return element.props?.action != null;
  if (typeName === 'ListBlock') {
    const items = element.props?.items;
    return Array.isArray(items) && items.some(hasInteractiveNode);
  }
  return false;
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
        const headerProps = childProps<{
          title?: string;
          value?: string;
          subtitle?: string;
          subtext?: string;
          alt?: string;
        }>(itemProps?.header);
        const headerTitle = headerProps?.title ?? headerProps?.value;
        const headerSubtitle = headerProps?.subtitle ?? headerProps?.subtext;
        const headerAlt = headerProps?.alt;
        const label = headerTitle ?? headerAlt ?? itemProps?.id ?? `Item ${index + 1}`;
        const footerPrice = childProps<{ value?: string }>(itemProps?.footer?.price)?.value;
        const footerButtonLabel = childProps<{ label?: string }>(itemProps?.footer?.button)?.label;

        const bodyItems = Array.isArray(itemProps?.body) ? itemProps.body : [];
        const interactiveBody = hasInteractiveNode(bodyItems);
        const headerNode = itemProps?.header ? (
          <div className="min-w-0">{renderNode(itemProps.header)}</div>
        ) : null;
        const bodyNode =
          bodyItems.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-2">
              {bodyItems.map((node, bodyIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 卡片内容由模型按顺序生成
                <Fragment key={bodyIndex}>{renderNode(normalizeCompositeBodyNode(node))}</Fragment>
              ))}
            </div>
          ) : null;
        const footerNode = itemProps?.footer ? (
          <div className="mt-auto flex min-w-0 flex-col gap-2 border-t border-line pt-2">
            <div className="min-w-0">{renderNode(itemProps.footer.price)}</div>
            {itemProps.footer.button ? (
              <div className="min-w-0">{renderNode(itemProps.footer.button)}</div>
            ) : null}
          </div>
        ) : null;

        const cardContext = {
          itemIndex: index,
          itemId: itemProps?.id,
          itemTitle: label,
          itemHeaderSubtitle: headerSubtitle,
          itemFooterPrice: footerPrice,
          itemFooterButtonLabel: footerButtonLabel,
        };

        if (clickable && interactiveBody) {
          if (headerNode) {
            return (
              <BlockCard
                key={itemProps?.id ?? index}
                clickable
                onActivate={() => activate(label, cardContext)}
                footer={
                  <>
                    {bodyNode}
                    {footerNode}
                  </>
                }
              >
                {headerNode}
              </BlockCard>
            );
          }
          return (
            <BlockCard key={itemProps?.id ?? index} clickable={false}>
              {bodyNode}
              {footerNode}
            </BlockCard>
          );
        }

        const splitFooter = clickable && Boolean(itemProps?.footer?.button);
        return (
          <BlockCard
            key={itemProps?.id ?? index}
            clickable={clickable}
            onActivate={() => activate(label, cardContext)}
            {...(splitFooter ? { footer: footerNode } : {})}
          >
            {headerNode}
            {bodyNode}
            {splitFooter ? null : footerNode}
          </BlockCard>
        );
      })}
    </CardBlockGrid>
  );
}

const CARD_CHART_TYPES = new Set(['BarChart', 'LineChart', 'AreaChart']);

function normalizeCompositeBodyNode(node: unknown) {
  if (typeof node !== 'object' || node === null) return node;
  const element = node as { type?: unknown; typeName?: unknown; props?: Record<string, unknown> };
  if (element.type !== 'element') return node;
  const typeName = String(element.typeName ?? '');
  const props = element.props ?? {};
  if (CARD_CHART_TYPES.has(typeName)) {
    return { ...element, props: { ...props, height: props.height ?? 192 } };
  }
  if (typeName === 'EntityList') {
    return { ...element, props: { ...props, size: 'small', header: undefined, footer: undefined } };
  }
  if (typeName === 'ListBlock') {
    return { ...element, props: { ...props, size: props.size ?? 'small' } };
  }
  return node;
}
