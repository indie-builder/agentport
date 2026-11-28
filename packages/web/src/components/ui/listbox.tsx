import {
  createListboxController,
  ListboxGroupLabel as ListboxGroupLabelPrimitive,
  ListboxGroup as ListboxGroupPrimitive,
  ListboxItemIcon as ListboxItemIconPrimitive,
  ListboxItemIndicator as ListboxItemIndicatorPrimitive,
  ListboxItem as ListboxItemPrimitive,
  ListboxItems,
  type ListboxOptions,
  Listbox as ListboxPrimitive,
  type ListboxProps as ListboxPrimitiveProps,
  ListboxSeparator as ListboxSeparatorPrimitive,
} from '@ui-sdk/react/listbox';
import { Check } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

function mergeClassName<State>(
  base: string,
  className: string | ((state: State) => string | undefined) | undefined,
) {
  return typeof className === 'function'
    ? (state: State) => cn(base, className(state))
    : cn(base, className);
}

const listboxClassName =
  'flex w-full min-w-0 flex-col gap-0.5 rounded-item border border-line bg-surface p-1 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring data-[orientation=horizontal]:flex-row data-[orientation=horizontal]:flex-wrap data-disabled:pointer-events-none data-disabled:opacity-35';

const listboxItemClassName =
  "relative flex w-full cursor-pointer items-center gap-2 rounded-icon px-2 py-1.5 text-start text-sm text-fg transition-colors duration-150 ease-out-soft outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring select-none not-data-selected:not-data-disabled:hover:bg-hover not-data-selected:not-data-disabled:data-highlighted:bg-hover data-selected:bg-selected data-selected:font-medium data-selected:text-selected-foreground data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-35 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

const listboxItemIconClassName =
  "inline-flex shrink-0 items-center justify-center text-muted-foreground data-mirror:rtl:-scale-x-100 [&_svg:not([class*='size-'])]:size-4";

const listboxItemIndicatorClassName =
  "ms-auto inline-flex shrink-0 items-center justify-center text-fg [&_svg:not([class*='size-'])]:size-4";

const listboxGroupClassName = 'flex flex-col gap-0.5';

const listboxGroupLabelClassName =
  'px-2 py-1 text-xs font-medium text-muted-foreground select-none';

const listboxSeparatorClassName = '-mx-1 my-1 h-px bg-border';

type ListboxProps<T = string, Multiple extends boolean | undefined = false> = Omit<
  ListboxPrimitiveProps,
  keyof ListboxOptions | 'className'
> & {
  className?: ListboxPrimitiveProps['className'] | undefined;
} & ListboxOptions<T, Multiple>;

type ListboxItemProps<T = string> = Omit<
  ComponentProps<typeof ListboxItemPrimitive<T>>,
  'className'
> & {
  className?: ComponentProps<typeof ListboxItemPrimitive<T>>['className'] | undefined;
};

type ListboxItemIconProps = Omit<ComponentProps<typeof ListboxItemIconPrimitive>, 'className'> & {
  className?: ComponentProps<typeof ListboxItemIconPrimitive>['className'] | undefined;
};

type ListboxItemIndicatorProps = Omit<
  ComponentProps<typeof ListboxItemIndicatorPrimitive>,
  'className'
> & {
  className?: ComponentProps<typeof ListboxItemIndicatorPrimitive>['className'] | undefined;
};

type ListboxGroupProps = Omit<ComponentProps<typeof ListboxGroupPrimitive>, 'className'> & {
  className?: ComponentProps<typeof ListboxGroupPrimitive>['className'] | undefined;
};

type ListboxGroupLabelProps = Omit<
  ComponentProps<typeof ListboxGroupLabelPrimitive>,
  'className'
> & {
  className?: ComponentProps<typeof ListboxGroupLabelPrimitive>['className'] | undefined;
};

type ListboxSeparatorProps = Omit<ComponentProps<typeof ListboxSeparatorPrimitive>, 'className'> & {
  className?: ComponentProps<typeof ListboxSeparatorPrimitive>['className'] | undefined;
};

function Listbox<T = string, Multiple extends boolean | undefined = false>({
  className,
  ...props
}: ListboxProps<T, Multiple>) {
  return (
    <ListboxPrimitive<T, Multiple>
      {...(props as ListboxPrimitiveProps<T, Multiple>)}
      className={mergeClassName(listboxClassName, className)}
    />
  );
}

function ListboxItem<T = string>({ className, ...props }: ListboxItemProps<T>) {
  return (
    <ListboxItemPrimitive<T>
      {...(props as ComponentProps<typeof ListboxItemPrimitive<T>>)}
      className={mergeClassName(listboxItemClassName, className)}
    />
  );
}

function ListboxItemIcon({ className, ...props }: ListboxItemIconProps) {
  return (
    <ListboxItemIconPrimitive
      className={mergeClassName(listboxItemIconClassName, className)}
      {...props}
    />
  );
}

function ListboxItemIndicator({ className, children, ...props }: ListboxItemIndicatorProps) {
  return (
    <ListboxItemIndicatorPrimitive
      className={mergeClassName(listboxItemIndicatorClassName, className)}
      {...props}
    >
      {children === undefined ? <Check aria-hidden="true" /> : children}
    </ListboxItemIndicatorPrimitive>
  );
}

function ListboxGroup({ className, ...props }: ListboxGroupProps) {
  return (
    <ListboxGroupPrimitive
      className={mergeClassName(listboxGroupClassName, className)}
      {...props}
    />
  );
}

function ListboxGroupLabel({ className, ...props }: ListboxGroupLabelProps) {
  return (
    <ListboxGroupLabelPrimitive
      className={mergeClassName(listboxGroupLabelClassName, className)}
      {...props}
    />
  );
}

function ListboxSeparator({ className, ...props }: ListboxSeparatorProps) {
  return (
    <ListboxSeparatorPrimitive
      className={mergeClassName(listboxSeparatorClassName, className)}
      {...props}
    />
  );
}

export {
  createListboxController,
  Listbox,
  ListboxGroup,
  ListboxGroupLabel,
  ListboxItem,
  ListboxItemIcon,
  ListboxItemIndicator,
  ListboxItems,
  ListboxSeparator,
};
