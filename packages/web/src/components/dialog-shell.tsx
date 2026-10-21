import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
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
};

export function DialogShell({
  title,
  description,
  children,
  className,
  finalFocus,
}: DialogShellProps) {
  return (
    <DialogContent
      className={cn('top-[10vh]! max-w-[560px]! translate-y-0! sm:max-w-[560px]!', className)}
      showCloseButton={false}
      finalFocus={finalFocus}
    >
      <DialogHeader className="flex-row items-start justify-between gap-4 border-b border-line px-5 py-3.5">
        <div className="min-w-0">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </div>
        <DialogClose
          aria-label="关闭"
          className="-mr-1 rounded-icon p-1.5 text-subtle transition-colors hover:bg-sunken hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg"
        >
          <X className="size-4" />
        </DialogClose>
      </DialogHeader>
      <div className="max-h-[calc(80vh-4rem)] overflow-y-auto px-5 py-4">{children}</div>
    </DialogContent>
  );
}
