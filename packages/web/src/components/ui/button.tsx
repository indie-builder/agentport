import { Button as ButtonPrimitive } from '@ui-sdk/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const neutralButtonStyles =
  'border-border bg-background text-foreground hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground';

const buttonVariantStyles = cva(
  "group/button cds-btn-squish inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap outline-none select-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-disabled:opacity-35 aria-disabled:pointer-events-none aria-disabled:opacity-35 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        plain: 'cursor-pointer bg-transparent',
        default: `${neutralButtonStyles} shadow-2xs focus-visible:ring-offset-2 focus-visible:ring-offset-background`,
        solid: `${neutralButtonStyles} shadow-2xs focus-visible:ring-offset-2 focus-visible:ring-offset-background`,
        outline: neutralButtonStyles,
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-hover aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost:
          'hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground',
        destructive: 'bg-destructive/10 text-destructive hover:bg-destructive/20',
        link: 'text-link underline-offset-4 hover:underline',
      },
      size: {
        default:
          'h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2',
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2',
        icon: 'size-8 rounded-icon',
        'icon-xs':
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        'icon-sm':
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3.5",
        'icon-lg': 'size-9 rounded-icon',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

const buttonVariants = (props?: Parameters<typeof buttonVariantStyles>[0]) =>
  cn(buttonVariantStyles(props));

type ButtonProps = Omit<ComponentProps<typeof ButtonPrimitive>, 'className'> &
  VariantProps<typeof buttonVariantStyles> & {
    className?: ComponentProps<typeof ButtonPrimitive>['className'] | undefined;
  };

function Button({ className, variant = 'default', size = 'default', ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-variant={variant}
      data-size={size}
      className={
        typeof className === 'function'
          ? (state) => cn(buttonVariantStyles({ variant, size }), className(state))
          : buttonVariants({ variant, size, className })
      }
      {...props}
    />
  );
}

export { Button, buttonVariants };
