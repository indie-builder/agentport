import { cn } from 'cn';
import {
  type ComponentType,
  type CSSProperties,
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  Cell,
  Line,
  Pie,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadialBar,
  RadialBarChart,
  BarChart as RechartsBarChart,
  LineChart as RechartsLineChart,
  PieChart as RechartsPieChart,
  RadarChart as RechartsRadarChart,
  ScatterChart as RechartsScatterChart,
  Scatter,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/motion-collapsible.js';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '../../components/ui/chart.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { asArray, childProps, type RenderProps } from './shared.js';

/**
 * 图表统一约定（dataviz）：
 * - 灰色只用主题 token 的实色阶梯，系列多于 5 个时叠加纹理/虚线并用 legend 图标标出，
 *   不靠降低透明度区分（浅到 8% 的线在纸白底上看不见）；
 * - 主图默认 256px，schema 显式 height 优先；横向条形按类别和系列数增高，不把标签压扁；
 * - 缺失值是 null，不是 0：断线、空条都保留为真实缺口，数据视图用「—」表达；
 * - 不播放动画：流式每 delta 重渲染会让图形抖动；
 * - 图例、tooltip 复用 ui/chart 的现有实现，不另造一套；tooltip 原生 portal 到 body，
 *   避免被消息流的 content-visibility 裁掉。
 */

const DEFAULT_CHART_HEIGHT = 256;

/** 5 档实色灰阶；第 2 条系列起每条叠加独立虚线与纹理，灰阶循环但线型不循环。 */
const SERIES_TONES = [
  'var(--color-fg)',
  'color-mix(in srgb, var(--color-fg) 80%, var(--color-surface))',
  'var(--color-muted-foreground)',
  'color-mix(in srgb, var(--color-fg) 62%, var(--color-surface))',
  'color-mix(in srgb, var(--color-fg) 50%, var(--color-surface))',
] as const;

function seriesTone(index: number): string {
  return SERIES_TONES[index % SERIES_TONES.length] ?? SERIES_TONES[0];
}

/** 第 2 个系列起改用纹理/虚线，第 1 条保持纯实色。 */
function usesTexture(index: number): boolean {
  return index > 0;
}

/** 每条系列用不同虚线段长，第 11 条与第 1 条即使灰阶相同也不重复。 */
function seriesDash(index: number): string | undefined {
  return index === 0 ? undefined : `${index + 2} 3`;
}

const SCATTER_SHAPES = ['circle', 'square', 'triangle', 'diamond', 'cross', 'star', 'wye'] as const;

/** 一整个 dash + gap 周期；legend 按它缩放，长虚线的尾巴不会被 12px 画布看成实线。 */
function seriesKeyPeriod(index: number): number {
  const dash = seriesDash(index);
  if (!dash) return 12;
  return dash.split(' ').reduce((total, part) => total + Number(part), 0);
}

/**
 * legend 图标按系列序号同步子/纹理，与线型、条形填充一致——灰度之外的第二识别通道。
 * 用普通渲染函数而不是内建组件，避免在同一位置重复创建组件类型。
 */
function seriesKeySvg(index: number, kind: 'line' | 'fill', uid: string) {
  const stroke = seriesTone(index);
  if (kind === 'line') {
    const period = seriesKeyPeriod(index);
    return (
      <svg width={12} height={12} viewBox={`0 0 ${period} 12`} aria-hidden="true">
        <line
          x1={0}
          y1={6}
          x2={period}
          y2={6}
          stroke={stroke}
          strokeWidth={2}
          strokeDasharray={seriesDash(index)}
        />
      </svg>
    );
  }
  if (!usesTexture(index)) {
    return (
      <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
        <rect width={12} height={12} rx={2} fill={stroke} />
      </svg>
    );
  }
  const { size, angle } = patternStep(index);
  const id = `${uid}-legend-${index}`;
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
      <defs>
        <pattern
          id={id}
          width={size}
          height={size}
          patternUnits="userSpaceOnUse"
          patternTransform={`rotate(${angle})`}
        >
          <rect width={size} height={size} fill="var(--color-surface)" />
          <line x1={0} y1={0} x2={0} y2={size} stroke={stroke} strokeWidth={2} />
        </pattern>
      </defs>
      <rect width={12} height={12} rx={2} fill={`url(#${id})`} />
    </svg>
  );
}

