import { X } from 'lucide-react';
import * as DialogPrimitive from 'radix-ui/dialog';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

/**
 * shadcn/ui Dialog（radix 版）。
 *
 * 焦点陷阱、Esc、滚动锁、aria 关联全部由 Radix 提供；之前自己实现的版本
 * 在嵌套弹层和 portal 边界上容易出错，这正是「用组件库而不是重复设计」的理由。
 */
interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  /**
   * 关闭后把焦点还给触发元素。Radix 默认会还给它自己的 trigger；
   * 本项目多数调用方用外部按钮打开，因此保留这个入口。
   */
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
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
          returnFocusRef?.current?.focus();
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-[10vh] z-50 w-[calc(100%-2rem)] max-w-[560px] -translate-x-1/2 rounded-[12px] border border-line bg-surface shadow-overlay',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-[15px] font-semibold text-fg">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-xs leading-relaxed text-muted">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close
              aria-label="关闭"
              className="-mr-1 rounded-[7px] p-1.5 text-subtle transition-colors hover:bg-sunken hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
          <div className="max-h-[calc(80vh-4rem)] overflow-y-auto px-5 py-4">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
