'use client';

import {
  AlertDialog,
  AlertDialogBackdrop as AlertDialogBackdropPrimitive,
  AlertDialogClose,
  AlertDialogContent as AlertDialogContentPrimitive,
  AlertDialogDescription as AlertDialogDescriptionPrimitive,
  AlertDialogTitle as AlertDialogTitlePrimitive,
  AlertDialogTrigger,
} from '@ui-sdk/react/alert-dialog';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

function AlertDialogBackdrop({
  className,
  ...props
}: ComponentProps<typeof AlertDialogBackdropPrimitive>) {
  return (
    <AlertDialogBackdropPrimitive
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

function AlertDialogContent<Payload = unknown>({
  className,
  ...props
}: ComponentProps<typeof AlertDialogContentPrimitive<Payload>>) {
  return (
    <AlertDialogContentPrimitive
      className={(state) =>
        cn(
          'fixed inset-auto top-1/2 left-1/2 z-50 m-0 grid max-h-(--visual-viewport-height) w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-visible rounded-[var(--radius-dialog)] border-0 bg-surface p-4 text-sm text-fg shadow-overlay ring-1 ring-line cds-overlay-enter outline-none sm:max-w-sm',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function AlertDialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn('flex flex-col gap-2', className)}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn('flex justify-end gap-2', className)}
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof AlertDialogTitlePrimitive>) {
  return (
    <AlertDialogTitlePrimitive
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

function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof AlertDialogDescriptionPrimitive>) {
  return (
    <AlertDialogDescriptionPrimitive
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
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
};