/** ChartConfig.icon 只接受零参组件；按真实系列数生成，useMemo 固定引用。 */
function useLegendIcons(count: number, kind: 'line' | 'fill'): ComponentType[] {
  const rawId = useId();
  const uid = `openui-legend-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return useMemo(
    () =>
      Array.from({ length: count }, (_, index) => {
        // biome-ignore lint/correctness/noComponentHookFactories: 零参图标组件无状态，由 useMemo 固定引用
        const Icon = () => seriesKeySvg(index, kind, uid);
        return Icon;
      }),
    [count, kind, uid],
  );
}

type SeriesInput = { category: string; values: (number | null)[] };
type SeriesEntry = SeriesInput & { key: string; label: string };

function finiteValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 读子节点数据，同时给重复系列名生成稳定且不互相覆盖的键。 */
function seriesFrom(input: unknown[]): SeriesEntry[] {
  const occurrences = new Map<string, number>();
  return input
    .map((node) => childProps<SeriesInput>(node))
    .filter((series): series is SeriesInput => !!series && typeof series.category === 'string')
    .map((series) => {
      const count = (occurrences.get(series.category) ?? 0) + 1;
      occurrences.set(series.category, count);
      return {
        category: series.category,
        label: count === 1 ? series.category : `${series.category} (${count})`,
        key: count === 1 ? series.category : `${series.category}·${count}`,
        values: asArray(series.values ?? []).map(finiteValue),
      };
    });
}

type ChartRow = { category: string; [key: string]: string | number | null };

/** labels + Series[] → recharts 行数据；缺失值保持 null，图表断线而不是伪造 0。 */
function buildRows(labels: string[], series: SeriesEntry[]): ChartRow[] {
  return labels.map((label, index) => {
    const row: ChartRow = { category: label };
    for (const item of series) {
      row[item.key] = item.values[index] ?? null;
    }
    return row;
  });
}

function buildConfig(series: SeriesEntry[], icons: readonly ComponentType[]): ChartConfig {
  return Object.fromEntries(
    series.map((item, index) => [
      item.key,
      { label: item.label, color: seriesTone(index), icon: icons[index] ?? (() => null) },
    ]),
  );
}

function hasData(labels: string[], series: SeriesEntry[]): boolean {
  return (
    labels.length > 0 &&
    series.length > 0 &&
    series.some((item) => item.values.some((value) => value !== null))
  );
}

type SliceInput = { category: string; label: string; key: string; value: number | null };

function buildSlices(labels: string[], values: unknown[]): SliceInput[] {
  const occurrences = new Map<string, number>();
  return labels
    .map((category, index) => {
      const count = (occurrences.get(category) ?? 0) + 1;
      occurrences.set(category, count);
      return {
        category,
        label: count === 1 ? category : `${category} (${count})`,
        key: count === 1 ? category : `${category}·${count}`,
        value: finiteValue(values[index]),
      };
    })
    .filter((slice) => slice.category !== '');
}

function sliceRows(slices: SliceInput[]): ChartRow[] {
  return slices.map((slice) => ({ category: slice.label, value: slice.value }));
}

/** 单条堆叠只有两端的段朝外圆角，中间段保持方角。 */
function segmentRadius(position: number, count: number): [number, number, number, number] | 0 {
  if (position === 0) return [4, 0, 0, 4];
  if (position === count - 1) return [0, 4, 4, 0];
  return 0;
}

// ─── Tooltip portal ──────────────────────────────────────────────────────────

type ChartFrameContextValue = {
  anchor: RefObject<HTMLDivElement | null>;
  portal: HTMLElement | null;
};

const ChartFrameContext = createContext<ChartFrameContextValue | null>(null);

/** Recharts 3 的 portal 会跳过自带的定位样式，这里用坐标自行换算成 fixed 位置。 */
function fixedTooltipStyle(
  anchor: HTMLElement | null,
  coordinate: { x?: number; y?: number } | undefined,
): CSSProperties {
  const style: CSSProperties = {
    position: 'fixed',
    zIndex: 50,
    pointerEvents: 'none',
    overflowWrap: 'anywhere',
    maxWidth: 'min(18rem, calc(100vw - 2rem))',
  };
  if (
    !anchor ||
    !coordinate ||
    typeof coordinate.x !== 'number' ||
    typeof coordinate.y !== 'number' ||
    typeof window === 'undefined'
  ) {
    return { ...style, top: 8, left: 8 };
  }
  const rect = anchor.getBoundingClientRect();
  const x = rect.left + coordinate.x;
  const y = rect.top + coordinate.y;
  const gap = 12;
  const edge = 8;
  const fit = (available: number) => Math.max(0, Math.min(288, available));
  // 贴边翻转并夹到视口内：图表在长消息里滚动到顶部/底部时 tooltip 也不出界。
  if (x > window.innerWidth / 2) {
    const right = Math.max(edge, Math.round(window.innerWidth - x + gap));
    style.right = right;
    style.maxWidth = fit(window.innerWidth - right - edge);
  } else {
    const left = Math.max(edge, Math.round(x + gap));
    style.left = left;
    style.maxWidth = fit(window.innerWidth - left - edge);
  }
  if (y > window.innerHeight / 2) {
    const bottom = Math.max(edge, Math.round(window.innerHeight - y + gap));
    style.bottom = bottom;
    style.maxHeight = Math.max(80, window.innerHeight - bottom - edge);
  } else {
    const top = Math.max(edge, Math.round(y - gap));
    style.top = top;
    style.maxHeight = Math.max(80, window.innerHeight - top - edge);
  }
  // 超出部分截在 tooltip 内，完整数据走「数据视图」表格。
  style.overflowY = 'auto';
  return style;
}

function FixedTooltipContent({
  coordinate,
  className,
  ...props
}: React.ComponentProps<typeof ChartTooltipContent> & {
  coordinate?: { x?: number; y?: number } | undefined;
}) {
  const frame = useContext(ChartFrameContext);
  return (
    <ChartTooltipContent
      {...props}
      // 共享 tooltip 的 min-w-32 会在窄视口盖过 maxWidth，这里让宽度只受显式上限约束。
      className={cn('min-w-0', className)}
      style={fixedTooltipStyle(frame?.anchor.current ?? null, coordinate)}
    />
  );
}

function ChartTooltipPortal(props: React.ComponentProps<typeof ChartTooltip>) {
  const frame = useContext(ChartFrameContext);
  return <ChartTooltip {...props} portal={frame?.portal ?? null} />;
}

function useTooltipPortal(): HTMLElement | null {
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  // 只在客户端挂载后提供 portal，服务端渲染与无 document 的测试不会碰 body。
  useEffect(() => setPortal(document.body), []);
  return portal;
}

// ─── Frame & data view ───────────────────────────────────────────────────────

type DataColumn = { key: string; label: string };

function formatCell(value: string | number | null | undefined): string {
  if (value == null) return '—';
  return typeof value === 'number' ? value.toLocaleString() : value;
}

/** 完整数据视图：默认折叠，键盘可达；图例之外的第二条无色彩识别路径。 */
function ChartDataView({
  columns,
  rows,
  label = '类别',
}: {
  columns: DataColumn[];
  rows: ChartRow[];
  label?: string;
}) {
  if (rows.length === 0) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger className="self-start rounded-item text-xs text-muted-foreground transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        数据视图
      </CollapsibleTrigger>
      <CollapsibleContent animated className="pt-2">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="text-muted-foreground">{label}</TableHead>
              {columns.map((column) => (
                <TableHead key={column.key} className="text-right text-muted-foreground">
                  {column.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 数据视图与图表同序、只读渲染，索引就是行身份
              <TableRow key={`${row.category}-${index}`}>
                <TableCell>{row.category}</TableCell>
                {columns.map((column) => (
                  <TableCell key={column.key} className="text-right font-mono tabular-nums">
                    {formatCell(row[column.key])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ChartFrame({
  height,
  xLabel,
  yLabel,
  dataView,
  children,
}: {
  height?: number | undefined;
  xLabel?: string | undefined;
  yLabel?: string | undefined;
  dataView?: ReactNode;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLDivElement | null>(null);
  const portal = useTooltipPortal();
  const frame = useMemo(() => ({ anchor, portal }), [portal]);
  return (
    <ChartFrameContext.Provider value={frame}>
      <div className="flex min-w-0 flex-col gap-1">
        {yLabel ? <span className="text-xs text-muted-foreground">{yLabel}</span> : null}
        <div
          ref={anchor}
          data-openui-chart-frame=""
          className="w-full min-w-0"
          style={{ height: height ?? DEFAULT_CHART_HEIGHT }}
        >
          {children}
        </div>
        {xLabel ? <span className="text-right text-xs text-muted-foreground">{xLabel}</span> : null}
        {dataView}
      </div>
    </ChartFrameContext.Provider>
  );
}

function useSeriesTexture() {
  const rawId = useId();
  const uid = `openui-chart-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return useMemo(
    () => ({
      uid,
      fill: (index: number) =>
        usesTexture(index) ? `url(#${uid}-hatch-${index})` : seriesTone(index),
    }),
    [uid],
  );
}

