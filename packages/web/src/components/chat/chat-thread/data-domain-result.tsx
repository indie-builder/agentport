import { ChartColumn, ChevronRight, Table2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  chartPlan,
  type DataDomainQueryResult,
  inferColumnTypes,
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

interface ResultRow {
  key: string;
  cells: unknown[];
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'object' ? (JSON.stringify(value) ?? '') : String(value);
}

export function DataDomainResultView({ result }: { result: DataDomainQueryResult }) {
  const [view, setView] = useState<'table' | 'chart'>('table');
  const isEmpty = result.rows.length === 0;
  const effectiveRows = isEmpty ? [] : result.rows;
  const plan = chartPlan(result.columns, effectiveRows);
  const [dimension, setDimension] = useState(String(plan.dimensions[0]?.index ?? ''));
  const [measure, setMeasure] = useState(String(plan.measures[0]?.index ?? ''));
  const fieldId = useId();

  const shown = effectiveRows.slice(0, MAX_ROWS);
  const sliced = effectiveRows.length > MAX_ROWS;
  const dimensionColumn = plan.dimensions.find((column) => String(column.index) === dimension);
  const measureColumn = plan.measures.find((column) => String(column.index) === measure);
  const types = inferColumnTypes(result.columns, effectiveRows);

  const columns: DataColumn<ResultRow>[] = result.columns.map((name, index) => ({
    id: `c${index}`,
    header: name,
    numeric: types[index] === 'number',
    cell: (row) => formatCell(row.cells[index]),
  }));
  const rows = shown.map((cells, index) => ({ key: String(index), cells }));

  const chartRows =
    dimensionColumn === undefined || measureColumn === undefined
      ? []
      : shown.map((cells, index) => {
          const value = cells[measureColumn.index];
          return {
            position: index,
            label: formatCell(cells[dimensionColumn.index]),
            value: typeof value === 'number' ? value : null,
          };
        });
  const chartConfig = {
    value: { label: measureColumn?.name ?? '值', color: 'var(--color-chart-runs)' },
  } satisfies ChartConfig;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {sliced || result.truncated ? (
        <p className="text-xs text-muted-foreground">
          {sliced ? `显示前 ${MAX_ROWS} 行，共 ${result.rowCount} 行` : null}
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
          ) : plan.canChart && dimensionColumn !== undefined && measureColumn !== undefined ? (
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-end gap-3">
                <Field className="w-44">
                  <FieldLabel htmlFor={`${fieldId}-dimension`}>维度</FieldLabel>
                  <Select
                    value={dimension}
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
                        {plan.dimensions.map((column) => (
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
              </div>
              <div aria-hidden="true">
                <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
                  <BarChart
                    accessibilityLayer={false}
                    data={chartRows}
                    margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
                  >
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="position"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      minTickGap={24}
                      tickFormatter={(value: number) => chartRows[value]?.label ?? ''}
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
                </ChartContainer>
              </div>
              <p className="text-xs text-muted-foreground">聚合请在查询 SQL 中完成</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              没有可用于图表的维度与度量；聚合请在查询 SQL 中完成。
            </p>
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
