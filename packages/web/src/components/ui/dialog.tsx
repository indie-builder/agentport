'use client';

import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent as DialogContentPrimitive,
  DialogDescription as DialogDescriptionPrimitive,
  DialogTitle as DialogTitlePrimitive,
  DialogTrigger,
} from '@ui-sdk/react/dialog';
import { XIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './button.js';

function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogBackdrop>) {
  return (
    <DialogBackdrop
      className={(state) =>
        cn(
          'fixed inset-0 isolate z-50 bg-scrim transition-opacity duration-150 ease-out-soft data-ending-style:opacity-0 data-ending-style:duration-200 data-starting-style:opacity-0',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function DialogContent<Payload = unknown>({
  className,
  children,
  showCloseButton = true,
  variant = 'default',
  animated = true,
  ...props
}: ComponentProps<typeof DialogContentPrimitive<Payload>> & {
  showCloseButton?: boolean | undefined;
  variant?: 'default' | 'bare' | undefined;
  animated?: boolean | undefined;
}) {
  return (
    <>
      <DialogOverlay />
      <DialogContentPrimitive
        data-variant={variant}
        className={(state) =>
          cn(
            'fixed inset-auto top-1/2 left-1/2 z-50 m-0 grid max-h-(--visual-viewport-height) w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-visible border-0 text-sm outline-none sm:max-w-sm',
            variant === 'default'
              ? 'gap-4 rounded-dialog bg-popover p-4 text-popover-foreground shadow-overlay ring-1 ring-line'
              : 'gap-0 rounded-none bg-transparent p-0 text-fg shadow-none ring-0',
            animated ? 'cds-overlay-enter' : 'transition-none',
            typeof className === 'function' ? className(state) : className,
          )
        }
        {...props}
      >
        {(state) => (
          <>
            {typeof children === 'function' ? children(state) : children}
            {showCloseButton && (
              <DialogClose
                render={<Button variant="ghost" className="absolute top-2 end-2" size="icon-sm" />}
              >
                <XIcon className="size-3" />
                <span className="sr-only">关闭</span>
              </DialogClose>
            )}
          </>
        )}
      </DialogContentPrimitive>
    </>
  );
}

function DialogHeader({
  className,
  bordered = false,
  ...props
}: ComponentProps<'div'> & { bordered?: boolean | undefined }) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2', bordered && 'border-b', className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: ComponentProps<typeof DialogTitlePrimitive>) {
  return (
    <DialogTitlePrimitive
      className={(state) =>
        cn(
          'break-words text-base leading-normal font-medium',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogDescriptionPrimitive>) {
  return (
    <DialogDescriptionPrimitive
      className={(state) =>
        cn(
          'text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
