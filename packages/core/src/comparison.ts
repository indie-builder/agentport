import type { EvalJudgeMode } from '@agentport/shared';

export interface EvalCaseSnapshot {
  id: string;
  name: string;
  prompt: string;
  expectation: string;
  judgeMode: EvalJudgeMode;
  expectedTools?: string[] | null;
  forbiddenTools?: string[] | null;
}

export interface EvalResultRow {
  caseId: string | null;
  name: string;
  prompt: string;
  expectation: string;
  passed: boolean;
  output: string;
  judgeReason: string | null;
  runId: string | null;
}

export interface StoredEvalResult extends EvalResultRow {
  id: string;
  caseSnapshot: EvalCaseSnapshot | null;
}

export type EvalComparisonStatus =
  | 'improved'
  | 'regressed'
  | 'unchanged'
  | 'changed_inputs'
  | 'base_only'
  | 'head_only'
  | 'unverified';

export interface EvalComparisonRow {
  key: string;
  status: EvalComparisonStatus;
  base: EvalResultRow | null;
  head: EvalResultRow | null;
}

export function toPublicResult(row: StoredEvalResult): EvalResultRow {
  return {
    caseId: row.caseId,
    name: row.name,
    prompt: row.prompt,
    expectation: row.expectation,
    passed: row.passed,
    output: row.output,
    judgeReason: row.judgeReason,
    runId: row.runId,
  };
}

export function snapshotInputs(row: Pick<StoredEvalResult, 'caseSnapshot'>): {
  prompt: string;
  expectation: string;
  judgeMode: EvalJudgeMode;
  expectedTools: string[];
  forbiddenTools: string[];
} | null {
  return row.caseSnapshot === null
    ? null
    : {
        prompt: row.caseSnapshot.prompt,
        expectation: row.caseSnapshot.expectation,
        judgeMode: row.caseSnapshot.judgeMode ?? 'contains',
        expectedTools: [...new Set(row.caseSnapshot.expectedTools ?? [])].sort(),
        forbiddenTools: [...new Set(row.caseSnapshot.forbiddenTools ?? [])].sort(),
      };
}

export function comparePair(
  key: string,
  base: StoredEvalResult,
  head: StoredEvalResult,
): EvalComparisonRow {
  const baseInputs = snapshotInputs(base);
  const headInputs = snapshotInputs(head);
  if (baseInputs === null || headInputs === null) {
    return { key, status: 'unverified', base: toPublicResult(base), head: toPublicResult(head) };
  }
  if (
    baseInputs.prompt !== headInputs.prompt ||
    baseInputs.expectation !== headInputs.expectation ||
    baseInputs.judgeMode !== headInputs.judgeMode ||
    baseInputs.expectedTools.join('\u0000') !== headInputs.expectedTools.join('\u0000') ||
    baseInputs.forbiddenTools.join('\u0000') !== headInputs.forbiddenTools.join('\u0000')
  ) {
    return {
      key,
      status: 'changed_inputs',
      base: toPublicResult(base),
      head: toPublicResult(head),
    };
  }
  const status: EvalComparisonStatus =
    base.passed === head.passed ? 'unchanged' : head.passed ? 'improved' : 'regressed';
  return { key, status, base: toPublicResult(base), head: toPublicResult(head) };
}

export function compareResults(
  baseRows: StoredEvalResult[],
  headRows: StoredEvalResult[],
): EvalComparisonRow[] {
  const keyOf = (row: StoredEvalResult): string | null => row.caseSnapshot?.id ?? row.caseId;

  const group = (rows: StoredEvalResult[]) => {
    const groups = new Map<string, StoredEvalResult[]>();
    const loose: StoredEvalResult[] = [];
    for (const row of rows) {
      const key = keyOf(row);
      if (key === null) loose.push(row);
      else {
        const existing = groups.get(key);
        if (existing) existing.push(row);
        else groups.set(key, [row]);
      }
    }
    return { groups, loose };
  };
  const base = group(baseRows);
  const head = group(headRows);

  const rows: EvalComparisonRow[] = [];

  for (const row of base.loose) {
    rows.push({
      key: `base:${row.id}`,
      status: 'unverified',
      base: toPublicResult(row),
      head: null,
    });
  }
  for (const [key, baseGroup] of base.groups) {
    const headGroup = head.groups.get(key) ?? [];
    if (baseGroup.length > 1 || headGroup.length > 1) {
      for (const result of baseGroup) {
        rows.push({
          key: `base:${result.id}`,
          status: 'unverified',
          base: toPublicResult(result),
          head: null,
        });
      }
      for (const result of headGroup) {
        rows.push({
          key: `head:${result.id}`,
          status: 'unverified',
          base: null,
          head: toPublicResult(result),
        });
      }
      continue;
    }
    const [baseResult] = baseGroup;
    const [headResult] = headGroup;
    if (baseResult === undefined) continue;
    rows.push(
      headResult === undefined
        ? { key, status: 'base_only', base: toPublicResult(baseResult), head: null }
        : comparePair(key, baseResult, headResult),
    );
  }
  for (const row of head.loose) {
    rows.push({
      key: `head:${row.id}`,
      status: 'unverified',
      base: null,
      head: toPublicResult(row),
    });
  }
  for (const [key, headGroup] of head.groups) {
    if (base.groups.has(key)) continue;
    const status = headGroup.length > 1 ? 'unverified' : 'head_only';
    for (const result of headGroup) {
      rows.push({
        key: headGroup.length > 1 ? `head:${result.id}` : key,
        status,
        base: null,
        head: toPublicResult(result),
      });
    }
  }

  return rows;
}
