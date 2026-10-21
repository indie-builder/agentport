import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.js';
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  Dialog as DialogRoot,
  DialogTitle,
} from './dialog.js';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  returnFocusRef?: { current: HTMLElement | null };
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
  returnFocusRef,
}: DialogProps) {
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        // 项目尺寸：底座默认是居中的 sm 弹层，这里固定为 560px / 10vh 的对话框形态。
        className={cn('top-[10vh]! max-w-[560px]! translate-y-0! sm:max-w-[560px]!', className)}
        showCloseButton={false}
        finalFocus={returnFocusRef}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
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
        </div>
        <div className="max-h-[calc(80vh-4rem)] overflow-y-auto px-5 py-4">{children}</div>
      </DialogContent>
    </DialogRoot>
  );
}
