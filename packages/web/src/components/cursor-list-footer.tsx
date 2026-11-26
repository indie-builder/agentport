import { cn } from '../lib/cn.js';
import { ErrorState } from './states.js';
import { Button } from './ui/button.js';

export type CursorListFooterQuery = {
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
  showEndLabel = false,
  className,
}: {
  query: CursorListFooterQuery;
  label?: string;
  errorTitle?: string;
  showEndLabel?: boolean;
  className?: string;
}) {
  if (query.isFetchNextPageError) {
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
          重试加载{label}
        </Button>
      </div>
    );
  }
  if (query.hasNextPage) {
    return (
      <div className={cn('flex justify-center', className)}>
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetchingNextPage}
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
