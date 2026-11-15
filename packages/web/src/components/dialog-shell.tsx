import { X } from 'lucide-react';
import { type ComponentProps, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from './ui/button.js';
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';

type DialogShellProps = Pick<ComponentProps<typeof DialogContent>, 'children' | 'className'> & {
  finalFocus?: ComponentProps<typeof DialogContent>['finalFocus'];
  title: string;
  description?: string;
  closeDisabled?: boolean;
  footer?: ReactNode;
};

export function DialogShell({
  title,
  description,
  children,
  className,
  finalFocus,
  closeDisabled = false,
  footer,
}: DialogShellProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyScrolls, setBodyScrolls] = useState(false);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const update = () => setBodyScrolls(el.scrollHeight > el.clientHeight + 1);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, []);

  return (
    <DialogContent
      className={cn(
        'top-[10dvh]! flex max-h-[80dvh] w-[calc(100%-2rem)] max-w-140 translate-y-0! flex-col gap-0 p-0 sm:max-w-140',
        className,
      )}
      showCloseButton={false}
      {...(finalFocus === undefined ? {} : { finalFocus })}
    >
      <DialogHeader className="shrink-0 flex-row items-start justify-between gap-4 border-b px-5 py-3.5">
        <div className="min-w-0">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </div>
        <DialogClose
          disabled={closeDisabled}
          render={<Button variant="ghost" size="icon-sm" aria-label="关闭" />}
        >
          <X className="size-3" aria-hidden="true" />
        </DialogClose>
      </DialogHeader>
      <div
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4"
        onSubmitCapture={({ currentTarget }) => {
          requestAnimationFrame(() => {
            currentTarget.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
          });
        }}
      >
        {children}
      </div>
      {footer ? (
        <div
          data-slot="dialog-footer"
          className={cn('shrink-0 px-5 py-3.5', bodyScrolls && 'border-t')}
        >
          {footer}
        </div>
      ) : null}
    </DialogContent>
  );
}
