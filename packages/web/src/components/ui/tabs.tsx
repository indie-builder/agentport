import {
  TabsList as TabsListPrimitive,
  TabsPanel,
  Tabs as TabsPrimitive,
  TabsTab,
} from '@ui-sdk/react/tabs';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactElement } from 'react';
import { cn } from '@/lib/cn';

const tabsClassName = 'group/tabs flex gap-2 data-[orientation=horizontal]:flex-col';

const tabsTriggerClassName = cn(
  "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border-y border-transparent px-0 py-0.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,border-color,box-shadow] duration-150 ease-out-soft group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-disabled:opacity-50 has-data-[icon=inline-end]:pe-1 has-data-[icon=inline-start]:ps-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 group-data-[variant=default]/tabs-list:data-selected:border-line [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  'group-data-[variant=default]/tabs-list:border-x group-data-[variant=default]/tabs-list:px-1.5 group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-selected:bg-transparent',
  'data-selected:bg-selected data-selected:text-selected-foreground',
  'after:absolute after:bg-primary after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-end-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-selected:after:opacity-100',
);

const tabsContentClassName =
  'flex-1 p-0 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

type TabsDetails<T extends string> = Parameters<
  NonNullable<ComponentProps<typeof TabsPrimitive<T>>['onValueChange']>
>[1];

type TabsBaseProps<T extends string = string> = Omit<
  ComponentProps<typeof TabsPrimitive<T>>,
  'className' | 'onValueChange'
> & {
  className?: ComponentProps<typeof TabsPrimitive<T>>['className'] | undefined;
};

type TabsNullableProps<T extends string = string> = TabsBaseProps<T> & {
  allowNull: true;
  onValueChange?: ((value: T | null, details: TabsDetails<T>) => void) | undefined;
};

type TabsNonNullProps<T extends string = string> = TabsBaseProps<T> & {
  allowNull?: false | undefined;
  onValueChange?: ((value: T, details: TabsDetails<T>) => void) | undefined;
};

function Tabs<T extends string = string>(props: TabsNullableProps<T>): ReactElement;
function Tabs<T extends string = string>(props: TabsNonNullProps<T>): ReactElement;
function Tabs<T extends string = string>({
  className,
  orientation = 'horizontal',
  allowNull,
  onValueChange,
  ...props
}: TabsNullableProps<T> | TabsNonNullProps<T>) {
  return (
    <TabsPrimitive<T>
      orientation={orientation}
      className={
        typeof className === 'function'
          ? (state) => cn(tabsClassName, className(state))
          : cn(tabsClassName, className)
      }
      {...props}
      onValueChange={
        onValueChange === undefined
          ? undefined
          : (value, details) => {
              if (allowNull) {
                (onValueChange as (value: T | null, details: TabsDetails<T>) => void)(
                  value,
                  details,
                );
              } else if (value !== null) {
                (onValueChange as (value: T, details: TabsDetails<T>) => void)(value, details);
              }
            }
      }
    />
  );
}

const tabsListVariants = cva(
  'group/tabs-list inline-flex w-fit items-center justify-center rounded-lg text-muted-foreground group-data-[orientation=horizontal]/tabs:h-8 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none',
  {
    variants: {
      variant: {
        default: 'bg-hover p-[3px]',
        line: 'gap-4 bg-transparent px-0 py-[3px]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

type TabsListProps = Omit<ComponentProps<typeof TabsListPrimitive>, 'className'> &
  VariantProps<typeof tabsListVariants> & {
    className?: ComponentProps<typeof TabsListPrimitive>['className'] | undefined;
  };

function TabsList({ className, variant = 'default', ...props }: TabsListProps) {
  return (
    <TabsListPrimitive
      data-variant={variant}
      className={
        typeof className === 'function'
          ? (state) => cn(tabsListVariants({ variant }), className(state))
          : cn(tabsListVariants({ variant }), className)
      }
      {...props}
    />
  );
}

type TabsTriggerProps = Omit<ComponentProps<typeof TabsTab>, 'className'> & {
  className?: ComponentProps<typeof TabsTab>['className'] | undefined;
};

function TabsTrigger({ className, ...props }: TabsTriggerProps) {
  return (
    <TabsTab
      className={
        typeof className === 'function'
          ? (state) => cn(tabsTriggerClassName, className(state))
          : cn(tabsTriggerClassName, className)
      }
      {...props}
    />
  );
}

type TabsContentProps = Omit<ComponentProps<typeof TabsPanel>, 'className'> & {
  className?: ComponentProps<typeof TabsPanel>['className'] | undefined;
};

function TabsContent({ className, ...props }: TabsContentProps) {
  return (
    <TabsPanel
      className={
        typeof className === 'function'
          ? (state) => cn(tabsContentClassName, className(state))
          : cn(tabsContentClassName, className)
      }
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
