'use client';

import type { ConversationSearchItem } from '@agentport/shared';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatRelative } from '../lib/format.js';
import { searchConversationsOptions } from '../lib/queries.js';
import { useDebouncedValue } from '../lib/use-debounced-value.js';
import { ErrorState, LoadingState } from './states.js';
import { Button } from './ui/button.js';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.js';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from './ui/input-group.js';

const LIMIT = 20;

/**
 * 全局会话搜索浮层：历史面板与聊天头部的收起入口共用同一实例。
 * 列表由服务端检索（标题 / ID / 正文），空 q 返回最近会话；本地不再二次过滤。
 */
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
  const [input, setInput] = useState('');
  const q = useDebouncedValue(input.trim(), 300);
  const inputRef = useRef<HTMLInputElement>(null);
  // Base UI 只维护列表内部索引；Enter 要选的是用户眼前真正高亮的那一项。
  const highlighted = useRef<ConversationSearchItem | undefined>(undefined);
  // Enter 与 Base UI 合成 click 可能同一次按键各触发一次，选择只认第一次。
  const choosing = useRef(false);
  const hintsId = useId();
  const client = useQueryClient();

  const options = useMemo(
    () => searchConversationsOptions({ ...(q ? { q } : {}), limit: LIMIT }),
    [q],
  );
  // 换查询时取消上一轮请求：旧结果即使晚到也不能替换当前列表。
  // 只在 key 真正变化时取消，StrictMode 的挂载重放不会掐掉首次请求。
  const previousOptions = useRef(options);
  useEffect(() => {
    const previous = previousOptions.current;
    if (previous === options) return;
    previousOptions.current = options;
    void client.cancelQueries({ queryKey: previous.queryKey });
  }, [client, options]);

  const search = useInfiniteQuery({ ...options, enabled: open });

  const items = useMemo(
    () => search.data?.pages.flatMap((page) => page.items) ?? [],
    [search.data],
  );
  const nextBefore = search.data?.pages.at(-1)?.nextBefore ?? null;
  const firstLoad = search.isPending && items.length === 0;
  // 已有缓存时重取失败也要报错并提供重试，但保留旧列表；下页失败交给按钮自己提示。
  const showError = search.isError && !search.isFetchNextPageError && !firstLoad;

  const clear = (): void => {
    setInput('');
    inputRef.current?.focus();
  };

  const choose = (item: ConversationSearchItem): void => {
    if (choosing.current) return;
    choosing.current = true;
    onSelect(item);
    queueMicrotask(() => {
      choosing.current = false;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        finalFocus={finalFocus}
        className="top-[14vh] flex max-h-[min(70vh,36rem)] w-full max-w-xl translate-y-0 flex-col gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">搜索会话</DialogTitle>
        <Autocomplete.Root
          inline
          open
          items={items}
          filter={null}
          autoHighlight="always"
          keepHighlight
          value={input}
          onValueChange={(value) => {
            if (choosing.current) return;
            setInput(value);
          }}
          onItemHighlighted={(item) => {
            highlighted.current = item;
          }}
          itemToStringValue={(item: ConversationSearchItem) => item.id}
        >
          <div className="shrink-0 p-2 pb-0">
            <InputGroup className="rounded-none border-0 border-b border-line">
              <InputGroupAddon>
                <Search aria-hidden="true" />
              </InputGroupAddon>
              <Autocomplete.Input
                ref={inputRef}
                aria-label="搜索会话"
                aria-describedby={hintsId}
                placeholder="搜索标题、正文或会话 ID…"
                onKeyDown={(event) => {
                  if (
                    event.key !== 'Enter' ||
                    event.nativeEvent.isComposing ||
                    event.nativeEvent.keyCode === 229
                  ) {
                    return;
                  }
                  const item = highlighted.current;
                  if (!item) return;
                  // Base UI 的 Enter 会合成一次 item click；这里先走同一条选择路径，
                  // choosing 保证两种来源只导航一次。
                  event.preventDefault();
                  choose(item);
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
            <Autocomplete.Empty>
              {!firstLoad && !search.isError ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <p className="text-xs text-muted-foreground">
                    {q ? '没有匹配的会话' : '还没有会话'}
                  </p>
                  {q ? (
                    <Button variant="outline" size="sm" onClick={clear}>
                      清除搜索
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </Autocomplete.Empty>
            <Autocomplete.List className="flex flex-col gap-0.5 p-0">
              {(item: ConversationSearchItem) => (
                <Autocomplete.Item
                  key={item.id}
                  value={item}
                  onClick={() => choose(item)}
                  className="flex min-w-0 cursor-default flex-col gap-0.5 rounded-item px-2.5 py-2 outline-none select-none data-highlighted:bg-hover"
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">
                      {item.title || '未命名会话'}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{item.agentName}</span>
                    <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                      {formatRelative(item.updatedAt)}
                    </span>
                  </span>
                  {item.match?.excerpt ? (
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {item.match.excerpt}
                    </span>
                  ) : null}
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </div>

          {nextBefore && items.length > 0 ? (
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
        </Autocomplete.Root>
      </DialogContent>
    </Dialog>
  );
}
