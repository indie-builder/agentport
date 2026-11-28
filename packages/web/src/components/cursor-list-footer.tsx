import { errorMessage } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { PageNote } from './page.js';
import { ErrorState } from './states.js';
import { Button } from './ui/button.js';

type CursorListFooterQuery = {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  error?: unknown;
  fetchNextPage: () => Promise<unknown>;
};

export function CursorListFooter({
  query,
  label = '',
  errorTitle,
  errorVariant = 'state',
  showEndLabel = false,
  disabled = false,
  autoDrain = false,
  drainingLabel,
  retryLabel,
  className,
}: {
  query: CursorListFooterQuery;
  label?: string;
  errorTitle?: string;
  errorVariant?: 'state' | 'note';
  showEndLabel?: boolean;
  disabled?: boolean;
  autoDrain?: boolean;
  drainingLabel?: string;
  retryLabel?: string;
  className?: string;
}) {
  if (query.isFetchNextPageError) {
    if (drainingLabel !== undefined && errorTitle === undefined) {
      return (
        <div className={cn('flex flex-wrap items-center gap-3', className)}>
          <span className="text-xs text-muted-foreground">{drainingLabel}</span>
          <Button variant="outline" size="sm" onClick={() => void query.fetchNextPage()}>
            {retryLabel ?? `重试加载${label}`}
          </Button>
        </div>
      );
    }
    if (errorVariant === 'note') {
      return (
        <PageNote
          tone="danger"
          title={errorTitle ?? `更多${label}没有加载出来`}
          {...(query.error == null ? {} : { description: errorMessage(query.error) })}
          action={
            <Button variant="outline" size="sm" onClick={() => void query.fetchNextPage()}>
              {retryLabel ?? '重试'}
            </Button>
          }
        />
      );
    }
    if (errorTitle !== undefined) {
      return (
        <div className={cn('flex justify-center', className)}>
          <ErrorState
            error={query.error}
            onRetry={() => void query.fetchNextPage()}
            title={errorTitle}
          />
        </div>
      );
    }
    return (
      <div className={cn('flex justify-center', className)}>
        <Button variant="outline" size="sm" onClick={() => void query.fetchNextPage()}>
          {retryLabel ?? `重试加载${label}`}
        </Button>
      </div>
    );
  }
  if (query.hasNextPage) {
    if (autoDrain) {
      if (drainingLabel !== undefined) {
        return (
          <div className={cn('flex flex-wrap items-center gap-3', className)}>
            <span className="text-xs text-muted-foreground">{drainingLabel}</span>
          </div>
        );
      }
      return null;
    }
    return (
      <div className={cn('flex justify-center', className)}>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || query.isFetchingNextPage}
          aria-busy={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? '加载中…' : `加载更多${label}`}
        </Button>
      </div>
    );
  }
  if (showEndLabel) {
    return <div className="text-center text-xs text-muted-foreground">已到末尾</div>;
  }
  return null;
}
