import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';
import { XIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../../lib/cn.js';

/** Sheet：Base UI Dialog 的侧滑变体，结构沿用 shadcn 的 Portal > Backdrop > Popup。 */
function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Backdrop>) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-scrim data-[closed]:animate-out data-[closed]:fade-out-0 data-[open]:animate-in data-[open]:fade-in-0',
        className,
      )}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Popup> & {
  side?: 'top' | 'right' | 'bottom' | 'left';
  showCloseButton?: boolean;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          // §9：过渡 90–160ms，无入场位移，只保留淡入淡出。
          'fixed z-50 flex flex-col gap-4 bg-surface shadow-overlay transition ease-in-out data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:duration-150 data-[open]:animate-in data-[open]:fade-in-0 data-[open]:duration-150',
          side === 'right' && 'inset-y-0 right-0 h-full w-3/4 border-l border-line sm:max-w-sm',
          side === 'left' && 'inset-y-0 left-0 h-full w-3/4 border-r border-line sm:max-w-sm',
          side === 'top' && 'inset-x-0 top-0 h-auto border-b border-line',
          side === 'bottom' && 'inset-x-0 bottom-0 h-auto border-t border-line',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            aria-label="关闭"
            className="absolute top-4 right-4 rounded-icon p-1 text-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg disabled:pointer-events-none"
          >
            <XIcon className="size-4" />
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-1.5 p-4', className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn('mt-auto flex flex-col gap-2 p-4', className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('font-semibold text-fg', className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm text-muted', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
};
