import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { CodeBlock } from '../../components/code-block.js';
import { PageNote } from '../../components/page.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import { ApiError, api } from '../../lib/api.js';
import { downloadJson } from '../../lib/browser-files.js';
import { evalStatusLabel, evalStatusVariant } from '../../lib/format.js';
import { useEvalRun } from '../../lib/queries.js';
import { toastError } from '../../lib/toast.js';

export function EvalRunResults({ id }: { id: string }) {
  const detail = useEvalRun(id);
  const location = useLocation();
  const search = useSearch({ from: '/_shell/eval' });
  const navigate = useNavigate();
  const [exporting, setExporting] = useState(false);
  const onlyFailed = search.failedOnly === '1';

  // 只有从没拿到过详情时才整块报错；后台轮询/手动刷新失败要保留已有结果树。
  if (detail.isPending) return <LoadingState rows={2} />;
  if (!detail.data) {
    const missing = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <ErrorState
        error={detail.error}
        title={missing ? '这次评估运行不存在' : '内容没有加载出来'}
        onRetry={() => void detail.refetch()}
      />
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

  return (
    <>
      {detail.isError ? (
        <ErrorState
          error={detail.error}
          title="刷新失败，内容仍是上次结果"
          onRetry={() => void detail.refetch()}
        />
      ) : null}
      <div
        data-slot="eval-run-summary"
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-3 text-sm"
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
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
        <p className="text-xs text-muted-foreground">
          导出已记录结果；专家配置未固定，文件不构成完整复现包。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {failedCount > 0 ? (
            <Button
              variant="outline"
              size="sm"
              aria-pressed={onlyFailed}
              onClick={toggleFailed}
            >
              {onlyFailed ? '显示全部' : `只看未通过（${failedCount}）`}
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
      {evalRun.status === 'failed' ? (
        <PageNote
          tone="danger"
          title={results.length === 0 ? '评估失败，未生成结果' : '评估失败'}
          description={
            <span className="[overflow-wrap:anywhere]">
              {evalRun.error ?? '未提供失败原因。'} 请检查后重新运行评估。
            </span>
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
          <p className="text-sm text-muted-foreground">
            {running
              ? '正在逐个执行用例…'
              : evalRun.status === 'cancelled'
                ? '后续用例已停止，没有结果记录。'
                : '评估已完成，没有结果记录。'}
          </p>
        ) : null
      ) : onlyFailed && visibleResults.length === 0 ? (
        <p className="text-sm text-muted-foreground">本次评估没有未通过的用例。</p>
      ) : (
        <ul>
          {visibleResults.map((result) => (
            <li
              // 用例被删除后 caseId 为 null：退回「名称 + 提示词」，两者相同即同一条用例。
              key={result.caseId ?? `${result.name}\u0000${result.prompt}`}
              className="border-b py-4 last:border-b-0 last:pb-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={result.passed ? 'success' : 'danger'}>
                  {result.passed ? '通过' : '未通过'}
                </StatusBadge>
                <span className="min-w-0 text-md font-medium text-fg [overflow-wrap:anywhere]">
                  {result.name}
                </span>
                {result.runId ? (
                  <Link
                    to="/runs/$runId"
                    params={{ runId: result.runId }}
                    search={{ backTo: location.href }}
                    className="ml-auto text-sm text-fg underline underline-offset-4"
                  >
                    查看运行
                  </Link>
                ) : null}
              </div>
              <div className="mt-2 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                <div>
                  <div className="text-xs text-muted-foreground">Prompt</div>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
                    {result.prompt}
                  </p>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">期望</div>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
                    {result.expectation || '（只要求有文本输出）'}
                  </p>
                </div>
              </div>
              <div className="mt-2">
                <div className="text-xs text-muted-foreground">输出</div>
                <CodeBlock
                  code={result.output || '（空）'}
                  maxHeight="12rem"
                  className="mt-1"
                  copyLabel="复制输出"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
