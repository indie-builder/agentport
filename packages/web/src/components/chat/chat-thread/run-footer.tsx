import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChatItem } from '../../../lib/chat-state.js';
import type { ActiveChatPhase, LiveChatPhase } from '../../../lib/chat-store.js';
import { cn } from '../../../lib/cn.js';
import { useRun } from '../../../lib/queries.js';
import type { useChatStream } from '../../../lib/use-chat-stream.js';
import { ErrorState } from '../../states.js';
import { Button } from '../../ui/button.js';

function currentRunItems(items: ChatItem[]): ChatItem[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === 'user') return items.slice(index + 1);
  }
  return items;
}

function runningTool(items: ChatItem[]): Extract<ChatItem, { kind: 'tool' }> | undefined {
  const current = currentRunItems(items);
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const item = current[index];
    if (item?.kind === 'tool' && item.result === undefined) return item;
  }
  return undefined;
}

function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function RunReconciliation({
  phase,
  reconcileRun,
}: {
  phase: ActiveChatPhase;
  reconcileRun: ReturnType<typeof useChatStream>['reconcileRun'];
}) {
  const runQuery = useRun(phase.runId, phase.kind !== 'streaming');
  useEffect(() => {
    if (runQuery.data && (phase.kind !== 'streaming' || runQuery.data.run.status === 'cancelled')) {
      reconcileRun(runQuery.data.run);
    }
  }, [runQuery.data, phase.kind, reconcileRun]);
  return runQuery.isError ? (
    <ErrorState error={runQuery.error} onRetry={() => void runQuery.refetch()} />
  ) : null;
}

export function RunFooter({
  phase,
  items,
  onRetry,
}: {
  phase: LiveChatPhase;
  items: ChatItem[];
  onRetry: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (phase.kind === 'submitting') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  const spinning = phase.kind === 'connecting' || phase.kind === 'recovering';
  const broken = spinning || phase.kind === 'detached';

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 font-mono text-xs tabular-nums text-muted-foreground">
      <span
        className="status-dot shrink-0"
        data-kind={phase.kind === 'detached' ? 'error' : 'running'}
        aria-hidden="true"
      />
      <span className="min-w-0 break-words text-fg">{runStatusText(phase, items)}</span>
      <span aria-hidden="true">·</span>
      <span>{elapsed(now - phase.startedAt)}</span>
      {broken ? (
        <RefreshCw className={cn('size-3', spinning && 'animate-spin')} aria-hidden="true" />
      ) : null}
      {phase.kind === 'detached' ? (
        <Button variant="link" size="none" onClick={onRetry}>
          重连
        </Button>
      ) : null}
    </div>
  );
}

export function runStatusText(phase: LiveChatPhase, items: ChatItem[]): string {
  if (phase.kind === 'submitting') return '任务已提交，正在准备';
  if (phase.kind === 'connecting') {
    return phase.attempt <= 1 ? '正在连接…' : '连接已中断，正在重连';
  }
  if (phase.kind === 'recovering') return '正在读取已保存结果…';
  if (phase.kind === 'detached') return '连接已中断 · 运行状态未知';
  const tool = runningTool(items);
  if (tool?.name === 'AskUserQuestion') return '等待你的回答';
  return tool ? `正在调用 ${tool.name}` : '等待回复';
}
