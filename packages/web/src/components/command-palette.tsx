import type { AuthMe } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandItemIcon,
  CommandList,
} from '@ui-sdk/react/command';
import { useShortcut, useShortcutHint } from '@ui-sdk/react/shortcuts';
import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  BUILD_MENU,
  canAny,
  type MenuItem,
  OPERATIONS_MENU,
  PERSONAL_NAV_GROUPS,
  PLATFORM_MENU,
  RESOURCE_MENU,
  WORK_MENU,
} from '../lib/access.js';
import { searchQuery } from '../lib/queries.js';
import { SEARCH_KIND_META, SEARCH_KIND_ORDER, searchItemHref } from '../lib/search-meta.js';
import { useDebouncedValue } from '../lib/use-debounced-value.js';
import { EmptyState } from './states.js';
import { Button } from './ui/button.js';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.js';
import { Input } from './ui/input.js';

const OPEN_EVENT = 'command-palette:open';

const COMMAND_SOURCES: readonly { label: string; items: readonly MenuItem[] }[] = [
  { label: '工作', items: WORK_MENU },
  { label: '资源', items: RESOURCE_MENU },
  { label: '构建', items: BUILD_MENU.filter((item) => item.to === '/eval') },
  { label: '运维', items: OPERATIONS_MENU },
  { label: '平台', items: PLATFORM_MENU },
  { label: '个人', items: PERSONAL_NAV_GROUPS.flatMap((group) => group.items) },
];

