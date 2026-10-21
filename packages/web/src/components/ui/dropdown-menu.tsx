import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { Separator } from '@base-ui/react/separator';
import type * as React from 'react';
import { cn } from '../../lib/cn.js';

/**
 * DropdownMenu（Base UI）。
 *
 * 结构：Root > Trigger > Portal > Positioner（定位）> Popup（外观）。
 * 只保留项目实际使用的部件；radix 的 Sub/Radio/Checkbox 在本项目没有使用方，
 * 需要时从 @base-ui/react/menu 重新补齐。
 */
function DropdownMenu({ ...props }: React.ComponentProps<typeof MenuPrimitive.Root>) {
  // 保留原菜单在首尾停止的键盘行为，短操作列表不循环焦点。
  return <MenuPrimitive.Root data-slot="dropdown-menu" loopFocus={false} {...props} />;
}

function DropdownMenuTrigger({ ...props }: React.ComponentProps<typeof MenuPrimitive.Trigger>) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  align = 'end',
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Popup> & {
  sideOffset?: number;
  align?: React.ComponentProps<typeof MenuPrimitive.Positioner>['align'];
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner align={align} sideOffset={sideOffset} className="z-50">
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            'z-50 min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-card border border-line bg-surface p-1 text-fg shadow-overlay data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95 data-[open]:animate-in data-[open]:fade-in-0 data-[open]:zoom-in-95',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Item> & {
  variant?: 'default' | 'destructive';
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(
        'flex cursor-default items-center gap-2 rounded-icon px-2.5 py-1.5 text-xs text-muted-foreground outline-hidden select-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-sunken data-[highlighted]:text-fg data-[variant=destructive]:text-danger data-[variant=destructive]:data-[highlighted]:bg-danger-soft [&_svg]:pointer-events-none [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="dropdown-menu-separator"
      className={cn('my-1 h-px bg-line', className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};
