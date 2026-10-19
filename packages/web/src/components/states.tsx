import { CircleAlert, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { errorMessage } from '../lib/api.js';
import { Button } from './ui/button.js';
import { Skeleton } from './ui/skeleton.js';

export function LoadingState({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="加载中" role="status">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 骨架屏是静态占位
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-300">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="flex-1">
        <div className="font-medium">加载失败</div>
        <div className="mt-0.5 text-xs text-red-400/80">{errorMessage(error)}</div>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string | undefined;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 px-6 py-12 text-center">
      <Inbox className="size-6 text-zinc-600" />
      <div className="text-sm font-medium text-zinc-300">{title}</div>
      {description ? <div className="max-w-sm text-xs text-zinc-500">{description}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
