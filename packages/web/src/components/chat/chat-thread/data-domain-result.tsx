import { ChartColumn, ChevronRight, Table2 } from 'lucide-react';
import { useId, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from 'recharts';
import {
  aggregateChartData,
  type ChartAggregation,
  type ChartType,
  chartPlan,
  type DataDomainQueryResult,
  formatCell,
  inferColumnTypes,
  scatterChartData,
  suggestChartType,
} from '../../../lib/data-domain-result.js';
import { JsonBlock } from '../../code-block.js';
import { type DataColumn, DataTable } from '../../data-table.js';
import { type ChartConfig, ChartContainer } from '../../ui/chart.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible.js';
import { Field, FieldLabel } from '../../ui/field.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../ui/select.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs.js';

const MAX_ROWS = 200;

const AGGREGATION_LABELS: Record<ChartAggregation, string> = {
  none: '不聚合',
  sum: '求和',
  avg: '平均',
  count: '计数',
  min: '最小',
  max: '最大',
};

const CHART_TYPE_LABELS: Record<ChartType, string> = {
  bar: '柱状图',
  line: '折线图',
  scatter: '散点图',
};

interface ResultRow {
  key: string;
  cells: unknown[];
}

export function DataDomainResultView({ result }: { result: DataDomainQueryResult }) {
  const [view, setView] = useState<'table' | 'chart'>('table');
  const isEmpty = result.rows.length === 0;
  const effectiveRows = isEmpty ? [] : result.rows;
  const plan = chartPlan(result.columns, effectiveRows);
  const dimensionColumns = [...plan.dimensions, ...plan.measures];
  const defaultDimension = dimensionColumns[0];
  const defaultMeasure =
    plan.measures.find((column) => column.index !== defaultDimension?.index) ?? plan.measures[0];
  const [dimension, setDimension] = useState(String(defaultDimension?.index ?? ''));
  const [measure, setMeasure] = useState(String(defaultMeasure?.index ?? ''));
  const [aggregation, setAggregation] = useState<ChartAggregation>('none');
  const [chartTypeChoice, setChartTypeChoice] = useState<ChartType | null>(null);
  const fieldId = useId();

  const shown = effectiveRows.slice(0, MAX_ROWS);
  const sliced = effectiveRows.length > MAX_ROWS;
  const dimensionColumn = dimensionColumns.find((column) => String(column.index) === dimension);
  const measureColumn = plan.measures.find((column) => String(column.index) === measure);
  const types = inferColumnTypes(result.columns, effectiveRows);

  const columns: DataColumn<ResultRow>[] = result.columns.map((name, index) => ({
    id: `c${index}`,
    header: name,
    numeric: types[index] === 'number',
    cell: (row) => formatCell(row.cells[index]),
  }));
  const rows = shown.map((cells, index) => ({ key: String(index), cells }));

  const hasColumns = dimensionColumn !== undefined && measureColumn !== undefined;
  const chartable = hasColumns && dimensionColumn.index !== measureColumn.index;
  const scatterValid =
    chartable &&
    types[dimensionColumn.index] === 'number' &&
    types[measureColumn.index] === 'number';
  const suggestedType = suggestChartType(
    result.columns,
    effectiveRows,
    dimensionColumn?.index ?? -1,
    measureColumn?.index ?? -1,
  );
  const selectedType = chartTypeChoice ?? suggestedType;
  const scatterFallback = selectedType === 'scatter' && !scatterValid;
  const effectiveType = scatterFallback ? 'bar' : selectedType;
  const chartPoints = chartable
    ? aggregateChartData(effectiveRows, dimensionColumn.index, measureColumn.index, aggregation)
    : [];
  const seriesData = chartPoints.slice(0, MAX_ROWS).map((point, index) => ({
    position: index,
    ...point,
  }));
  const hasNullGap = seriesData.some((point) => point.value === null);
  const scatterPoints =
    scatterValid && effectiveType === 'scatter'
      ? scatterChartData(effectiveRows, dimensionColumn.index, measureColumn.index)
      : [];
  const plottedCount = effectiveType === 'scatter' ? scatterPoints.length : chartPoints.length;
  const chartConfig = {
    value: { label: measureColumn?.name ?? '值', color: 'var(--color-chart-runs)' },
  } satisfies ChartConfig;
  const dimensionName = dimensionColumn?.name ?? '';
  const measureName = measureColumn?.name ?? '';
  const truncatedCaption =
    plottedCount > MAX_ROWS ? `，仅显示前 ${MAX_ROWS} 个点，共 ${plottedCount} 个` : '';
  const chartCaption =
    effectiveType === 'scatter'
      ? `散点图，维度 ${dimensionName}，度量 ${measureName}，散点不聚合${truncatedCaption}`
      : `${CHART_TYPE_LABELS[effectiveType]}，维度 ${dimensionName}，度量 ${measureName}，聚合方式 ${AGGREGATION_LABELS[aggregation]}${truncatedCaption}`;
  const scatterData = scatterPoints.slice(0, MAX_ROWS);
  const chartTableHeaders =
    effectiveType === 'scatter'
      ? [`${dimensionName}(X)`, `${measureName}(Y)`]
      : [dimensionName, `${AGGREGATION_LABELS[aggregation]}(${measureName})`];
  const chartTableRows =
    effectiveType === 'scatter'
      ? scatterData.map((point, index) => ({
          key: String(index),
          label: formatCell(point.x),
          value: formatCell(point.y),
        }))
      : seriesData.map((point, index) => ({
          key: String(index),
          label: point.label,
          value: formatCell(point.value),
        }));
  const chartRendered =
    effectiveType === 'scatter' ? scatterPoints.length > 0 : chartable && seriesData.length > 0;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {sliced || result.truncated ? (
        <p className="text-xs text-muted-foreground">
          {sliced
            ? view === 'table'
              ? `显示前 ${MAX_ROWS} 行，共 ${result.rowCount} 行`
              : `表格显示前 ${MAX_ROWS} 行，图表基于全部 ${result.rowCount} 行`
            : null}
          {sliced && result.truncated ? ' · ' : null}
          {result.truncated ? '结果已达查询上限，已截断' : null}
        </p>
      ) : null}
      <Tabs value={view} onValueChange={(value) => setView(value)} className="min-w-0">
        <TabsList aria-label="结果视图">
          <TabsTrigger value="table">
            <Table2 aria-hidden="true" />
            表格
          </TabsTrigger>
          <TabsTrigger value="chart">
            <ChartColumn aria-hidden="true" />
            图表
          </TabsTrigger>
        </TabsList>
        <TabsContent value="table">
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(row) => row.key}
            label="查询结果"
            empty="查询无结果"
            hideRowCount={sliced}
          />
        </TabsContent>
        <TabsContent value="chart">
          {isEmpty ? (
            <p className="text-xs text-muted-foreground">查询无结果</p>
          ) : hasColumns ? (
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-end gap-3">
                <Field className="w-44">
                  <FieldLabel htmlFor={`${fieldId}-dimension`}>维度</FieldLabel>
                  <Select
                    value={dimension}
                    items={dimensionColumns.map((column) => ({
                      value: String(column.index),
                      label: column.name,
                    }))}
                    onValueChange={(value) => {
                      if (value !== null) setDimension(value);
                    }}
                  >
                    <SelectTrigger
                      id={`${fieldId}-dimension`}
                      aria-label="图表维度"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {dimensionColumns.map((column) => (
                          <SelectItem key={column.index} value={String(column.index)}>
                            {column.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field className="w-44">
                  <FieldLabel htmlFor={`${fieldId}-measure`}>度量</FieldLabel>
                  <Select
                    value={measure}
                    items={plan.measures.map((column) => ({
                      value: String(column.index),
                      label: column.name,
                    }))}
                    onValueChange={(value) => {
                      if (value !== null) setMeasure(value);
                    }}
                  >
                    <SelectTrigger
                      id={`${fieldId}-measure`}
                      aria-label="图表度量"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {plan.measures.map((column) => (
                          <SelectItem key={column.index} value={String(column.index)}>
                            {column.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field className="w-36">
                  <FieldLabel htmlFor={`${fieldId}-aggregation`}>聚合方式</FieldLabel>
                  <Select
                    value={aggregation}
                    items={(Object.keys(AGGREGATION_LABELS) as ChartAggregation[]).map((value) => ({
                      value,
                      label: AGGREGATION_LABELS[value],
                    }))}
                    disabled={effectiveType === 'scatter'}
                    onValueChange={(value) => {
                      if (value !== null) setAggregation(value as ChartAggregation);
                    }}
                  >
                    <SelectTrigger
                      id={`${fieldId}-aggregation`}
                      aria-label="图表聚合方式"
                      className="w-full"
                    >
                      <SelectValue>
                        {effectiveType === 'scatter' ? '散点不聚合' : undefined}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {(Object.keys(AGGREGATION_LABELS) as ChartAggregation[]).map((value) => (
                          <SelectItem key={value} value={value}>
                            {AGGREGATION_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field className="w-32">
                  <FieldLabel htmlFor={`${fieldId}-type`}>图表类型</FieldLabel>
                  <Select
                    value={effectiveType}
                    items={(Object.keys(CHART_TYPE_LABELS) as ChartType[]).map((value) => ({
                      value,
                      label: CHART_TYPE_LABELS[value],
                    }))}
                    onValueChange={(value) => {
                      if (value !== null) setChartTypeChoice(value as ChartType);
                    }}
                  >
                    <SelectTrigger id={`${fieldId}-type`} aria-label="图表类型" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {(Object.keys(CHART_TYPE_LABELS) as ChartType[]).map((value) => (
                          <SelectItem key={value} value={value}>
                            {CHART_TYPE_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              {effectiveType === 'scatter' ? (
                <p className="text-xs text-muted-foreground">
                  X：{dimensionName}，Y：{measureName}。
                </p>
              ) : !chartable ? (
                <p className="text-xs text-muted-foreground">维度和度量不能是同一列。</p>
              ) : aggregation === 'none' ? (
                <p className="text-xs text-muted-foreground">不聚合：每行一个数据点。</p>
              ) : aggregation === 'count' ? (
                <p className="text-xs text-muted-foreground">
                  按 {dimensionName} 计数（每个分组的有效数值个数）。
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  按 {dimensionName} {AGGREGATION_LABELS[aggregation]}。
                </p>
              )}
              {scatterFallback ? (
                <p className="text-xs text-muted-foreground">散点图需要两个不同的数值列。</p>
              ) : null}
              {effectiveType === 'scatter' ? (
                scatterPoints.length === 0 ? (
                  <p className="text-xs text-muted-foreground">没有可绘制的数据点</p>
                ) : (
                  <div aria-hidden="true">
                    <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
                      <ScatterChart
                        accessibilityLayer={false}
                        margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
                      >
                        <CartesianGrid />
                        <XAxis
                          type="number"
                          dataKey="x"
                          tickLine={false}
                          axisLine={false}
                          tickMargin={8}
                        />
                        <YAxis
                          type="number"
                          dataKey="y"
                          width="auto"
                          axisLine={false}
                          tickLine={false}
                          tickMargin={8}
                        />
                        <Scatter
                          data={scatterData}
                          fill="var(--color-value)"
                          isAnimationActive={false}
                        />
                      </ScatterChart>
                    </ChartContainer>
                  </div>
                )
              ) : chartable ? (
                seriesData.length === 0 ? (
                  <p className="text-xs text-muted-foreground">没有可绘制的数据点</p>
                ) : (
                  <div aria-hidden="true">
                    <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
                      {effectiveType === 'line' ? (
                        <LineChart
                          accessibilityLayer={false}
                          data={seriesData}
                          margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
                        >
                          <CartesianGrid vertical={false} />
                          <XAxis
                            dataKey="position"
                            tickLine={false}
                            axisLine={false}
                            tickMargin={8}
                            minTickGap={24}
                            tickFormatter={(value: number) => seriesData[value]?.label ?? ''}
                          />
                          <YAxis width="auto" axisLine={false} tickLine={false} tickMargin={8} />
                          <Line
                            dataKey="value"
                            type="monotone"
                            stroke="var(--color-value)"
                            strokeWidth={1.5}
                            dot={seriesData.length === 1 || hasNullGap}
                            connectNulls={false}
                            isAnimationActive={false}
                          />
                        </LineChart>
                      ) : (
                        <BarChart
                          accessibilityLayer={false}
                          data={seriesData}
                          margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
                        >
                          <CartesianGrid vertical={false} />
                          <XAxis
                            dataKey="position"
                            tickLine={false}
                            axisLine={false}
                            tickMargin={8}
                            minTickGap={24}
                            tickFormatter={(value: number) => seriesData[value]?.label ?? ''}
                          />
                          <YAxis width="auto" axisLine={false} tickLine={false} tickMargin={8} />
                          <Bar
                            dataKey="value"
                            fill="var(--color-value)"
                            maxBarSize={24}
                            radius={[4, 4, 0, 0]}
                            isAnimationActive={false}
                          />
                        </BarChart>
                      )}
                    </ChartContainer>
                  </div>
                )
              ) : null}
              {chartRendered ? (
                <table className="sr-only">
                  <caption>{chartCaption}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{chartTableHeaders[0]}</th>
                      <th scope="col">{chartTableHeaders[1]}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chartTableRows.map((row) => (
                      <tr key={row.key}>
                        <th scope="row">{row.label}</th>
                        <td>{row.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              {plottedCount > MAX_ROWS ? (
                <p className="text-xs text-muted-foreground">
                  图表显示前 {MAX_ROWS} 个数据点，共 {plottedCount} 个
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">没有可用于图表的维度与度量。</p>
          )}
        </TabsContent>
      </Tabs>
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1 text-left text-xs text-muted-foreground">
          <ChevronRight
            className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90"
            aria-hidden="true"
          />
          查看原始结果
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pt-2">
            <JsonBlock value={result} maxHeight="16rem" />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
