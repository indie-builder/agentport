import { renderElement } from '@ui-sdk/react/primitive';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ElementPartProps, mergeClassName } from '@/components/ui/part-class';

const markerVariants = cva(
  "group/marker relative flex min-h-4 w-full items-center gap-2 text-start text-sm text-muted-foreground [&_svg:not([class*='size-'])]:size-4 [a]:underline [a]:underline-offset-3 [a]:hover:text-foreground",
  {
    variants: {
      variant: {
        default: '',
        separator:
          'before:me-1 before:h-px before:min-w-0 before:flex-1 before:bg-border after:ms-1 after:h-px after:min-w-0 after:flex-1 after:bg-border',
        border: 'border-b border-border pb-2',
      },
    },
  },
);

type MarkerState = {
  slot: 'marker';
  variant: NonNullable<VariantProps<typeof markerVariants>['variant']>;
};

function Marker({
  className,
  variant = 'default',
  render,
  ...props
}: ElementPartProps<'div', MarkerState> & VariantProps<typeof markerVariants>) {
  const resolvedVariant = variant ?? 'default';
  return renderElement(
    'div',
    {
      'data-slot': 'marker',
      'data-variant': resolvedVariant,
      ...props,
      className: mergeClassName(markerVariants({ variant: resolvedVariant }), className),
    },
    render,
    { slot: 'marker', variant: resolvedVariant },
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