function openCommandPalette(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

export function CommandPalette({ me }: { me: AuthMe | undefined }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const composing = useRef(false);
  const debouncedQuery = useDebouncedValue(query.trim().slice(0, 128), 200);
  const search = useQuery({
    ...searchQuery(debouncedQuery, 5),
    enabled: open && me?.authenticated === true && debouncedQuery.length > 0,
  });
  const searchGroups = SEARCH_KIND_ORDER.map((kind) => ({
    kind,
    ...SEARCH_KIND_META[kind],
    items: (search.data?.items ?? []).filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);

  useShortcut('mod+k', () => setOpen(true), { description: '打开命令面板' });

  useEffect(() => {
    const show = (): void => setOpen(true);
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, []);

  const seen = new Set<string>();
  const groups = COMMAND_SOURCES.map((group) => ({
    label: group.label,
    items: group.items.filter((item) => {
      if (!me?.authenticated) return false;
      if (item.permissionIds.length > 0 && !canAny(me, item.permissionIds)) return false;
      if (seen.has(item.to)) return false;
      seen.add(item.to);
      return true;
    }),
  })).filter((group) => group.items.length > 0);

  const changeOpen = (next: boolean): void => {
    setOpen(next);
    if (!next) setQuery('');
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        showCloseButton={false}
        animated={false}
        aria-describedby={undefined}
        className="top-[12%] flex max-h-[min(72vh,36rem)] w-full max-w-[calc(100%-2rem)] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-[36rem]"
      >
        <DialogTitle className="sr-only">命令面板</DialogTitle>
        <Command
          filter="contains"
          query={query}
          onQueryChange={setQuery}
          onAction={(to) => {
            changeOpen(false);
            void navigate({ href: to });
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 transition-colors focus-within:border-subtle">
            <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <CommandInput
              autoFocus
              aria-label="搜索页面或操作"
              placeholder="搜索页面或操作…"
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                if (
                  composing.current ||
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229
                ) {
                  event.preventDefault();
                  return;
                }
                event.preventDefault();
                changeOpen(false);
              }}
              render={<Input variant="bare" className="h-11 flex-1" />}
            />
            <span
              aria-hidden="true"
              className="hidden h-[22px] min-w-[22px] items-center justify-center rounded-tag border border-line bg-sunken px-1.5 font-mono text-2xs leading-none text-muted-foreground sm:inline-flex"
            >
              esc
            </span>
          </div>
          <CommandEmpty>
            {debouncedQuery !== '' && (search.isFetching || search.isError) ? null : (
              <EmptyState
                variant="filter"
                scale="inline"
                title={query.trim() ? `没有匹配「${query.trim()}」的页面或内容` : '没有匹配的结果'}
                description="尝试更简短的关键词，或按 Esc 关闭。"
                action={
                  query.trim() ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => setQuery('')}>
                      清空输入
                    </Button>
                  ) : undefined
                }
                secondaryAction={
                  query.trim() ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const target = `/search?${new URLSearchParams({ q: query.trim() }).toString()}`;
                        changeOpen(false);
                        void navigate({ href: target });
                      }}
                    >
                      在搜索页查看全部
                    </Button>
                  ) : undefined
                }
              />
            )}
          </CommandEmpty>
          {debouncedQuery !== '' && search.isFetching ? (
            <div role="status" className="shrink-0 px-4 py-2 text-xs text-muted-foreground">
              搜索中…
            </div>
          ) : null}
          {debouncedQuery !== '' && !search.isFetching && search.isError ? (
            <div
              role="alert"
              className="flex shrink-0 items-center justify-between gap-2 px-4 py-2 text-xs text-danger"
            >
              <span>搜索暂时不可用</span>
              <Button type="button" variant="ghost" size="xs" onClick={() => void search.refetch()}>
                重试
              </Button>
            </div>
          ) : null}
          <CommandList className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
            {debouncedQuery === ''
              ? null
              : searchGroups.map((group) => (
                  <CommandGroup key={group.kind}>
                    <CommandGroupLabel className="px-2 pb-1 pt-3 text-xs font-medium text-muted-foreground">
                      {group.label}
                    </CommandGroupLabel>
                    {group.items.map((item) => {
                      const href = searchItemHref(item);
                      return (
                        <CommandItem
                          key={item.id}
                          value={href}
                          label={item.title}
                          keywords={
                            item.subtitle === ''
                              ? [debouncedQuery]
                              : [item.subtitle, debouncedQuery]
                          }
                          className="flex cursor-default items-center gap-2.5 rounded-item px-2 py-2 text-sm text-fg outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                        >
                          <CommandItemIcon className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                            <group.icon aria-hidden="true" />
                          </CommandItemIcon>
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate">{item.title}</span>
                            {item.subtitle === '' ? null : (
                              <span className="truncate text-xs text-muted-foreground">
                                {item.subtitle}
                              </span>
                            )}
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ))}
            {debouncedQuery === '' ? null : (
              <CommandGroup>
                <CommandItem
                  value={`/search?${new URLSearchParams({ q: debouncedQuery }).toString()}`}
                  label="查看全部搜索结果"
                  keywords={[debouncedQuery]}
                  className="flex cursor-default items-center gap-2.5 rounded-item px-2 py-2 text-sm text-fg outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <CommandItemIcon className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                    <Search aria-hidden="true" />
                  </CommandItemIcon>
                  <span className="truncate">查看全部搜索结果</span>
                </CommandItem>
              </CommandGroup>
            )}
            {groups.map((group) => (
              <CommandGroup key={group.label}>
                <CommandGroupLabel className="px-2 pb-1 pt-3 text-xs font-medium text-muted-foreground">
                  {group.label}
                </CommandGroupLabel>
                {group.items.map((item) => (
                  <CommandItem
                    key={item.to}
                    value={item.to}
                    label={item.label}
                    className="flex cursor-default items-center gap-2.5 rounded-item px-2 py-2 text-sm text-fg outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                  >
                    <CommandItemIcon className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                      <item.icon aria-hidden="true" />
                    </CommandItemIcon>
                    <span className="truncate">{item.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          <div
            aria-hidden="true"
            className="flex shrink-0 items-center gap-3 border-t border-line px-4 py-2 text-xs text-muted-foreground"
          >
            <span className="flex items-center gap-1.5">
              <kbd className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-tag border border-line bg-sunken px-1.5 font-mono text-2xs leading-none text-fg">
                ↑↓
              </kbd>
              选择
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-tag border border-line bg-sunken px-1.5 font-mono text-2xs leading-none text-fg">
                ↵
              </kbd>
              打开
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-tag border border-line bg-sunken px-1.5 font-mono text-2xs leading-none text-fg">
                esc
              </kbd>
              关闭
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export function CommandPaletteTrigger() {
  const hint = useShortcutHint('mod+k');
  return (
    <Button
      variant="nav"
      size="nav"
      aria-label={`搜索（${hint.text}）`}
      aria-keyshortcuts={hint.ariaKeyshortcuts}
      onClick={openCommandPalette}
      className="w-full"
    >
      <span className="flex w-full min-w-0 items-center gap-2.5">
        <Search aria-hidden="true" className="shrink-0" />
        <span className="truncate">搜索…</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{hint.text}</span>
      </span>
    </Button>
  );
}