/** 每个系列一条 pattern：灰阶循环，但间距与角度随序号单调变化，纹理不重复。 */
function patternStep(index: number): { size: number; angle: number } {
  return { size: 6 + (index % 3) * 2, angle: 45 + index * 15 };
}

function SeriesPatterns({ uid, count }: { uid: string; count: number }) {
  return (
    <defs>
      {Array.from({ length: count }, (_, index) => {
        const { size, angle } = patternStep(index);
        return (
          <pattern
            // biome-ignore lint/suspicious/noArrayIndexKey: pattern 由系列序号唯一命名，列表只按序号增删
            key={`${uid}-hatch-${index}`}
            id={`${uid}-hatch-${index}`}
            width={size}
            height={size}
            patternUnits="userSpaceOnUse"
            patternTransform={`rotate(${angle})`}
          >
            <rect width={size} height={size} fill="var(--color-surface)" />
            <line x1={0} y1={0} x2={0} y2={size} stroke={seriesTone(index)} strokeWidth={2} />
          </pattern>
        );
      })}
    </defs>
  );
}

function chartDataView(series: SeriesEntry[], rows: ChartRow[]) {
  return (
    <ChartDataView
      columns={series.map((item) => ({ key: item.key, label: item.label }))}
      rows={rows}
    />
  );
}

