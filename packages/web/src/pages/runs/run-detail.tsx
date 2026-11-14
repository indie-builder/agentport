import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  ArrowLeft,
  CircleAlert,
  CircleStop,
  ClipboardList,
  Download,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { CopyButton } from '../../components/copy-button.js';
import { Metric } from '../../components/metric-label.js';
import { Page, PageBody, PageHeader, PageSection, PageTopbar } from '../../components/page.js';
import { RunQuestionCard } from '../../components/run/run-question.js';
import { RunStatusBadge } from '../../components/run/run-status-badge.js';
import {
  questionForStep,
  StepInspector,
  stepIcons,
  stepName,
} from '../../components/run/run-steps.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { can } from '../../lib/access.js';
import { api, type ApprovalRequest } from '../../lib/api.js';
import { downloadJson } from '../../lib/browser-files.js';
import { questionFromContent } from '../../lib/chat-state.js';
import { cn } from '../../lib/cn.js';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  runStatusLabel,
  shortId,
} from '../../lib/format.js';
import {
  meQuery,
  useApproveRun,
  useCancelRun,
  useCreateEvalCaseFromRun,
  useDenyRun,
  useRerun,
  useRun,
  useRunApprovals,
  useRunQuestions,
  useSkillDraftFromRun,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';

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
  const canEval = can(me.data, 'eval.manage');
  const canExport = can(me.data, 'runs.export');
  const [exporting, setExporting] = useState(false);
  const navigate = useNavigate();
  // 状态尚未读取或仍在排队时也轮询，终态转换负责最后刷新。
  const status = run.data?.run.status;
  const approvals = useRunApprovals(
    params.runId,
    !status || status === 'queued' || status === 'running',
  );
  const questions = useRunQuestions(
    params.runId,
    !status || status === 'queued' || status === 'running',
  );
  const rerunMutation = useRerun();
  const cancelMutation = useCancelRun();
  const draftMutation = useSkillDraftFromRun();
  const approveMutation = useApproveRun();
  const denyMutation = useDenyRun();
  const approvalInFlight = useRef(false);
  // 来源页把进入前的 URL 带在 backTo 里；直接打开详情就回到运行列表。
  const backTo = search.backTo ?? '/runs';
  const selected = search.step ?? null;

  const selectStep = (index: number): void => {
    void navigate({
      to: '/runs/$runId',
      params: { runId: params.runId },
      search: (prev) => ({ ...prev, step: index }),
      replace: true,
    });
  };

  const rerun = (): void => {
    if (!run.data) return;
    const { run: detail, steps } = run.data;
    if (detail.status === 'queued' || detail.status === 'running') return;
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
            // 新运行没有步骤选中，来源仍沿用当前页带来的 backTo。
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
      { runId: run.data.run.id, serverId: item.serverId, toolName: item.toolName },
      {
        onSettled: () => {
          approvalInFlight.current = false;
        },
        onSuccess: (data) =>
          toastSuccess(
            data.waiting
              ? '已批准工具；仍在等待的调用可继续，无需重发消息'
              : '已记录后续调用许可；本次调用不会恢复。',
          ),
        onError: (error) => toastError(error),
      },
    );
  };

  const deny = (item: ApprovalRequest): void => {
    if (!run.data || approvalInFlight.current) return;
    approvalInFlight.current = true;
    denyMutation.mutate(
      { runId: run.data.run.id, serverId: item.serverId, toolName: item.toolName },
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
  const cancellable = run.data?.run.status === 'queued' || run.data?.run.status === 'running';
  const terminal = run.data ? !cancellable : false;

  const saveAsSkill = (): void => {
    if (!run.data) return;
    draftMutation.mutate(run.data.run.id, {
      onSuccess: (skill) => toastSuccess(`已生成技能草稿「${skill.name}」，可在技能页查看编辑`),
      onError: (error) => toastError(error),
    });
  };

  const evalCaseMutation = useCreateEvalCaseFromRun();
  const saveAsEvalCase = (): void => {
    if (!run.data) return;
    evalCaseMutation.mutate(run.data.run.id, {
      onSuccess: (evalCase) => toastSuccess(`已生成评估用例「${evalCase.name}」`),
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
      leading={
        <a
          href={backTo}
          onClick={(event) => {
            if (
              event.defaultPrevented ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            ) {
              return;
            }
            event.preventDefault();
            void navigate({ href: backTo });
          }}
          aria-label={search.backTo ? '返回来源' : '返回运行列表'}
          className={buttonVariants({ variant: 'outline', size: 'icon' })}
        >
          <ArrowLeft aria-hidden="true" />
        </a>
      }
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
            {terminal && hasPrompt && canRerun ? (
              <Button
                variant="outline"
                disabled={draftMutation.isPending}
                aria-busy={draftMutation.isPending}
                onClick={saveAsSkill}
              >
                <Sparkles data-icon="inline-start" aria-hidden="true" />
                {draftMutation.isPending ? '生成中…' : '存为技能'}
              </Button>
            ) : null}
            {terminal && hasPrompt && canEval ? (
              <Button
                variant="outline"
                disabled={evalCaseMutation.isPending}
                aria-busy={evalCaseMutation.isPending}
                onClick={saveAsEvalCase}
              >
                <ClipboardList data-icon="inline-start" aria-hidden="true" />
                {evalCaseMutation.isPending ? '生成中…' : '存为评估用例'}
              </Button>
            ) : null}
            {canExport ? (
              <Button
                variant="outline"
                disabled={exporting}
                aria-busy={exporting}
                onClick={() => void exportTrajectory()}
              >
                <Download data-icon="inline-start" aria-hidden="true" />
                {exporting ? '导出中…' : '导出轨迹'}
              </Button>
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

  // 只有从没拿到过数据时才整页报错；后台刷新失败要保留已加载的详情。
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
  // 运行步骤可能只留下用户消息或还没写入工具事件；未被任何步骤引用的提问仍要给回答入口。
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

  return (
    <Page>
      <PageTopbar>{header}</PageTopbar>
      <PageBody>
        {run.isError ? (
          <ErrorState
            error={run.error}
            title="刷新失败，内容仍是上次结果"
            onRetry={() => void run.refetch()}
          />
        ) : null}
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

        {failed && detail.error ? (
          <div
            role="alert"
            className="flex items-start gap-3 border-y border-line bg-danger-soft px-4 py-3"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-fg">运行{runStatusLabel[detail.status]}</div>
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
            className="flex flex-wrap items-center gap-3 border-y border-line bg-warning-soft px-4 py-2.5"
          >
            <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
            <span className="min-w-0 [overflow-wrap:anywhere] text-xs text-fg">
              {pending.length > 0
                ? detail.status === 'running'
                  ? `有 ${pending.length} 个工具待审批；请查看各项是否仍在等待。`
                  : '已结束运行的未批准请求不再生效，重新运行会重新请求批准。'
                : `已拒绝 ${denied.length} 个工具调用。`}
            </span>
            <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-2">
              {detail.status === 'running'
                ? pending.map((item) => {
                    // mutation 是全局状态：按当前 mutation 的变量判断是哪一条在决定。
                    const deciding = approveMutation.isPending || denyMutation.isPending;
                    const approving =
                      approveMutation.isPending &&
                      approveMutation.variables?.serverId === item.serverId &&
                      approveMutation.variables.toolName === item.toolName;
                    const denying =
                      denyMutation.isPending &&
                      denyMutation.variables?.serverId === item.serverId &&
                      denyMutation.variables.toolName === item.toolName;
                    return (
                      <div
                        key={item.id}
                        className="flex min-w-0 max-w-full flex-wrap items-center gap-2"
                      >
                        <span className="min-w-0 [overflow-wrap:anywhere] text-2xs text-muted-foreground">
                          {item.waiting
                            ? `等待至 ${formatDateTime(item.expiresAt)}`
                            : '本次调用已结束等待'}
                        </span>
                        {canApprove ? (
                          <>
                            <Button
                              size="sm"
                              className="h-auto min-h-7 max-w-full py-1 whitespace-normal"
                              disabled={deciding}
                              aria-busy={approving}
                              onClick={() => approve(item)}
                            >
                              <span className="min-w-0 [overflow-wrap:anywhere]">
                                {approving
                                  ? `批准中… ${item.serverName ?? item.serverId} / ${item.toolName}`
                                  : item.waiting
                                    ? `批准 ${item.serverName ?? item.serverId} / ${item.toolName}`
                                    : `批准后续 ${item.serverName ?? item.serverId} / ${item.toolName}`}
                              </span>
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-auto min-h-7 max-w-full py-1 whitespace-normal"
                              disabled={deciding}
                              aria-busy={denying}
                              onClick={() => deny(item)}
                            >
                              <span className="min-w-0 [overflow-wrap:anywhere]">
                                {denying
                                  ? `拒绝中… ${item.serverName ?? item.serverId} / ${item.toolName}`
                                  : `拒绝 ${item.serverName ?? item.serverId} / ${item.toolName}`}
                              </span>
                            </Button>
                          </>
                        ) : null}
                      </div>
                    );
                  })
                : null}
              {denied.map((item) => (
                <span
                  key={item.id}
                  className="min-w-0 self-center border-l border-line pl-2 [overflow-wrap:anywhere] text-2xs text-muted-foreground"
                >
                  已拒绝 {item.serverName ?? item.serverId} / {item.toolName}
                </span>
              ))}
            </div>
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

        <div className="grid min-w-0 gap-4 border-t pt-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <section className="flex min-w-0 flex-col gap-4" aria-label="步骤">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-3">
              <h2 className="text-base font-medium text-fg">步骤</h2>
              <span className="text-2xs text-muted-foreground">
                {steps.length} 步 · 时间为运行后经过时间
              </span>
            </div>
            {steps.length === 0 ? (
              <EmptyState
                title="还没有事件"
                {...(detail.status === 'queued' || detail.status === 'running'
                  ? { description: '稍后自动刷新。' }
                  : {})}
              />
            ) : (
              <ol className="flex flex-col">
                {steps.map((step, index) => {
                  const Icon = stepIcons[step.kind];
                  const isActive = index === activeIndex;
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 步骤没有稳定 id，位置即身份
                    <li key={`${index}-${step.at}`}>
                      <Button
                        variant="ghost"
                        onClick={() => selectStep(index)}
                        aria-current={isActive ? 'step' : undefined}
                        className={cn(
                          'w-full justify-start gap-2.5 text-left',
                          isActive && 'bg-selected hover:bg-selected',
                        )}
                      >
                        <span className="w-5 shrink-0 text-right font-mono text-2xs tabular-nums text-muted-foreground">
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
                      </Button>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section
            className="min-w-0 border-t pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4"
            aria-label="步骤详情"
          >
            {activeStep ? (
              <StepInspector
                step={activeStep}
                index={activeIndex}
                question={questionForStep(activeStep, liveQuestions, cancellable)}
                live={cancellable && canAnswer}
              />
            ) : null}
          </section>
        </div>

        <PageSection title="运行上下文">
          <div className="grid min-w-0 grid-cols-1 gap-x-4 sm:grid-cols-2">
            <ContextRow label="运行 ID" value={detail.id} mono copy />
            <ContextRow label="专家（当前）" value={detail.agentName ?? detail.agentId} />
            <ContextRow
              label="入队时版本"
              value={detail.agentVersion != null ? `v${detail.agentVersion}` : '—'}
              mono
            />
            <ContextRow
              label="运行环境"
              value={detail.runtimeEnvironment?.environmentName ?? '—'}
            />
            <ContextRow
              label="环境版本"
              value={detail.runtimeEnvironment?.versionId ?? '—'}
              mono
              copy={detail.runtimeEnvironment !== null}
            />
            <ContextRow label="开始" value={formatDateTime(detail.startedAt)} mono />
            <ContextRow label="结束" value={formatDateTime(detail.endedAt)} mono />
            <ContextRow label="Sandbox" value={detail.sandboxId ?? '—'} mono copy />
            <ContextRow label="Session" value={detail.sessionId ?? '—'} mono copy />
          </div>
        </PageSection>
      </PageBody>
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
    <div className="flex h-9 min-w-0 items-center gap-2 border-b">
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
