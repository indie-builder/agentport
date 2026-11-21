export interface DataDomainQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

export type ColumnType = 'number' | 'text';

interface ChartColumn {
  index: number;
  name: string;
}

export interface ChartPlan {
  dimensions: ChartColumn[];
  measures: ChartColumn[];
  canChart: boolean;
}

export type ChartType = 'bar' | 'line' | 'scatter';

export type ChartAggregation = 'none' | 'sum' | 'avg' | 'count' | 'min' | 'max';

export interface ChartPoint {
  label: string;
  value: number | null;
}

export interface ScatterPoint {
  x: number;
  y: number;
}

const RUN_SQL_TOOL = /^mcp__.+__run_sql$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifierColumn(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'id' || normalized.endsWith('_id');
}

export function dataDomainResultFromTool(
  name: string,
  result: string | undefined,
): DataDomainQueryResult | null {
  if (result === undefined || !RUN_SQL_TOOL.test(name)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(result);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { columns, rows, rowCount, truncated } = raw;
  if (!Array.isArray(columns) || !columns.every((column) => typeof column === 'string'))
    return null;
  if (!Array.isArray(rows)) return null;
  if (typeof rowCount !== 'number' || !Number.isInteger(rowCount) || rowCount < 0) return null;
  if (typeof truncated !== 'boolean') return null;
  if (rowCount !== rows.length) return null;
  if (!rows.every((row) => Array.isArray(row) && row.length === (columns as unknown[]).length)) {
    return null;
  }
  return {
    columns: columns as string[],
    rows: rows as unknown[][],
    rowCount,
    truncated,
  };
}

export function inferColumnTypes(columns: string[], rows: unknown[][]): ColumnType[] {
  return columns.map((name, index) => {
    if (isIdentifierColumn(name)) return 'text';
    let sawNumber = false;
    for (const row of rows) {
      const value = row[index];
      if (value === null || value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'text';
      sawNumber = true;
    }
    return sawNumber ? 'number' : 'text';
  });
}

export function chartPlan(columns: string[], rows: unknown[][]): ChartPlan {
  const types = inferColumnTypes(columns, rows);
  const dimensions = columns.flatMap((name, index) =>
    types[index] === 'text' ? [{ index, name }] : [],
  );
  const measures = columns.flatMap((name, index) =>
    types[index] === 'number' ? [{ index, name }] : [],
  );
  return {
    dimensions,
    measures,
    canChart: rows.length > 0 && dimensions.length > 0 && measures.length > 0,
  };
}

const DATE_LIKE =
  /^(\d{4})[-/](0[1-9]|1[0-2])([-/](0[1-9]|[12]\d|3[01]))?([T ]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?(\.\d+)?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)?)?$/;

const TIME_LIKE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

function dateValue(text: string): number | null {
  const time = TIME_LIKE.exec(text);
  if (time !== null) {
    return Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3] ?? 0);
  }
  const match = DATE_LIKE.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = match[4] === undefined ? null : Number(match[4]);
  if (day !== null && day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'object' ? (JSON.stringify(value) ?? '') : String(value);
}

function numericValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function groupKey(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return `number:${value}`;
  if (typeof value === 'string') return `string:${value}`;
  return `json:${JSON.stringify(value)}`;
}

function isMonotonic(values: number[]): boolean {
  let ascending = true;
  let descending = true;
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1] as number;
    const current = values[index] as number;
    if (current < previous) ascending = false;
    if (current > previous) descending = false;
    if (!ascending && !descending) return false;
  }
  return true;
}

function isOrderedTimeSeries(values: unknown[]): boolean {
  const dates: number[] = [];
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string') return false;
    const parsed = dateValue(value.trim());
    if (parsed === null || !Number.isFinite(parsed)) return false;
    dates.push(parsed);
  }
  return dates.length >= 2 && new Set(dates).size >= 2 && isMonotonic(dates);
}

export function suggestChartType(
  columns: string[],
  rows: unknown[][],
  dimensionIndex: number,
  measureIndex: number,
): ChartType {
  const types = inferColumnTypes(columns, rows);
  if (
    dimensionIndex !== measureIndex &&
    types[dimensionIndex] === 'number' &&
    types[measureIndex] === 'number'
  ) {
    return 'scatter';
  }
  return isOrderedTimeSeries(rows.map((row) => row[dimensionIndex])) ? 'line' : 'bar';
}

function aggregateValues(
  values: number[],
  aggregation: Exclude<ChartAggregation, 'none'>,
): number | null {
  if (aggregation === 'count') return values.length;
  if (values.length === 0) return null;
  switch (aggregation) {
    case 'sum':
      return values.reduce((total, value) => total + value, 0);
    case 'avg':
      return values.reduce((total, value) => total + value, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
  }
}

export function aggregateChartData(
  rows: unknown[][],
  dimensionIndex: number,
  measureIndex: number,
  aggregation: ChartAggregation,
): ChartPoint[] {
  if (aggregation === 'none') {
    return rows.map((row) => ({
      label: formatCell(row[dimensionIndex]),
      value: numericValue(row[measureIndex]),
    }));
  }
  const groups = new Map<string, { label: string; values: number[] }>();
  for (const row of rows) {
    const key = groupKey(row[dimensionIndex]);
    const group = groups.get(key) ?? { label: formatCell(row[dimensionIndex]), values: [] };
    const value = numericValue(row[measureIndex]);
    if (value !== null) group.values.push(value);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ label, values }) => ({
    label,
    value: aggregateValues(values, aggregation),
  }));
}

export function scatterChartData(
  rows: unknown[][],
  xIndex: number,
  yIndex: number,
): ScatterPoint[] {
  return rows.flatMap((row) => {
    const x = numericValue(row[xIndex]);
    const y = numericValue(row[yIndex]);
    return x === null || y === null ? [] : [{ x, y }];
  });
}
