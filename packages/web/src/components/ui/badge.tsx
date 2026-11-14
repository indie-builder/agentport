import { type PartProps, renderElement } from '@ui-sdk/react/primitive';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    variants: {
      variant: {
        default:
          'bg-muted text-fg focus-visible:ring-offset-2 focus-visible:ring-offset-background [a]:hover:bg-hover',
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
}: React.ComponentProps<'span'> & {
  render?: PartProps<
    'span',
    { slot: 'badge'; variant: VariantProps<typeof badgeVariants>['variant'] }
  >['render'];
} & VariantProps<typeof badgeVariants>) {
  return renderElement(
    'span',
    {
      'data-slot': 'badge',
      'data-variant': variant,
      ...props,
      className: cn(badgeVariants({ variant }), className),
    },
    render,
    { slot: 'badge', variant },
  );
}

export { Badge, badgeVariants };
