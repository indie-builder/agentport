import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

const badgeVariants = cva(
  'group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap outline-none transition-colors duration-150 ease-out-soft focus-visible:not-aria-invalid:border-ring focus-visible:aria-invalid:border-2 focus-visible:aria-invalid:px-[calc(--spacing(2)-1px)] focus-visible:aria-invalid:py-[calc(--spacing(0.5)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-end]:pr-[calc(--spacing(1.5)-1px)] focus-visible:aria-invalid:has-data-[icon=inline-start]:pl-[calc(--spacing(1.5)-1px)] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    variants: {
      variant: {
        default: 'bg-muted text-fg [a]:hover:bg-hover',
        secondary: 'bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80',
        destructive:
          'bg-destructive/10 text-destructive dark:bg-destructive/20 [a]:hover:bg-destructive/20',
        outline: 'border-border text-foreground [a]:hover:bg-hover [a]:hover:text-muted-foreground',
        ghost: 'hover:bg-hover hover:text-muted-foreground dark:hover:bg-muted/50',
        link: 'text-[var(--color-link)] underline-offset-4 hover:underline',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant = 'default',
  render,
  ...props
}: useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: 'badge',
      variant,
    },
  });
}

export { Badge, badgeVariants };
