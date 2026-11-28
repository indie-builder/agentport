import {
  Menu as DropdownMenu,
  MenuGroup as DropdownMenuGroup,
  MenuRadioGroup as DropdownMenuRadioGroup,
  MenuTrigger as DropdownMenuTrigger,
  MenuContent,
  MenuItem,
  MenuItemIndicator,
  MenuRadioItem,
  MenuSeparator,
} from '@ui-sdk/react/menu';
import { CheckIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

function DropdownMenuContent<Payload = unknown>({
  align = 'start',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  className,
  ...props
}: ComponentProps<typeof MenuContent<Payload>>) {
  return (
    <MenuContent<Payload>
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      className={(state) =>
        cn(
          'max-h-(--available-height) min-w-32 max-w-(--available-width) overflow-x-hidden overflow-y-auto overscroll-contain rounded-[var(--radius-popover)] bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-line cds-overlay-enter outline-none',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: ComponentProps<typeof MenuItem> & {
  inset?: boolean;
  variant?: 'default' | 'destructive';
}) {
  return (
    <MenuItem
      data-inset={inset}
      destructive={variant === 'destructive'}
      className={(state) =>
        cn(
          "relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground not-data-destructive:data-highlighted:**:text-accent-foreground data-inset:ps-7 data-destructive:text-destructive data-destructive:data-highlighted:bg-destructive/10 data-destructive:data-highlighted:text-destructive dark:data-destructive:data-highlighted:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-destructive:*:[svg]:text-destructive",
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: ComponentProps<typeof MenuRadioItem> & {
  inset?: boolean;
}) {
  return (
    <MenuRadioItem
      data-inset={inset}
      className={(state) =>
        cn(
          "relative flex cursor-default items-center gap-1.5 rounded-md py-1 pe-8 ps-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-highlighted:**:text-accent-foreground data-inset:ps-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    >
      {(state) => (
        <>
          <MenuItemIndicator
            keepMounted
            className="pointer-events-none invisible absolute end-2 flex items-center justify-center data-checked:visible"
          >
            <CheckIcon />
          </MenuItemIndicator>
          {typeof children === 'function' ? children(state) : children}
        </>
      )}
    </MenuRadioItem>
  );
}

function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof MenuSeparator>) {
  return (
    <MenuSeparator
      className={(state) =>
        cn(
          '-mx-1 my-1 h-px bg-border',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};