// ─── 2D charts ───────────────────────────────────────────────────────────────

type XYProps = {
  labels: string[];
  series: unknown[];
  xLabel?: string | undefined;
  yLabel?: string | undefined;
  height?: number | undefined;
};

const AXIS_PROPS = {
  tickLine: false,
  axisLine: false,
  tick: { fontSize: 12 },
  tickMargin: 6,
  minTickGap: 8,
} as const;

export function BarChartRenderer({
  props,
}: RenderProps<XYProps & { variant?: 'grouped' | 'stacked' }>) {
  const labels = asArray(props.labels ?? []);
  const series = seriesFrom(props.series ?? []);
  const texture = useSeriesTexture();
  const icons = useLegendIcons(series.length, 'fill');
  if (!hasData(labels, series)) return null;
  const stacked = props.variant === 'stacked';
  const config = buildConfig(series, icons);
  const rows = buildRows(labels, series);
  return (
    <ChartFrame
      height={props.height}
      xLabel={props.xLabel}
      yLabel={props.yLabel}
      dataView={chartDataView(series, rows)}
    >
      <ChartContainer
        config={config}
        initialDimension={{ width: 320, height: props.height ?? DEFAULT_CHART_HEIGHT }}
        className="aspect-auto h-full w-full"
      >
        <RechartsBarChart accessibilityLayer data={rows} barGap={2}>
          <SeriesPatterns uid={texture.uid} count={series.length} />
          <CartesianGrid vertical={false} />
          <XAxis dataKey="category" interval="preserveStartEnd" {...AXIS_PROPS} />
          <YAxis width="auto" {...AXIS_PROPS} />
          <ChartTooltipPortal content={<FixedTooltipContent />} />
          {series.length > 1 ? (
            <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
          ) : null}
          {series.map((item, index) => (
            <Bar
              key={item.key}
              dataKey={item.key}
              fill={texture.fill(index)}
              maxBarSize={24}
              // 堆叠时只在最上层圆角，否则每段都圆角会显得断裂。
              radius={stacked && index !== series.length - 1 ? 0 : [4, 4, 0, 0]}
              {...(stacked ? { stackId: 'stack' } : {})}
              isAnimationActive={false}
            />
          ))}
        </RechartsBarChart>
      </ChartContainer>
    </ChartFrame>
  );
}

