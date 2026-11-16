export interface DataDomainQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

export type ColumnType = 'number' | 'text';

export interface ChartColumn {
  index: number;
  name: string;
}

export interface ChartPlan {
  dimensions: ChartColumn[];
  measures: ChartColumn[];
  canChart: boolean;
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
