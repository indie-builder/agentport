import { Button as ButtonPrimitive } from '@ui-sdk/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

const neutralButtonStyles =
  'border-border bg-background text-foreground hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50';

const buttonVariantStyles = cva(
  "group/button cds-btn-squish inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap outline-none select-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-disabled:opacity-[0.35] aria-disabled:pointer-events-none aria-disabled:opacity-[0.35] aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        plain: 'cursor-pointer bg-transparent',
        default: `${neutralButtonStyles} shadow-[var(--shadow-2xs)] focus-visible:ring-offset-2 focus-visible:ring-offset-background`,
        solid: `${neutralButtonStyles} shadow-[var(--shadow-2xs)] focus-visible:ring-offset-2 focus-visible:ring-offset-background`,
        outline: neutralButtonStyles,
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-hover aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost:
          'hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground dark:hover:bg-muted/50',
        destructive:
          'bg-destructive/10 text-destructive hover:bg-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30',
        link: 'text-[var(--color-link)] underline-offset-4 hover:underline',
      },
      size: {
        default:
          'h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        icon: 'size-8 rounded-[var(--radius-icon)]',
        'icon-xs':
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        'icon-sm':
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3.5",
        'icon-lg': 'size-9 rounded-[var(--radius-icon)]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

// Link 等场景把 helper 直接当 className 用，不经过 Button 的 cn；这里先合并，
// 保证调用方追加的 className 也按 Tailwind 冲突规则覆盖基础样式与变体。
const buttonVariants = (props?: Parameters<typeof buttonVariantStyles>[0]) =>
  cn(buttonVariantStyles(props));

type ButtonProps = ComponentProps<typeof ButtonPrimitive> &
  VariantProps<typeof buttonVariantStyles> & {
    'data-slot'?: string | undefined;
  };

function Button({
  className,
  variant = 'default',
  size = 'default',
  render,
  'data-slot': dataSlot,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      {...(render !== undefined
        ? { render }
        : dataSlot === undefined || dataSlot === 'button'
          ? {}
          : { render: <button type={props.type ?? 'button'} data-slot={dataSlot} /> })}
      className={buttonVariants({ variant, size, className })}
      {...props}
    />
  );
}

export { Button, buttonVariants };
