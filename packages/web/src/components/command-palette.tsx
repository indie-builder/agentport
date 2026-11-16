import type { AuthMe } from '@agentport/shared';
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
import { cn } from '../lib/cn.js';
import { Button } from './ui/button.js';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.js';
import { Input } from './ui/input.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js';

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
  const composing = useRef(false);

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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="top-[12%] flex max-h-[min(72vh,36rem)] w-full max-w-[calc(100%-2rem)] translate-y-0 flex-col gap-0 overflow-hidden p-0 transition-none sm:max-w-[36rem]"
      >
        <DialogTitle className="sr-only">命令面板</DialogTitle>
        <Command
          filter="contains"
          onAction={(to) => {
            setOpen(false);
            void navigate({ to });
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 transition-colors focus-within:border-[var(--color-subtle)]">
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
                setOpen(false);
              }}
              render={
                <Input className="h-11 flex-1 rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:border-0" />
              }
            />
            <span
              aria-hidden="true"
              className="hidden h-[22px] min-w-[22px] items-center justify-center rounded-tag border border-line bg-sunken px-1.5 font-mono text-2xs leading-none text-muted-foreground sm:inline-flex"
            >
              esc
            </span>
          </div>
          <CommandEmpty>
            <div className="py-12 text-center text-sm text-muted-foreground">没有匹配的结果</div>
          </CommandEmpty>
          <CommandList className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
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
                    className="flex cursor-default items-center gap-2.5 rounded-item px-2.5 py-2 text-sm text-fg outline-none select-none data-highlighted:bg-hover"
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

export function CommandPaletteTrigger({
  collapsed,
  tooltipDisabled,
}: {
  collapsed: boolean;
  tooltipDisabled: boolean;
}) {
  const hint = useShortcutHint('mod+k');
  const trigger = (
    <Button
      variant="ghost"
      aria-label={`搜索（${hint.text}）`}
      aria-keyshortcuts={hint.ariaKeyshortcuts}
      onClick={openCommandPalette}
      className={cn(
        'h-8 text-sm text-fg hover:bg-sidebar-hover',
        collapsed ? 'size-8 rounded-tag p-0' : 'w-full justify-start gap-2.5 rounded-item px-2',
      )}
    >
      <Search aria-hidden="true" className="shrink-0" />
      {collapsed ? null : (
        <>
          <span className="truncate">搜索…</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{hint.text}</span>
        </>
      )}
    </Button>
  );
  return (
    <Tooltip disabled={tooltipDisabled} delay={400}>
      <TooltipTrigger render={trigger} />
      <TooltipContent side="right" sideOffset={8}>
        搜索（{hint.text}）
      </TooltipContent>
    </Tooltip>
  );
}
