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
} from '@ui-sdk/react/combobox';
import { cva, type VariantProps } from 'class-variance-authority';
import { CheckIcon, ChevronDownIcon, XIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';

const comboboxTriggerVariants = cva("[&_svg:not([class*='size-'])]:size-4", {
  variants: {
    variant: {
      default: '',
      field:
        'flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pe-2 ps-2.5 text-sm font-medium whitespace-nowrap transition-colors outline-none select-none cds-focus-glow disabled:cursor-not-allowed disabled:opacity-35 data-disabled:cursor-not-allowed data-disabled:opacity-35 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0',
      ghost:
        'inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-fg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-disabled:pointer-events-none data-disabled:opacity-40',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

const comboboxInputVariants = cva(
  'h-8 w-full min-w-0 rounded-lg border border-input px-2.5 py-1 text-sm transition-colors outline-none cds-focus-glow focus-visible:border-subtle placeholder:text-muted-foreground data-disabled:cursor-not-allowed data-disabled:opacity-35 aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive in-data-[slot=combobox-chips]:h-auto in-data-[slot=combobox-chips]:min-w-16 in-data-[slot=combobox-chips]:flex-1 in-data-[slot=combobox-chips]:rounded-none in-data-[slot=combobox-chips]:border-0 in-data-[slot=combobox-chips]:p-0 in-data-[slot=combobox-chips]:focus-visible:outline-none',
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        surface: 'bg-surface',
      },
      withTrigger: {
        false: '',
        true: 'pe-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      withTrigger: false,
    },
  },
);

const comboboxItemVariants = cva(
  "relative flex w-full cursor-default items-center gap-2 rounded-md pe-8 ps-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-highlighted:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      size: {
        default: 'py-1',
        lg: 'py-1.5',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

function ComboboxTrigger({
  className,
  variant = 'default',
  children,
  ...props
}: ComponentProps<typeof ComboboxTriggerPrimitive> & VariantProps<typeof comboboxTriggerVariants>) {
  return (
    <ComboboxTriggerPrimitive
      className={(state) =>
        cn(
          comboboxTriggerVariants({ variant }),
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

function ComboboxInput({
  className,
  variant = 'default',
  withTrigger = false,
  ...props
}: ComponentProps<typeof ComboboxInputPrimitive> & VariantProps<typeof comboboxInputVariants>) {
  return (
    <ComboboxInputPrimitive
      className={(state) =>
        cn(
          comboboxInputVariants({ variant, withTrigger }),
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
          'z-50 max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) min-w-(--anchor-width) overflow-hidden rounded-popover bg-popover text-popover-foreground shadow-md ring-1 ring-line outline-hidden cds-overlay-enter [--combobox-list-height:var(--available-height)]',
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
          'scrollbar-none max-h-[min(calc(--spacing(72)---spacing(9)),calc(var(--combobox-list-height)---spacing(9)))] scroll-py-1 overflow-y-auto overscroll-contain p-1',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function ComboboxItem<T = string>({
  className,
  size = 'default',
  children,
  ...props
}: ComponentProps<typeof ComboboxItemPrimitive<T>> & VariantProps<typeof comboboxItemVariants>) {
  return (
    <ComboboxItemPrimitive
      className={(state) =>
        cn(
          comboboxItemVariants({ size }),
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    >
      {(state) => (
        <>
          {typeof children === 'function' ? children(state) : children}
          <ComboboxItemIndicator className="pointer-events-none absolute end-2 flex size-4 items-center justify-center">
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
          'flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent bg-clip-padding px-2.5 py-1 text-sm transition-colors has-[[data-slot=combobox-input]:focus-visible]:border-subtle has-aria-invalid:border-destructive has-aria-invalid:has-[[data-slot=combobox-input]:focus-visible]:border-destructive has-data-[slot=combobox-chip]:px-1',
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
          'flex h-[calc(--spacing(5.25))] w-fit items-center justify-center gap-1 rounded-sm bg-muted px-1.5 text-xs font-medium whitespace-nowrap text-foreground data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50 has-data-[slot=combobox-chip-remove]:pe-0',
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
            '-ms-1 opacity-50 hover:opacity-100',
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
};
