import { shortcuts, useShortcut } from '@ui-sdk/react/shortcuts';
import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.js';

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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="gap-2 transition-none sm:max-w-md"
      >
        <DialogTitle>键盘快捷键</DialogTitle>
        <ul className="-mx-2 max-h-[min(60vh,28rem)] overflow-y-auto">
          {items
            .filter((item) => item.description)
            .map((item) => (
              <li
                key={item.keys}
                className="flex items-center justify-between gap-4 px-2 py-1.5"
              >
                <span className="text-sm text-fg">{item.description}</span>
                <kbd className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {item.hint}
                </kbd>
              </li>
            ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
