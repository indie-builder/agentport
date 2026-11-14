import {
  TabsList as TabsListPrimitive,
  TabsPanel,
  Tabs as TabsPrimitive,
  TabsTab,
} from '@ui-sdk/react/tabs';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import type { ComponentProps, ReactNode } from 'react';

type TabsProps<T extends string = string> = {
  value?: T | null | undefined;
  defaultValue?: T | null | undefined;
  onValueChange?: ((value: T) => void) | undefined;
  orientation?: 'horizontal' | 'vertical';
  className?: string | undefined;
  children?: ReactNode;
};

function Tabs<T extends string = string>({
  className,
  orientation = 'horizontal',
  onValueChange,
  ...props
}: TabsProps<T>) {
  return (
    <TabsPrimitive<T>
      orientation={orientation}
      className={cn('group/tabs flex gap-2 data-[orientation=horizontal]:flex-col', className)}
      {...props}
      onValueChange={
        onValueChange === undefined
          ? undefined
          : (value) => {
              if (value !== null) onValueChange(value);
            }
      }
    />
  );
}

const tabsListVariants = cva(
  'group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-[orientation=horizontal]/tabs:h-8 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none',
  {
    variants: {
      variant: {
        default: 'bg-hover',
        line: 'gap-1 bg-transparent',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

type TabsListProps = Omit<ComponentProps<typeof TabsListPrimitive>, 'className'> &
  VariantProps<typeof tabsListVariants> & {
    className?: string | undefined;
  };

function TabsList({ className, variant = 'default', ...props }: TabsListProps) {
  return (
    <TabsListPrimitive
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

type TabsTriggerProps = Omit<ComponentProps<typeof TabsTab>, 'className'> & {
  className?: string | undefined;
};

function TabsTrigger({ className, ...props }: TabsTriggerProps) {
  return (
    <TabsTab
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,border-color,box-shadow] duration-150 ease-out-soft group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-selected:border-line group-data-[variant=line]/tabs-list:data-selected:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        'group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-selected:bg-transparent dark:group-data-[variant=line]/tabs-list:data-selected:border-transparent dark:group-data-[variant=line]/tabs-list:data-selected:bg-transparent',
        'data-selected:bg-selected data-selected:text-selected-foreground dark:data-selected:border-input dark:data-selected:bg-input/30 dark:data-selected:text-foreground',
        'after:absolute after:bg-primary after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-selected:after:opacity-100',
        className,
      )}
      {...props}
    />
  );
}

type TabsContentProps = Omit<ComponentProps<typeof TabsPanel>, 'className'> & {
  className?: string | undefined;
};

function TabsContent({ className, ...props }: TabsContentProps) {
  return (
    <TabsPanel
      render={(partProps, state) => <div {...partProps} inert={!state.selected} />}
      className={cn(
        'flex-1 p-0 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants };
