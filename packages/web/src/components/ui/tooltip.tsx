import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import type * as React from 'react';
import { cn } from '../../lib/cn.js';

/**
 * Tooltip（Base UI）。
 * 结构从 radix 的 Portal > Content 变成 Portal > Positioner > Popup：
 * 定位属性（side/sideOffset）在 Positioner 上，外观在 Popup 上。
 */
function TooltipProvider({
  delay = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />;
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  side,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Popup> & {
  side?: React.ComponentProps<typeof TooltipPrimitive.Positioner>['side'];
  sideOffset?: number;
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} className="z-50">
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'z-50 w-fit animate-in rounded-icon bg-ink px-2 py-1 text-2xs text-white fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95',
            className,
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-icon bg-ink fill-ink" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
