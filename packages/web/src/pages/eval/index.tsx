import { evalDatasetSchema } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { CircleStop, Play } from 'lucide-react';
import { useRef, useState } from 'react';
import { FilterSelect } from '../../components/filter-select.js';
import { Page, PageBody, PageHeader, PageTopbar } from '../../components/page.js';
import { EvalFromRunDialog } from '../../components/run/eval-from-run-dialog.js';
import { ErrorState } from '../../components/states.js';
import { Button } from '../../components/ui/button.js';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { can, hasAnyGrant } from '../../lib/access.js';
import { api, type EvalCase, type EvalSampleCandidate, type EvalTarget } from '../../lib/api.js';
import { downloadJson } from '../../lib/browser-files.js';
import { cn } from '../../lib/cn.js';
import {
  meQuery,
  useAgentAccess,
  useAgentDetail,
  useCancelEvalRun,
  useEvalCases,
  useEvalRuns,
  useExperts,
  useImportEvalDataset,
  useStartEvalRun,
} from '../../lib/queries.js';
import { toast, toastError, toastSuccess } from '../../lib/toast.js';
import { CaseDialog } from './case-dialog.js';
import { EvalCasesTab } from './cases-tab.js';
import { EvalCompareTab } from './compare-tab.js';
import { DeleteCaseDialog } from './delete-case-dialog.js';
import { EvalRunsTab } from './runs-tab.js';
import { SampleRunsDialog } from './sample-runs-dialog.js';
import type { EvalSearchPatch, EvalTab } from './shared.js';

