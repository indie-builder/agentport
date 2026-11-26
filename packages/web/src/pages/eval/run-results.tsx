import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronDown, Download, Play } from 'lucide-react';
import { useState } from 'react';
import { CodeBlock } from '../../components/code-block.js';
import { PageNote } from '../../components/page.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/ui/collapsible.js';
import { ApiError, api, type EvalResult } from '../../lib/api.js';
import { downloadBlob, downloadJson } from '../../lib/browser-files.js';
import { cn } from '../../lib/cn.js';
import { toCsv } from '../../lib/csv.js';
import { evalStatusLabel, evalStatusVariant, shortId } from '../../lib/format.js';
import { useEvalRun } from '../../lib/queries.js';
import { toastError } from '../../lib/toast.js';

function EvalResultRow({ result, backTo }: { result: EvalResult; backTo: string }) {
  const [open, setOpen] = useState(!result.passed);

  return (
    <Collapsible
      render={<li />}
      open={open}
      onOpenChange={setOpen}
      className="border-b py-2.5 last:border-b-0 last:pb-0"
    >
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ease-out-soft hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'shrink-0 text-muted-foreground transition-transform duration-150',
            open ? 'rotate-0' : '-rotate-90',
          )}
        />
        <StatusBadge tone={result.passed ? 'success' : 'danger'}>
          {result.passed ? '通过' : '未通过'}
        </StatusBadge>
        <span className="min-w-0 flex-1 text-sm font-medium text-fg [overflow-wrap:anywhere]">
          {result.name}
        </span>
        {!open && !result.passed && result.judgeReason ? (
          <span className="max-w-xs truncate text-xs text-danger">{result.judgeReason}</span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2.5 rounded-lg bg-sunken p-3 text-sm">
          {result.judgeReason ? (
            <div className="mb-3">
              <div className="text-xs text-muted-foreground">评判理由</div>
              <p
                className={cn(
                  'mt-0.5 whitespace-pre-wrap break-words',
                  result.passed ? 'text-fg' : 'text-danger',
                )}
              >
                {result.judgeReason}
              </p>
            </div>
          ) : null}
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <div>
              <div className="text-xs text-muted-foreground">Prompt</div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-fg">{result.prompt}</p>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">期望</div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-fg">
                {result.expectation || '（只要求有文本输出）'}
              </p>
            </div>
          </div>
          <div className="mt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">实际输出</span>
              {result.runId ? (
                <Link
                  to="/runs/$runId"
                  params={{ runId: result.runId }}
                  search={{ backTo }}
                  className="text-xs text-fg underline underline-offset-4"
                >
                  查看运行
                </Link>
              ) : null}
            </div>
            <CodeBlock
              code={result.output || '（空）'}
              maxHeight="12rem"
              className="mt-1"
              copyLabel="复制输出"
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function EvalRunResults({
  id,
  onClearSelection,
}: {
  id: string;
  onClearSelection?: () => void;
}) {
  const detail = useEvalRun(id);
  const location = useLocation();
  const search = useSearch({ from: '/_shell/eval' });
  const navigate = useNavigate();
  const [exporting, setExporting] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const onlyFailed = search.failedOnly === '1';

  if (detail.isPending) return <LoadingState rows={2} />;
  if (!detail.data) {
    const missing = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="flex flex-col gap-3">
        <ErrorState
          error={detail.error}
          title={missing ? '这次评估运行不存在' : '内容没有加载出来'}
          onRetry={() => void detail.refetch()}
        />
        {missing && onClearSelection ? (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={onClearSelection}>
              返回最近运行
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const { results, evalRun } = detail.data;
  const failedCount = results.filter((r) => !r.passed).length;
  const visibleResults = onlyFailed ? results.filter((r) => !r.passed) : results;
  const running = evalRun.status === 'running';
  const executed = results.length;
  const pending = Math.max(0, evalRun.total - executed);

  const toggleFailed = (): void => {
    void navigate({
      to: '/eval',
      search: { ...search, failedOnly: onlyFailed ? undefined : '1' },
    });
  };

  const download = async (): Promise<void> => {
    setExporting(true);
    try {
      const data = await api.exportEvalRun(id);
      downloadJson(data, 'eval-result.json');
    } catch (error) {
      toastError(error);
    } finally {
      setExporting(false);
    }
  };

  const exportCsv = () => {
    setExportingCsv(true);
    try {
      const rows = visibleResults.map((result) => [
        result.name,
        result.passed ? '通过' : '未通过',
        result.prompt,
        result.expectation || '',
        result.output || '',
        result.runId ?? '',
      ]);
      const csv = toCsv(['用例名', '结果', 'Prompt', '期望', '输出', '运行ID'], rows);
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `eval-result-${id}.csv`);
    } catch (error) {
      toastError(error);
    } finally {
      setExportingCsv(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {detail.isError ? (
        <ErrorState
          error={detail.error}
          title="刷新失败，内容仍是上次结果"
          onRetry={() => void detail.refetch()}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-medium text-fg">运行明细</h2>
          <code className="font-mono text-xs text-muted-foreground" title={evalRun.id}>
            {shortId(evalRun.id)}
          </code>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {failedCount > 0 ? (
            <Button variant="outline" size="sm" aria-pressed={onlyFailed} onClick={toggleFailed}>
              {onlyFailed ? '显示全部' : `只看未通过（${failedCount}）`}
            </Button>
          ) : null}
          {results.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              disabled={exportingCsv || results.length === 0}
              aria-busy={exportingCsv}
              onClick={exportCsv}
            >
              <Download data-icon="inline-start" aria-hidden="true" />
              {exportingCsv ? '导出中…' : '导出 CSV'}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={running || exporting}
            aria-busy={exporting}
            title={running ? '运行结束后可导出' : undefined}
            onClick={() => void download()}
          >
            <Download data-icon="inline-start" aria-hidden="true" />
            {exporting ? '导出中…' : '导出结果'}
          </Button>
        </div>
      </div>

      <div
        data-slot="eval-run-summary"
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b pb-3 text-sm"
      >
        <StatusBadge tone={evalStatusVariant[evalRun.status]}>
          {running ? <span className="size-1.5 rounded-full bg-fg" aria-hidden="true" /> : null}
          {evalStatusLabel[evalRun.status]}
        </StatusBadge>
        <span className="text-muted-foreground">
          已记录{' '}
          <span className="font-mono tabular-nums text-fg">
            {executed} / {evalRun.total}
          </span>
        </span>
        <span className="text-muted-foreground">
          无记录 <span className="font-mono tabular-nums text-fg">{pending}</span>
        </span>
        <span className="text-muted-foreground">
          通过 <span className="font-mono tabular-nums text-fg">{evalRun.passed}</span>
        </span>
        <span className="text-muted-foreground">
          未通过 <span className="font-mono tabular-nums text-fg">{failedCount}</span>
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          导出已记录结果；专家配置未固定，文件不构成完整复现包。
        </span>
      </div>

      {evalRun.status === 'failed' && evalRun.error !== null ? (
        <PageNote
          tone="danger"
          title={results.length === 0 ? '评估失败，未生成结果' : '评估失败'}
          description={
            <span className="[overflow-wrap:anywhere]">{evalRun.error} 请检查后重新运行评估。</span>
          }
        />
      ) : null}
      {evalRun.status === 'cancelled' ? (
        <PageNote
          title="已停止后续用例"
          description={
            pending > 0
              ? `后续用例不会再开始；有 ${pending} 条用例没有结果记录，当前用例可能仍在执行。`
              : '后续用例不会再开始；已记录的结果保留。'
          }
        />
      ) : null}
      {results.length === 0 ? (
        evalRun.status !== 'failed' ? (
          <EmptyState
            variant="idle"
            scale="inline"
            icon={<Play aria-hidden="true" />}
            title={
              running
                ? '正在逐个执行用例…'
                : evalRun.status === 'cancelled'
                  ? '后续用例已停止，没有结果记录'
                  : '评估已完成，没有结果记录'
            }
          />
        ) : null
      ) : onlyFailed && visibleResults.length === 0 ? (
        <EmptyState
          variant="clear"
          scale="inline"
          title="本次评估全部用例均已通过"
          action={
            <Button variant="outline" size="sm" onClick={toggleFailed}>
              显示全部
            </Button>
          }
        />
      ) : (
        <ul>
          {visibleResults.map((result) => (
            <EvalResultRow
              key={result.caseId ?? `${result.name}\u0000${result.prompt}`}
              result={result}
              backTo={location.href}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
