'use client';

import {
  Popover,
  PopoverContent as PopoverContentPrimitive,
  PopoverTrigger,
} from '@ui-sdk/react/popover';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const popoverPadding = {
  default: 'p-2.5',
  sm: 'p-2',
  none: 'p-0',
} as const;

const popoverGap = {
  default: 'gap-2.5',
  none: 'gap-0',
} as const;

function PopoverContent<Payload = unknown>({
  className,
  align = 'center',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  padding = 'default',
  gap = 'default',
  ...props
}: ComponentProps<typeof PopoverContentPrimitive<Payload>> & {
  padding?: keyof typeof popoverPadding | undefined;
  gap?: keyof typeof popoverGap | undefined;
}) {
  return (
    <PopoverContentPrimitive
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      className={(state) =>
        cn(
          'z-50 flex max-h-(--available-height) w-72 max-w-(--available-width) overflow-y-auto overscroll-contain flex-col rounded-popover bg-popover text-sm text-popover-foreground shadow-md ring-1 ring-line outline-hidden cds-overlay-enter',
          popoverGap[gap],
          popoverPadding[padding],
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export { Popover, PopoverContent, PopoverTrigger };
