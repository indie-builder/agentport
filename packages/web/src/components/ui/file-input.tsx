'use client';

import {
  createFileInputController,
  FileInputDropzone as FileInputDropzonePrimitive,
  FileInputItem as FileInputItemPrimitive,
  FileInputItemRemove as FileInputItemRemovePrimitive,
  FileInputList as FileInputListPrimitive,
  FileInput as FileInputPrimitive,
  FileInputTrigger as FileInputTriggerPrimitive,
  formatFileSize,
  relativePath,
} from '@ui-sdk/react/file-input';
import type { ComponentProps } from 'react';
import { type Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';

type WithOptionalClassName<T extends { className?: unknown }> = Omit<T, 'className'> & {
  className?: T['className'] | undefined;
};

function FileInput({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof FileInputPrimitive>>) {
  return (
    <FileInputPrimitive
      {...(className === undefined
        ? {}
        : {
            className:
              typeof className === 'function' ? (state) => cn(className(state)) : cn(className),
          })}
      {...props}
    />
  );
}

function FileInputTrigger({
  className,
  variant = 'default',
  size = 'default',
  render,
  ...props
}: WithOptionalClassName<ComponentProps<typeof FileInputTriggerPrimitive>> &
  Pick<ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return (
    <FileInputTriggerPrimitive
      {...(render === undefined ? { 'data-variant': variant, 'data-size': size } : { render })}
      {...(render !== undefined && className === undefined
        ? {}
        : {
            className: (state) =>
              cn(
                render === undefined ? buttonVariants({ variant, size }) : undefined,
                typeof className === 'function' ? className(state) : className,
              ),
          })}
      {...props}
    />
  );
}

function FileInputDropzone({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof FileInputDropzonePrimitive>>) {
  return (
    <FileInputDropzonePrimitive
      className={(state) =>
        cn(
          'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface p-6 text-center text-sm text-muted-foreground transition-colors outline-none data-dragging:border-ring data-drag-accept:bg-hover data-drag-reject:border-destructive data-drag-reject:bg-destructive/5 data-disabled:pointer-events-none data-disabled:opacity-[0.35]',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function FileInputList({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof FileInputListPrimitive>>) {
  return (
    <FileInputListPrimitive
      className={(state) =>
        cn('flex flex-col gap-1.5', typeof className === 'function' ? className(state) : className)
      }
      {...props}
    />
  );
}

function FileInputItem({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof FileInputItemPrimitive>>) {
  return (
    <FileInputItemPrimitive
      className={(state) =>
        cn(
          'flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-disabled:opacity-[0.35]',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function FileInputItemRemove({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof FileInputItemRemovePrimitive>>) {
  return (
    <FileInputItemRemovePrimitive
      className={(state) =>
        cn(
          buttonVariants({ variant: 'ghost', size: 'icon-xs' }),
          'ml-auto',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export {
  createFileInputController,
  FileInput,
  FileInputDropzone,
  FileInputItem,
  FileInputItemRemove,
  FileInputList,
  FileInputTrigger,
  formatFileSize,
  relativePath,
};
