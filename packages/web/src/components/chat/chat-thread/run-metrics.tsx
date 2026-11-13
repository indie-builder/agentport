import { Link, useLocation } from '@tanstack/react-router';
import type { RunMetrics, RunOutcome } from '../../../lib/chat-store.js';
import { formatCost, formatDuration, formatTokens, shortId } from '../../../lib/format.js';

const outcomeLabel: Record<RunOutcome, string> = {
  succeeded: '完成',
  failed: '失败',
  cancelled: '已停止',
  timeout: '超时',
};

/** 一行读数：完成 · 轮次 · 耗时 · token · 成本 · 查看详情。 */
export function RunMetricsLine({ run, title }: { run: RunMetrics; title?: string }) {
  const location = useLocation();
  const tone =
    run.status === 'succeeded'
      ? 'text-success'
      : run.status === 'cancelled'
        ? 'text-muted-foreground'
        : 'text-danger';
  return (
    <div className="flex flex-col gap-1" title={title}>
      <div className="flex flex-wrap items-center gap-x-1.5 font-mono text-xs tabular-nums text-muted-foreground">
        <span className={tone}>{outcomeLabel[run.status]}</span>
        {run.turns !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{run.turns} 轮</span>
          </>
        ) : null}
        {run.durationMs !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{formatDuration(run.durationMs)}</span>
          </>
        ) : null}
        {run.tokens !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{formatTokens(run.tokens)} tokens</span>
          </>
        ) : null}
        {run.costUsd !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{formatCost(run.costUsd)}</span>
          </>
        ) : null}
        <span aria-hidden="true">·</span>
        <Link
          to="/runs/$runId"
          params={{ runId: run.runId }}
          search={{ backTo: location.href }}
          aria-label={`查看详情：运行 ${shortId(run.runId)}`}
          className="text-link underline underline-offset-2 hover:text-link/80"
        >
          查看详情
        </Link>
      </div>
      {run.error ? <p className="break-words text-sm text-danger">{run.error}</p> : null}
    </div>
  );
}
