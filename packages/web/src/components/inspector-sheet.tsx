import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { guardedOpenChange } from '../lib/dialog-guard.js';
import { Button } from './ui/button.js';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from './ui/sheet.js';

const INSPECTOR_SIZE = {
  sm: 'data-[side=right]:sm:max-w-[480px]',
  md: 'data-[side=right]:sm:max-w-[560px]',
  lg: 'data-[side=right]:sm:max-w-[640px]',
} as const;

export type InspectorSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: ((open: boolean) => void) | undefined;
  title: string;
  description?: ReactNode | undefined;
  eyebrow?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  footer?: ReactNode | undefined;
  size?: 'sm' | 'md' | 'lg' | undefined;
  closeDisabled?: boolean | undefined;
  finalFocus?: ComponentProps<typeof SheetContent>['finalFocus'];
  children: ReactNode;
  className?: string | undefined;
};

export function InspectorSheet({
  open,
  onOpenChange,
  onOpenChangeComplete,
  title,
  description,
  eyebrow,
  actions,
  footer,
  size = 'md',
  closeDisabled = false,
  finalFocus,
  children,
  className,
}: InspectorSheetProps) {
  return (
    <Sheet
      side="right"
      open={open}
      onOpenChange={guardedOpenChange(closeDisabled, () => onOpenChange(false))}
      {...(onOpenChangeComplete === undefined ? {} : { onOpenChangeComplete })}
    >
      <SheetContent
        showCloseButton={false}
        className={cn('gap-0 data-[side=right]:w-full', INSPECTOR_SIZE[size], className)}
        {...(finalFocus === undefined ? {} : { finalFocus })}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SheetTitle>{title}</SheetTitle>
              {eyebrow}
            </div>
            {description ? (
              <SheetDescription className="mt-1 text-sm text-muted-foreground">
                {description}
              </SheetDescription>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {actions}
            <SheetClose
              disabled={closeDisabled}
              render={
                <Button variant="ghost" size="icon-sm" aria-label="关闭" className="-mr-1.5" />
              }
            >
              <X className="size-3" aria-hidden="true" />
            </SheetClose>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {children}
        </div>
        {footer ? <div className="shrink-0 border-t border-line px-5 py-3.5">{footer}</div> : null}
      </SheetContent>
    </Sheet>
  );
}
