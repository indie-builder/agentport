import { ArrowRight, GitCompare } from 'lucide-react';
import { FilterSelect } from '../../components/filter-select.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from '../../components/ui/segmented-control.js';
import type { EvalRun } from '../../lib/api.js';
import {
  evalComparisonStatusLabel,
  evalComparisonStatusVariant,
  evalStatusLabel,
  formatDateTime,
  shortId,
} from '../../lib/format.js';
import { useEvalComparison } from '../../lib/queries.js';
import { useOptimisticValue } from '../../lib/use-optimistic-value.js';
import { CompareSide } from './compare-side.js';
import type { EvalDiffFilter, EvalSearchPatch } from './shared.js';

export function EvalCompareTab({
  runsPending,
  runsError,
  runsErrorValue,
  runsIsFetchNextPageError,
  onRetryRuns,
  baseId,
  headId,
  diff,
  runs,
  onChangeSearch,
  onBackToRuns,
}: {
  runsPending: boolean;
  runsError: boolean;
  runsErrorValue: unknown;
  runsIsFetchNextPageError: boolean;
  onRetryRuns: () => void;
  baseId: string | null;
  headId: string | null;
  diff: EvalDiffFilter;
  runs: EvalRun[];
  onChangeSearch: (patch: EvalSearchPatch) => void;
  onBackToRuns: () => void;
}) {
  const effectiveBaseId = baseId ?? runs[1]?.id ?? '';
  const effectiveHeadId = headId ?? runs[0]?.id ?? '';
  const hasValidPair =
    effectiveBaseId !== '' && effectiveHeadId !== '' && effectiveBaseId !== effectiveHeadId;

  const comparison = useEvalComparison(
    hasValidPair ? effectiveBaseId : '',
    hasValidPair ? effectiveHeadId : '',
  );
  const [optimisticDiff, commitDiff] = useOptimisticValue(diff);

  if (!hasValidPair) {
    if (runsPending) return <LoadingState rows={3} />;
    if (runsError && !runsIsFetchNextPageError) {
      return <ErrorState error={runsErrorValue} onRetry={onRetryRuns} />;
    }
    return (
      <EmptyState
        variant="idle"
        scale="section"
        icon={<GitCompare aria-hidden="true" />}
        title="至少需要两次已结束的运行才能比较"
        description="完成至少两次评估运行后，可在此逐条对比结果变化。"
        action={
          <Button variant="outline" size="sm" onClick={onBackToRuns}>
            返回评估运行
          </Button>
        }
      />
    );
  }

  const runLabel = (run: EvalRun): string =>
    `${shortId(run.id)} · ${evalStatusLabel[run.status]} · ${formatDateTime(run.createdAt)}`;
  const withSelected = (
    options: { value: string; label: string }[],
    selectedId: string,
  ): { value: string; label: string }[] =>
    options.some((option) => option.value === selectedId)
      ? options
      : [{ value: selectedId, label: `${shortId(selectedId)} · 不在当前列表` }, ...options];

  const baseOptions = withSelected(
    runs
      .filter((run) => run.id !== effectiveHeadId)
      .map((run) => ({ value: run.id, label: runLabel(run) })),
    effectiveBaseId,
  );
  const headOptions = withSelected(
    runs
      .filter((run) => run.id !== effectiveBaseId)
      .map((run) => ({ value: run.id, label: runLabel(run) })),
    effectiveHeadId,
  );

  const rows = comparison.data?.rows ?? [];
  const regressedCount = rows.filter((row) => row.status === 'regressed').length;
  const improvedCount = rows.filter((row) => row.status === 'improved').length;
  const changedCount = rows.filter((row) => row.status !== 'unchanged').length;
  const bothFailedCount = rows.filter(
    (row) => row.status === 'unchanged' && row.head?.passed === false,
  ).length;
  const bothPassedCount = rows.filter(
    (row) => row.status === 'unchanged' && row.head?.passed === true,
  ).length;
  const changedInputsCount = rows.filter((row) => row.status === 'changed_inputs').length;
  const baseOnlyCount = rows.filter((row) => row.status === 'base_only').length;
  const headOnlyCount = rows.filter((row) => row.status === 'head_only').length;
  const unverifiedCount = rows.filter((row) => row.status === 'unverified').length;

  const visibleRows = rows.filter((row) => {
    if (diff === 'regressed') return row.status === 'regressed';
    if (diff === 'changed') return row.status !== 'unchanged';
    return true;
  });

  const diffOptions: readonly { value: EvalDiffFilter; label: string }[] = [
    { value: 'changed', label: `仅变化 (${changedCount})` },
    { value: 'regressed', label: `仅退化 (${regressedCount})` },
    { value: 'all', label: `全部 (${rows.length})` },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <FilterSelect
            value={effectiveBaseId}
            onValueChange={(next) => onChangeSearch({ base: next, head: effectiveHeadId })}
            options={baseOptions}
            label="基准运行"
            className="w-full sm:w-64"
          />
          <ArrowRight className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <FilterSelect
            value={effectiveHeadId}
            onValueChange={(next) => onChangeSearch({ base: effectiveBaseId, head: next })}
            options={headOptions}
            label="对比运行"
            className="w-full sm:w-64"
          />
        </div>

        <SegmentedControl<EvalDiffFilter>
          aria-label="筛选对比结果"
          value={optimisticDiff}
          onValueChange={(next) => {
            if (next !== null && next !== optimisticDiff) {
              commitDiff(next, () => onChangeSearch({ diff: next }));
            }
          }}
        >
          <SegmentedControlIndicator />
          {diffOptions.map((option) => (
            <SegmentedControlItem
              key={option.value}
              value={option.value}
              className="h-6 px-2.5 text-xs"
            >
              {option.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>

      {comparison.isSuccess ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusBadge tone={regressedCount > 0 ? 'danger' : 'default'}>
            退化 {regressedCount}
          </StatusBadge>
          <StatusBadge tone={improvedCount > 0 ? 'success' : 'default'}>
            改善 {improvedCount}
          </StatusBadge>
          <StatusBadge tone={bothFailedCount > 0 ? 'warn' : 'default'}>
            持续未通过 {bothFailedCount}
          </StatusBadge>
          <StatusBadge tone="default">持续通过 {bothPassedCount}</StatusBadge>
          {changedInputsCount > 0 ? (
            <StatusBadge tone="warn">输入已变更 {changedInputsCount}</StatusBadge>
          ) : null}
          {baseOnlyCount > 0 ? (
            <StatusBadge tone="outline">仅基准 {baseOnlyCount}</StatusBadge>
          ) : null}
          {headOnlyCount > 0 ? (
            <StatusBadge tone="outline">仅对比 {headOnlyCount}</StatusBadge>
          ) : null}
          {unverifiedCount > 0 ? (
            <StatusBadge tone="warn">无法核对 {unverifiedCount}</StatusBadge>
          ) : null}
          <span className="ml-auto">
            只比较相同冻结输入的结果；专家配置未固定，不构成完整可复现结论。
          </span>
        </div>
      ) : null}

      {comparison.isPending ? <LoadingState rows={3} /> : null}

      {comparison.isError ? (
        <div className="flex flex-col gap-3">
          <ErrorState error={comparison.error} onRetry={() => void comparison.refetch()} />
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={onBackToRuns}>
              返回评估运行
            </Button>
          </div>
        </div>
      ) : null}

      {comparison.isSuccess && rows.length === 0 ? (
        <EmptyState
          variant="idle"
          scale="inline"
          icon={<GitCompare aria-hidden="true" />}
          title="两次运行都没有结果记录"
          description="无法比较。"
        />
      ) : null}

      {comparison.isSuccess && rows.length > 0 && visibleRows.length === 0 ? (
        <EmptyState
          variant="clear"
          scale="inline"
          title="当前筛选下无变化项"
          description="可切换至「全部」查看两次运行的所有用例。"
          action={
            <Button variant="outline" size="sm" onClick={() => onChangeSearch({ diff: 'all' })}>
              查看全部
            </Button>
          }
        />
      ) : null}

      {comparison.isSuccess && visibleRows.length > 0 ? (
        <ul aria-label="对比结果列表" className="flex flex-col gap-3 pt-2">
          {visibleRows.map((row) => (
            <li key={`${effectiveBaseId}:${effectiveHeadId}:${row.key}`}>
              <Card hover="static" size="sm">
                <CardHeader className="border-b">
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={evalComparisonStatusVariant[row.status]}>
                      {evalComparisonStatusLabel[row.status]}
                    </StatusBadge>
                    <span className="min-w-0 break-words text-fg">
                      {row.base?.name ?? row.head?.name ?? '—'}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <CompareSide
                      title="基准"
                      result={row.base}
                      showPass={row.status !== 'changed_inputs' && row.status !== 'unverified'}
                      defaultInputsOpen={row.status === 'changed_inputs'}
                    />
                    <CompareSide
                      title="对比"
                      result={row.head}
                      showPass={row.status !== 'changed_inputs' && row.status !== 'unverified'}
                      defaultInputsOpen={row.status === 'changed_inputs'}
                    />
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
