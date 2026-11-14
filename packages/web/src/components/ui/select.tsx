'use client';

import {
  Select,
  SelectContent as SelectContentPrimitive,
  SelectGroupLabel as SelectGroupLabelPrimitive,
  SelectGroup as SelectGroupPrimitive,
  SelectItemIndicator,
  SelectItem as SelectItemPrimitive,
  SelectTrigger as SelectTriggerPrimitive,
  SelectValue as SelectValuePrimitive,
} from '@ui-sdk/react/select';
import { cn } from 'cn';
import { Check, ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';

function SelectGroup({ className, ...props }: ComponentProps<typeof SelectGroupPrimitive>) {
  return (
    <SelectGroupPrimitive
      className={(state) =>
        cn('scroll-my-1 p-1', typeof className === 'function' ? className(state) : className)
      }
      {...props}
    />
  );
}

function SelectValue({ className, ...props }: ComponentProps<typeof SelectValuePrimitive>) {
  return (
    <SelectValuePrimitive
      className={(state) =>
        cn('flex flex-1 text-left', typeof className === 'function' ? className(state) : className)
      }
      {...props}
    />
  );
}

function SelectTrigger({
  className,
  size = 'default',
  children,
  ...props
}: ComponentProps<typeof SelectTriggerPrimitive> & {
  size?: 'sm' | 'default';
}) {
  return (
    <SelectTriggerPrimitive
      data-size={size}
      className={(state) =>
        cn(
          "flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none cds-focus-glow focus-visible:border-[var(--color-subtle)] disabled:cursor-not-allowed disabled:opacity-[0.35] aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:focus-visible:outline-2 aria-invalid:focus-visible:outline-solid aria-invalid:focus-visible:outline-ring aria-invalid:focus-visible:outline-offset-2 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    >
      {(state) => (
        <>
          {typeof children === 'function' ? children(state) : children}
          <ChevronDown
            aria-hidden="true"
            className="pointer-events-none size-4 text-muted-foreground"
          />
        </>
      )}
    </SelectTriggerPrimitive>
  );
}

function SelectContent({
  className,
  side = 'bottom',
  sideOffset = 4,
  align = 'start',
  alignOffset = 0,
  alignItemWithTrigger = false,
  ...props
}: ComponentProps<typeof SelectContentPrimitive>) {
  return (
    <SelectContentPrimitive
      side={side}
      sideOffset={sideOffset}
      align={align}
      alignOffset={alignOffset}
      alignItemWithTrigger={alignItemWithTrigger}
      className={(state) =>
        cn(
          'isolate z-50 max-h-(--available-height) data-[slot=select-content]:w-(--anchor-width) min-w-36 max-w-(--available-width) overflow-x-hidden overflow-y-auto overscroll-contain rounded-[var(--radius-popover)] bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-line cds-overlay-enter',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function SelectGroupLabel({
  className,
  ...props
}: ComponentProps<typeof SelectGroupLabelPrimitive>) {
  return (
    <SelectGroupLabelPrimitive
      className={(state) =>
        cn(
          'px-1.5 py-1 text-xs text-muted-foreground',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function SelectItem<T = string>({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectItemPrimitive<T>>) {
  return (
    <SelectItemPrimitive
      className={(state) =>
        cn(
          "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground not-data-[variant=destructive]:data-highlighted:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-[0.35] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    >
      {(state) => (
        <>
          <span className="flex min-w-0 flex-1 gap-2 whitespace-normal break-words">
            {typeof children === 'function' ? children(state) : children}
          </span>
          <SelectItemIndicator className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
            <Check aria-hidden="true" className="pointer-events-none" />
          </SelectItemIndicator>
        </>
      )}
    </SelectItemPrimitive>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
};
