import { createMenuController } from '@ui-sdk/react/menu';
import {
  EllipsisVertical,
  GitBranch,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Search,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { Button } from '../../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { cn } from '../../lib/cn.js';
import { formatRelative } from '../../lib/format.js';

export interface HistoryEntry {
  id: string;
  title: string;
  updatedAt: string;
}

export function HistoryPanel({
  history,
  pending,
  error,
  onRetry,
  conversationId,
  branching,
  onOpen,
  onBranch,
  onOpenSearch,
  onRename,
  hasNextPage,
  loadingMore,
  onLoadMore,
}: {
  history: HistoryEntry[];
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  conversationId: string | null;
  branching: string | null;
  onOpen: (id: string) => void;
  onBranch: (id: string) => void;
  onOpenSearch: (trigger: HTMLElement) => void;
  onRename: (conversation: HistoryEntry, trigger: HTMLElement) => void;
  hasNextPage: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const [menu] = useState(() => createMenuController<HistoryEntry>());
  return (
    <>
      <div className="shrink-0 px-3">
        <Button
          variant="outline"
          onClick={(event) => onOpenSearch(event.currentTarget)}
          className="h-8 w-full justify-start gap-2 px-2.5 font-normal text-muted-foreground"
        >
          <Search aria-hidden="true" className="size-4" />
          <span className="min-w-0 flex-1 truncate text-left text-sm">搜索全部会话</span>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {pending ? <LoadingState rows={4} /> : null}
        {error ? <ErrorState error={error} onRetry={onRetry} /> : null}
        {history.length === 0 && !pending && !error ? (
          <EmptyState
            variant="idle"
            scale="panel"
            icon={<MessageSquare className="size-5" aria-hidden="true" />}
            title="还没有历史对话"
            description="发出第一条消息后，会话会自动保存在这里。"
          />
        ) : null}
        <ul className="flex flex-col gap-0.5">
          {history.map((conversation) => (
            <li key={conversation.id} className="group relative">
              <Button
                variant="ghost"
                aria-current={conversation.id === conversationId ? 'true' : undefined}
                onClick={() => onOpen(conversation.id)}
                className={cn(
                  'h-auto w-full min-w-0 flex-col items-start gap-0 whitespace-normal px-2.5 py-2 pr-8 text-left font-normal',
                  conversation.id === conversationId
                    ? 'bg-selected text-selected-foreground hover:bg-selected hover:text-selected-foreground'
                    : 'text-muted-foreground hover:bg-hover',
                )}
              >
                <span className="block w-full truncate text-sm">{conversation.title}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {formatRelative(conversation.updatedAt)}
                </span>
              </Button>
              <DropdownMenuTrigger
                controller={menu}
                payload={conversation}
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`操作「${conversation.title}」`}
                    disabled={branching !== null}
                    className="absolute right-1 top-2.5 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:transition-opacity [@media(hover:hover)_and_(pointer:fine)]:duration-150 ease-out-soft focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-open:opacity-100"
                    onFocus={(event) => {
                      menuTriggerRef.current = event.currentTarget;
                    }}
                    onPointerDown={(event) => {
                      menuTriggerRef.current = event.currentTarget;
                    }}
                    onClick={(event) => {
                      menuTriggerRef.current = event.currentTarget;
                    }}
                  >
                    {branching === conversation.id ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <EllipsisVertical className="size-3.5" />
                    )}
                  </Button>
                }
              />
            </li>
          ))}
        </ul>
        {hasNextPage ? (
          <div className="flex justify-center px-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={loadingMore}
              aria-busy={loadingMore}
              onClick={onLoadMore}
            >
              {loadingMore ? '加载中…' : '加载更多'}
            </Button>
          </div>
        ) : null}
      </div>
      <DropdownMenu controller={menu}>
        <DropdownMenuContent align="end" sideOffset={4} className="w-40">
          {(state) => {
            const conversation = state.payload as HistoryEntry | undefined;
            if (!conversation) return null;
            return (
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onSelect={() => {
                    if (menuTriggerRef.current) {
                      onRename(conversation, menuTriggerRef.current);
                    }
                  }}
                >
                  <Pencil /> 重命名
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={branching !== null}
                  onSelect={() => onBranch(conversation.id)}
                >
                  {branching === conversation.id ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <GitBranch />
                  )}
                  分支
                </DropdownMenuItem>
              </DropdownMenuGroup>
            );
          }}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
