'use client';

import {
  ToggleGroup as ToggleGroupPrimitive,
  Toggle as TogglePrimitive,
} from '@ui-sdk/react/toggle';
import type { VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { toggleVariants } from '@/components/ui/toggle';
import { cn } from '@/lib/cn';

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    spacing?: number;
    orientation?: 'horizontal' | 'vertical';
  }
>({
  size: 'default',
  variant: 'default',
  spacing: 2,
  orientation: 'horizontal',
});

const toggleGroupClassName =
  'group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] rounded-lg data-[size=sm]:rounded-[min(var(--radius-md),10px)] data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch';

const toggleGroupItemBaseClassName =
  'shrink-0 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-2 focus:z-10 focus-visible:z-10 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-end]:pe-1.5 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-start]:ps-1.5 group-data-[orientation=horizontal]/toggle-group:data-[spacing=0]:first:rounded-s-lg group-data-[orientation=vertical]/toggle-group:data-[spacing=0]:first:rounded-t-lg group-data-[orientation=horizontal]/toggle-group:data-[spacing=0]:last:rounded-e-lg group-data-[orientation=vertical]/toggle-group:data-[spacing=0]:last:rounded-b-lg group-data-[orientation=horizontal]/toggle-group:data-[spacing=0]:data-[variant=outline]:border-s-0 group-data-[orientation=vertical]/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-[orientation=horizontal]/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-s group-data-[orientation=vertical]/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t';

type ToggleGroupProps<T extends string = string> = Omit<
  React.ComponentProps<typeof ToggleGroupPrimitive<T>>,
  'className' | 'style'
> &
  VariantProps<typeof toggleVariants> & {
    spacing?: number;
    className?: React.ComponentProps<typeof ToggleGroupPrimitive<T>>['className'] | undefined;
    style?: React.ComponentProps<typeof ToggleGroupPrimitive<T>>['style'] | undefined;
  };

function ToggleGroup<T extends string = string>({
  className,
  style,
  variant,
  size,
  spacing = 2,
  orientation = 'horizontal',
  children,
  ...props
}: ToggleGroupProps<T>) {
  const gapStyle = { '--gap': spacing } as React.CSSProperties;
  return (
    <ToggleGroupPrimitive<T>
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      orientation={orientation}
      style={
        typeof style === 'function'
          ? (state) => ({ ...gapStyle, ...style(state) })
          : { ...gapStyle, ...style }
      }
      className={
        typeof className === 'function'
          ? (state) => cn(toggleGroupClassName, className(state))
          : cn(toggleGroupClassName, className)
      }
      {...props}
    >
      {typeof children === 'function' ? (
        (state) => (
          <ToggleGroupContext.Provider value={{ variant, size, spacing, orientation }}>
            {children(state)}
          </ToggleGroupContext.Provider>
        )
      ) : (
        <ToggleGroupContext.Provider value={{ variant, size, spacing, orientation }}>
          {children}
        </ToggleGroupContext.Provider>
      )}
    </ToggleGroupPrimitive>
  );
}

function ToggleGroupItem({
  className,
  children,
  variant = 'default',
  size = 'default',
  ...props
}: Omit<React.ComponentProps<typeof TogglePrimitive>, 'className'> &
  VariantProps<typeof toggleVariants> & {
    className?: React.ComponentProps<typeof TogglePrimitive>['className'] | undefined;
  }) {
  const context = React.useContext(ToggleGroupContext);
  const itemClassName = cn(
    toggleGroupItemBaseClassName,
    toggleVariants({
      variant: context.variant || variant,
      size: context.size || size,
    }),
  );

  return (
    <TogglePrimitive
      data-variant={context.variant || variant}
      data-size={context.size || size}
      data-spacing={context.spacing}
      className={
        typeof className === 'function'
          ? (state) => cn(itemClassName, className(state))
          : cn(itemClassName, className)
      }
      {...props}
    >
      {children}
    </TogglePrimitive>
  );
}

export { ToggleGroup, ToggleGroupItem };
