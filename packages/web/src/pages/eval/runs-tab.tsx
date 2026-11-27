import { Button as PrimitiveButton } from '@ui-sdk/react/button';
import { GitCompare, Play, Plus, Shuffle } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { Meter, MeterIndicator, MeterTrack } from '../../components/ui/meter.js';
import type { EvalCase, EvalRun } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import {
  evalStatusLabel,
  evalStatusVariant,
  formatDateTime,
  formatRelative,
  shortId,
} from '../../lib/format.js';
import { buildEvalPassRatePoints, EvalPassRateChart } from './pass-rate-chart.js';
import { EvalRunResults } from './run-results.js';

export function EvalRunsTab({
  runsPending,
  runsError,
  runsErrorValue,
  runsIsFetchNextPageError,
  runsSuccess,
  runsHasNextPage,
  runsFetchingNextPage,
  onRetryRuns,
  onFetchNextRuns,
  runItems,
  caseItems,
  casesSuccess,
  casesEmpty,
  casesHasNextPage,
  canManageEval,
  canExecuteEval,
  canReadRuns,
  selectedRunId,
  onSelectRun,
  onClearRunSelection,
  onCompareLatest,
  onOpenCreateCase,
  onOpenSampleRuns,
}: {
  runsPending: boolean;
  runsError: boolean;
  runsErrorValue: unknown;
  runsIsFetchNextPageError: boolean;
  runsSuccess: boolean;
  runsHasNextPage: boolean;
  runsFetchingNextPage: boolean;
  onRetryRuns: () => void;
  onFetchNextRuns: () => void;
  runItems: EvalRun[];
  caseItems: EvalCase[];
  casesSuccess: boolean;
  casesEmpty: boolean;
  casesHasNextPage: boolean;
  canManageEval: boolean;
  canExecuteEval: boolean;
  canReadRuns: boolean;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  onClearRunSelection: () => void;
  onCompareLatest: () => void;
  onOpenCreateCase: (trigger: HTMLElement) => void;
  onOpenSampleRuns: (trigger: HTMLElement) => void;
}) {
  if (runsPending) return <LoadingState rows={3} />;
  if (runsError && !runsIsFetchNextPageError) {
    return <ErrorState error={runsErrorValue} onRetry={onRetryRuns} />;
  }

  if (runsSuccess && runItems.length === 0 && !selectedRunId) {
    return (
      <EmptyState
        variant="idle"
        scale="section"
        icon={<Play aria-hidden="true" />}
        title="尚未执行过评估"
        description={
          casesSuccess && casesEmpty
            ? '先添加用例后再运行评估。'
            : casesSuccess && !casesEmpty && canExecuteEval
              ? '准备好用例后，点击右上角「运行评估」生成基线报告。'
              : !canExecuteEval
                ? '当前账户没有执行该专家评估的权限。'
                : undefined
        }
        action={
          casesSuccess && casesEmpty && canManageEval ? (
            <Button
              variant="outline"
              size="sm"
              onClick={(event) => onOpenCreateCase(event.currentTarget)}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              新建用例
            </Button>
          ) : undefined
        }
        secondaryAction={
          casesSuccess && casesEmpty && canManageEval && canReadRuns ? (
            <Button
              variant="outline"
              size="sm"
              onClick={(event) => onOpenSampleRuns(event.currentTarget)}
            >
              <Shuffle data-icon="inline-start" aria-hidden="true" />
              从运行抽样
            </Button>
          ) : undefined
        }
      />
    );
  }

  const terminalRuns = runItems.filter((run) => run.status !== 'running');
  const latestTerminal = terminalRuns[0];
  const prevTerminal = terminalRuns[1];
  const latestRate =
    latestTerminal && latestTerminal.total > 0
      ? Math.round((latestTerminal.passed / latestTerminal.total) * 100)
      : null;
  const prevRate =
    prevTerminal && prevTerminal.total > 0
      ? Math.round((prevTerminal.passed / prevTerminal.total) * 100)
      : null;
  const delta = latestRate !== null && prevRate !== null ? latestRate - prevRate : null;
  const latestFailed = latestTerminal
    ? Math.max(0, latestTerminal.total - latestTerminal.passed)
    : null;
  const llmCount = caseItems.filter((item) => item.judgeMode === 'llm').length;
  const containsCount = caseItems.length - llmCount;
  const chartPoints = buildEvalPassRatePoints(runItems);
  const effectiveRunId = selectedRunId ?? runItems[0]?.id ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {runItems.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2 xl:grid-cols-[repeat(3,minmax(0,1fr))_minmax(260px,1.5fr)]">
          <Card hover="static" size="sm">
            <CardContent className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">最近通过率</span>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-2xl font-medium tabular-nums text-fg">
                  {latestRate !== null ? `${latestRate}%` : '—'}
                </span>
                {delta !== null ? (
                  <StatusBadge tone={delta > 0 ? 'success' : delta < 0 ? 'danger' : 'default'}>
                    {delta > 0 ? `+${delta}%` : `${delta}%`}
                  </StatusBadge>
                ) : null}
              </div>
              <span className="text-xs text-muted-foreground">
                {latestTerminal
                  ? `${latestTerminal.passed} / ${latestTerminal.total} 通过 · ${formatRelative(latestTerminal.createdAt)}`
                  : '暂无已结束的运行'}
              </span>
            </CardContent>
          </Card>

          <Card hover="static" size="sm">
            <CardContent className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">最近失败项</span>
              <span
                className={cn(
                  'font-mono text-2xl font-medium tabular-nums',
                  latestFailed !== null && latestFailed > 0 ? 'text-danger' : 'text-fg',
                )}
              >
                {latestFailed !== null ? latestFailed : '—'}
              </span>
              <span className="text-xs text-muted-foreground">
                {latestTerminal ? evalStatusLabel[latestTerminal.status] : '等待首次运行结束'}
              </span>
            </CardContent>
          </Card>

          <Card hover="static" size="sm">
            <CardContent className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">用例覆盖</span>
              <span className="font-mono text-2xl font-medium tabular-nums text-fg">
                {caseItems.length}
                {casesHasNextPage ? '+' : ''}
              </span>
              <span className="text-xs text-muted-foreground">
                {llmCount} LLM 评判 · {containsCount} 包含匹配
              </span>
            </CardContent>
          </Card>

          <Card hover="static" size="sm">
            <CardContent className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">通过率走势</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={terminalRuns.length < 2}
                  title={terminalRuns.length < 2 ? '至少需要两次已结束的运行' : undefined}
                  onClick={onCompareLatest}
                  className="-mr-2.5 h-6 px-2 text-xs"
                >
                  <GitCompare data-icon="inline-start" aria-hidden="true" />
                  对比最近两次
                </Button>
              </div>
              {chartPoints.length >= 2 ? (
                <EvalPassRateChart runs={runItems} compact />
              ) : (
                <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
                  至少需要两次已结束的运行
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 rounded-xl border bg-surface p-4">
          {effectiveRunId ? (
            <EvalRunResults
              key={effectiveRunId}
              id={effectiveRunId}
              {...(selectedRunId ? { onClearSelection: onClearRunSelection } : {})}
            />
          ) : null}
        </div>

        {runItems.length > 0 ? (
          <aside className="min-w-0 rounded-xl border bg-surface p-3 xl:sticky xl:top-0">
            <div className="flex items-center justify-between px-1 pb-2">
              <h2 className="text-sm font-medium text-fg">历史运行</h2>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {runItems.length}
                {runsHasNextPage ? '+' : ''}
              </span>
            </div>
            <ul className="flex flex-col gap-1">
              {runItems.map((run) => {
                const isSelected = run.id === effectiveRunId;
                const passRatio =
                  run.total > 0 ? Math.min(100, Math.round((run.passed / run.total) * 100)) : 0;
                return (
                  <li key={run.id}>
                    <PrimitiveButton
                      type="button"
                      data-row={run.id}
                      aria-label={`${formatDateTime(run.createdAt)} · ${shortId(run.id)}`}
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={() => onSelectRun(run.id)}
                      className={cn(
                        'flex w-full flex-col gap-1.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isSelected ? 'bg-selected text-selected-foreground' : 'hover:bg-hover',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-xs text-muted-foreground" title={run.id}>
                          {shortId(run.id)}
                        </code>
                        <StatusBadge tone={evalStatusVariant[run.status]}>
                          {run.status === 'running' ? (
                            <span className="size-1.5 rounded-full bg-fg" aria-hidden="true" />
                          ) : null}
                          {evalStatusLabel[run.status]}
                        </StatusBadge>
                        <span
                          className="ml-auto text-xs text-muted-foreground"
                          title={formatDateTime(run.createdAt)}
                        >
                          {formatRelative(run.createdAt)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <Meter
                          value={passRatio}
                          min={0}
                          max={100}
                          aria-label={`通过率 ${run.passed} / ${run.total}`}
                          className="flex-1"
                        >
                          <MeterTrack>
                            <MeterIndicator
                              className={
                                run.status === 'failed'
                                  ? 'bg-danger'
                                  : run.status === 'running'
                                    ? 'bg-fg'
                                    : 'bg-success'
                              }
                            />
                          </MeterTrack>
                        </Meter>
                        <span className="font-mono text-xs tabular-nums text-fg">
                          {run.passed} / {run.total}
                        </span>
                      </div>
                    </PrimitiveButton>
                  </li>
                );
              })}
            </ul>
            {runsIsFetchNextPageError ? (
              <div className="mt-3">
                <ErrorState
                  error={runsErrorValue}
                  onRetry={onFetchNextRuns}
                  title="下一页加载失败，保留已加载的运行记录"
                />
              </div>
            ) : runsHasNextPage ? (
              <div className="mt-3 flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={runsFetchingNextPage}
                  aria-busy={runsFetchingNextPage}
                  onClick={onFetchNextRuns}
                >
                  {runsFetchingNextPage ? '加载中…' : '加载更多'}
                </Button>
              </div>
            ) : (
              <div className="mt-3 text-center text-xs text-muted-foreground">已到末尾</div>
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
