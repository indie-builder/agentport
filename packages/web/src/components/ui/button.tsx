import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

const buttonVariantStyles = cva(
  "group/button cds-btn-squish inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap outline-none select-none focus-visible:not-aria-invalid:border-ring focus-visible:aria-invalid:border-2 focus-visible:aria-invalid:border-destructive disabled:pointer-events-none disabled:border-input disabled:bg-sunken disabled:text-muted-foreground aria-disabled:pointer-events-none aria-disabled:border-input aria-disabled:bg-sunken aria-disabled:text-muted-foreground aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        plain: 'cursor-pointer bg-transparent',
        default:
          'border-button-primary bg-button-primary text-primary-foreground hover:border-button-primary-hover hover:bg-button-primary-hover active:border-button-primary-active active:bg-button-primary-active',
        solid:
          'border-button-primary bg-button-primary text-primary-foreground hover:border-button-primary-hover hover:bg-button-primary-hover active:border-button-primary-active active:bg-button-primary-active',
        outline:
          'border-input bg-background text-foreground hover:not-focus-visible:border-control-boundary hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary:
          'bg-sunken text-secondary-foreground hover:bg-hover aria-expanded:bg-hover aria-expanded:text-secondary-foreground',
        ghost:
          'hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground dark:hover:bg-muted/50',
        destructive:
          'bg-destructive/10 text-destructive hover:bg-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30',
        link: 'text-[var(--color-link)] underline-offset-4 hover:underline',
      },
      size: {
        default:
          'h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 focus-visible:aria-invalid:px-[calc(--spacing(2.5)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-end]:pr-[calc(--spacing(2)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-start]:pl-[calc(--spacing(2)-1px)]',
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 focus-visible:aria-invalid:px-[calc(--spacing(2)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-end]:pr-[calc(--spacing(1.5)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-start]:pl-[calc(--spacing(1.5)-1px)] text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 focus-visible:aria-invalid:px-[calc(--spacing(2.5)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-end]:pr-[calc(--spacing(1.5)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-start]:pl-[calc(--spacing(1.5)-1px)] text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 focus-visible:aria-invalid:px-[calc(--spacing(2.5)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-end]:pr-[calc(--spacing(2)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-start]:pl-[calc(--spacing(2)-1px)]',
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

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariantStyles>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={buttonVariants({ variant, size, className })}
      {...props}
    />
  );
}

export { Button, buttonVariants };
