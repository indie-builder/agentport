import { isActiveRunStatus } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  CircleAlert,
  CircleStop,
  ClipboardList,
  Download,
  EllipsisVertical,
  FileText,
  ListTree,
  LoaderCircle,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { BackLink } from '../../components/back-link.js';
import { CopyButton } from '../../components/copy-button.js';
import { CursorListFooter } from '../../components/cursor-list-footer.js';
import { InspectorSheet } from '../../components/inspector-sheet.js';
import { Metric } from '../../components/metric-label.js';
import { Page, PageBody, PageHeader, PageTopbar } from '../../components/page.js';
import { EvalFromRunDialog } from '../../components/run/eval-from-run-dialog.js';
import { RunFeedbackPanel } from '../../components/run/run-feedback.js';
import { RunQuestionCard } from '../../components/run/run-question.js';
import { RunStatusBadge } from '../../components/run/run-status-badge.js';
import {
  questionForStep,
  StepInspector,
  stepIcons,
  stepName,
} from '../../components/run/run-steps.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { Button } from '../../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { Listbox, ListboxItem } from '../../components/ui/listbox.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { SegmentedToggle } from '../../components/view-toggle.js';
import { can } from '../../lib/access.js';
import { type ApprovalRequest, api } from '../../lib/api.js';
import { downloadJson } from '../../lib/browser-files.js';
import { questionFromContent } from '../../lib/chat-state.js';
import { cn } from '../../lib/cn.js';
import {
  formatBytes,
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  runStatusLabel,
  shortId,
} from '../../lib/format.js';
import {
  chatKeys,
  meQuery,
  useApproveRun,
  useCancelRun,
  useConversationOutputs,
  useDenyRun,
  useDrainPages,
  useRefetchWhenRunEnds,
  useRerun,
  useRun,
  useRunApprovals,
  useRunQuestions,
  useSkillDraftFromRun,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';

type StepFilter = 'all' | 'tool' | 'message';
type DetailTab = 'trace' | 'delivery';

const STEP_FILTERS: ReadonlyArray<{ value: StepFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'tool', label: '工具' },
  { value: 'message', label: '消息' },
];

function elapsed(at: string, start: string | null): number {
  const base = new Date(start ?? at).getTime();
  const time = new Date(at).getTime();
  if (Number.isNaN(base) || Number.isNaN(time)) return 0;
  return Math.max(0, time - base);
}

