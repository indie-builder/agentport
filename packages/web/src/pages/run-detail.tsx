import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Bot, Check, ChevronDown, CircleAlert, Copy, User, Wrench } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { CodeBlock, prettyJson } from '../components/code-block.js';
import { PageHeader } from '../components/page.js';
import { RunStatusBadge } from '../components/run-status-badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Skeleton } from '../components/ui/skeleton.js';
import type { RunStep } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  runStatusLabel,
} from '../lib/format.js';
import { useRun } from '../lib/queries.js';

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

function ToolStep({ step }: { step: Extract<RunStep, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-canvas/60">
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
          <div
            className={cn(
              'whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-[13px] leading-relaxed text-fg/90',
              step.kind === 'user' ? 'border-accent/20 bg-accent/5' : 'border-line bg-surface/60',
            )}
          >
            {step.text}
          </div>
        )}
      </div>
    </li>
  );
}

export function RunDetailPage() {
  const params = useParams({ strict: false }) as { runId: string };
  const run = useRun(params.runId);

  if (run.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-32 w-full" />
        <LoadingState rows={4} />
      </div>
    );
  }

  if (run.isError) {
    return (
      <div>
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
  const firstStepAt = steps[0]?.at ?? null;
  const start = detail.startedAt ?? firstStepAt;
  const failed = detail.status === 'failed' || detail.status === 'timeout';

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
        actions={<RunStatusBadge status={detail.status} />}
      />

      {failed && detail.error ? (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/5 p-3.5"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">运行失败</div>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted">
              {detail.error}
            </pre>
          </div>
          <CopyButton value={detail.error} label="复制错误" />
        </div>
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
