import { renderElement } from '@ui-sdk/react/primitive';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ElementPartProps, mergeClassName } from '@/components/ui/part-class';

const markerVariants = cva(
  "group/marker relative flex min-h-4 w-full items-center gap-2 text-start text-sm [&_svg:not([class*='size-'])]:size-4 [a]:underline [a]:underline-offset-3 [a]:hover:text-foreground",
  {
    variants: {
      variant: {
        default: '',
        separator:
          'before:me-1 before:h-px before:min-w-0 before:flex-1 before:bg-border after:ms-1 after:h-px after:min-w-0 after:flex-1 after:bg-border',
        border: 'border-b border-border pb-2',
      },
      tone: {
        default: 'text-muted-foreground',
        primary: 'text-fg',
        success: 'text-success',
        warning: 'text-warning',
        danger: 'text-danger',
        muted: 'text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
      tone: 'default',
    },
  },
);

type MarkerState = {
  slot: 'marker';
  variant: NonNullable<VariantProps<typeof markerVariants>['variant']>;
  tone: NonNullable<VariantProps<typeof markerVariants>['tone']>;
};

function Marker({
  className,
  variant = 'default',
  tone = 'default',
  render,
  ...props
}: ElementPartProps<'div', MarkerState> & VariantProps<typeof markerVariants>) {
  const resolvedVariant = variant ?? 'default';
  const resolvedTone = tone ?? 'default';
  return renderElement(
    'div',
    {
      'data-slot': 'marker',
      'data-variant': resolvedVariant,
      'data-tone': resolvedTone,
      ...props,
      className: mergeClassName(
        markerVariants({ variant: resolvedVariant, tone: resolvedTone }),
        className,
      ),
    },
    render,
    { slot: 'marker', variant: resolvedVariant, tone: resolvedTone },
  );
}

function MarkerIcon({
  className,
  render,
  ...props
}: ElementPartProps<'span', { slot: 'marker-icon' }>) {
  return renderElement(
    'span',
    {
      'data-slot': 'marker-icon',
      'aria-hidden': true,
      ...props,
      className: mergeClassName("size-4 shrink-0 [&_svg:not([class*='size-'])]:size-4", className),
    },
    render,
    { slot: 'marker-icon' },
  );
}

function MarkerContent({
  className,
  render,
  ...props
}: ElementPartProps<'span', { slot: 'marker-content' }>) {
  return renderElement(
    'span',
    {
      'data-slot': 'marker-content',
      ...props,
      className: mergeClassName(
        'min-w-0 wrap-break-word group-data-[variant=separator]/marker:flex-none group-data-[variant=separator]/marker:text-center *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      ),
    },
    render,
    { slot: 'marker-content' },
  );
}

export { Marker, MarkerContent, MarkerIcon };
