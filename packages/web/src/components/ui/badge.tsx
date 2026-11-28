import { renderElement } from '@ui-sdk/react/primitive';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ElementPartProps, mergeClassName } from '@/components/ui/part-class';

const badgeVariants = cva(
  'group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden border border-transparent py-0.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3!',
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
        neutral: 'border-line bg-sunken text-fg',
        success: 'border-line bg-success-soft text-success',
        warn: 'border-line bg-warning-soft text-warning',
        brand: 'border-line bg-selected text-fg',
        danger: 'border-line bg-danger-soft text-danger',
        subtle: 'border-line-strong bg-transparent text-muted-foreground',
        mono: 'border-code-line bg-code font-mono text-muted-foreground',
      },
      size: {
        default: 'rounded-4xl px-2',
        tag: 'rounded-tag px-1.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

type BadgeState = {
  slot: 'badge';
  variant: NonNullable<VariantProps<typeof badgeVariants>['variant']>;
  size: NonNullable<VariantProps<typeof badgeVariants>['size']>;
};

function Badge({
  className,
  variant = 'default',
  size = 'default',
  render,
  ...props
}: ElementPartProps<'span', BadgeState> & VariantProps<typeof badgeVariants>) {
  const resolvedVariant = variant ?? 'default';
  const resolvedSize = size ?? 'default';
  return renderElement(
    'span',
    {
      'data-slot': 'badge',
      'data-variant': resolvedVariant,
      'data-size': resolvedSize,
      ...props,
      className: mergeClassName(
        badgeVariants({ variant: resolvedVariant, size: resolvedSize }),
        className,
      ),
    },
    render,
    { slot: 'badge', variant: resolvedVariant, size: resolvedSize },
  );
}

export { Badge };
