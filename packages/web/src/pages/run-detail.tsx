import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  RotateCcw,
  User,
  Wrench,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { CodeBlock, CollapsibleText, prettyJson } from '../components/code-block.js';
import { PageHeader } from '../components/page.js';
import { RunStatusBadge } from '../components/run-status-badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Skeleton } from '../components/ui/skeleton.js';
import type { ApprovalRequest, RunStep } from '../lib/api.js';
import { api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  runStatusLabel,
} from '../lib/format.js';
import { useRun, useRunApprovals } from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';

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

function Meta({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-20 shrink-0 text-xs text-subtle">{label}</span>
      <span
        className={cn(
          'flex min-w-0 items-center gap-1 break-all text-xs text-fg/90',
          mono && 'font-mono text-[11.5px]',
        )}
      >
        <span className="min-w-0 break-all">{children}</span>
      </span>
    </div>
  );
}

function elapsed(at: string, start: string | null): string {
  const base = new Date(start ?? at).getTime();
  const time = new Date(at).getTime();
  if (Number.isNaN(base) || Number.isNaN(time)) return '';
  const ms = Math.max(0, time - base);
  return ms < 1000 ? `+${ms}ms` : `+${(ms / 1000).toFixed(1)}s`;
}

const stepMeta = {
  user: { icon: User, label: '用户', tone: 'text-accent' },
  assistant: { icon: Bot, label: '助手', tone: 'text-success' },
  tool: { icon: Wrench, label: '工具', tone: 'text-warning' },
} as const;

/** 审批面板只需要这三个字段，直接取 GET /api/runs/:id/approvals 的条目。 */
type ApprovalItem = ApprovalRequest;

function ToolStep({ step }: { step: Extract<RunStep, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const nested = step.parentToolUseId !== null;
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-line bg-canvas/60',
        // 子智能体内部的调用：缩进并加左线，视觉上归属父 Agent 步骤。
        nested && 'ml-6 border-l-2 border-l-accent/40',
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
      >
        <Wrench className="size-3.5 text-warning" />
        <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg">
          {step.name ?? '未知工具'}
        </code>
        {nested ? <Badge variant="accent">子智能体内部调用</Badge> : null}
        {step.toolUseId ? (
          <Badge variant="mono" title={step.toolUseId}>
            {step.toolUseId}
          </Badge>
        ) : null}
        <ChevronDown
          className={cn('size-3.5 text-subtle transition-transform', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div className="border-t border-line p-2">
          <CodeBlock code={prettyJson(step.content)} json maxHeight="28rem" />
        </div>
      ) : null}
    </div>
  );
}

function StepCard({ step, start }: { step: RunStep; start: string | null }) {
  const meta = stepMeta[step.kind];
  const Icon = meta.icon;
  return (
    <li className="relative flex gap-3 pl-0">
      <div className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface">
        <Icon className={cn('size-3.5', meta.tone)} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-[11px] text-subtle">
          <span>{meta.label}</span>
          <span className="font-mono tabular-nums" title={formatDateTime(step.at)}>
            {elapsed(step.at, start)}
          </span>
        </div>
        {step.kind === 'tool' ? (
          <ToolStep step={step} />
        ) : (
          <CollapsibleText
            text={step.text}
            className={cn(
              'whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-[13px] leading-relaxed text-fg/90',
              step.kind === 'user' ? 'border-accent/20 bg-accent/5' : 'border-line bg-surface/60',
            )}
          />
        )}
      </div>
    </li>
  );
}

