import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from './ui/button.js';
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

type DialogShellProps = Pick<
  ComponentProps<typeof DialogContent>,
  'children' | 'className' | 'finalFocus'
> & {
  title: string;
  description?: string;
  closeDisabled?: boolean;
};

export function DialogShell({
  title,
  description,
  children,
  className,
  finalFocus,
  closeDisabled = false,
}: DialogShellProps) {
  return (
    <DialogContent
      className={cn(
        'top-[10vh]! w-[calc(100%-2rem)] max-w-[560px] translate-y-0! gap-0 p-0 sm:max-w-[560px]',
        className,
      )}
      showCloseButton={false}
      finalFocus={finalFocus}
    >
      <DialogHeader className="flex-row items-start justify-between gap-4 border-b px-5 py-3.5">
        <div className="min-w-0">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </div>
        <DialogClose
          disabled={closeDisabled}
          render={<Button variant="ghost" size="icon-sm" aria-label="关闭" />}
        >
          <X aria-hidden="true" />
        </DialogClose>
      </DialogHeader>
      <div className="max-h-[calc(80vh-4rem)] overflow-y-auto px-5 py-4">{children}</div>
    </DialogContent>
  );
}
