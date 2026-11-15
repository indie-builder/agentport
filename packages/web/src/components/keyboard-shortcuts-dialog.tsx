import { ariaKeyshortcuts, formatShortcut, shortcuts, useShortcut } from '@ui-sdk/react/shortcuts';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { DialogShell } from './dialog-shell.js';
import { Dialog } from './ui/dialog.js';

const isMac = formatShortcut('mod').includes('⌘');
const modifierLabels: Record<string, string> = {
  Meta: isMac ? '⌘' : 'Ctrl',
  Control: isMac ? '⌃' : 'Ctrl',
  Alt: isMac ? '⌥' : 'Alt',
  Shift: isMac ? '⇧' : 'Shift',
};
const keyLabels: Record<string, string> = {
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: isMac ? '⌫' : 'Backspace',
  Delete: isMac ? '⌦' : 'Del',
  Tab: 'Tab',
  Space: 'Space',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Home: 'Home',
  End: 'End',
};
const keyLabel = (token: string): string => {
  const canonical = ariaKeyshortcuts(token);
  return modifierLabels[canonical] ?? keyLabels[canonical] ?? canonical;
};

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-tag border border-line bg-sunken px-1.5 font-mono text-2xs leading-none text-fg">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ReturnType<typeof shortcuts.list>>([]);

  useShortcut(
    'shift+?',
    () => {
      setItems(shortcuts.list());
      setOpen(true);
    },
    { description: '键盘快捷键' },
  );

  const groups = [
    {
      title: '全局',
      items: items.flatMap((item) =>
        item.description ? [{ label: item.description, keys: item.keys }] : [],
      ),
    },
    {
      title: '对话输入',
      items: [
        { label: '发送消息', keys: 'enter' },
        { label: '换行', keys: 'shift+enter' },
      ],
    },
    {
      title: '通用',
      items: [{ label: '关闭弹层', keys: 'escape' }],
    },
  ].filter((group) => group.items.length > 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogShell title="键盘快捷键">
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <section key={group.title} className="flex flex-col gap-1">
              <h3 className="text-xs text-muted-foreground">{group.title}</h3>
              {group.items.map((item) => (
                <div key={item.keys} className="flex items-center justify-between gap-4 py-1.5">
                  <span className="text-sm text-fg">{item.label}</span>
                  <span className="flex items-center gap-1">
                    {item.keys.split('+').map((token) => (
                      <Kbd key={token}>{keyLabel(token)}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </DialogShell>
    </Dialog>
  );
}