export function EvalPage() {
  const agents = useExperts();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/eval' });
  const agentId = search.agent ?? '';
  const selectedAgent = agentId
    ? agents.data?.find((agent) => agent.id === agentId)
    : agents.data?.[0];
  const effectiveAgentId = selectedAgent?.id ?? null;
  const me = useQuery(meQuery);
  const access = useAgentAccess(effectiveAgentId);
  const permissions = access.data?.permissionIds ?? [];
  const accessPending = effectiveAgentId !== null && access.isPending;
  const accessFailed = effectiveAgentId !== null && access.isError && access.data === undefined;
  const canReadEval = hasAnyGrant(permissions, 'eval.read');
  const canManageEval = hasAnyGrant(permissions, 'eval.manage');
  const canExecuteEval = hasAnyGrant(permissions, 'eval.execute');
  const canReadRuns = can(me.data, 'runs.read');
  const canReadConfig = hasAnyGrant(permissions, 'agents.config.read');
  const agentDetail = useAgentDetail(effectiveAgentId, canReadConfig);
  const hasDraft = agentDetail.data?.hasDraft === true;
  const missingPublished =
    agentDetail.data !== undefined && agentDetail.data.publishedVersion == null;
  const [target, setTarget] = useState<EvalTarget>('published');
  const missingAgent = agents.isSuccess && Boolean(agentId) && !selectedAgent;
  const selectedRunId = search.run ?? null;
  const selectedCaseId = search.caseId ?? null;
  const baseId = search.base ?? null;
  const headId = search.head ?? null;
  const activeTab: EvalTab =
    search.tab ?? (baseId !== null && headId !== null && baseId !== headId ? 'compare' : 'runs');
  const diffFilter = search.diff ?? 'changed';

  const setSearch = (patch: EvalSearchPatch): void => {
    void navigate({
      to: '/eval',
      search: { ...search, ...patch },
    });
  };

  const setAgentId = (next: string): void => {
    if (next === (effectiveAgentId ?? '') && !missingAgent) return;
    setSearch({
      agent: next || undefined,
      run: undefined,
      caseId: undefined,
      base: undefined,
      head: undefined,
      failedOnly: undefined,
    });
  };

  const selectRun = (runId: string): void => setSearch({ run: runId, failedOnly: undefined });
  const clearRunSelection = (): void => setSearch({ run: undefined, failedOnly: undefined });
  const selectCase = (caseId: string): void => setSearch({ caseId });

  const cases = useEvalCases(effectiveAgentId);
  const caseItems = cases.data?.pages.flatMap((page) => page.items) ?? [];
  const casesEmpty = cases.isSuccess && caseItems.length === 0;
  const runs = useEvalRuns(effectiveAgentId);
  const runItems = runs.data?.pages.flatMap((page) => page.items) ?? [];
  const start = useStartEvalRun();
  const cancel = useCancelEvalRun();
  const importDataset = useImportEvalDataset();
  const importInputRef = useRef<HTMLInputElement>(null);

  const [exporting, setExporting] = useState(false);
  const [creatingAgentId, setCreatingAgentId] = useState<string | null>(null);
  const [samplingAgentId, setSamplingAgentId] = useState<string | null>(null);
  const [sampleCandidate, setSampleCandidate] = useState<EvalSampleCandidate | null>(null);
  const [editing, setEditing] = useState<EvalCase | null>(null);
  const [deleting, setDeleting] = useState<EvalCase | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const finalFocus = (): HTMLElement | null =>
    dialogTriggerRef.current?.isConnected ? dialogTriggerRef.current : createButtonRef.current;

  const runningRun = effectiveAgentId
    ? runItems.find((run) => run.status === 'running')
    : undefined;

  const terminalRuns = runItems.filter((run) => run.status !== 'running');
  const compareHead = terminalRuns[0];
  const compareBase = terminalRuns[1];

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
              : target === 'published' && missingPublished
                ? '该专家尚未发布，请先发布或选择当前草稿'
                : accessPending
                  ? '正在检查评估权限，稍后再试'
                  : accessFailed
                    ? '评估权限加载失败，请重试'
                    : !canExecuteEval
                      ? '当前账户没有执行该专家评估的权限'
                      : cases.isPending
                        ? '用例加载中，稍后再试'
                        : cases.isError && !cases.isFetchNextPageError
                          ? '用例加载失败，请重试'
                          : casesEmpty
                            ? '先新建至少一个用例'
                            : null;

  const startRun = (): void => {
    if (!effectiveAgentId || startDisabledReason !== null) return;
    start.mutate(
      { agentId: effectiveAgentId, target },
      {
        onSuccess: () => toastSuccess('评估已开始，结果会自动刷新'),
        onError: toastError,
      },
    );
  };

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

  const openCompareLatest = (): void => {
    if (!compareBase || !compareHead) return;
    setSearch({ tab: 'compare', base: compareBase.id, head: compareHead.id });
  };

  const backToRuns = (): void => {
    setSearch({ tab: 'runs', base: undefined, head: undefined, diff: undefined });
  };

  const agentOptions = (agents.data ?? []).map((agent) => ({ value: agent.id, label: agent.name }));

  const openCreateCase = (trigger: HTMLElement): void => {
    dialogTriggerRef.current = trigger;
    setCreatingAgentId(effectiveAgentId);
  };

  const openSampleRuns = (trigger: HTMLElement): void => {
    dialogTriggerRef.current = trigger;
    setSamplingAgentId(effectiveAgentId);
  };

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          title="评估"
          eyebrow={
            <div className="flex flex-wrap items-center gap-2">
              <FilterSelect
                value={effectiveAgentId ?? ''}
                onValueChange={setAgentId}
                options={agentOptions}
                label="按专家筛选"
                className="w-40"
              />
              <fieldset
                aria-label="评估目标"
                className="inline-flex items-center rounded-pill border-0 bg-sunken p-0.5"
              >
                <button
                  type="button"
                  aria-pressed={target === 'published'}
                  onClick={() => setTarget('published')}
                  className={cn(
                    'rounded-pill px-2.5 py-1 text-xs font-medium transition-colors duration-150 ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    target === 'published'
                      ? 'bg-surface text-fg shadow-sm'
                      : 'text-muted-foreground hover:text-fg',
                  )}
                >
                  线上版本
                </button>
                <button
                  type="button"
                  aria-pressed={target === 'draft'}
                  onClick={() => setTarget('draft')}
                  className={cn(
                    'rounded-pill px-2.5 py-1 text-xs font-medium transition-colors duration-150 ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    target === 'draft'
                      ? 'bg-surface text-fg shadow-sm'
                      : 'text-muted-foreground hover:text-fg',
                  )}
                >
                  当前草稿
                  {hasDraft ? <span className="ml-1 text-muted-foreground">· 有改动</span> : null}
                </button>
              </fieldset>
            </div>
          }
          actions={
            <>
              {runningRun ? (
                <span className="text-xs text-muted-foreground">
                  当前用例可能继续执行；停止后不再开始后续用例。
                </span>
              ) : null}
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
              {startDisabledReason ? (
                <span id="eval-start-reason" className="text-xs text-muted-foreground">
                  {startDisabledReason}
                </span>
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

        <div className="border-b">
          <Tabs<EvalTab> value={activeTab} onValueChange={(next) => setSearch({ tab: next })}>
            <TabsList variant="line">
              <TabsTrigger value="runs">
                {runningRun ? (
                  <span className="size-1.5 rounded-full bg-fg" aria-hidden="true" />
                ) : null}
                评估运行
                {effectiveAgentId && runs.isSuccess ? (
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {runItems.length}
                    {runs.hasNextPage ? '+' : ''}
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="cases">
                用例集
                {effectiveAgentId && cases.isSuccess ? (
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {caseItems.length}
                    {cases.hasNextPage ? '+' : ''}
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="compare">运行对比</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
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

        {activeTab === 'runs' ? (
          <EvalRunsTab
            agentsPending={agents.isPending}
            agentsError={agents.isError}
            agentsErrorValue={agents.error}
            onRetryAgents={() => void agents.refetch()}
            missingAgent={missingAgent}
            onClearAgent={() => setAgentId('')}
            effectiveAgentId={effectiveAgentId}
            runsPending={runs.isPending}
            runsError={runs.isError}
            runsErrorValue={runs.error}
            runsIsFetchNextPageError={runs.isFetchNextPageError}
            runsSuccess={runs.isSuccess}
            runsHasNextPage={runs.hasNextPage}
            runsFetchingNextPage={runs.isFetchingNextPage}
            onRetryRuns={() => void runs.refetch()}
            onFetchNextRuns={() => void runs.fetchNextPage()}
            runItems={runItems}
            caseItems={caseItems}
            casesSuccess={cases.isSuccess}
            casesEmpty={casesEmpty}
            casesHasNextPage={cases.hasNextPage}
            canManageEval={canManageEval}
            canExecuteEval={canExecuteEval}
            canReadRuns={canReadRuns}
            selectedRunId={selectedRunId}
            onSelectRun={selectRun}
            onClearRunSelection={clearRunSelection}
            onCompareLatest={openCompareLatest}
            onOpenCreateCase={openCreateCase}
            onOpenSampleRuns={openSampleRuns}
          />
        ) : null}

        {activeTab === 'cases' ? (
          <EvalCasesTab
            agentsPending={agents.isPending}
            agentsError={agents.isError}
            agentsErrorValue={agents.error}
            onRetryAgents={() => void agents.refetch()}
            missingAgent={missingAgent}
            onClearAgent={() => setAgentId('')}
            effectiveAgentId={effectiveAgentId}
            casesPending={cases.isPending}
            casesError={cases.isError}
            casesErrorValue={cases.error}
            casesIsFetchNextPageError={cases.isFetchNextPageError}
            casesEmpty={casesEmpty}
            casesHasNextPage={cases.hasNextPage}
            casesFetchingNextPage={cases.isFetchingNextPage}
            onRetryCases={() => void cases.refetch()}
            onFetchNextCases={() => void cases.fetchNextPage()}
            caseItems={caseItems}
            selectedCaseId={selectedCaseId}
            onSelectCase={selectCase}
            canManageEval={canManageEval}
            canReadEval={canReadEval}
            canReadRuns={canReadRuns}
            createButtonRef={createButtonRef}
            importInputRef={importInputRef}
            importPending={importDataset.isPending}
            exporting={exporting}
            onImportFile={(file) => {
              if (!effectiveAgentId || !selectedAgent) return;
              void importJson(effectiveAgentId, selectedAgent.name, file);
            }}
            onExportJson={() => void exportJson()}
            onOpenCreateCase={openCreateCase}
            onOpenSampleRuns={openSampleRuns}
            onEditCase={(testCase, trigger) => {
              dialogTriggerRef.current = trigger;
              setEditing(testCase);
            }}
            onDeleteCase={(testCase, trigger) => {
              dialogTriggerRef.current = trigger;
              setDeleting(testCase);
            }}
          />
        ) : null}

        {activeTab === 'compare' ? (
          <EvalCompareTab
            agentsPending={agents.isPending}
            agentsError={agents.isError}
            agentsErrorValue={agents.error}
            onRetryAgents={() => void agents.refetch()}
            missingAgent={missingAgent}
            onClearAgent={() => setAgentId('')}
            effectiveAgentId={effectiveAgentId}
            runsPending={runs.isPending}
            runsError={runs.isError}
            runsErrorValue={runs.error}
            runsIsFetchNextPageError={runs.isFetchNextPageError}
            onRetryRuns={() => void runs.refetch()}
            baseId={baseId}
            headId={headId}
            diff={diffFilter}
            runs={terminalRuns}
            onChangeSearch={setSearch}
            onBackToRuns={backToRuns}
          />
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
      {samplingAgentId ? (
        <SampleRunsDialog
          agentId={samplingAgentId}
          finalFocus={finalFocus}
          onConvert={(candidate) => {
            setSamplingAgentId(null);
            setSampleCandidate(candidate);
          }}
          onClose={() => setSamplingAgentId(null)}
        />
      ) : null}
      {sampleCandidate ? (
        <EvalFromRunDialog
          runId={sampleCandidate.runId}
          conversationTitle={sampleCandidate.title}
          prompt={sampleCandidate.prompt}
          finalFocus={finalFocus}
          onClose={() => setSampleCandidate(null)}
        />
      ) : null}
      {deleting ? (
        <DeleteCaseDialog
          testCase={deleting}
          finalFocus={finalFocus}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </Page>
  );
}

export { buildEvalPassRatePoints, EvalPassRateChart } from './pass-rate-chart.js';
