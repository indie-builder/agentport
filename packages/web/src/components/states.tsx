import { CircleAlert, Inbox, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { errorMessage } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { Button } from './ui/button.js';
import { Skeleton } from './ui/skeleton.js';

export function LoadingState({
  rows = 3,
  layout = 'rows',
}: {
  rows?: number;
  layout?: 'rows' | 'cards' | 'list';
}) {
  if (layout === 'list') {
    return (
      <div role="status" aria-busy="true" aria-label="加载中" className="@container">
        <div className="grid grid-cols-1 gap-x-6 gap-y-0.5 @4xl:grid-cols-2">
          {Array.from({ length: rows }, (_, i) => (
            <Skeleton
              // biome-ignore lint/suspicious/noArrayIndexKey: 骨架屏是静态占位
              key={i}
              className="h-14.5 w-full rounded-item"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        layout === 'cards'
          ? 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,256px),1fr))] gap-4 p-2'
          : 'flex flex-col gap-2'
      }
      aria-busy="true"
      aria-label="加载中"
      role="status"
    >
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: 骨架屏是静态占位
          key={i}
          className={layout === 'cards' ? 'h-52 w-full rounded-card' : 'h-11 w-full'}
        />
      ))}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = '内容没有加载出来',
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-card border border-line bg-danger-soft p-3.5 text-sm"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-fg">{title}</div>
        <div className="mt-0.5 break-words text-sm text-muted-foreground">
          {errorMessage(error)}
        </div>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-3.5" aria-hidden="true" /> 重试
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  illustration,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  illustration?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-card px-6 py-14 text-center',
        className,
      )}
    >
      {illustration ?? (
        <div className="flex size-10 items-center justify-center rounded-full bg-sunken text-subtle">
          {icon ?? <Inbox className="size-5" />}
        </div>
      )}
      <div className="mt-1 text-sm font-medium text-fg">{title}</div>
      {description ? (
        <div className="max-w-sm text-sm text-muted-foreground">{description}</div>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function InlineEmpty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-6 text-center text-xs text-muted-foreground">{children}</div>;
}
