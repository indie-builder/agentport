import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Bot, Check, CircleAlert, Copy, RotateCcw, User, Wrench } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { CodeBlock, CollapsibleText, prettyJson } from '../components/code-block.js';
import { Page, PageHeader } from '../components/page.js';
import { RunStatusBadge } from '../components/run-status-badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import type { ApprovalRequest, RunStep } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  runStatusLabel,
  shortId,
} from '../lib/format.js';
import { useApproveRun, useRerun, useRun, useRunApprovals } from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';

/**
 * 运行详情：主从结构（左步骤树 + 右检查器）。
 *
 * 为什么不是纯时间线：时间线适合读故事，但长 trace 里无法并排比较参数与结果，
 * 也看不出哪一步最慢。这里左栏给「谁花了多久」，右栏给「它到底传了什么、拿回了什么」。
 * 选中步骤写进 URL（?step=），可分享、刷新不丢。
 */

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 非安全上下文或权限被拒时静默失败，内容仍可手动选择。
    }
  };
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => void copy()}
      aria-label={copied ? '已复制' : label}
      title={copied ? '已复制' : label}
    >
      {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
    </Button>
  );
}

function elapsed(at: string, start: string | null): number {
  const base = new Date(start ?? at).getTime();
  const time = new Date(at).getTime();
  if (Number.isNaN(base) || Number.isNaN(time)) return 0;
  return Math.max(0, time - base);
}

const stepMeta = {
  user: { icon: User, label: '用户', tone: 'text-muted-foreground' },
  assistant: { icon: Bot, label: '助手', tone: 'text-success' },
  tool: { icon: Wrench, label: '工具', tone: 'text-muted-foreground' },
} as const;

type ApprovalItem = ApprovalRequest;

/** 每一步的显示名：工具名只保留最后一段，前缀是 server 名，表格里太占宽。 */
function stepName(step: RunStep): string {
  if (step.kind === 'tool') return step.name ?? '未知工具';
  return step.kind === 'user' ? '用户消息' : '助手回复';
}

function stepServerName(step: RunStep): string | null {
  if (step.kind !== 'tool' || !step.name?.startsWith('mcp__')) return null;
  const parts = step.name.split('__');
  return parts.length >= 3 ? (parts[1] ?? null) : null;
}

