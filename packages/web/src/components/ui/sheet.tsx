'use client';

import {
  DrawerBackdrop as SheetBackdropPrimitive,
  DrawerClose as SheetClosePrimitive,
  DrawerContent as SheetContentPrimitive,
  DrawerDescription as SheetDescriptionPrimitive,
  Drawer as SheetPrimitive,
  DrawerTitle as SheetTitlePrimitive,
} from '@ui-sdk/react/drawer';
import { XIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';
import { buttonVariants } from './button.js';

const Sheet = SheetPrimitive;
const SheetClose = SheetClosePrimitive;

function SheetOverlay({ className, ...props }: ComponentProps<typeof SheetBackdropPrimitive>) {
  return (
    <SheetBackdropPrimitive
      className={(state) =>
        cn(
          'fixed inset-0 z-50 bg-scrim',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function SheetContent<Payload = unknown>({
  className,
  children,
  showCloseButton = true,
  ...props
}: ComponentProps<typeof SheetContentPrimitive<Payload>> & {
  showCloseButton?: boolean | undefined;
}) {
  return (
    <>
      <SheetOverlay />
      <SheetContentPrimitive
        className={(state) =>
          cn(
            'relative m-0 flex flex-col gap-4 overflow-visible rounded-none border-0 bg-surface bg-clip-padding p-0 text-sm text-fg shadow-overlay outline-none data-[side=bottom]:h-auto data-[side=bottom]:max-h-[min(85dvh,var(--visual-viewport-height))] data-[side=bottom]:w-full data-[side=bottom]:border-t data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=left]:sm:max-w-sm data-[side=right]:ml-auto data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:sm:max-w-sm data-[side=top]:h-auto data-[side=top]:max-h-[min(85dvh,var(--visual-viewport-height))] data-[side=top]:w-full data-[side=top]:border-b',
            typeof className === 'function' ? className(state) : className,
          )
        }
        {...props}
      >
        {(state) => (
          <>
            {typeof children === 'function' ? children(state) : children}
            {showCloseButton && (
              <SheetClosePrimitive
                data-variant="ghost"
                data-size="icon-sm"
                className={buttonVariants({
                  variant: 'ghost',
                  size: 'icon-sm',
                  className: 'absolute top-3 right-3',
                })}
              >
                <XIcon className="size-3" aria-hidden="true" />
                <span className="sr-only">关闭</span>
              </SheetClosePrimitive>
            )}
          </>
        )}
      </SheetContentPrimitive>
    </>
  );
}

function SheetTitle({ className, ...props }: ComponentProps<typeof SheetTitlePrimitive>) {
  return (
    <SheetTitlePrimitive
      className={(state) =>
        cn(
          'text-base font-medium text-foreground',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: ComponentProps<typeof SheetDescriptionPrimitive>) {
  return (
    <SheetDescriptionPrimitive
      className={(state) =>
        cn(
          'text-sm text-muted-foreground',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle };
