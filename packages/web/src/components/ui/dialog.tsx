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
import { cn } from 'cn';
import { XIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from './button.js';

type Loose<T> = { [K in keyof T]: T[K] | undefined };

type DialogOverlayProps = Loose<Omit<ComponentProps<typeof DialogBackdrop>, 'className'>> & {
  className?: string | undefined;
};

function DialogOverlay({ className, ...props }: DialogOverlayProps) {
  return (
    <DialogBackdrop
      render={<div data-slot="dialog-overlay" />}
      className={cn(
        'fixed inset-0 isolate z-50 bg-scrim backdrop-blur-[2px] transition-opacity duration-150 ease-out-soft data-ending-style:opacity-0 data-starting-style:opacity-0',
        className,
      )}
      {...(props as ComponentProps<typeof DialogBackdrop>)}
    />
  );
}

type DialogContentProps = Loose<
  Omit<ComponentProps<typeof DialogContentPrimitive>, 'className' | 'children'>
> & {
  className?: string | undefined;
  children?: ReactNode;
  showCloseButton?: boolean | undefined;
};

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogContentProps) {
  return (
    <>
      <DialogOverlay />
      <DialogContentPrimitive
        className={cn(
          'fixed inset-auto top-1/2 left-1/2 z-50 m-0 grid max-h-none w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-visible rounded-[var(--radius-dialog)] border-0 bg-popover p-4 text-sm text-popover-foreground shadow-overlay ring-1 ring-line cds-overlay-enter outline-none sm:max-w-sm',
          className,
        )}
        {...(props as ComponentProps<typeof DialogContentPrimitive>)}
      >
        {children}
        {showCloseButton && (
          <DialogClose
            render={<Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" />}
          >
            <XIcon className="size-3" />
            <span className="sr-only">关闭</span>
          </DialogClose>
        )}
      </DialogContentPrimitive>
    </>
  );
}

function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div data-slot="dialog-header" className={cn('flex flex-col gap-2', className)} {...props} />
  );
}

type DialogTitleProps = Loose<Omit<ComponentProps<typeof DialogTitlePrimitive>, 'className'>> & {
  className?: string | undefined;
};

function DialogTitle({ className, ...props }: DialogTitleProps) {
  return (
    <DialogTitlePrimitive
      className={cn('break-words text-base leading-normal font-medium', className)}
      {...(props as ComponentProps<typeof DialogTitlePrimitive>)}
    />
  );
}

type DialogDescriptionProps = Loose<
  Omit<ComponentProps<typeof DialogDescriptionPrimitive>, 'className'>
> & {
  className?: string | undefined;
};

function DialogDescription({ className, ...props }: DialogDescriptionProps) {
  return (
    <DialogDescriptionPrimitive
      className={cn(
        'text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      )}
      {...(props as ComponentProps<typeof DialogDescriptionPrimitive>)}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogTitle,
  DialogTrigger,
};
