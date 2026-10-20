import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Bot, Check, CircleAlert, Copy, RotateCcw, User, Wrench } from 'lucide-react';
import { useState } from 'react';
import { CodeBlock, CollapsibleText, prettyJson } from '../components/code-block.js';
import { Page, PageHeader, PageSection, Readout } from '../components/page.js';
import { RunStatusBadge } from '../components/run-status-badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Skeleton } from '../components/ui/skeleton.js';
import type { ApprovalRequest, RunStep } from '../lib/api.js';
import { api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  shortId,
} from '../lib/format.js';
import { useRun, useRunApprovals } from '../lib/queries.js';
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
  user: { icon: User, label: '用户', tone: 'text-muted' },
  assistant: { icon: Bot, label: '助手', tone: 'text-success' },
  tool: { icon: Wrench, label: '工具', tone: 'text-signal-text' },
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
  const params = useParams({ strict: false }) as { runId: string };
  const search = useSearch({ strict: false }) as { step?: string };
  const run = useRun(params.runId);
  const approvals = useRunApprovals(params.runId);
  const navigate = useNavigate();
  const [rerunning, setRerunning] = useState(false);
  const [selected, setSelected] = useState<number | null>(
    search.step === undefined ? null : Number(search.step),
  );

  const rerun = async (): Promise<void> => {
    if (!run.data || rerunning) return;
    const { run: detail, steps } = run.data;
    const prompt = steps.find((step) => step.kind === 'user')?.text;
    if (!prompt) {
      toastError(new Error('这次运行没有可重发的用户消息。'));
      return;
    }
    setRerunning(true);
    try {
      const accepted = await api.sendChat({
        agentId: detail.agentId,
        conversationId: detail.conversationId,
        message: prompt,
      });
      await navigate({ to: '/runs/$runId', params: { runId: accepted.runId } });
    } catch (error) {
      toastError(error);
    } finally {
      setRerunning(false);
    }
  };

  const approve = (item: ApprovalItem): void => {
    if (!run.data) return;
    api
      .approveRun(run.data.run.id, item.serverId, item.toolName)
      .then(() => {
        toastSuccess(`已批准 ${item.toolName}`);
        void approvals.refetch();
      })
      .catch((error) => toastError(error));
  };

  if (run.isPending) {
    return (
      <div className="space-y-4">
        <h1 className="sr-only">运行详情</h1>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-32 w-full" />
        <LoadingState rows={4} />
      </div>
    );
  }

  if (run.isError) {
    return (
      <div>
        <h1 className="sr-only">运行详情</h1>
        <Link
          to="/runs"
          className="mb-4 inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
        >
          <ArrowLeft className="size-3.5" /> 返回运行列表
        </Link>
        <ErrorState error={run.error} onRetry={() => void run.refetch()} />
      </div>
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
      <PageHeader
        title={`运行 ${shortId(detail.id)}`}
        description={conversation.title || '运行详情与步骤'}
        meta={
          <>
            <Readout
              label="耗时"
              value={formatDuration(detail.latencyMs)}
              tone={detail.status === 'timeout' ? 'danger' : 'default'}
            />
            <Readout label="轮次" value={detail.turns ?? '—'} />
            <Readout label="成本" value={formatCost(detail.costUsd)} />
            <Readout
              label="Tokens"
              value={`${formatTokens(detail.inputTokens)} / ${formatTokens(detail.outputTokens)}`}
            />
          </>
        }
        actions={
          <>
            <RunStatusBadge status={detail.status} />
            <Button
              variant="outline"
              size="sm"
              disabled={rerunning || !hasPrompt}
              aria-busy={rerunning}
              onClick={() => void rerun()}
            >
              <RotateCcw className="size-3.5" />
              {rerunning ? '提交中…' : '重跑'}
            </Button>
          </>
        }
      />

      {failed && detail.error ? (
        <div
          role="alert"
          className="flex items-start gap-3 border-y border-danger-line bg-danger-soft px-4 py-3"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">运行{failureLabel(detail.status)}</div>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted">
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
            {pending.map((item) => (
              <Button key={item.id} size="sm" onClick={() => approve(item)}>
                批准 {item.toolName}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
        <section className="flex min-w-0 flex-col gap-2" aria-label="步骤">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-fg">步骤</h2>
            <span className="font-mono text-2xs text-subtle">{steps.length} 步</span>
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
                      onClick={() => setSelected(index)}
                      aria-current={isActive ? 'step' : undefined}
                      className={cn(
                        'group relative flex w-full items-center gap-2.5 border-b border-line py-2 pr-2 text-left transition-colors hover:bg-sunken/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal',
                        isActive && 'bg-sunken/60',
                      )}
                    >
                      {/* 选中标记：左侧 2px 信号条 */}
                      <span
                        aria-hidden="true"
                        className={cn(
                          'absolute left-0 top-1 h-[calc(100%-0.5rem)] w-[2px]',
                          isActive ? 'bg-signal' : 'bg-transparent',
                        )}
                      />
                      <span className="w-6 shrink-0 pl-2 text-right font-mono text-2xs tabular-nums text-subtle">
                        {index + 1}
                      </span>
                      <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', meta.tone)} />
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block truncate font-mono text-xs',
                            step.kind === 'tool' ? 'text-fg' : 'text-muted',
                          )}
                        >
                          {stepName(step)}
                        </span>
                        {server ? (
                          <span className="block truncate text-2xs text-subtle">@ {server}</span>
                        ) : null}
                      </span>
                      {/* 时长条：按本次最长步骤归一化，「卡在哪」一眼可见 */}
                      <span
                        aria-hidden="true"
                        className="h-1 shrink-0 rounded-[1px] bg-line-strong/50"
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

        <section className="min-w-0" aria-label="步骤详情">
          {activeStep ? (
            <StepInspector step={activeStep} index={activeIndex} start={start} />
          ) : null}
        </section>
      </div>

      <PageSection
        title="运行上下文"
        description="这些值在运行开始时确定，之后修改智能体不影响本次运行"
      >
        <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          <ContextRow label="运行 ID" value={detail.id} mono copy />
          <ContextRow label="智能体" value={detail.agentName ?? detail.agentId} />
          <ContextRow label="开始" value={formatDateTime(detail.startedAt)} mono />
          <ContextRow label="结束" value={formatDateTime(detail.endedAt)} mono />
          <ContextRow label="Sandbox" value={detail.sandboxId ?? '—'} mono copy />
          <ContextRow label="Session" value={detail.sessionId ?? '—'} mono copy />
        </div>
      </PageSection>
    </Page>
  );
}

function failureLabel(status: string): string {
  if (status === 'timeout') return '超时';
  if (status === 'cancelled') return '已取消';
  return '失败';
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
    <div className="flex items-center gap-2 border-b border-line py-1.5 last:border-0">
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
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line pb-2">
        <span className="font-mono text-2xs text-subtle">#{index + 1}</span>
        <span className="font-mono text-sm text-fg">{stepName(step)}</span>
        <span className="font-mono text-2xs tabular-nums text-subtle">
          {start ? formatDateTime(step.at) : ''}
        </span>
        {nested ? <Badge variant="accent">子智能体内部调用</Badge> : null}
        {step.kind === 'tool' && step.toolUseId ? (
          <Badge variant="mono" title={step.toolUseId}>
            {shortId(step.toolUseId)}
          </Badge>
        ) : null}
      </div>

      {step.kind === 'assistant' || step.kind === 'user' ? (
        <CollapsibleText
          text={step.text}
          className="whitespace-pre-wrap break-words text-base leading-relaxed text-fg"
        />
      ) : (
        <>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-2xs font-medium uppercase tracking-[0.06em] text-subtle">
                参数
              </span>
              {input !== null ? <CopyButton value={prettyJson(input)} label="复制参数" /> : null}
            </div>
            {input !== null ? (
              <CodeBlock code={prettyJson(input)} json maxHeight="18rem" />
            ) : (
              <p className="text-xs text-subtle">这次调用没有参数。</p>
            )}
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-2xs font-medium uppercase tracking-[0.06em] text-subtle">
                结果
              </span>
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
