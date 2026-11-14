'use client';

import {
  Popover,
  PopoverContent as PopoverContentPrimitive,
  PopoverTrigger,
} from '@ui-sdk/react/popover';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

type Loose<T> = { [K in keyof T]: T[K] | undefined };

type PopoverContentProps = Loose<
  Omit<ComponentProps<typeof PopoverContentPrimitive>, 'className'>
> & {
  className?: string | undefined;
};

function PopoverContent({
  className,
  align = 'center',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  ...props
}: PopoverContentProps) {
  return (
    <PopoverContentPrimitive
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      className={cn(
        'z-50 flex max-h-(--available-height) w-72 max-w-(--available-width) overflow-y-auto overscroll-contain flex-col gap-2.5 rounded-[var(--radius-popover)] bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-line outline-hidden cds-overlay-enter',
        className,
      )}
      {...(props as ComponentProps<typeof PopoverContentPrimitive>)}
    />
  );
}

export { Popover, PopoverContent, PopoverTrigger };
