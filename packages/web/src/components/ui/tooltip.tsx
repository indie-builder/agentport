'use client';

import {
  Tooltip,
  TooltipArrow,
  TooltipContent as TooltipContentPrimitive,
  TooltipTrigger,
} from '@ui-sdk/react/tooltip';
import { cn } from 'cn';
import type { ComponentProps, ReactNode } from 'react';

type Loose<T> = { [K in keyof T]: T[K] | undefined };

type TooltipContentProps = Loose<
  Omit<ComponentProps<typeof TooltipContentPrimitive>, 'className' | 'children'>
> & {
  className?: string | undefined;
  children?: ReactNode;
};

function TooltipContent({
  className,
  children,
  side = 'top',
  sideOffset = 4,
  align = 'center',
  alignOffset = 0,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipContentPrimitive
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      className={cn(
        'z-50 inline-flex w-fit max-w-xs items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background cds-overlay-enter has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-ending-style:opacity-0 data-starting-style:opacity-0',
        className,
      )}
      {...(props as ComponentProps<typeof TooltipContentPrimitive>)}
    >
      {children}
      <TooltipArrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
    </TooltipContentPrimitive>
  );
}

export { Tooltip, TooltipContent, TooltipTrigger };
