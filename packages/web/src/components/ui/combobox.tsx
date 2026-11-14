'use client';

import {
  Combobox,
  ComboboxChip as ComboboxChipPrimitive,
  ComboboxChipRemove as ComboboxChipRemovePrimitive,
  ComboboxChips as ComboboxChipsPrimitive,
  ComboboxContent as ComboboxContentPrimitive,
  ComboboxEmpty as ComboboxEmptyPrimitive,
  ComboboxInput as ComboboxInputPrimitive,
  ComboboxItemIndicator,
  ComboboxItem as ComboboxItemPrimitive,
  ComboboxList as ComboboxListPrimitive,
  ComboboxTrigger as ComboboxTriggerPrimitive,
  ComboboxValue,
} from '@ui-sdk/react/combobox';
import { cn } from 'cn';
import { CheckIcon, ChevronDownIcon, XIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { buttonVariants } from '@/components/ui/button';

function ComboboxTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof ComboboxTriggerPrimitive>) {
  return (
    <ComboboxTriggerPrimitive
      className={(state) =>
        cn(
          "[&_svg:not([class*='size-'])]:size-4",
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    >
      {(state) => (
        <>
          {typeof children === 'function' ? children(state) : children}
          <ChevronDownIcon
            aria-hidden="true"
            className="pointer-events-none size-4 text-muted-foreground"
          />
        </>
      )}
    </ComboboxTriggerPrimitive>
  );
}

function ComboboxInput({ className, ...props }: ComponentProps<typeof ComboboxInputPrimitive>) {
  return (
    <ComboboxInputPrimitive
      className={(state) =>
        cn(
          'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none cds-focus-glow focus-visible:border-[var(--color-subtle)] placeholder:text-muted-foreground data-disabled:cursor-not-allowed data-disabled:opacity-[0.35] aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive in-data-[slot=combobox-chips]:h-auto in-data-[slot=combobox-chips]:min-w-16 in-data-[slot=combobox-chips]:flex-1 in-data-[slot=combobox-chips]:rounded-none in-data-[slot=combobox-chips]:border-0 in-data-[slot=combobox-chips]:p-0 in-data-[slot=combobox-chips]:focus-visible:outline-none',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function ComboboxContent({
  className,
  side = 'bottom',
  sideOffset = 6,
  align = 'start',
  alignOffset = 0,
  ...props
}: ComponentProps<typeof ComboboxContentPrimitive>) {
  return (
    <ComboboxContentPrimitive
      side={side}
      sideOffset={sideOffset}
      align={align}
      alignOffset={alignOffset}
      className={(state) =>
        cn(
          'z-50 max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) min-w-(--anchor-width) overflow-hidden rounded-[var(--radius-popover)] bg-popover text-popover-foreground shadow-md ring-1 ring-line outline-hidden cds-overlay-enter [--combobox-list-height:var(--available-height)]',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function ComboboxList({ className, ...props }: ComponentProps<typeof ComboboxListPrimitive>) {
  return (
    <ComboboxListPrimitive
      className={(state) =>
        cn(
          'no-scrollbar max-h-[min(calc(--spacing(72)---spacing(9)),calc(var(--combobox-list-height)---spacing(9)))] scroll-py-1 overflow-y-auto overscroll-contain p-1',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function ComboboxItem<T = string>({
  className,
  children,
  ...props
}: ComponentProps<typeof ComboboxItemPrimitive<T>>) {
  return (
    <ComboboxItemPrimitive
      className={(state) =>
        cn(
          "relative flex w-full cursor-default items-center gap-2 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-highlighted:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    >
      {(state) => (
        <>
          {typeof children === 'function' ? children(state) : children}
          <ComboboxItemIndicator className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
            <CheckIcon aria-hidden="true" className="pointer-events-none" />
          </ComboboxItemIndicator>
        </>
      )}
    </ComboboxItemPrimitive>
  );
}

function ComboboxEmpty({ className, ...props }: ComponentProps<typeof ComboboxEmptyPrimitive>) {
  return (
    <ComboboxEmptyPrimitive
      className={(state) =>
        cn(
          'hidden w-full justify-center py-2 text-center text-sm text-muted-foreground data-empty:flex',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function ComboboxChips({ className, ...props }: ComponentProps<typeof ComboboxChipsPrimitive>) {
  return (
    <ComboboxChipsPrimitive
      className={(state) =>
        cn(
          'flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent bg-clip-padding px-2.5 py-1 text-sm transition-colors has-[[data-slot=combobox-input]:focus-visible]:border-[var(--color-subtle)] has-aria-invalid:border-destructive has-aria-invalid:has-[[data-slot=combobox-input]:focus-visible]:border-destructive has-data-[slot=combobox-chip]:px-1',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function ComboboxChip<T = string>({
  className,
  ...props
}: ComponentProps<typeof ComboboxChipPrimitive<T>>) {
  return (
    <ComboboxChipPrimitive
      className={(state) =>
        cn(
          'flex h-[calc(--spacing(5.25))] w-fit items-center justify-center gap-1 rounded-sm bg-muted px-1.5 text-xs font-medium whitespace-nowrap text-foreground data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50 has-data-[slot=combobox-chip-remove]:pr-0',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function ComboboxChipRemove({
  className,
  children = <XIcon aria-hidden="true" className="pointer-events-none" />,
  ...props
}: ComponentProps<typeof ComboboxChipRemovePrimitive>) {
  return (
    <ComboboxChipRemovePrimitive
      className={(state) =>
        buttonVariants({
          variant: 'ghost',
          size: 'icon-xs',
          className: cn(
            '-ml-1 opacity-50 hover:opacity-100',
            typeof className === 'function' ? className(state) : className,
          ),
        })
      }
      {...props}
    >
      {children}
    </ComboboxChipRemovePrimitive>
  );
}

export {
  Combobox,
  ComboboxChip,
  ComboboxChipRemove,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
};