export function RunDetailPage() {
  const params = useParams({ from: '/shell/runs/$runId' });
  const search = useSearch({ from: '/shell/runs/$runId' });
  const run = useRun(params.runId);
  const navigate = useNavigate();
  // 运行结束后不再轮询审批。
  const approvals = useRunApprovals(params.runId, run.data?.run.status === 'running');
  const rerunMutation = useRerun();
  const approveMutation = useApproveRun();
  // 选中的步骤由 URL 决定：刷新、分享、前进后退都保留。
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

  const approve = (item: ApprovalItem): void => {
    if (!run.data) return;
    approveMutation.mutate(
      { runId: run.data.run.id, serverId: item.serverId, toolName: item.toolName },
      {
        onSuccess: () => toastSuccess(`已批准 ${item.toolName}`),
        onError: (error) => toastError(error),
      },
    );
  };

  if (run.isPending) {
    return (
      <Page>
        <PageHeader title="运行详情" className="sr-only" />
        <LoadingState rows={6} />
      </Page>
    );
  }

  if (run.isError) {
    return (
      <Page>
        <PageHeader title="运行详情" className="sr-only" />
        <Link
          to="/runs"
          className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-fg"
        >
          <ArrowLeft className="size-3.5" /> 返回运行列表
        </Link>
        <ErrorState error={run.error} onRetry={() => void run.refetch()} />
      </Page>
    );
  }

  const { run: detail, steps, conversation } = run.data;
  const hasPrompt = steps.some((step) => step.kind === 'user');
  const start = detail.startedAt ?? steps[0]?.at ?? null;
  const failed = detail.status === 'failed' || detail.status === 'timeout';
  const pending = (approvals.data?.items ?? []).filter((item) => item.approvedAt === null);
  const activeIndex = selected !== null && selected < steps.length ? selected : steps.length - 1;
  const activeStep = steps[activeIndex];

  // 每步耗时：从本步到下一步的时间差；最后一步没有下一步，记为 0。
  const durations = steps.map((step, index) => {
    const next = steps[index + 1];
    if (!next) return 0;
    return Math.max(0, elapsed(next.at, step.at));
  });
  const slowest = Math.max(...durations, 1);

  return (
    <Page>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link
          to="/runs"
          aria-label="返回运行列表"
          className="rounded-icon p-1.5 text-subtle transition-colors hover:bg-hover hover:text-fg"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <PageHeader
          title={`运行 ${shortId(detail.id)}`}
          className="min-w-0 flex-1 gap-x-3 gap-y-2"
          meta={
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {conversation.title ? (
                <span className="hidden min-w-0 max-w-56 truncate text-xs text-subtle sm:block">
                  {conversation.title}
                </span>
              ) : null}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <Metric
                  label="耗时"
                  value={formatDuration(detail.latencyMs)}
                  danger={detail.status === 'timeout'}
                />
                <Metric label="轮次" value={detail.turns ?? '—'} />
                <Metric label="成本" value={formatCost(detail.costUsd)} />
                <Metric
                  label="Tokens"
                  value={`${formatTokens(detail.inputTokens)} / ${formatTokens(detail.outputTokens)}`}
                />
              </div>
            </div>
          }
          actions={
            <>
              <RunStatusBadge status={detail.status} />
              <Button
                variant="outline"
                size="sm"
                className="rounded-full px-3"
                disabled={rerunMutation.isPending || !hasPrompt}
                aria-busy={rerunMutation.isPending}
                onClick={() => void rerun()}
              >
                <RotateCcw className="size-4" />
                {rerunMutation.isPending ? '提交中…' : '重跑'}
              </Button>
            </>
          }
        />
      </div>

      {failed && detail.error ? (
        <div
          role="alert"
          className="flex items-start gap-3 border-y border-danger-line bg-danger-soft px-4 py-3"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">运行{runStatusLabel[detail.status]}</div>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
              {detail.error}
            </pre>
          </div>
          <CopyButton value={detail.error} label="复制错误" />
        </div>
      ) : null}

      {pending.length > 0 ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-y border-warning-line bg-warning-soft px-4 py-2.5"
        >
          <CircleAlert className="size-4 shrink-0 text-warning" />
          <span className="text-xs text-fg">
            有 {pending.length} 个工具等待批准；批准后回到对话页重发上一条消息。
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            {pending.map((item) => {
              // mutation 是全局状态：按当前 mutation 的变量判断是哪一条在批准。
              const approving =
                approveMutation.isPending &&
                approveMutation.variables?.serverId === item.serverId &&
                approveMutation.variables.toolName === item.toolName;
              return (
                <Button
                  key={item.id}
                  size="sm"
                  disabled={approveMutation.isPending}
                  aria-busy={approving}
                  onClick={() => approve(item)}
                >
                  {approving ? '批准中…' : `批准 ${item.toolName}`}
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
        <section className="flex min-w-0 flex-col" aria-label="步骤">
          <div className="flex h-10 items-baseline justify-between border-b border-line">
            <h2 className="text-xs text-subtle">步骤</h2>
            <span className="font-mono text-2xs tabular-nums text-subtle">{steps.length} 步</span>
          </div>
          {steps.length === 0 ? (
            <EmptyState
              title="还没有事件"
              description={
                detail.status === 'queued' || detail.status === 'running'
                  ? '运行尚未产生可回放的消息，稍后自动刷新。'
                  : '该运行没有持久化任何消息。'
              }
            />
          ) : (
            <ol className="flex flex-col">
              {steps.map((step, index) => {
                const meta = stepMeta[step.kind];
                const Icon = meta.icon;
                const duration = durations[index] ?? 0;
                const ratio = Math.max(0.02, duration / slowest);
                const isActive = index === activeIndex;
                const server = stepServerName(step);
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 步骤没有稳定 id，位置即身份
                  <li key={`${index}-${step.at}`}>
                    <button
                      type="button"
                      onClick={() => selectStep(index)}
                      aria-current={isActive ? 'step' : undefined}
                      className={cn(
                        'group flex h-12 w-full items-center gap-2.5 rounded-item px-2 text-left transition-colors hover:bg-hover',
                        isActive && 'bg-hover',
                      )}
                    >
                      <span className="w-5 shrink-0 text-right font-mono text-2xs tabular-nums text-subtle">
                        {index + 1}
                      </span>
                      <Icon aria-hidden="true" className={cn('size-4 shrink-0', meta.tone)} />
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block truncate font-mono text-xs',
                            step.kind === 'tool' ? 'text-fg' : 'text-muted-foreground',
                          )}
                        >
                          {stepName(step)}
                        </span>
                        {server ? (
                          <span className="block truncate text-2xs text-subtle">@ {server}</span>
                        ) : null}
                      </span>
                      {/* 时长条：2px 线，按本次最长步骤归一化，「卡在哪」一眼可见 */}
                      <span
                        aria-hidden="true"
                        className="h-0.5 shrink-0 rounded-full bg-line-strong"
                        style={{ width: `${Math.round(ratio * 56)}px` }}
                      />
                      <span className="w-12 shrink-0 text-right font-mono text-2xs tabular-nums text-subtle">
                        {duration === 0 ? '—' : formatDuration(duration)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className="min-w-0 border-line lg:border-l lg:pl-6" aria-label="步骤详情">
          {activeStep ? (
            <StepInspector step={activeStep} index={activeIndex} start={start} />
          ) : null}
        </section>
      </div>

      <section className="flex flex-col gap-3 border-t border-line pt-5">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-xs text-subtle">运行上下文</h2>
          <span className="text-2xs text-subtle">
            这些值在运行开始时确定，之后修改智能体不影响本次运行
          </span>
        </div>
        <div className="grid gap-x-8 sm:grid-cols-2">
          <ContextRow label="运行 ID" value={detail.id} mono copy />
          <ContextRow label="智能体" value={detail.agentName ?? detail.agentId} />
          <ContextRow label="开始" value={formatDateTime(detail.startedAt)} mono />
          <ContextRow label="结束" value={formatDateTime(detail.endedAt)} mono />
          <ContextRow label="Sandbox" value={detail.sandboxId ?? '—'} mono copy />
          <ContextRow label="Session" value={detail.sessionId ?? '—'} mono copy />
        </div>
      </section>
    </Page>
  );
}

/** 摘要读数：12px 弱标签 + 等宽数字，跟在标题后，不另起一块。 */
function Metric({ label, value, danger }: { label: string; value: ReactNode; danger?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-2xs text-subtle">{label}</span>
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
    <div className="flex h-9 items-center gap-2 border-b border-line">
      <span className="w-20 shrink-0 text-2xs text-subtle">{label}</span>
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
 * 检查器：参数与结果分开。
 * 旧版把 step.content 整块塞进一个代码块，读者无法区分「它传了什么」和「它拿回了什么」——
 * 而这正是可解释性的核心。
 */
function StepInspector({
  step,
  index,
  start,
}: {
  step: RunStep;
  index: number;
  start: string | null;
}) {
  const input = step.kind === 'tool' ? (step.content ?? null) : null;
  const output = step.kind === 'tool' ? (step.result ?? null) : null;
  const nested = step.kind === 'tool' && step.parentToolUseId !== null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-3">
        <span className="font-mono text-2xs tabular-nums text-subtle">#{index + 1}</span>
        <span className="font-mono text-xs text-fg">{stepName(step)}</span>
        <span className="font-mono text-2xs tabular-nums text-subtle">
          {start ? formatDateTime(step.at) : ''}
        </span>
        {nested ? (
          <span className="rounded-tag bg-chip px-1.5 py-0.5 text-2xs text-muted-foreground">
            子智能体内部调用
          </span>
        ) : null}
        {step.kind === 'tool' && step.toolUseId ? (
          <span
            className="rounded-tag bg-chip px-1.5 py-0.5 font-mono text-2xs text-subtle"
            title={step.toolUseId}
          >
            {shortId(step.toolUseId)}
          </span>
        ) : null}
      </div>

      {step.kind === 'assistant' || step.kind === 'user' ? (
        <CollapsibleText
          text={step.text}
          className="whitespace-pre-wrap break-words text-md leading-relaxed text-fg"
        />
      ) : (
        <>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs text-subtle">参数</span>
              {input !== null ? <CopyButton value={prettyJson(input)} label="复制参数" /> : null}
            </div>
            {input !== null ? (
              <CodeBlock code={prettyJson(input)} json maxHeight="18rem" />
            ) : (
              <p className="text-xs text-subtle">这次调用没有参数。</p>
            )}
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs text-subtle">结果</span>
              {output !== null ? <CopyButton value={prettyJson(output)} label="复制结果" /> : null}
            </div>
            {output !== null ? (
              <CodeBlock code={prettyJson(output)} json maxHeight="22rem" />
            ) : (
              <p className="text-xs text-subtle">
                没有结果：可能等待批准、被拒绝，或运行在返回前结束。
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
