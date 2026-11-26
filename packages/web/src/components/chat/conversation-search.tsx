'use client';

import type { ConversationSearchItem } from '@agentport/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@ui-sdk/react/command';
import { MessageSquare, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { formatRelative } from '../../lib/format.js';
import { chatKeys, useCursorList } from '../../lib/queries.js';
import { useDebouncedValue } from '../../lib/use-debounced-value.js';
import { EmptyState, ErrorState, LoadingState } from '../states.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog.js';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '../ui/input-group.js';

const LIMIT = 20;

export function ConversationSearch({
  open,
  onOpenChange,
  onSelect,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (item: ConversationSearchItem) => void;
  finalFocus?: (() => HTMLElement | null) | undefined;
}) {
  const dialog = useDialogClose(() => onOpenChange(false), open);
  const [input, setInput] = useState('');
  const q = useDebouncedValue(input.trim(), 300);
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const hintsId = useId();
  const client = useQueryClient();

  const queryKey = useMemo(() => chatKeys.search({ ...(q ? { q } : {}), limit: LIMIT }), [q]);
  const previousKey = useRef(queryKey);
  useEffect(() => {
    const previous = previousKey.current;
    if (previous === queryKey) return;
    previousKey.current = queryKey;
    void client.cancelQueries({ queryKey: previous });
  }, [client, queryKey]);

  const search = useCursorList({
    queryKey,
    queryFn: (cursor, signal) =>
      api.searchConversations(
        {
          ...(q ? { q } : {}),
          limit: LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
    enabled: open,
    staleTime: 0,
  });

  const items = useMemo(
    () => search.data?.pages.flatMap((page) => page.items) ?? [],
    [search.data],
  );
  const nextCursor = search.data?.pages.at(-1)?.nextCursor ?? null;
  const firstLoad = search.isPending && items.length === 0;
  const showError = search.isError && !search.isFetchNextPageError && !firstLoad;

  const clear = (): void => {
    setInput('');
    inputRef.current?.focus();
  };

  return (
    <Dialog
      open={dialog.open}
      onOpenChange={(next) => (next ? onOpenChange(true) : dialog.close())}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        {...(finalFocus === undefined ? {} : { finalFocus })}
        className="top-[14vh] flex max-h-[min(70vh,36rem)] w-full max-w-xl translate-y-0 flex-col gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">搜索会话</DialogTitle>
        <Command
          filter={false}
          query={input}
          onQueryChange={setInput}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="shrink-0 p-2 pb-0">
            <InputGroup>
              <InputGroupAddon>
                <Search aria-hidden="true" />
              </InputGroupAddon>
              <CommandInput
                ref={inputRef}
                aria-label="搜索会话"
                aria-describedby={hintsId}
                placeholder="搜索标题、正文或会话 ID…"
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                onKeyDown={(event) => {
                  if (
                    (event.key === 'Enter' || event.key === 'Escape') &&
                    (composing.current ||
                      event.nativeEvent.isComposing ||
                      event.nativeEvent.keyCode === 229)
                  ) {
                    event.preventDefault();
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    dialog.close();
                  }
                }}
                render={
                  <InputGroupInput
                    type="search"
                    className="px-0 [&::-webkit-search-cancel-button]:hidden"
                  />
                }
              />
              {input ? (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="icon-xs" aria-label="清除搜索" onClick={clear}>
                    <X aria-hidden="true" />
                  </InputGroupButton>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
          </div>

          <div className="flex h-9 shrink-0 items-center justify-between px-4 text-xs text-muted-foreground">
            <span>所有专家</span>
            <span aria-hidden="true" className="flex items-center gap-2 tabular-nums">
              <span>↑↓ 选择</span>
              <span>Enter 打开</span>
              <span>{items.length} 个</span>
            </span>
          </div>
          <span id={hintsId} className="sr-only">
            使用上下方向键选择结果，按 Enter 打开，按 Escape 关闭。
          </span>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
            {firstLoad ? <LoadingState rows={3} /> : null}
            {showError ? (
              <div className="p-2">
                <ErrorState error={search.error} onRetry={() => void search.refetch()} />
              </div>
            ) : null}
            <CommandEmpty>
              {!firstLoad && !search.isError ? (
                q ? (
                  <EmptyState
                    variant="filter"
                    scale="inline"
                    title={`未找到包含「${q}」的会话`}
                    description="支持按会话标题、消息正文或会话 ID 检索。"
                    action={
                      <Button variant="outline" size="sm" onClick={clear}>
                        清除搜索
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    variant="idle"
                    scale="inline"
                    icon={<MessageSquare className="size-4" aria-hidden="true" />}
                    title="还没有可搜索的会话"
                    description="与专家发起对话后，标题与正文都会自动纳入检索。"
                  />
                )
              ) : null}
            </CommandEmpty>
            <CommandList className="flex flex-col gap-0.5 p-0">
              {items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.id}
                  onSelect={() => dialog.finish(() => onSelect(item))}
                  className="flex min-w-0 cursor-default flex-col gap-0.5 rounded-item px-2.5 py-2 outline-none select-none data-highlighted:bg-hover"
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">
                      {item.title || '未命名会话'}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{item.agentName}</span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      {formatRelative(item.updatedAt)}
                    </span>
                  </span>
                  {item.match?.excerpt ? (
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {item.match.excerpt}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandList>
          </div>

          {nextCursor && items.length > 0 ? (
            <div className="shrink-0 border-t p-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                disabled={search.isFetchingNextPage}
                aria-busy={search.isFetchingNextPage}
                onClick={() => void search.fetchNextPage()}
              >
                {search.isFetchingNextPage
                  ? '加载中…'
                  : search.isFetchNextPageError
                    ? '加载失败，重试'
                    : '加载更多'}
              </Button>
            </div>
          ) : null}
        </Command>
      </DialogContent>
    </Dialog>
  );
}
