'use client';

import {
  DialogBackdrop as SheetBackdropPrimitive,
  DialogClose as SheetClosePrimitive,
  DialogContent as SheetContentPrimitive,
  DialogDescription as SheetDescriptionPrimitive,
  Dialog as SheetPrimitive,
  DialogTitle as SheetTitlePrimitive,
} from '@ui-sdk/react/dialog';
import { cn } from 'cn';
import { XIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { buttonVariants } from './button.js';

const Sheet = SheetPrimitive;
const SheetClose = SheetClosePrimitive;

type SheetOverlayProps = Omit<ComponentProps<typeof SheetBackdropPrimitive>, 'className'> & {
  className?: string | undefined;
};

function SheetOverlay({ className, ...props }: SheetOverlayProps) {
  return (
    <SheetBackdropPrimitive
      render={<div data-slot="sheet-overlay" />}
      className={cn(
        'fixed inset-0 z-50 bg-scrim transition-opacity duration-150 ease-out-soft data-ending-style:opacity-0 data-starting-style:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

type SheetContentProps = Omit<
  ComponentProps<typeof SheetContentPrimitive>,
  'className' | 'children' | 'side'
> & {
  className?: string | undefined;
  children?: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  showCloseButton?: boolean | undefined;
};

function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton = true,
  ...props
}: SheetContentProps) {
  return (
    <>
      <SheetOverlay />
      <SheetContentPrimitive
        data-side={side}
        className={cn(
          'fixed inset-auto z-50 m-0 flex max-h-none flex-col gap-4 overflow-visible rounded-none border-0 bg-popover bg-clip-padding p-0 text-sm text-popover-foreground shadow-lg cds-overlay-enter data-ending-style:opacity-0 data-starting-style:opacity-0 data-[side=bottom]:bottom-0 data-[side=bottom]:left-0 data-[side=bottom]:right-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:bottom-0 data-[side=left]:left-0 data-[side=left]:top-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:bottom-0 data-[side=right]:right-0 data-[side=right]:top-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=top]:left-0 data-[side=top]:right-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetClosePrimitive
            render={
              <button
                type="button"
                data-slot="sheet-close"
                className={buttonVariants({
                  variant: 'ghost',
                  size: 'icon-sm',
                  className: 'absolute top-3 right-3',
                })}
              />
            }
          >
            <XIcon className="size-3" />
            <span className="sr-only">关闭</span>
          </SheetClosePrimitive>
        )}
      </SheetContentPrimitive>
    </>
  );
}

type SheetTitleProps = Omit<ComponentProps<typeof SheetTitlePrimitive>, 'className'> & {
  className?: string | undefined;
};

function SheetTitle({ className, ...props }: SheetTitleProps) {
  return (
    <SheetTitlePrimitive
      className={cn('text-base font-medium text-foreground', className)}
      {...props}
    />
  );
}

type SheetDescriptionProps = Omit<ComponentProps<typeof SheetDescriptionPrimitive>, 'className'> & {
  className?: string | undefined;
};

function SheetDescription({ className, ...props }: SheetDescriptionProps) {
  return (
    <SheetDescriptionPrimitive
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle };
