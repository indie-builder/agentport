import {
  SegmentedControlIndicator as SegmentedControlIndicatorPrimitive,
  SegmentedControlItem as SegmentedControlItemPrimitive,
  SegmentedControl as SegmentedControlPrimitive,
} from '@ui-sdk/react/segmented-control';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ComponentProps, createContext, useContext } from 'react';
import { cn } from '@/lib/cn';

const segmentedControlClassName =
  'relative isolate inline-flex w-fit items-center rounded-pill bg-sunken p-0.5 text-muted-foreground data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch data-disabled:opacity-35';

const segmentedControlIndicatorClassName =
  'pointer-events-none absolute top-[var(--segmented-control-indicator-top)] left-[var(--segmented-control-indicator-left)] -z-10 hidden h-[var(--segmented-control-indicator-height)] w-[var(--segmented-control-indicator-width)] rounded-pill bg-surface shadow-sm transition-[top,left,width,height] duration-150 ease-out-soft data-visible:block data-[activation-direction=none]:transition-none motion-reduce:transition-none';

const segmentedControlItemVariants = cva(
  "relative z-10 inline-flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-pill font-medium whitespace-nowrap text-muted-foreground transition-colors duration-150 ease-out-soft outline-none select-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring data-checked:text-fg data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-35 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      size: {
        default: 'h-7 px-3 text-sm',
        sm: 'h-6 px-2.5 text-xs',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

type SegmentedControlSize = NonNullable<VariantProps<typeof segmentedControlItemVariants>['size']>;

const SegmentedControlSizeContext = createContext<SegmentedControlSize>('default');

type SegmentedControlProps<T extends string = string> = Omit<
  ComponentProps<typeof SegmentedControlPrimitive<T>>,
  'className'
> &
  VariantProps<typeof segmentedControlItemVariants> & {
    className?: ComponentProps<typeof SegmentedControlPrimitive<T>>['className'] | undefined;
  };

type SegmentedControlItemProps = Omit<
  ComponentProps<typeof SegmentedControlItemPrimitive>,
  'className'
> &
  VariantProps<typeof segmentedControlItemVariants> & {
    className?: ComponentProps<typeof SegmentedControlItemPrimitive>['className'] | undefined;
  };

type SegmentedControlIndicatorProps = Omit<
  ComponentProps<typeof SegmentedControlIndicatorPrimitive>,
  'className'
> & {
  className?: ComponentProps<typeof SegmentedControlIndicatorPrimitive>['className'] | undefined;
};

function SegmentedControl<T extends string = string>({
  className,
  size = 'default',
  ...props
}: SegmentedControlProps<T>) {
  return (
    <SegmentedControlSizeContext.Provider value={size ?? 'default'}>
      <SegmentedControlPrimitive<T>
        className={
          typeof className === 'function'
            ? (state) => cn(segmentedControlClassName, className(state))
            : cn(segmentedControlClassName, className)
        }
        {...props}
      />
    </SegmentedControlSizeContext.Provider>
  );
}

function SegmentedControlItem({ className, size, ...props }: SegmentedControlItemProps) {
  const contextSize = useContext(SegmentedControlSizeContext);
  const resolvedSize = size ?? contextSize;
  return (
    <SegmentedControlItemPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(segmentedControlItemVariants({ size: resolvedSize }), className(state))
          : cn(segmentedControlItemVariants({ size: resolvedSize }), className)
      }
      {...props}
    />
  );
}

function SegmentedControlIndicator({ className, ...props }: SegmentedControlIndicatorProps) {
  return (
    <SegmentedControlIndicatorPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(segmentedControlIndicatorClassName, className(state))
          : cn(segmentedControlIndicatorClassName, className)
      }
      {...props}
    />
  );
}

export { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem };
