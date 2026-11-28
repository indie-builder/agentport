import { Toggle as TogglePrimitive } from '@ui-sdk/react/toggle';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,opacity] duration-150 ease-out-soft outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-disabled:opacity-35 aria-invalid:border aria-invalid:border-destructive data-pressed:bg-selected data-pressed:text-selected-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'rounded-lg bg-transparent',
        outline: 'rounded-lg border border-border bg-transparent hover:bg-hover',
        pill: 'rounded-full border border-line bg-transparent font-normal text-muted-foreground hover:bg-hover data-pressed:border-line-strong data-pressed:bg-selected data-pressed:text-selected-foreground disabled:cursor-not-allowed disabled:opacity-50 data-disabled:cursor-not-allowed data-disabled:opacity-50',
        card: 'cds-card-surface flex items-start justify-start gap-2 rounded-card border border-transparent bg-surface text-left font-normal whitespace-normal data-pressed:border-line-strong data-pressed:bg-selected data-pressed:text-selected-foreground disabled:cursor-not-allowed disabled:opacity-50 data-disabled:cursor-not-allowed data-disabled:opacity-50',
      },
      size: {
        default:
          'h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2',
        sm: "h-7 min-w-7 rounded-[min(var(--radius-md),12px)] px-2.5 text-sm has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 min-w-9 px-2.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2',
        icon: 'size-8 min-w-8 px-0',
        pill: 'h-auto min-w-0 px-3 py-1',
        card: 'h-auto min-w-0 p-3',
        tile: 'h-auto min-w-0 flex-col items-start gap-1 whitespace-normal px-3 py-2.5 text-left',
      },
      mono: {
        false: '',
        true: 'font-mono',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
      mono: false,
    },
  },
);

function Toggle({
  className,
  variant = 'default',
  size = 'default',
  mono = false,
  ...props
}: Omit<ComponentProps<typeof TogglePrimitive>, 'className'> &
  VariantProps<typeof toggleVariants> & {
    className?: ComponentProps<typeof TogglePrimitive>['className'] | undefined;
  }) {
  return (
    <TogglePrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(toggleVariants({ variant, size, mono }), className(state))
          : cn(toggleVariants({ variant, size, mono }), className)
      }
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