export function RunDetailPage() {
  const params = useParams({ from: '/_shell/runs/$runId' });
  const search = useSearch({ from: '/_shell/runs/$runId' });
  const run = useRun(params.runId);
  const me = useQuery(meQuery);
  const canCancel = can(me.data, 'runs.cancel');
  const canApprove = can(me.data, 'runs.approve');
  const canAnswer = can(me.data, 'runs.questions.answer');
  const canRerun = can(me.data, 'conversations.create');
  const canSaveAsSkill = can(me.data, 'skills.create');
  const canEval = can(me.data, 'eval.manage');
  const canExport = can(me.data, 'runs.export');
  const canFeedback = can(me.data, 'runs.feedback');
  const [exporting, setExporting] = useState(false);
  const [evalOpen, setEvalOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [stepFilter, setStepFilter] = useState<StepFilter>('all');
  const contextTriggerRef = useRef<HTMLButtonElement | null>(null);
  const navigate = useNavigate({ from: '/runs/$runId' });
  const status = run.data?.run.status;
  const approvals = useRunApprovals(params.runId, !status || isActiveRunStatus(status));
  const questions = useRunQuestions(params.runId, !status || isActiveRunStatus(status));
  const outputs = useConversationOutputs(run.data?.conversation.id ?? null, params.runId);
  useDrainPages(outputs);
  useRefetchWhenRunEnds(
    params.runId,
    isActiveRunStatus(status),
    chatKeys.runOutputs(run.data?.conversation.id ?? null, params.runId),
  );
  const rerunMutation = useRerun();
  const cancelMutation = useCancelRun();
  const draftMutation = useSkillDraftFromRun();
  const approveMutation = useApproveRun();
  const denyMutation = useDenyRun();
  const approvalInFlight = useRef(false);
  const backTo = search.backTo ?? '/runs';
  const selected = search.step ?? null;
  const activeTab: DetailTab = search.tab ?? 'trace';

  const selectStep = (index: number): void => {
    void navigate({
      to: '/runs/$runId',
      params: { runId: params.runId },
      search: (prev) => ({ ...prev, step: index }),
      replace: true,
    });
  };

  const selectTab = (next: DetailTab): void => {
    void navigate({
      to: '/runs/$runId',
      params: { runId: params.runId },
      search: (prev) => ({ ...prev, tab: next }),
      replace: true,
    });
  };

  const rerun = (): void => {
    if (!run.data) return;
    const { run: detail, steps } = run.data;
    if (isActiveRunStatus(detail.status)) return;
    const prompt = steps.find((step) => step.kind === 'user')?.text;
    if (!prompt) {
      toastError(new Error('这次运行没有可重发的用户消息。'));
      return;
    }
    rerunMutation.mutate(
      { agentId: detail.agentId, conversationId: detail.conversationId, message: prompt },
      {
        onSuccess: (accepted) =>
          void navigate({
            to: '/runs/$runId',
            params: { runId: accepted.runId },
            search: search.backTo ? { backTo: search.backTo } : {},
          }),
        onError: (error) => toastError(error),
      },
    );
  };

  const approve = (item: ApprovalRequest): void => {
    if (!run.data || approvalInFlight.current) return;
    approvalInFlight.current = true;
    approveMutation.mutate(
      { runId: run.data.run.id, approvalId: item.id },
      {
        onSettled: () => {
          approvalInFlight.current = false;
        },
        onSuccess: (data) =>
          toastSuccess(
            data.waiting ? '已批准工具；仍在等待的调用可继续，无需重发消息' : '已批准工具。',
          ),
        onError: (error) => toastError(error),
      },
    );
  };

  const deny = (item: ApprovalRequest): void => {
    if (!run.data || approvalInFlight.current) return;
    approvalInFlight.current = true;
    denyMutation.mutate(
      { runId: run.data.run.id, approvalId: item.id },
      {
        onSettled: () => {
          approvalInFlight.current = false;
        },
        onSuccess: (data) =>
          toastSuccess(
            data.waiting
              ? '已拒绝工具；等待中的调用会立即收到拒绝'
              : '已拒绝工具；本次调用不会执行。',
          ),
        onError: (error) => toastError(error),
      },
    );
  };

  const hasPrompt = run.data?.steps.some((step) => step.kind === 'user') ?? false;
  const cancellable = isActiveRunStatus(run.data?.run.status);
  const terminal = run.data ? !cancellable : false;
  const moreBusy = draftMutation.isPending || exporting;

  const saveAsSkill = (): void => {
    if (!run.data) return;
    draftMutation.mutate(run.data.run.id, {
      onSuccess: (skill) => toastSuccess(`已生成技能草稿「${skill.name}」，审核通过后可绑定`),
      onError: (error) => toastError(error),
    });
  };

  const exportTrajectory = async (): Promise<void> => {
    if (!run.data || exporting) return;
    setExporting(true);
    try {
      const data = await api.exportRun(run.data.run.id);
      downloadJson(data, `run-${run.data.run.id}.json`);
      toastSuccess('已导出运行轨迹');
    } catch (error) {
      toastError(error);
    } finally {
      setExporting(false);
    }
  };

  const cancel = (): void => {
    if (!run.data) return;
    cancelMutation.mutate(run.data.run.id, {
      onSuccess: () => toastSuccess('已请求取消运行'),
      onError: (error) => toastError(error),
    });
  };

  const header = (
    <PageHeader
      leading={<BackLink to={backTo} label={search.backTo ? '返回来源' : '返回运行列表'} />}
      title={`运行 ${shortId(params.runId)}`}
      eyebrow={run.data ? <RunStatusBadge status={run.data.run.status} /> : null}
      actions={
        run.data ? (
          <>
            {cancellable && canCancel ? (
              <Button
                variant="outline"
                disabled={cancelMutation.isPending}
                aria-busy={cancelMutation.isPending}
                aria-label="取消运行"
                onClick={cancel}
              >
                <CircleStop data-icon="inline-start" aria-hidden="true" />
                {cancelMutation.isPending ? '取消中…' : '取消'}
              </Button>
            ) : null}
            {terminal && hasPrompt && canRerun ? (
              <Button
                disabled={rerunMutation.isPending}
                aria-busy={rerunMutation.isPending}
                onClick={rerun}
              >
                <RotateCcw data-icon="inline-start" aria-hidden="true" />
                {rerunMutation.isPending ? '提交中…' : '重跑'}
              </Button>
            ) : null}
            <Button variant="outline" ref={contextTriggerRef} onClick={() => setContextOpen(true)}>
              运行信息
            </Button>
            {(terminal && hasPrompt && canSaveAsSkill) ||
            (terminal && hasPrompt && canEval) ||
            canExport ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="icon" aria-label="更多操作" aria-busy={moreBusy}>
                      {moreBusy ? (
                        <LoaderCircle className="animate-spin" aria-hidden="true" />
                      ) : (
                        <EllipsisVertical />
                      )}
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" sideOffset={4} className="w-48">
                  <DropdownMenuGroup>
                    {terminal && hasPrompt && canSaveAsSkill ? (
                      <DropdownMenuItem
                        disabled={draftMutation.isPending}
                        aria-busy={draftMutation.isPending}
                        onSelect={saveAsSkill}
                      >
                        <Sparkles aria-hidden="true" />
                        {draftMutation.isPending ? '生成中…' : '存为技能'}
                      </DropdownMenuItem>
                    ) : null}
                    {terminal && hasPrompt && canEval ? (
                      <DropdownMenuItem onSelect={() => setEvalOpen(true)}>
                        <ClipboardList aria-hidden="true" />
                        存为评估用例
                      </DropdownMenuItem>
                    ) : null}
                    {canExport ? (
                      <DropdownMenuItem
                        disabled={exporting}
                        aria-busy={exporting}
                        onSelect={() => void exportTrajectory()}
                      >
                        <Download aria-hidden="true" />
                        {exporting ? '导出中…' : '导出轨迹'}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        ) : undefined
      }
    />
  );

  if (run.isPending) {
    return (
      <Page>
        <PageTopbar>{header}</PageTopbar>
        <PageBody>
          <LoadingState rows={6} />
        </PageBody>
      </Page>
    );
  }

  if (run.data === undefined) {
    return (
      <Page>
        <PageTopbar>{header}</PageTopbar>
        <PageBody>
          <ErrorState error={run.error} onRetry={() => void run.refetch()} />
        </PageBody>
      </Page>
    );
  }

  const { run: detail, steps, conversation } = run.data;
  const liveQuestions = new Map(
    (questions.data?.items ?? []).map((question) => [question.toolUseId, question]),
  );
  const attached = new Set<string>();
  for (const step of steps) {
    if (step.kind !== 'tool') continue;
    if (step.toolUseId !== null) attached.add(step.toolUseId);
    const snapshot =
      step.question ?? questionFromContent(step.content) ?? questionFromContent(step.result);
    if (snapshot) attached.add(snapshot.requestId);
  }
  const orphanQuestions = (questions.data?.items ?? []).filter(
    (question) => !attached.has(question.toolUseId) && !attached.has(question.requestId),
  );
  const start = detail.startedAt ?? steps[0]?.at ?? null;
  const failed = detail.status === 'failed' || detail.status === 'timeout';
  const approvalItems = approvals.data?.items ?? [];
  const pending = approvalItems.filter(
    (item) => item.approvedAt === null && item.deniedAt === null,
  );
  const denied = approvalItems.filter((item) => item.deniedAt !== null);
  const activeIndex = selected !== null && selected < steps.length ? selected : steps.length - 1;
  const activeStep = steps[activeIndex];
  const activeStepKey = activeStep
    ? `${activeIndex}:${activeStep.at}:${activeStep.kind === 'tool' ? (activeStep.toolUseId ?? activeStep.name ?? '') : activeStep.kind}`
    : 'empty';
  const userPrompt = steps.find((step) => step.kind === 'user')?.text ?? '';
  const lastAssistantMessageId =
    steps.flatMap((step) => (step.kind === 'assistant' ? [step.messageId ?? null] : [])).at(-1) ??
    null;
  const runFiles = (outputs.data?.items ?? []).filter((file) => file.runId === detail.id);

  const seenSteps = new Map<string, number>();
  const stepEntries = steps.map((step, index) => {
    const base = `${step.kind}:${step.at}:${step.kind === 'tool' ? (step.toolUseId ?? step.name ?? '') : ''}`;
    const count = (seenSteps.get(base) ?? 0) + 1;
    seenSteps.set(base, count);
    return { step, index, key: `${base}:${count}` };
  });
  const filteredSteps = stepEntries.filter(({ step }) => {
    if (stepFilter === 'all') return true;
    if (stepFilter === 'tool') return step.kind === 'tool';
    return step.kind === 'user' || step.kind === 'assistant';
  });

  const hasAlerts =
    run.isError ||
    (failed && Boolean(detail.error)) ||
    approvals.isError ||
    questions.isError ||
    pending.length > 0 ||
    denied.length > 0 ||
    orphanQuestions.length > 0;

  return (
    <Page>
      <Tabs<DetailTab> value={activeTab} onValueChange={selectTab} className="min-h-0 flex-1 gap-4">
        <PageTopbar>
          {header}
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-2 text-xs">
            <Link
              to="/chat"
              search={{ agent: conversation.agentId, conversation: conversation.id }}
              className="min-w-0 text-muted-foreground underline underline-offset-2 [overflow-wrap:anywhere] hover:text-fg"
            >
              {conversation.title || '返回会话'}
            </Link>
            <Metric
              label="运行耗时"
              value={formatDuration(detail.latencyMs)}
              danger={detail.status === 'timeout'}
            />
            <Metric label="轮次" value={detail.turns ?? '—'} />
            <Metric label="成本" value={formatCost(detail.costUsd)} />
            <Metric
              label="Tokens 输入 / 输出"
              value={`${formatTokens(detail.inputTokens)} / ${formatTokens(detail.outputTokens)}`}
            />
          </div>
          <TabsList variant="line" aria-label="运行详情视图">
            <TabsTrigger value="trace">
              执行轨迹{' '}
              <span className="text-xs tabular-nums text-muted-foreground">{steps.length}</span>
            </TabsTrigger>
            <TabsTrigger value="delivery">
              交付与验收
              {runFiles.length > 0 ? (
                <>
                  {' '}
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {runFiles.length}
                  </span>
                </>
              ) : null}
            </TabsTrigger>
          </TabsList>
        </PageTopbar>

        <PageBody className="gap-4 max-xl:overflow-y-auto xl:overflow-hidden xl:[&>*]:shrink">
          {hasAlerts ? (
            <div className="flex min-w-0 shrink-0 flex-col gap-3">
              {run.isError ? (
                <ErrorState
                  error={run.error}
                  title="刷新失败，内容仍是上次结果"
                  onRetry={() => void run.refetch()}
                />
              ) : null}

              {failed && detail.error ? (
                <div
                  role="alert"
                  className="flex items-start gap-3 rounded-item border border-line bg-danger-soft px-4 py-3"
                >
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-fg">
                      运行{runStatusLabel[detail.status]}
                    </div>
                    <pre className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs leading-5 text-muted-foreground">
                      {detail.error}
                    </pre>
                  </div>
                  <CopyButton value={detail.error} label="复制错误" />
                </div>
              ) : null}

              {approvals.isError ? (
                <ErrorState error={approvals.error} onRetry={() => void approvals.refetch()} />
              ) : null}

              {questions.isError ? (
                <ErrorState
                  title="提问状态没有加载出来"
                  error={questions.error}
                  onRetry={() => void questions.refetch()}
                />
              ) : null}

              {pending.length > 0 || denied.length > 0 ? (
                <div
                  role={detail.status === 'running' && pending.length > 0 ? 'alert' : undefined}
                  className="flex min-w-0 flex-col gap-2 rounded-item border border-line bg-warning-soft px-4 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
                    <span className="min-w-0 [overflow-wrap:anywhere] text-xs text-fg">
                      {pending.length > 0
                        ? detail.status === 'running'
                          ? `有 ${pending.length} 个工具待审批；请查看各项是否仍在等待。`
                          : '已结束运行的未批准请求不再生效，重新运行会重新请求批准。'
                        : `已拒绝 ${denied.length} 个工具调用。`}
                    </span>
                  </div>
                  {detail.status === 'running' && pending.length > 0 ? (
                    <div className="flex min-w-0 flex-col gap-2 border-t border-line pt-2">
                      {pending.map((item) => {
                        const target = `${item.serverName ?? item.serverId} / ${item.toolName}`;
                        const deciding = approveMutation.isPending || denyMutation.isPending;
                        const approving =
                          approveMutation.isPending &&
                          approveMutation.variables?.approvalId === item.id;
                        const denying =
                          denyMutation.isPending && denyMutation.variables?.approvalId === item.id;
                        return (
                          <div
                            key={item.id}
                            className="flex min-w-0 flex-wrap items-center justify-between gap-2"
                          >
                            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                              <span className="min-w-0 font-mono text-xs text-fg [overflow-wrap:anywhere]">
                                {target}
                              </span>
                              <span className="text-2xs text-muted-foreground">
                                {item.waiting
                                  ? `等待至 ${formatDateTime(item.expiresAt)}`
                                  : '审批已失效，请让智能体重新发起'}
                              </span>
                            </div>
                            {canApprove && item.waiting ? (
                              <div className="flex shrink-0 items-center gap-1.5">
                                <Button
                                  size="sm"
                                  disabled={deciding}
                                  aria-busy={approving}
                                  aria-label={`批准 ${target}`}
                                  data-agent-confirm={`批准 ${target} 的工具调用`}
                                  onClick={() => approve(item)}
                                >
                                  {approving ? '批准中…' : '批准'}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={deciding}
                                  aria-busy={denying}
                                  aria-label={`拒绝 ${target}`}
                                  data-agent-confirm={`拒绝 ${target} 的工具调用`}
                                  onClick={() => deny(item)}
                                >
                                  {denying ? '拒绝中…' : '拒绝'}
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  {denied.length > 0 ? (
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2">
                      {denied.map((item) => (
                        <span
                          key={item.id}
                          className="min-w-0 [overflow-wrap:anywhere] text-2xs text-muted-foreground"
                        >
                          已拒绝 {item.serverName ?? item.serverId} / {item.toolName}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {orphanQuestions.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {orphanQuestions.map((question) => (
                    <RunQuestionCard
                      key={question.requestId}
                      question={question}
                      live={cancellable && canAnswer}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <TabsContent
            value="trace"
            className="flex flex-col max-xl:flex-none xl:min-h-0 xl:flex-1 xl:overflow-hidden"
          >
            <div className="grid gap-5 border-t border-line pt-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[320px_minmax(0,1fr)]">
              <section className="flex min-w-0 flex-col gap-3 xl:min-h-0" aria-label="步骤">
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                  <div className="flex items-baseline gap-2">
                    <h2 className="text-sm font-medium text-fg">步骤</h2>
                    <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                      {filteredSteps.length === steps.length
                        ? `${steps.length} 步`
                        : `${filteredSteps.length} / ${steps.length} 步`}
                    </span>
                  </div>
                  <SegmentedToggle
                    label="筛选步骤类型"
                    value={stepFilter}
                    onChange={setStepFilter}
                    options={STEP_FILTERS}
                  />
                </div>
                {steps.length === 0 ? (
                  <EmptyState
                    variant="idle"
                    scale="section"
                    icon={<ListTree className="size-5" aria-hidden="true" />}
                    title="还没有产生执行步骤"
                    description={
                      isActiveRunStatus(detail.status)
                        ? '正在等待事件流入，稍后自动刷新。'
                        : '本次运行未记录到步骤事件。'
                    }
                  />
                ) : filteredSteps.length === 0 ? (
                  <EmptyState variant="filter" scale="inline" title="该分类下没有步骤" />
                ) : (
                  <Listbox
                    aria-label="执行步骤"
                    value={
                      activeIndex >= 0 &&
                      activeIndex < steps.length &&
                      filteredSteps.some((entry) => entry.index === activeIndex)
                        ? String(activeIndex)
                        : null
                    }
                    onValueChange={(next) => {
                      if (next !== null) selectStep(Number(next));
                    }}
                    className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-0 bg-transparent p-0 max-xl:max-h-80"
                  >
                    {filteredSteps.map(({ step, index, key }) => {
                      const Icon = stepIcons[step.kind];
                      return (
                        <ListboxItem
                          key={key}
                          value={String(index)}
                          label={`${index + 1} ${stepName(step)}`}
                          className="gap-2.5 px-2.5 py-2"
                        >
                          <span className="w-5 shrink-0 text-end font-mono text-2xs tabular-nums text-muted-foreground">
                            {index + 1}
                          </span>
                          <Icon aria-hidden="true" className="shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span
                              className={cn(
                                'block truncate font-mono text-xs',
                                step.kind === 'tool' ? 'text-fg' : 'text-muted-foreground',
                              )}
                            >
                              {stepName(step)}
                            </span>
                          </span>
                          <span
                            className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground"
                            title={`事件时间：${formatDateTime(step.at)}`}
                          >
                            +{formatDuration(elapsed(step.at, start))}
                          </span>
                        </ListboxItem>
                      );
                    })}
                  </Listbox>
                )}
              </section>

              <section
                className="min-w-0 border-t border-line pt-4 xl:min-h-0 xl:overflow-y-auto xl:overscroll-contain xl:border-t-0 xl:border-l xl:pt-0 xl:pl-5"
                aria-label="步骤详情"
              >
                <StepInspector
                  key={activeStepKey}
                  step={activeStep}
                  index={activeIndex}
                  question={
                    activeStep ? questionForStep(activeStep, liveQuestions, cancellable) : undefined
                  }
                  live={cancellable && canAnswer}
                />
              </section>
            </div>
          </TabsContent>

          <TabsContent
            value="delivery"
            className="max-xl:flex-none xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain"
          >
            <div className="flex min-w-0 flex-col gap-6 border-t border-line pt-4">
              <CursorListFooter
                query={outputs}
                autoDrain
                errorTitle="后续成果没有加载完整"
                className="justify-start"
              />
              {outputs.isError && !outputs.isFetchNextPageError ? (
                <ErrorState
                  title="成果没有加载出来"
                  error={outputs.error}
                  onRetry={() => void outputs.refetch()}
                />
              ) : null}
              {runFiles.length > 0 ? (
                <section className="flex min-w-0 flex-col gap-2" aria-label="产出文件">
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="text-sm font-medium text-fg">产出文件</h2>
                    <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                      {runFiles.length} 个
                    </span>
                  </div>
                  <ul className="divide-y divide-line rounded-item border border-line bg-surface">
                    {runFiles.map((file) => (
                      <li
                        key={file.path}
                        className="flex min-w-0 items-center justify-between gap-3 px-3 py-2 text-xs"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <FileText
                            className="size-3.5 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 truncate font-mono text-fg" title={file.path}>
                            {file.path}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                          {formatBytes(file.size)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <RunFeedbackPanel
                runId={detail.id}
                conversationTitle={conversation.title}
                prompt={userPrompt}
                messageId={lastAssistantMessageId}
                files={runFiles}
                canEvaluate={canEval}
                canWrite={canFeedback && terminal}
              />
            </div>
          </TabsContent>
        </PageBody>
      </Tabs>

      <InspectorSheet
        open={contextOpen}
        onOpenChange={setContextOpen}
        size="sm"
        title="运行上下文"
        finalFocus={() =>
          contextTriggerRef.current?.isConnected ? contextTriggerRef.current : null
        }
      >
        <div className="flex min-w-0 flex-col">
          <ContextRow label="运行 ID" value={detail.id} mono copy />
          <ContextRow label="专家（当前）" value={detail.agentName ?? detail.agentId} />
          <ContextRow
            label="入队时版本"
            value={detail.agentVersion != null ? `v${detail.agentVersion}` : '—'}
            mono
          />
          <ContextRow label="运行环境" value={detail.runtimeEnvironment?.environmentName ?? '—'} />
          <ContextRow
            label="环境版本"
            value={detail.runtimeEnvironment?.versionId ?? '—'}
            mono
            copy={detail.runtimeEnvironment !== null}
          />
          <ContextRow label="开始" value={formatDateTime(detail.startedAt)} mono />
          <ContextRow label="结束" value={formatDateTime(detail.endedAt)} mono />
          <ContextRow
            label="Sandbox"
            value={detail.sandboxId ?? '—'}
            mono
            copy={detail.sandboxId != null}
          />
          <ContextRow
            label="Session"
            value={detail.sessionId ?? '—'}
            mono
            copy={detail.sessionId != null}
          />
        </div>
      </InspectorSheet>

      {evalOpen ? (
        <EvalFromRunDialog
          runId={detail.id}
          conversationTitle={conversation.title}
          prompt={userPrompt}
          onClose={() => setEvalOpen(false)}
        />
      ) : null}
    </Page>
  );
}

function ContextRow({
  label,
  value,
  mono,
  copy,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copy?: boolean;
}) {
  return (
    <div className="flex h-9 min-w-0 items-center gap-2 border-b border-line last:border-b-0">
      <span className="w-20 shrink-0 text-2xs text-muted-foreground">{label}</span>
      <span
        className={cn('min-w-0 flex-1 truncate text-xs text-fg', mono && 'font-mono tabular-nums')}
        title={value}
      >
        {value}
      </span>
      {copy ? <CopyButton value={value} label={`复制${label}`} /> : null}
    </div>
  );
}
