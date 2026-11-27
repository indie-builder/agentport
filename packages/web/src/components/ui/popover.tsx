'use client';

import {
  Popover,
  PopoverContent as PopoverContentPrimitive,
  PopoverTrigger,
} from '@ui-sdk/react/popover';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

function PopoverContent<Payload = unknown>({
  className,
  align = 'center',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  ...props
}: ComponentProps<typeof PopoverContentPrimitive<Payload>>) {
  return (
    <PopoverContentPrimitive
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      className={(state) =>
        cn(
          'z-50 flex max-h-(--available-height) w-72 max-w-(--available-width) overflow-y-auto overscroll-contain flex-col gap-2.5 rounded-[var(--radius-popover)] bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-line outline-hidden cds-overlay-enter',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export { Popover, PopoverContent, PopoverTrigger };
