import { evalDatasetSchema } from '@agentport/shared';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { CircleStop, Download, GitCompare, Pencil, Play, Plus, Trash2, Upload } from 'lucide-react';
import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { BusinessIllustration } from '../components/business-illustration.js';
import { CodeBlock } from '../components/code-block.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { DialogShell } from '../components/dialog-shell.js';
import { FilterSelect } from '../components/filter-select.js';
import { Page, PageHeader, PageNote, PageSection, PageToolbar } from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import { Dialog } from '../components/ui/dialog.js';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { Textarea } from '../components/ui/textarea.js';
import { hasAnyGrant } from '../lib/access.js';
import {
  ApiError,
  api,
  type EvalCase,
  type EvalCaseInput,
  type EvalResult,
  type EvalRun,
} from '../lib/api.js';
import { useFormBlocker } from '../lib/form.js';
import {
  evalComparisonStatusLabel,
  evalComparisonStatusVariant,
  evalStatusLabel,
  evalStatusVariant,
  formatDateTime,
  formatRelative,
  shortId,
} from '../lib/format.js';
import {
  useAgentAccess,
  useAgents,
  useCancelEvalRun,
  useCreateEvalCase,
  useDeleteEvalCase,
  useEvalCases,
  useEvalComparison,
  useEvalRun,
  useEvalRuns,
  useImportEvalDataset,
  useStartEvalRun,
  useUpdateEvalCase,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

const runColumns: DataColumn<EvalRun>[] = [
  {
    id: 'id',
    header: '评估 ID',
    locked: true,
    width: '110px',
    sortValue: (run) => run.id,
    cell: (run) => (
      <code className="font-mono text-xs text-muted-foreground" title={run.id}>
        {shortId(run.id)}
      </code>
    ),
  },
  {
    id: 'status',
    header: '状态',
    locked: true,
    width: '100px',
    sortValue: (run) => run.status,
    cell: (run) => (
      <StatusBadge tone={evalStatusVariant[run.status]}>
        {run.status === 'running' ? (
          <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
        ) : null}
        {evalStatusLabel[run.status]}
      </StatusBadge>
    ),
  },
  {
    id: 'passed',
    header: '通过 / 总数',
    numeric: true,
    width: '120px',
    sortValue: (run) => (run.total === 0 ? 0 : run.passed / run.total),
    cell: (run) => (
      <span className="font-mono tabular-nums">
        {run.passed} / {run.total}
      </span>
    ),
  },
  {
    id: 'createdAt',
    header: '发起',
    width: '96px',
    sortValue: (run) => run.createdAt,
    cell: (run) => (
      <span className="text-sm text-muted-foreground" title={formatDateTime(run.createdAt)}>
        {formatRelative(run.createdAt)}
      </span>
    ),
  },
  {
    id: 'error',
    header: '失败原因',
    width: '220px',
    hiddenByDefault: true,
    sortValue: (run) => run.error ?? '',
    cell: (run) =>
      run.error ? (
        <span className="block truncate text-sm text-danger" title={run.error}>
          {run.error}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: 'finishedAt',
    header: '结束',
    width: '96px',
    sortValue: (run) => run.finishedAt ?? '',
    cell: (run) => (
      <span className="text-sm text-muted-foreground" title={formatDateTime(run.finishedAt)}>
        {formatRelative(run.finishedAt)}
      </span>
    ),
  },
];

type EvalSearchPatch = {
  agent?: string | undefined;
  run?: string | undefined;
  base?: string | undefined;
  head?: string | undefined;
};

export function EvalPage() {
  const agents = useAgents();
  const navigate = useNavigate();
  // 专家、选中的运行和比较两侧都放在 URL 里：刷新、分享、前进后退都保留。
  const search = useSearch({ from: '/_shell/eval' });
  const agentId = search.agent ?? '';
  const selectedAgent = agentId
    ? agents.data?.find((agent) => agent.id === agentId)
    : agents.data?.[0];
  const effectiveAgentId = selectedAgent?.id ?? null;
  const access = useAgentAccess(effectiveAgentId);
  const permissions = access.data?.permissionIds ?? [];
  const accessPending = effectiveAgentId !== null && access.isPending;
  const accessFailed = effectiveAgentId !== null && access.isError && access.data === undefined;
  const canReadEval = hasAnyGrant(permissions, 'eval.read');
  const canManageEval = hasAnyGrant(permissions, 'eval.manage');
  const canExecuteEval = hasAnyGrant(permissions, 'eval.execute');
  const missingAgent = agents.isSuccess && Boolean(agentId) && !selectedAgent;
  const selectedRunId = search.run ?? null;
  const baseId = search.base ?? null;
  const headId = search.head ?? null;
  const compareOpen = baseId !== null && headId !== null && baseId !== headId;

  const setSearch = (patch: EvalSearchPatch): void => {
    void navigate({
      to: '/eval',
      search: { ...search, ...patch },
    });
  };
  const setAgentId = (next: string): void => {
    // 切专家时丢掉旧的运行/比较上下文，避免把别的专家的批次带过来。
    setSearch({ agent: next || undefined, run: undefined, base: undefined, head: undefined });
  };
  const selectRun = (runId: string): void => setSearch({ run: runId });
  const closeRun = (): void => setSearch({ run: undefined });

  const cases = useEvalCases(effectiveAgentId);
  const runs = useEvalRuns(effectiveAgentId);
  const runItems = runs.data?.pages.flatMap((page) => page.items) ?? [];
  const start = useStartEvalRun();
  const cancel = useCancelEvalRun();
  const importDataset = useImportEvalDataset();
  const importInputRef = useRef<HTMLInputElement>(null);

  const [exporting, setExporting] = useState(false);
  const [creatingAgentId, setCreatingAgentId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EvalCase | null>(null);
  const [deleting, setDeleting] = useState<EvalCase | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const compareButtonRef = useRef<HTMLButtonElement>(null);
  const dialogTriggerRef = useRef<HTMLButtonElement | null>(null);
  const finalFocus = (): HTMLButtonElement | null =>
    dialogTriggerRef.current?.isConnected ? dialogTriggerRef.current : createButtonRef.current;
  const compareFinalFocus = (): HTMLButtonElement | null =>
    compareButtonRef.current?.isConnected ? compareButtonRef.current : createButtonRef.current;

  const startRun = (): void => {
    if (!effectiveAgentId || startDisabledReason !== null) return;
    start.mutate(effectiveAgentId, {
      onSuccess: () => toastSuccess('评估已开始，结果会自动刷新'),
      onError: toastError,
    });
  };

  /** 只停止后续用例：不撤销已在执行的 run，也不打断模型调用。 */
  const runningRun = effectiveAgentId
    ? runItems.find((run) => run.status === 'running')
    : undefined;
  const stopRun = (): void => {
    if (!runningRun) return;
    cancel.mutate(runningRun.id, {
      onSuccess: () =>
        toastSuccess('已处理停止请求；运行已结束时保持原状态，当前用例可能仍在执行。'),
      onError: toastError,
    });
  };

  const exportJson = async (): Promise<void> => {
    if (!effectiveAgentId) return;
    setExporting(true);
    try {
      const data = await api.exportEvalDataset(effectiveAgentId);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'eval-cases.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      toastError(error);
    } finally {
      setExporting(false);
    }
  };

  const importJson = async (
    targetAgentId: string,
    targetAgentName: string,
    file: File,
  ): Promise<void> => {
    if (file.size > 1_048_576) {
      toastError(new Error('评估用例文件不能超过 1 MiB，请拆分后重试。'));
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      toastError(new Error('文件不是有效的 JSON，请选择由「导出 JSON」生成的用例文件。'));
      return;
    }
    const parsed = evalDatasetSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const at = first?.path.join('.');
      toastError(
        new Error(
          `文件格式不符合评估用例数据集${at ? `（${at}）` : ''}：${first?.message ?? '校验失败'}`,
        ),
      );
      return;
    }
    try {
      const result = await importDataset.mutateAsync({
        agentId: targetAgentId,
        dataset: parsed.data,
      });
      toastSuccess(
        `已向「${targetAgentName}」导入 ${result.imported} 条用例，跳过 ${result.skipped} 条`,
      );
      for (const warning of result.warnings) toast.info(warning);
    } catch (error) {
      toastError(error);
    }
  };

  const terminalRuns = runItems.filter((run) => run.status !== 'running');
  const compareHead = terminalRuns[0];
  const compareBase = terminalRuns[1];
  const openCompare = (): void => {
    if (!compareBase || !compareHead) return;
    // runs 按创建时间倒序：默认比较前一次与最新一次。
    setSearch({ base: compareBase.id, head: compareHead.id });
  };
  const closeCompare = (): void => setSearch({ base: undefined, head: undefined });
  const startDisabledReason = start.isPending
    ? '正在启动评估'
    : runningRun
      ? '已有评估正在运行，请等待结束或先停止'
      : agents.isPending
        ? '专家加载中，稍后再试'
        : agents.isError
          ? '专家加载失败，请重试'
          : missingAgent
            ? '所选专家不存在，请清除筛选或重新选择'
            : !effectiveAgentId
              ? '先创建一个专家'
              : accessPending
                ? '正在检查评估权限，稍后再试'
                : accessFailed
                  ? '评估权限加载失败，请重试'
                  : !canExecuteEval
                    ? '当前账户没有执行该专家评估的权限'
                    : cases.isPending
                      ? '用例加载中，稍后再试'
                      : cases.isError
                        ? '用例加载失败，请重试'
                        : cases.data.length === 0
                          ? '先新建至少一个用例'
                          : null;

  const agentOptions = (agents.data ?? []).map((agent) => ({ value: agent.id, label: agent.name }));

  return (
    <Page>
      <PageHeader
        title="评估"
        actions={
          <>
            {runningRun && canExecuteEval ? (
              <Button
                variant="outline"
                onClick={stopRun}
                disabled={cancel.isPending}
                aria-busy={cancel.isPending}
              >
                <CircleStop data-icon="inline-start" aria-hidden="true" />
                {cancel.isPending ? '停止中…' : '停止后续用例'}
              </Button>
            ) : null}
            {canExecuteEval ? (
              <Button
                onClick={startRun}
                disabled={startDisabledReason !== null}
                aria-busy={start.isPending}
                aria-describedby={startDisabledReason ? 'eval-start-reason' : undefined}
              >
                <Play data-icon="inline-start" aria-hidden="true" />
                {start.isPending ? '启动中…' : '运行评估'}
              </Button>
            ) : null}
          </>
        }
      />

      <PageToolbar>
        <FilterSelect
          value={effectiveAgentId ?? ''}
          onValueChange={setAgentId}
          options={agentOptions}
          label="按专家筛选"
          className="w-full sm:w-36"
        />
        {startDisabledReason ? (
          <span id="eval-start-reason" className="text-sm text-muted-foreground">
            {startDisabledReason}
          </span>
        ) : null}
        {runningRun ? (
          <span className="text-sm text-muted-foreground">
            当前用例可能继续执行；停止后不再开始后续用例。
          </span>
        ) : null}
      </PageToolbar>

      {access.isError ? (
        <ErrorState
          error={access.error}
          title={access.data === undefined ? '评估权限没有加载出来' : '权限刷新失败，保留上次结果'}
          onRetry={() => void access.refetch()}
        />
      ) : null}

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <PageSection
          title="用例维护"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={importInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  // 先清空 value，同一个文件重试时才会再次触发 change。
                  event.target.value = '';
                  if (!file || !effectiveAgentId || !selectedAgent) return;
                  // 目标专家在选文件时确定：解析期间切换筛选不会把用例导到别人名下。
                  const targetId = effectiveAgentId;
                  const targetName = selectedAgent.name;
                  void importJson(targetId, targetName, file);
                }}
              />
              {canManageEval ? (
                <Button
                  variant="outline"
                  disabled={!effectiveAgentId || importDataset.isPending}
                  aria-busy={importDataset.isPending}
                  onClick={() => importInputRef.current?.click()}
                >
                  <Upload data-icon="inline-start" aria-hidden="true" />{' '}
                  {importDataset.isPending ? '导入中…' : '导入 JSON'}
                </Button>
              ) : null}
              {canReadEval ? (
                <Button
                  variant="outline"
                  disabled={!effectiveAgentId || exporting}
                  aria-busy={exporting}
                  onClick={() => void exportJson()}
                >
                  <Download data-icon="inline-start" aria-hidden="true" />{' '}
                  {exporting ? '导出中…' : '导出 JSON'}
                </Button>
              ) : null}
              {canManageEval ? (
                <Button
                  variant="outline"
                  ref={createButtonRef}
                  disabled={!effectiveAgentId}
                  onClick={(event) => {
                    dialogTriggerRef.current = event.currentTarget;
                    setCreatingAgentId(effectiveAgentId);
                  }}
                >
                  <Plus data-icon="inline-start" aria-hidden="true" /> 新建用例
                </Button>
              ) : null}
            </div>
          }
        >
          {agents.isPending ? <LoadingState rows={3} /> : null}
          {agents.isError ? (
            <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
          ) : null}
          {missingAgent ? (
            <PageNote
              title="所选专家不存在"
              description="链接中的专家可能已删除，请清除筛选或重新选择专家。"
              action={
                <Button variant="outline" size="sm" onClick={() => setAgentId('')}>
                  清除专家筛选
                </Button>
              }
            />
          ) : null}
          {agents.isSuccess && !missingAgent && !effectiveAgentId ? (
            <PageNote
              icon={<BusinessIllustration name="agents" size="compact" />}
              title="还没有专家"
              action={
                <Link to="/agents" className="text-sm text-fg underline underline-offset-4">
                  前往创建专家
                </Link>
              }
            />
          ) : null}
          {cases.isPending && effectiveAgentId ? <LoadingState rows={3} /> : null}
          {effectiveAgentId && cases.isError ? (
            <ErrorState error={cases.error} onRetry={() => void cases.refetch()} />
          ) : null}
          {effectiveAgentId && cases.isSuccess && cases.data.length === 0 ? (
            <PageNote
              icon={<BusinessIllustration name="review" size="compact" />}
              title="还没有用例"
              action={
                canManageEval ? (
                  <Button
                    variant="outline"
                    onClick={(event) => {
                      dialogTriggerRef.current = event.currentTarget;
                      setCreatingAgentId(effectiveAgentId);
                    }}
                  >
                    <Plus data-icon="inline-start" aria-hidden="true" /> 新建用例
                  </Button>
                ) : undefined
              }
            />
          ) : null}
          {effectiveAgentId && cases.data && cases.data.length > 0 ? (
            <ul>
              {cases.data.map((testCase) => (
                <li
                  key={testCase.id}
                  className="group flex min-h-14 items-start gap-3 border-b px-2.5 py-3.5 transition-colors duration-150 last:border-b-0 hover:bg-hover"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-md font-medium text-fg [overflow-wrap:anywhere]">
                      {testCase.name}
                    </div>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                      {testCase.prompt}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {testCase.expectation
                        ? `期望包含：${testCase.expectation}`
                        : '期望为空：只要求有文本输出'}
                    </p>
                  </div>
                  {canManageEval ? (
                    <div className="flex shrink-0 gap-1 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:transition-opacity [@media(hover:hover)_and_(pointer:fine)]:duration-150 ease-out-soft group-hover:opacity-100 group-focus-within:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={(event) => {
                          dialogTriggerRef.current = event.currentTarget;
                          setEditing(testCase);
                        }}
                      >
                        <span className="sr-only">编辑 {testCase.name}</span>
                        <Pencil className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={(event) => {
                          dialogTriggerRef.current = event.currentTarget;
                          setDeleting(testCase);
                        }}
                      >
                        <span className="sr-only">删除 {testCase.name}</span>
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </PageSection>

        <PageSection
          title="运行历史"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {terminalRuns.length < 2 ? (
                <span className="text-xs text-muted-foreground">至少需要两次已结束的运行</span>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                ref={compareButtonRef}
                disabled={terminalRuns.length < 2}
                title={terminalRuns.length < 2 ? '至少需要两次已结束的运行' : undefined}
                onClick={openCompare}
              >
                <GitCompare data-icon="inline-start" aria-hidden="true" /> 比较运行
              </Button>
            </div>
          }
        >
          {agents.isPending ? <LoadingState rows={3} /> : null}
          {!effectiveAgentId && !agents.isPending ? (
            <p className="text-sm text-muted-foreground">
              {agents.isError
                ? '专家加载失败，请重试后查看运行历史。'
                : '选择有效的专家后查看运行历史。'}
            </p>
          ) : null}
          {effectiveAgentId && runs.isError && !runs.isFetchNextPageError ? (
            <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
          ) : null}
          {runs.isPending && effectiveAgentId ? <LoadingState rows={3} /> : null}
          {effectiveAgentId && runs.isSuccess && runItems.length === 0 ? (
            <PageNote
              icon={<BusinessIllustration name="runs" size="compact" />}
              title="还没有评估运行"
              description="点「运行评估」开始。"
            />
          ) : null}
          {effectiveAgentId && runItems.length > 0 ? (
            <>
              <DataTable
                rows={runItems}
                columns={runColumns}
                rowKey={(run) => run.id}
                rowLabel={(run) => `${formatDateTime(run.createdAt)} · ${shortId(run.id)}`}
                label="评估运行"
                storageKey="agentport.eval-runs.columns"
                onRowClick={(run) => selectRun(run.id)}
              />
              {runs.isFetchNextPageError ? (
                <ErrorState
                  error={runs.error}
                  onRetry={() => void runs.fetchNextPage()}
                  title="下一页加载失败，保留已加载的运行记录"
                />
              ) : runs.hasNextPage ? (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={runs.isFetchingNextPage}
                    aria-busy={runs.isFetchingNextPage}
                    onClick={() => void runs.fetchNextPage()}
                  >
                    {runs.isFetchingNextPage ? '加载中…' : '加载更多'}
                  </Button>
                </div>
              ) : (
                <div className="text-center text-xs text-muted-foreground">已到末尾</div>
              )}
            </>
          ) : null}
        </PageSection>
      </div>

      {selectedRunId ? (
        <PageSection
          title="运行结果"
          description={`评估 ${shortId(selectedRunId)}`}
          actions={
            <Button variant="outline" size="sm" onClick={closeRun}>
              返回历史
            </Button>
          }
        >
          <EvalRunResults id={selectedRunId} />
        </PageSection>
      ) : null}

      {creatingAgentId ? (
        <CaseDialog
          agentId={creatingAgentId}
          finalFocus={finalFocus}
          onClose={() => setCreatingAgentId(null)}
        />
      ) : null}
      {editing ? (
        <CaseDialog testCase={editing} finalFocus={finalFocus} onClose={() => setEditing(null)} />
      ) : null}
      {deleting ? (
        <DeleteCaseDialog
          testCase={deleting}
          finalFocus={finalFocus}
          onClose={() => setDeleting(null)}
        />
      ) : null}
      {compareOpen ? (
        <CompareDialog
          baseId={baseId ?? ''}
          headId={headId ?? ''}
          runs={terminalRuns}
          onChange={setSearch}
          finalFocus={compareFinalFocus}
          onClose={closeCompare}
        />
      ) : null}
    </Page>
  );
}

function EvalRunResults({ id }: { id: string }) {
  const detail = useEvalRun(id);
  const location = useLocation();
  const [exporting, setExporting] = useState(false);

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
  const running = evalRun.status === 'running';
  const executed = results.length;
  const pending = Math.max(0, evalRun.total - executed);

  const download = async (): Promise<void> => {
    setExporting(true);
    try {
      const data = await api.exportEvalRun(id);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'eval-result.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
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
          {running ? (
            <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
          ) : null}
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
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
        <p className="text-xs text-muted-foreground">
          导出已记录结果；专家配置未固定，文件不构成完整复现包。
        </p>
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
                ? '后续用例已停止，还没有结果记录。'
                : '评估已完成，没有结果记录。'}
          </p>
        ) : null
      ) : (
        <ul>
          {results.map((result) => (
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
              <div className="mt-2 grid gap-x-8 gap-y-2 text-sm leading-relaxed sm:grid-cols-2">
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

function CompareDialog({
  baseId,
  headId,
  runs,
  onChange,
  onClose,
  finalFocus,
}: {
  baseId: string;
  headId: string;
  runs: EvalRun[];
  onChange: (patch: EvalSearchPatch) => void;
  onClose: () => void;
  finalFocus: ComponentProps<typeof DialogShell>['finalFocus'];
}) {
  const comparison = useEvalComparison(baseId, headId);

  const runLabel = (run: EvalRun): string =>
    `${shortId(run.id)} · ${evalStatusLabel[run.status]} · ${formatDateTime(run.createdAt)}`;
  const withSelected = (
    options: { value: string; label: string }[],
    selectedId: string,
  ): { value: string; label: string }[] =>
    options.some((option) => option.value === selectedId)
      ? options
      : [{ value: selectedId, label: `${shortId(selectedId)} · 不在当前列表` }, ...options];
  // 两侧都排除对方已选中的运行，从源头上避免自己和自己比较。
  const baseOptions = withSelected(
    runs.filter((run) => run.id !== headId).map((run) => ({ value: run.id, label: runLabel(run) })),
    baseId,
  );
  const headOptions = withSelected(
    runs.filter((run) => run.id !== baseId).map((run) => ({ value: run.id, label: runLabel(run) })),
    headId,
  );

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogShell
        title="比较评估运行"
        description="只比较相同冻结输入的结果；单边记录也可能是批次未执行完成，不代表用例增删。专家配置未固定，不构成完整可复现的结论。"
        finalFocus={finalFocus}
        className="sm:max-w-[900px]"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs text-muted-foreground">基准运行</span>
            <FilterSelect
              value={baseId}
              onValueChange={(next) => onChange({ base: next })}
              options={baseOptions}
              label="基准运行"
              className="w-full"
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs text-muted-foreground">对比运行</span>
            <FilterSelect
              value={headId}
              onValueChange={(next) => onChange({ head: next })}
              options={headOptions}
              label="对比运行"
              className="w-full"
            />
          </div>
        </div>

        <div className="mt-4 border-t pt-4">
          {comparison.isPending ? <LoadingState rows={3} /> : null}
          {comparison.isError ? (
            <>
              <ErrorState error={comparison.error} onRetry={() => void comparison.refetch()} />
              <div className="mt-2 flex justify-end">
                <Button variant="outline" size="sm" onClick={onClose}>
                  返回历史
                </Button>
              </div>
            </>
          ) : null}
          {comparison.isSuccess && comparison.data.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">两次运行都没有结果记录，无法比较。</p>
          ) : null}
          {comparison.isSuccess && comparison.data.rows.length > 0 ? (
            <ul className="flex flex-col gap-4">
              {comparison.data.rows.map((row) => (
                <li key={row.key} className="border-b pb-4 last:border-b-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={evalComparisonStatusVariant[row.status]}>
                      {evalComparisonStatusLabel[row.status]}
                    </StatusBadge>
                    <span className="min-w-0 truncate text-md font-medium text-fg">
                      {row.base?.name ?? row.head?.name ?? '—'}
                    </span>
                  </div>
                  <div className="mt-2 grid gap-x-8 gap-y-3 text-sm leading-relaxed sm:grid-cols-2">
                    <CompareSide
                      title="基准"
                      result={row.base}
                      showPass={row.status !== 'changed_inputs' && row.status !== 'unverified'}
                    />
                    <CompareSide
                      title="对比"
                      result={row.head}
                      showPass={row.status !== 'changed_inputs' && row.status !== 'unverified'}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </DialogShell>
    </Dialog>
  );
}

function CompareSide({
  title,
  result,
  showPass,
}: {
  title: string;
  result: EvalResult | null;
  showPass: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground">
        {title}
        {showPass && result ? (
          <StatusBadge tone={result.passed ? 'success' : 'danger'}>
            {result.passed ? '通过' : '未通过'}
          </StatusBadge>
        ) : null}
      </div>
      {result ? (
        <>
          <div className="mt-2 text-xs text-muted-foreground">Prompt</div>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
            {result.prompt}
          </p>
          <div className="mt-2 text-xs text-muted-foreground">期望</div>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
            {result.expectation || '（只要求有文本输出）'}
          </p>
          <div className="mt-2 text-xs text-muted-foreground">输出</div>
          <CodeBlock
            code={result.output || '（空）'}
            maxHeight="10rem"
            className="mt-1"
            copyLabel={`复制${title}输出`}
          />
        </>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          这次运行没有记录结果，可能未执行或用例不在批次中。
        </p>
      )}
    </div>
  );
}

const evalCaseFormSchema = z.object({
  name: z.string().trim().min(1, '名称需要填写。').max(128, '名称不能超过 128 字。'),
  prompt: z.string().min(1, '输入需要填写。').max(20_000, '输入不能超过 20,000 字。'),
  expectation: z.string().max(5_000, '期望不能超过 5,000 字。'),
});

function CaseDialog({
  agentId,
  testCase,
  onClose,
  finalFocus,
}: {
  agentId?: string;
  testCase?: EvalCase;
  onClose: () => void;
  finalFocus: ComponentProps<typeof DialogShell>['finalFocus'];
}) {
  const create = useCreateEvalCase();
  const update = useUpdateEvalCase();
  const { register, handleSubmit, watch, formState } = useZodForm(evalCaseFormSchema, {
    defaultValues: testCase
      ? { name: testCase.name, prompt: testCase.prompt, expectation: testCase.expectation }
      : { name: '', prompt: '', expectation: '' },
  });
  const { errors, isDirty } = formState;
  const values = watch();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = isDirty;

  const submit = handleSubmit((form) => {
    if (pending) return;
    const input: EvalCaseInput = {
      agentId: agentId ?? testCase?.agentId ?? '',
      ...form,
    };
    const done = (): void => {
      toastSuccess(testCase ? '用例已更新' : '用例已创建');
      finish();
    };
    if (testCase) {
      update.mutate(
        {
          id: testCase.id,
          input: { name: input.name, prompt: input.prompt, expectation: input.expectation },
        },
        { onSuccess: done, onError: toastError },
      );
    } else {
      create.mutate(input, { onSuccess: done, onError: toastError });
    }
  });

  const pending = create.isPending || update.isPending;
  const blocker = useFormBlocker(dirty, pending);
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);
  // 关闭会卸载编辑器并摘掉 blocker：先取消期间被拦下的离开，否则它的 resolver 一直挂着。
  const finish = (): void => {
    blockerRef.current.reset?.();
    onClose();
  };
  const close = (): void => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else finish();
  };

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) close();
      }}
    >
      <DialogShell
        title={testCase ? '编辑用例' : '新建用例'}
        description="运行评估时，每个用例都会发起一次真实运行。"
        closeDisabled={pending}
        finalFocus={finalFocus}
      >
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup className="gap-4">
            <Field className="gap-1.5" data-invalid={Boolean(errors.name)} data-disabled={pending}>
              <FieldLabel htmlFor="eval-name">
                名称 <RequiredMark />
              </FieldLabel>
              <Input
                {...register('name')}
                value={values.name}
                id="eval-name"
                disabled={pending}
                required
                aria-required="true"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'eval-name-error' : undefined}
                placeholder="例如：拒绝编造不存在的工具"
              />
              <FieldError id="eval-name-error">{errors.name?.message}</FieldError>
            </Field>
            <Field
              className="gap-1.5"
              data-invalid={Boolean(errors.prompt)}
              data-disabled={pending}
            >
              <FieldLabel htmlFor="eval-prompt">
                输入 <RequiredMark />
              </FieldLabel>
              <Textarea
                {...register('prompt')}
                value={values.prompt}
                id="eval-prompt"
                disabled={pending}
                required
                aria-required="true"
                rows={5}
                aria-invalid={Boolean(errors.prompt)}
                aria-describedby={errors.prompt ? 'eval-prompt-error' : undefined}
                placeholder="发送给专家的完整输入"
              />
              <FieldError id="eval-prompt-error">{errors.prompt?.message}</FieldError>
            </Field>
            <Field
              className="gap-1.5"
              data-invalid={Boolean(errors.expectation)}
              data-disabled={pending}
            >
              <FieldLabel htmlFor="eval-expectation">期望包含</FieldLabel>
              <Textarea
                {...register('expectation')}
                value={values.expectation}
                id="eval-expectation"
                disabled={pending}
                rows={2}
                aria-invalid={Boolean(errors.expectation)}
                aria-describedby={
                  errors.expectation
                    ? 'eval-expectation-error eval-expectation-description'
                    : 'eval-expectation-description'
                }
                placeholder="输出中应出现的文本（不区分大小写）；留空则只要求有文本输出"
              />
              <FieldDescription id="eval-expectation-description">
                最小判定，不做语义判断；需要更严格时写更具体的片段。
              </FieldDescription>
              <FieldError id="eval-expectation-error">{errors.expectation?.message}</FieldError>
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={pending} aria-busy={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后这条用例的修改会丢失。"
          confirmLabel="放弃并关闭"
          confirmDisabled={pending}
          onConfirm={async () => {
            if (!pending) finish();
          }}
        />
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title="放弃未保存的更改？"
          description={pending ? '正在保存，请等待请求完成。' : '离开后这条用例的修改会丢失。'}
          confirmLabel="放弃并离开"
          confirmDisabled={pending}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}

function DeleteCaseDialog({
  testCase,
  onClose,
  finalFocus,
}: {
  testCase: EvalCase;
  onClose: () => void;
  finalFocus: ComponentProps<typeof ConfirmDialog>['finalFocus'];
}) {
  const remove = useDeleteEvalCase();
  return (
    <ConfirmDialog
      open
      title="删除用例"
      description={`将删除「${testCase.name}」，后续评估不再执行此用例；已有的历史评估结果会保留。`}
      onClose={onClose}
      finalFocus={finalFocus}
      onConfirm={async () => {
        await remove.mutateAsync(testCase.id);
        toastSuccess('用例已删除');
      }}
    />
  );
}
