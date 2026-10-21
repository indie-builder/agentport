import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import type * as React from 'react';
import { cn } from '../../lib/cn.js';

/**
 * Popover（Base UI）。
 * 结构：Root > Portal > Positioner（定位）> Popup（外观）。
 * radix 的 Anchor 在 Base UI 里用 `anchor` prop 表达，本项目没有使用方，未保留。
 */
function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = 'center',
  side,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Popup> & {
  align?: React.ComponentProps<typeof PopoverPrimitive.Positioner>['align'];
  side?: React.ComponentProps<typeof PopoverPrimitive.Positioner>['side'];
  sideOffset?: number;
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            'z-50 w-72 animate-in rounded-card border border-line bg-surface p-3 text-fg shadow-overlay fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95',
            className,
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="popover-header"
      className={cn('flex flex-col gap-1 text-sm', className)}
      {...props}
    />
  );
}

function PopoverTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return <div data-slot="popover-title" className={cn('font-medium', className)} {...props} />;
}

function PopoverDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p data-slot="popover-description" className={cn('text-muted', className)} {...props} />;
}

export { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger };
