import { renderElement } from '@ui-sdk/react/primitive';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ElementPartProps, mergeClassName } from '@/components/ui/part-class';

const badgeVariants = cva(
  'group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    variants: {
      variant: {
        default:
          'bg-muted text-fg focus-visible:ring-offset-2 focus-visible:ring-offset-background [a]:hover:bg-hover',
        secondary: 'bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80',
        destructive: 'bg-destructive/10 text-destructive [a]:hover:bg-destructive/20',
        outline: 'border-border text-foreground [a]:hover:bg-hover [a]:hover:text-muted-foreground',
        ghost: 'hover:bg-hover hover:text-muted-foreground',
        link: 'text-link underline-offset-4 hover:underline',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

type BadgeState = {
  slot: 'badge';
  variant: NonNullable<VariantProps<typeof badgeVariants>['variant']>;
};

function Badge({
  className,
  variant = 'default',
  render,
  ...props
}: ElementPartProps<'span', BadgeState> & VariantProps<typeof badgeVariants>) {
  const resolvedVariant = variant ?? 'default';
  return renderElement(
    'span',
    {
      'data-slot': 'badge',
      'data-variant': resolvedVariant,
      ...props,
      className: mergeClassName(badgeVariants({ variant: resolvedVariant }), className),
    },
    render,
    { slot: 'badge', variant: resolvedVariant },
  );
}

export { Badge };
