import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

const toggleVariants = cva(
  "group/toggle inline-flex border border-transparent items-center justify-center gap-1 rounded-lg text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,opacity] duration-150 ease-out-soft outline-none hover:bg-hover hover:text-foreground focus-visible:not-aria-invalid:border-ring focus-visible:aria-invalid:border-2 disabled:pointer-events-none disabled:bg-sunken disabled:text-muted-foreground aria-invalid:border-destructive aria-pressed:bg-selected aria-pressed:text-selected-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border border-input bg-background hover:bg-hover',
      },
      size: {
        default:
          'h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 focus-visible:aria-invalid:px-[calc(--spacing(2.5)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-end]:pr-[calc(--spacing(2)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-start]:pl-[calc(--spacing(2)-1px)]',
        sm: "h-7 min-w-7 rounded-[min(var(--radius-md),12px)] px-2.5 focus-visible:aria-invalid:px-[calc(--spacing(2.5)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-end]:pr-[calc(--spacing(1.5)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-start]:pl-[calc(--spacing(1.5)-1px)] text-sm has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 min-w-9 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 focus-visible:aria-invalid:px-[calc(--spacing(2.5)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-end]:pr-[calc(--spacing(2)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-start]:pl-[calc(--spacing(2)-1px)]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Toggle({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
