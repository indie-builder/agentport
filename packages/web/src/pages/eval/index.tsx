import { evalDatasetSchema } from '@agentport/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { CircleStop, Download, GitCompare, Pencil, Play, Plus, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { BusinessIllustration } from '../../components/business-illustration.js';
import { type DataColumn, DataTable } from '../../components/data-table.js';
import { FilterSelect } from '../../components/filter-select.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageSection,
  PageToolbar,
  PageTopbar,
} from '../../components/page.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import { hasAnyGrant } from '../../lib/access.js';
import { api, type EvalCase, type EvalRun } from '../../lib/api.js';
import { downloadJson } from '../../lib/browser-files.js';
import {
  evalStatusLabel,
  evalStatusVariant,
  formatDateTime,
  formatRelative,
  shortId,
} from '../../lib/format.js';
import {
  useAgentAccess,
  useCancelEvalRun,
  useEvalCases,
  useEvalRuns,
  useExperts,
  useImportEvalDataset,
  useStartEvalRun,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { CaseDialog } from './case-dialog.js';
import { CompareDialog } from './compare-dialog.js';
import { DeleteCaseDialog } from './delete-case-dialog.js';
import { EvalPassRateChart } from './pass-rate-chart.js';
import { EvalRunResults } from './run-results.js';
import type { EvalSearchPatch } from './shared.js';

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
          <span className="size-1.5 rounded-full bg-fg" aria-hidden="true" />
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

export function EvalPage() {
  const agents = useExperts();
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
  const casesEmpty = cases.isSuccess && cases.data.length === 0;
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
      downloadJson(data, 'eval-cases.json');
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
                        : casesEmpty
                          ? '先新建至少一个用例'
                          : null;

  const agentOptions = (agents.data ?? []).map((agent) => ({ value: agent.id, label: agent.name }));
  const createCaseButton = canManageEval ? (
    <Button
      variant="outline"
      size="sm"
      ref={createButtonRef}
      disabled={!effectiveAgentId}
      onClick={(event) => {
        dialogTriggerRef.current = event.currentTarget;
        setCreatingAgentId(effectiveAgentId);
      }}
    >
      <Plus data-icon="inline-start" aria-hidden="true" /> 新建用例
    </Button>
  ) : null;

  return (
    <Page>
      <PageTopbar>
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
      </PageTopbar>

      <PageBody>
        {access.isError ? (
          <ErrorState
            error={access.error}
            title={
              access.data === undefined ? '评估权限没有加载出来' : '权限刷新失败，保留上次结果'
            }
            onRetry={() => void access.refetch()}
          />
        ) : null}

        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <PageSection
            title="用例维护"
            divided={false}
            className="[&>div:first-child]:items-center"
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
                    size="sm"
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
                    size="sm"
                    disabled={!effectiveAgentId || exporting}
                    aria-busy={exporting}
                    onClick={() => void exportJson()}
                  >
                    <Download data-icon="inline-start" aria-hidden="true" />{' '}
                    {exporting ? '导出中…' : '导出 JSON'}
                  </Button>
                ) : null}
                {casesEmpty ? null : createCaseButton}
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
                title="专家列表为空"
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
            {effectiveAgentId && casesEmpty ? (
              <PageNote
                icon={<BusinessIllustration name="review" size="compact" />}
                title="用例为空"
                action={createCaseButton}
              />
            ) : null}
            {effectiveAgentId && cases.data && cases.data.length > 0 ? (
              <ul>
                {cases.data.map((testCase) => (
                  <li
                    key={testCase.id}
                    className="group flex min-h-14 items-start gap-3 border-b px-2.5 py-3.5 transition-colors duration-150 ease-out-soft last:border-b-0 hover:bg-hover"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-md font-medium text-fg [overflow-wrap:anywhere]">
                        {testCase.name}
                      </div>
                      <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">
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
                          <Pencil aria-hidden="true" />
                        </Button>
                        <Button
                          variant="destructive"
                          size="icon-sm"
                          onClick={(event) => {
                            dialogTriggerRef.current = event.currentTarget;
                            setDeleting(testCase);
                          }}
                        >
                          <span className="sr-only">删除 {testCase.name}</span>
                          <Trash2 aria-hidden="true" />
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
            className="xl:border-t-0 xl:pt-0 [&>div:first-child]:items-center"
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
                title="评估尚未运行"
                description={
                  cases.isSuccess && !casesEmpty && canExecuteEval
                    ? '点「运行评估」开始。'
                    : undefined
                }
              />
            ) : null}
            {effectiveAgentId && runItems.length > 0 ? (
              <>
                <EvalPassRateChart runs={runItems} />
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
      </PageBody>

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

export { buildEvalPassRatePoints, EvalPassRateChart } from './pass-rate-chart.js';