/** 批准只写审批记录；重试由用户在对话页重新发送消息完成，不做自动恢复。 */
function ApprovalPanel({
  runId,
  items,
  onApproved,
}: {
  runId: string;
  items: ApprovalItem[];
  onApproved: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const approve = (item: ApprovalItem): void => {
    if (pending) return;
    setPending(item.id);
    api
      .approveRun(runId, item.serverId, item.toolName)
      .then(() => {
        toastSuccess(`已批准 ${item.toolName}，回到对话重新发送消息即可继续`);
        onApproved();
      })
      .catch((error) => toastError(error))
      .finally(() => setPending(null));
  };
  return (
    <div
      role="alert"
      className="mb-4 space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3.5"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-fg">
        <CircleAlert className="size-4 shrink-0 text-warning" />
        等待批准的工具
      </div>
      {items.map((item) => (
        <div key={item.id} className="flex flex-wrap items-center gap-2 pl-6 text-xs text-muted">
          <code className="font-mono text-[11.5px] text-fg">{item.toolName}</code>
          {item.serverName ? <span className="text-subtle">@ {item.serverName}</span> : null}
          <Button
            size="sm"
            disabled={pending !== null}
            aria-busy={pending === item.id}
            onClick={() => approve(item)}
          >
            {pending === item.id ? '批准中…' : '批准并重试'}
          </Button>
        </div>
      ))}
      <p className="pl-6 text-[11px] text-subtle">批准后回到对话页重新发送上一条消息。</p>
    </div>
  );
}

export function RunDetailPage() {
  const params = useParams({ strict: false }) as { runId: string };
  const run = useRun(params.runId);
  const approvals = useRunApprovals(params.runId);
  const navigate = useNavigate();
  const [rerunning, setRerunning] = useState(false);

  // 重跑取本次 run 的第一条 user 消息；run 详情接口只返回本次 run 的消息。
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
          className="mb-4 inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <ArrowLeft className="size-3.5" /> 返回运行列表
        </Link>
        <ErrorState error={run.error} onRetry={() => void run.refetch()} />
      </div>
    );
  }

  const { run: detail, steps, conversation } = run.data;
  const hasPrompt = steps.some((step) => step.kind === 'user');
  const firstStepAt = steps[0]?.at ?? null;
  const start = detail.startedAt ?? firstStepAt;
  const failed = detail.status === 'failed' || detail.status === 'timeout';
  const pending = (approvals.data?.items ?? []).filter((item) => item.approvedAt === null);

  return (
    <div>
      <Link
        to="/runs"
        className="mb-4 inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <ArrowLeft className="size-3.5" /> 返回运行列表
      </Link>

      <PageHeader
        title={`运行 ${detail.id}`}
        description={conversation.title || '运行详情与事件时间线'}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <RunStatusBadge status={detail.status} />
            <Button
              variant="outline"
              size="sm"
              disabled={rerunning || !hasPrompt}
              aria-busy={rerunning}
              onClick={() => void rerun()}
            >
              <RotateCcw className="size-3.5" />
              {rerunning ? '提交中…' : '用同样输入重新运行'}
            </Button>
          </div>
        }
      />

      {failed && detail.error ? (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/5 p-3.5"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">这次运行没有完成</div>
            <p className="mt-0.5 text-xs text-muted">
              原因见下方；修正配置或输入后，从对话页重新发起即可。
            </p>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted">
              {detail.error}
            </pre>
          </div>
          <CopyButton value={detail.error} label="复制错误" />
        </div>
      ) : null}

      {pending.length > 0 ? (
        <ApprovalPanel
          runId={detail.id}
          items={pending}
          onApproved={() => void approvals.refetch()}
        />
      ) : null}

      <Card className="mb-6">
        <CardContent className="grid gap-x-8 gap-y-2 p-4 sm:grid-cols-2">
          <Meta label="智能体">
            {detail.agentName ?? detail.agentId}
            <CopyButton value={detail.agentId} label="复制 agent ID" />
          </Meta>
          <Meta label="状态">
            {runStatusLabel[detail.status]}
            {typeof detail.turns === 'number' ? ` · ${detail.turns} 轮` : ''}
          </Meta>
          <Meta label="开始" mono>
            {formatDateTime(detail.startedAt)}
          </Meta>
          <Meta label="结束" mono>
            {formatDateTime(detail.endedAt)}
          </Meta>
          <Meta label="耗时" mono>
            {formatDuration(detail.latencyMs)}
          </Meta>
          <Meta label="成本" mono>
            {formatCost(detail.costUsd)}
          </Meta>
          <Meta label="Tokens" mono>
            {formatTokens(detail.inputTokens)} 输入 / {formatTokens(detail.outputTokens)} 输出
          </Meta>
          <Meta label="轮次" mono>
            {detail.turns ?? '—'}
          </Meta>
          <Meta label="Sandbox" mono>
            {detail.sandboxId ?? '—'}
            {detail.sandboxId ? (
              <CopyButton value={detail.sandboxId} label="复制 sandbox ID" />
            ) : null}
          </Meta>
          <Meta label="Session" mono>
            {detail.sessionId ?? '—'}
            {detail.sessionId ? (
              <CopyButton value={detail.sessionId} label="复制 session ID" />
            ) : null}
          </Meta>
        </CardContent>
      </Card>

      <div className="mb-2.5 flex items-center justify-between">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-subtle">Trace</h2>
        <span className="text-[11px] text-subtle">{steps.length} 步</span>
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
        <ol className="relative space-y-4 before:absolute before:bottom-4 before:left-4 before:top-4 before:w-px before:bg-line">
          {steps.map((step, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: trace 是只追加序列，顺序即身份
            <StepCard key={index} step={step} start={start} />
          ))}
        </ol>
      )}
    </div>
  );
}
