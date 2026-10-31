import type { PublicRunQuestion } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  ArrowLeft,
  Bot,
  CircleAlert,
  CircleStop,
  RotateCcw,
  Sparkles,
  User,
  Wrench,
} from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { CodeBlock, CollapsibleText, prettyJson } from '../components/code-block.js';
import { CopyButton } from '../components/copy-button.js';
import { Page, PageHeader, PageSection } from '../components/page.js';
import { RunQuestionCard } from '../components/run-question.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import type { ApprovalRequest, RunStep } from '../lib/api.js';
import { can } from '../lib/access.js';
import { questionFromContent } from '../lib/chat-state.js';
import { cn } from '../lib/cn.js';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  runStatusLabel,
  shortId,
} from '../lib/format.js';
import {
  meQuery,
  useApproveRun,
  useCancelRun,
  useRerun,
  useRun,
  useRunApprovals,
  useRunQuestions,
  useSkillDraftFromRun,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';

function elapsed(at: string, start: string | null): number {
  const base = new Date(start ?? at).getTime();
  const time = new Date(at).getTime();
  if (Number.isNaN(base) || Number.isNaN(time)) return 0;
  return Math.max(0, time - base);
}

const stepIcons = { user: User, assistant: Bot, tool: Wrench } as const;

function stepName(step: RunStep): string {
  if (step.kind === 'tool') return step.name ?? '未知工具';
  return step.kind === 'user' ? '用户消息' : '助手回复';
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
  const approvalInFlight = useRef(false);
  // 列表来源筛选随 URL 往返，返回时恢复；直接打开详情就回到未筛选列表。
  const listSearch = {
    ...(search.fromAgent ? { agent: search.fromAgent } : {}),
    ...(search.fromStatus ? { status: search.fromStatus } : {}),
  };
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
          void navigate({ to: '/runs/$runId', params: { runId: accepted.runId } }),
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

  const cancel = (): void => {
    if (!run.data) return;
    cancelMutation.mutate(run.data.run.id, {
      onSuccess: () => toastSuccess('已请求取消运行'),
      onError: (error) => toastError(error),
    });
  };

  const header = (
    <div className="flex min-w-0 items-end gap-3">
      <Button
        variant="outline"
        size="icon"
        render={<Link to="/runs" search={listSearch} />}
        nativeButton={false}
        role="link"
        aria-label="返回运行列表"
      >
        <ArrowLeft />
      </Button>
      <PageHeader
        title={`运行 ${shortId(params.runId)}${run.data ? ` · ${runStatusLabel[run.data.run.status]}` : ''}`}
        className="min-w-0 flex-1 [&_h1]:shrink"
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
                  <CircleStop data-icon="inline-start" />
                  {cancelMutation.isPending ? '取消中…' : '取消'}
                </Button>
              ) : null}
              {terminal && hasPrompt && canRerun ? (
                <Button
                  disabled={rerunMutation.isPending}
                  aria-busy={rerunMutation.isPending}
                  onClick={rerun}
                >
                  <RotateCcw data-icon="inline-start" />
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
                  <Sparkles data-icon="inline-start" />
                  {draftMutation.isPending ? '生成中…' : '存为技能'}
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />
    </div>
  );

  if (run.isPending) {
    return (
      <Page>
        {header}
        <LoadingState rows={6} />
      </Page>
    );
  }

  // 只有从没拿到过数据时才整页报错；后台刷新失败要保留已加载的详情。
  if (run.data === undefined) {
    return (
      <Page>
        {header}
        <ErrorState error={run.error} onRetry={() => void run.refetch()} />
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
  const pending = (approvals.data?.items ?? []).filter((item) => item.approvedAt === null);
  const activeIndex = selected !== null && selected < steps.length ? selected : steps.length - 1;
  const activeStep = steps[activeIndex];

  return (
    <Page>
      {header}
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
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">运行{runStatusLabel[detail.status]}</div>
            <pre className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs leading-relaxed text-muted-foreground">
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

      {pending.length > 0 ? (
        <div
          role={detail.status === 'running' ? 'alert' : undefined}
          className="flex flex-wrap items-center gap-3 border-y border-line bg-warning-soft px-4 py-2.5"
        >
          <CircleAlert className="size-4 shrink-0 text-warning" />
          <span className="min-w-0 [overflow-wrap:anywhere] text-xs text-fg">
            {detail.status === 'running'
              ? `有 ${pending.length} 个工具待审批；请查看各项是否仍在等待。`
              : '已结束运行的未批准请求不再生效，重新运行会重新请求批准。'}
          </span>
          {detail.status === 'running' ? (
            <div className="ml-auto flex min-w-0 max-w-full flex-wrap gap-2">
              {pending.map((item) => {
                // mutation 是全局状态：按当前 mutation 的变量判断是哪一条在批准。
                const approving =
                  approveMutation.isPending &&
                  approveMutation.variables?.serverId === item.serverId &&
                  approveMutation.variables.toolName === item.toolName;
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
                    <Button
                      size="sm"
                      className="h-auto min-h-7 max-w-full py-1 whitespace-normal"
                      disabled={approveMutation.isPending}
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
                    ) : null}
                  </div>
                );
              })}
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

      <div className="grid min-w-0 gap-4 border-t pt-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section className="flex min-w-0 flex-col gap-4" aria-label="步骤">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-3">
            <h2 className="text-sm font-medium text-fg">步骤</h2>
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
                        isActive && 'bg-hover',
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
          <ContextRow label="运行环境" value={detail.runtimeEnvironment?.environmentName ?? '—'} />
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
    </Page>
  );
}

function Metric({ label, value, danger }: { label: string; value: ReactNode; danger?: boolean }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-1.5">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <span className={cn('font-mono tabular-nums', danger ? 'text-danger' : 'text-fg')}>
        {value}
      </span>
    </span>
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

/**
 * 工具步骤对应的提问：以该 run 的提问列表为准（回答状态会变化）。
 * 运行步骤可能只保留工具参数，因此再按 toolUseId 对齐；历史快照作兜底。
 * 运行结束后提问不会再有新状态，以落库的最终快照为准，避免接口旧 pending 或 404。
 */
function questionForStep(
  step: RunStep,
  questionsByToolUseId: ReadonlyMap<string, PublicRunQuestion>,
  live: boolean,
): PublicRunQuestion | undefined {
  if (step.kind !== 'tool') return undefined;
  const snapshot =
    step.question ?? questionFromContent(step.content) ?? questionFromContent(step.result);
  const current = step.toolUseId === null ? undefined : questionsByToolUseId.get(step.toolUseId);
  return live ? (current ?? snapshot) : (snapshot ?? current);
}

function StepInspector({
  step,
  index,
  question,
  live,
}: {
  step: RunStep;
  index: number;
  question?: PublicRunQuestion | undefined;
  live: boolean;
}) {
  const input = step.kind === 'tool' ? (step.content ?? null) : null;
  const output = step.kind === 'tool' ? (step.result ?? null) : null;
  const nested = step.kind === 'tool' && step.parentToolUseId !== null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b pb-3">
        <span className="font-mono text-2xs tabular-nums text-muted-foreground">#{index + 1}</span>
        <span className="min-w-0 break-all font-mono text-xs text-fg">{stepName(step)}</span>
        <span className="font-mono text-2xs tabular-nums text-muted-foreground">
          事件时间 {formatDateTime(step.at)}
        </span>
        {nested ? (
          <span className="rounded-tag bg-chip px-1.5 py-0.5 text-2xs text-muted-foreground">
            子智能体内部调用
          </span>
        ) : null}
        {step.kind === 'tool' && step.toolUseId ? (
          <span
            className="rounded-tag bg-chip px-1.5 py-0.5 font-mono text-2xs text-muted-foreground"
            title={step.toolUseId}
          >
            {shortId(step.toolUseId)}
          </span>
        ) : null}
      </div>

      {question ? (
        <RunQuestionCard key={question.requestId} question={question} live={live} />
      ) : null}

      {step.kind === 'assistant' || step.kind === 'user' ? (
        <CollapsibleText
          text={step.text}
          className="whitespace-pre-wrap [overflow-wrap:anywhere] text-md text-fg"
        />
      ) : (
        <>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">参数</span>
              {input !== null ? <CopyButton value={prettyJson(input)} label="复制参数" /> : null}
            </div>
            {input !== null ? (
              <CodeBlock code={prettyJson(input)} json maxHeight="18rem" />
            ) : (
              <p className="text-xs text-muted-foreground">无参数。</p>
            )}
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">结果</span>
              {output !== null ? <CopyButton value={prettyJson(output)} label="复制结果" /> : null}
            </div>
            {output !== null ? (
              <CodeBlock code={prettyJson(output)} json maxHeight="22rem" />
            ) : (
              <p className="text-xs text-muted-foreground">
                没有结果：可能等待批准、被拒绝，或运行在返回前结束。
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
