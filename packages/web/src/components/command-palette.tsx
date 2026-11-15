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
        className="top-[16%] flex max-h-[min(70vh,32rem)] w-full max-w-lg translate-y-0 flex-col gap-0 overflow-hidden p-0 transition-none sm:max-w-lg"
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
            render={<Input className="h-9 rounded-none border-0 border-b px-3" />}
          />
          <CommandEmpty>
            <div className="py-8 text-center text-xs text-muted-foreground">没有匹配的结果</div>
          </CommandEmpty>
          <CommandList className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
            {groups.map((group) => (
              <CommandGroup key={group.label}>
                <CommandGroupLabel className="px-2 pb-1 pt-2 text-xs text-muted-foreground">
                  {group.label}
                </CommandGroupLabel>
                {group.items.map((item) => (
                  <CommandItem
                    key={item.to}
                    value={item.to}
                    label={item.label}
                    className="flex cursor-default items-center gap-2.5 rounded-item px-2 py-1.5 text-sm text-fg outline-none select-none data-highlighted:bg-hover"
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