export function LineChartRenderer({
  props,
}: RenderProps<XYProps & { variant?: 'linear' | 'natural' | 'step' }>) {
  const labels = asArray(props.labels ?? []);
  const series = seriesFrom(props.series ?? []);
  const icons = useLegendIcons(series.length, 'line');
  if (!hasData(labels, series)) return null;
  const type = props.variant ?? 'linear';
  const config = buildConfig(series, icons);
  const rows = buildRows(labels, series);
  return (
    <ChartFrame
      height={props.height}
      xLabel={props.xLabel}
      yLabel={props.yLabel}
      dataView={chartDataView(series, rows)}
    >
      <ChartContainer
        config={config}
        initialDimension={{ width: 320, height: props.height ?? DEFAULT_CHART_HEIGHT }}
        className="aspect-auto h-full w-full"
      >
        <RechartsLineChart accessibilityLayer data={rows}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="category" interval="preserveStartEnd" {...AXIS_PROPS} />
          <YAxis width="auto" {...AXIS_PROPS} />
          <ChartTooltipPortal content={<FixedTooltipContent />} />
          {series.length > 1 ? (
            <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
          ) : null}
          {series.map((item, index) => (
            <Line
              key={item.key}
              type={type}
              dataKey={item.key}
              stroke={seriesTone(index)}
              {...(seriesDash(index) ? { strokeDasharray: seriesDash(index) as string } : {})}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-surface)' }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </RechartsLineChart>
      </ChartContainer>
    </ChartFrame>
  );
}

export function AreaChartRenderer({
  props,
}: RenderProps<XYProps & { variant?: 'linear' | 'natural' | 'step' }>) {
  const labels = asArray(props.labels ?? []);
  const series = seriesFrom(props.series ?? []);
  const icons = useLegendIcons(series.length, 'line');
  if (!hasData(labels, series)) return null;
  const type = props.variant ?? 'linear';
  const config = buildConfig(series, icons);
  const rows = buildRows(labels, series);
  return (
    <ChartFrame
      height={props.height}
      xLabel={props.xLabel}
      yLabel={props.yLabel}
      dataView={chartDataView(series, rows)}
    >
      <ChartContainer
        config={config}
        initialDimension={{ width: 320, height: props.height ?? DEFAULT_CHART_HEIGHT }}
        className="aspect-auto h-full w-full"
      >
        <AreaChart accessibilityLayer data={rows}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="category" interval="preserveStartEnd" {...AXIS_PROPS} />
          <YAxis width="auto" {...AXIS_PROPS} />
          <ChartTooltipPortal content={<FixedTooltipContent />} />
          {series.length > 1 ? (
            <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
          ) : null}
          {series.map((item, index) => (
            <Area
              key={item.key}
              type={type}
              dataKey={item.key}
              stroke={seriesTone(index)}
              {...(seriesDash(index) ? { strokeDasharray: seriesDash(index) as string } : {})}
              // 面积用同一灰阶的低透明度填充，避免多系列互相遮死。
              fill={seriesTone(index)}
              fillOpacity={0.12}
              strokeWidth={2}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-surface)' }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ChartContainer>
    </ChartFrame>
  );
}

export function HorizontalBarChartRenderer({
  props,
}: RenderProps<XYProps & { variant?: 'grouped' | 'stacked' }>) {
  const labels = asArray(props.labels ?? []);
  const series = seriesFrom(props.series ?? []);
  const texture = useSeriesTexture();
  const icons = useLegendIcons(series.length, 'fill');
  if (!hasData(labels, series)) return null;
  const stacked = props.variant === 'stacked';
  const config = buildConfig(series, icons);
  const rows = buildRows(labels, series);
  // 横向图的高度随类别数增长；grouped 还要为每个系列留一条位置，标签和数据都不挤。
  const barsHeight = stacked ? 24 : Math.max(24, series.length * 26);
  const rowHeight = Math.max(40, barsHeight + 16);
  const height = props.height ?? Math.max(DEFAULT_CHART_HEIGHT, labels.length * rowHeight + 48);
  return (
    <ChartFrame
      height={height}
      xLabel={props.xLabel}
      yLabel={props.yLabel}
      dataView={chartDataView(series, rows)}
    >
      <ChartContainer
        config={config}
        initialDimension={{ width: 320, height }}
        className="aspect-auto h-full w-full"
      >
        <RechartsBarChart accessibilityLayer data={rows} layout="vertical" barGap={2}>
          <SeriesPatterns uid={texture.uid} count={series.length} />
          <CartesianGrid horizontal={false} />
          <XAxis type="number" {...AXIS_PROPS} />
          {/* width="auto" 由 Recharts 量实际 tick 文本，长类别名不再挤掉柱体。 */}
          <YAxis type="category" dataKey="category" width="auto" {...AXIS_PROPS} />
          <ChartTooltipPortal content={<FixedTooltipContent />} />
          {series.length > 1 ? (
            <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
          ) : null}
          {series.map((item, index) => (
            <Bar
              key={item.key}
              dataKey={item.key}
              fill={texture.fill(index)}
              maxBarSize={24}
              radius={stacked && index !== series.length - 1 ? 0 : [0, 4, 4, 0]}
              {...(stacked ? { stackId: 'stack' } : {})}
              isAnimationActive={false}
            />
          ))}
        </RechartsBarChart>
      </ChartContainer>
    </ChartFrame>
  );
}

export function RadarChartRenderer({ props }: RenderProps<XYProps>) {
  const labels = asArray(props.labels ?? []);
  const series = seriesFrom(props.series ?? []);
  const icons = useLegendIcons(series.length, 'line');
  if (!hasData(labels, series)) return null;
  const config = buildConfig(series, icons);
  const rows = buildRows(labels, series);
  return (
    <ChartFrame height={props.height} dataView={chartDataView(series, rows)}>
      <ChartContainer
        config={config}
        initialDimension={{ width: 320, height: props.height ?? DEFAULT_CHART_HEIGHT }}
        className="aspect-auto h-full w-full"
      >
        <RechartsRadarChart accessibilityLayer data={rows}>
          <PolarGrid />
          <PolarAngleAxis dataKey="category" tick={{ fontSize: 12 }} />
          <PolarRadiusAxis tick={false} axisLine={false} />
          <ChartTooltipPortal content={<FixedTooltipContent />} />
          {series.length > 1 ? (
            <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
          ) : null}
          {series.map((item, index) => (
            <Radar
              key={item.key}
              dataKey={item.key}
              stroke={seriesTone(index)}
              {...(seriesDash(index) ? { strokeDasharray: seriesDash(index) as string } : {})}
              fill={seriesTone(index)}
              fillOpacity={0.12}
              strokeWidth={2}
              isAnimationActive={false}
            />
          ))}
        </RechartsRadarChart>
      </ChartContainer>
    </ChartFrame>
  );
}

// ─── 1D charts ───────────────────────────────────────────────────────────────

function sliceConfig(slices: SliceInput[], icons: readonly ComponentType[]): ChartConfig {
  return Object.fromEntries(
    slices.map((slice, index) => [
      slice.key,
      { label: slice.label, color: seriesTone(index), icon: icons[index] ?? (() => null) },
    ]),
  );
}

function sliceDataView(slices: SliceInput[]) {
  return <ChartDataView columns={[{ key: 'value', label: '数值' }]} rows={sliceRows(slices)} />;
}

export function PieChartRenderer({
  props,
}: RenderProps<{ labels: string[]; values: number[]; variant?: 'pie' | 'donut' }>) {
  const slices = buildSlices(asArray(props.labels ?? []), asArray(props.values ?? []));
  const texture = useSeriesTexture();
  const icons = useLegendIcons(slices.length, 'fill');
  const config = sliceConfig(slices, icons);
  const visible = slices
    .map((slice, index) => ({ ...slice, index }))
    .filter((slice) => slice.value !== null);
  if (visible.length === 0) return null;
  const donut = props.variant !== 'pie';
  return (
    <ChartFrame dataView={sliceDataView(slices)}>
      <ChartContainer
        config={config}
        initialDimension={{ width: 320, height: DEFAULT_CHART_HEIGHT }}
        className="aspect-auto h-full w-full"
      >
        <RechartsPieChart accessibilityLayer>
          <SeriesPatterns uid={texture.uid} count={slices.length} />
          <ChartTooltipPortal content={<FixedTooltipContent hideLabel />} />
          <Pie
            data={visible.map((slice) => ({ ...slice, value: slice.value as number }))}
            dataKey="value"
            nameKey="key"
            innerRadius={donut ? '55%' : 0}
            outerRadius="78%"
            stroke="var(--color-surface)"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {visible.map((slice) => (
              <Cell key={slice.key} fill={texture.fill(slice.index)} />
            ))}
          </Pie>
          <ChartLegend
            content={<ChartLegendContent nameKey="key" className="flex-wrap gap-x-4 gap-y-1" />}
          />
        </RechartsPieChart>
      </ChartContainer>
    </ChartFrame>
  );
}

export function RadialChartRenderer({
  props,
}: RenderProps<{ labels: string[]; values: number[] }>) {
  const slices = buildSlices(asArray(props.labels ?? []), asArray(props.values ?? []));
  const texture = useSeriesTexture();
  const icons = useLegendIcons(slices.length, 'fill');
  const config = sliceConfig(slices, icons);
  const visible = slices
    .map((slice, index) => ({ ...slice, index }))
    .filter((slice) => slice.value !== null);
  if (visible.length === 0) return null;
  return (
    <ChartFrame dataView={sliceDataView(slices)}>
      <ChartContainer
        config={config}
        initialDimension={{ width: 320, height: DEFAULT_CHART_HEIGHT }}
        className="aspect-auto h-full w-full"
      >
        <RadialBarChart
          accessibilityLayer
          data={visible.map((slice) => ({ ...slice, value: slice.value as number }))}
          innerRadius="24%"
          outerRadius="82%"
          barSize={12}
        >
          <SeriesPatterns uid={texture.uid} count={slices.length} />
          <RadialBar dataKey="value" background isAnimationActive={false}>
            {visible.map((slice) => (
              <Cell key={slice.key} fill={texture.fill(slice.index)} />
            ))}
          </RadialBar>
          <ChartTooltipPortal content={<FixedTooltipContent hideLabel />} />
          <ChartLegend
            content={<ChartLegendContent nameKey="key" className="flex-wrap gap-x-4 gap-y-1" />}
          />
        </RadialBarChart>
      </ChartContainer>
    </ChartFrame>
  );
}

export function SingleStackedBarChartRenderer({
  props,
}: RenderProps<{ labels: string[]; values: number[] }>) {
  const slices = buildSlices(asArray(props.labels ?? []), asArray(props.values ?? []));
  const texture = useSeriesTexture();
  const icons = useLegendIcons(slices.length, 'fill');
  const config = sliceConfig(slices, icons);
  const visible = slices
    .map((slice, index) => ({ ...slice, index }))
    .filter((slice) => slice.value !== null);
  if (visible.length === 0) return null;
  // 单条堆叠：全部归到一个 stackId，横条上按灰阶 + 纹理区分占比。
  const row = Object.fromEntries(visible.map((slice) => [slice.key, slice.value as number]));
  return (
    <ChartFrame height={DEFAULT_CHART_HEIGHT} dataView={sliceDataView(slices)}>
      <ChartContainer
        config={config}
        initialDimension={{ width: 320, height: DEFAULT_CHART_HEIGHT }}
        className="aspect-auto h-full w-full"
      >
        <RechartsBarChart
          accessibilityLayer
          data={[{ category: 'total', ...row }]}
          layout="vertical"
          barSize={28}
        >
          <SeriesPatterns uid={texture.uid} count={slices.length} />
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="category" hide />
          <ChartTooltipPortal content={<FixedTooltipContent />} />
          {visible.map((slice, position) => (
            <Bar
              key={slice.key}
              dataKey={slice.key}
              stackId="stack"
              fill={texture.fill(slice.index)}
              radius={segmentRadius(position, visible.length)}
              isAnimationActive={false}
            />
          ))}
        </RechartsBarChart>
      </ChartContainer>
    </ChartFrame>
  );
}

// ─── Scatter ─────────────────────────────────────────────────────────────────

type ScatterDataset = { name: string; data: Array<{ x: number; y: number; z?: number }> };

export function ScatterChartRenderer({
  props,
}: RenderProps<{ datasets: unknown[]; xLabel?: string; yLabel?: string }>) {
  const datasets: ScatterDataset[] = (props.datasets ?? [])
    .map((node) => childProps<{ name?: string; points?: unknown[] }>(node))
    .filter((dataset): dataset is { name?: string; points?: unknown[] } => !!dataset)
    .map((dataset) => ({
      name: dataset.name ?? '',
      data: asArray(dataset.points ?? [])
        .map((point) => childProps<{ x: number; y: number; z?: number }>(point))
        .filter((point): point is { x: number; y: number; z?: number } => !!point)
        .map((point) => ({
          x: Number(point.x),
          y: Number(point.y),
          ...(point.z != null ? { z: Number(point.z) } : {}),
        }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
    }))
    .filter((dataset) => dataset.data.length > 0);
  const icons = useLegendIcons(datasets.length, 'fill');
  if (datasets.length === 0) return null;
  const config: ChartConfig = Object.fromEntries(
    datasets.map((dataset, index) => [
      dataset.name || `series-${index}`,
      {
        label: dataset.name || `series-${index}`,
        color: seriesTone(index),
        icon: icons[index] ?? (() => null),
      },
    ]),
  );
  const rows: ChartRow[] = datasets.flatMap((dataset, datasetIndex) =>
    dataset.data.map((point, pointIndex) => ({
      category: `${dataset.name || `series-${datasetIndex}`} #${pointIndex + 1}`,
      x: point.x,
      y: point.y,
      z: point.z ?? null,
    })),
  );
  return (
    <ChartFrame
      xLabel={props.xLabel}
      yLabel={props.yLabel}
      dataView={
        <ChartDataView
          columns={[
            { key: 'x', label: 'X' },
            { key: 'y', label: 'Y' },
            { key: 'z', label: 'Z' },
          ]}
          rows={rows}
          label="数据点"
        />
      }
    >
      <ChartContainer
        config={config}
        initialDimension={{ width: 320, height: DEFAULT_CHART_HEIGHT }}
        className="aspect-auto h-full w-full"
      >
        <RechartsScatterChart accessibilityLayer>
          <CartesianGrid />
          <XAxis
            type="number"
            dataKey="x"
            {...AXIS_PROPS}
            {...(props.xLabel ? { name: props.xLabel } : {})}
          />
          <YAxis
            type="number"
            dataKey="y"
            width="auto"
            {...AXIS_PROPS}
            {...(props.yLabel ? { name: props.yLabel } : {})}
          />
          <ChartTooltipPortal content={<FixedTooltipContent hideLabel />} />
          {datasets.length > 1 ? (
            <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
          ) : null}
          {datasets.map((dataset, index) => (
            <Scatter
              key={dataset.name || index}
              name={dataset.name || `series-${index}`}
              data={dataset.data}
              fill={seriesTone(index)}
              shape={SCATTER_SHAPES[index % SCATTER_SHAPES.length] ?? 'circle'}
              isAnimationActive={false}
            />
          ))}
        </RechartsScatterChart>
      </ChartContainer>
    </ChartFrame>
  );
}

// ─── Virtual children ────────────────────────────────────────────────────────

/** Series / Slice / Point / ScatterSeries 只承载数据，由父图表读取。 */
export function SeriesRenderer() {
  return null;
}
export function SliceRenderer() {
  return null;
}
export function PointRenderer() {
  return null;
}
export function ScatterSeriesRenderer() {
  return null;
}
