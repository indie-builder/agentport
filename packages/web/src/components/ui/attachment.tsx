import { type PartProps, renderElement } from '@ui-sdk/react/primitive';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

function mergeClassName<State>(
  base: string,
  className: string | ((state: State) => string | undefined) | undefined,
) {
  return typeof className === 'function'
    ? (state: State) => cn(base, className(state))
    : cn(base, className);
}

const attachmentVariants = cva(
  'group/attachment relative flex w-fit max-w-full min-w-0 shrink-0 flex-wrap rounded-xl border bg-card text-card-foreground transition-colors focus-within:ring-1 focus-within:ring-ring/50 has-[>a,>button]:hover:bg-muted/50 data-[state=error]:border-destructive/30 data-[state=idle]:border-dashed',
  {
    variants: {
      size: {
        default:
          'gap-2 text-sm has-data-[slot=attachment-content]:px-2.5 has-data-[slot=attachment-content]:py-2 has-data-[slot=attachment-media]:p-2',
        sm: 'gap-2.5 text-xs has-data-[slot=attachment-content]:px-2 has-data-[slot=attachment-content]:py-1.5 has-data-[slot=attachment-media]:p-1.5',
        xs: 'gap-1.5 rounded-lg text-xs has-data-[slot=attachment-content]:px-1.5 has-data-[slot=attachment-content]:py-1 has-data-[slot=attachment-media]:p-1',
      },
      orientation: {
        horizontal: 'min-w-40 items-center',
        vertical: 'w-24 flex-col has-data-[slot=attachment-content]:w-30',
      },
    },
  },
);

type AttachmentStatus = 'idle' | 'uploading' | 'processing' | 'error' | 'done';

type AttachmentState = {
  slot: 'attachment';
  state: AttachmentStatus;
  size: NonNullable<VariantProps<typeof attachmentVariants>['size']>;
  orientation: NonNullable<VariantProps<typeof attachmentVariants>['orientation']>;
};

type ElementPartProps<Tag extends keyof React.JSX.IntrinsicElements, State> = Omit<
  PartProps<Tag, State>,
  'className' | 'style' | 'render' | 'children'
> & {
  className?: PartProps<Tag, State>['className'] | undefined;
  style?: PartProps<Tag, State>['style'] | undefined;
  render?: PartProps<Tag, State>['render'] | undefined;
  children?: PartProps<Tag, State>['children'] | undefined;
};

function Attachment({
  className,
  state = 'done',
  size = 'default',
  orientation = 'horizontal',
  render,
  ...props
}: ElementPartProps<'div', AttachmentState> &
  VariantProps<typeof attachmentVariants> & {
    state?: AttachmentStatus;
  }) {
  const resolvedSize = size ?? 'default';
  const resolvedOrientation = orientation ?? 'horizontal';
  return renderElement(
    'div',
    {
      'data-slot': 'attachment',
      'data-state': state,
      'data-size': resolvedSize,
      'data-orientation': resolvedOrientation,
      ...props,
      className: mergeClassName(
        attachmentVariants({ size: resolvedSize, orientation: resolvedOrientation }),
        className,
      ),
    },
    render,
    { slot: 'attachment', state, size: resolvedSize, orientation: resolvedOrientation },
  );
}

const attachmentMediaVariants = cva(
  "relative flex aspect-square w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-foreground group-data-[orientation=vertical]/attachment:w-full group-data-[size=sm]/attachment:w-8 group-data-[size=xs]/attachment:w-7 group-data-[size=xs]/attachment:rounded-md group-data-[state=error]/attachment:bg-destructive/10 group-data-[state=error]/attachment:text-destructive group-data-[orientation=vertical]/attachment:*:data-[slot=spinner]:size-6! [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 group-data-[orientation=vertical]/attachment:[&_svg:not([class*='size-'])]:size-6 group-data-[size=xs]/attachment:[&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        icon: '',
        image:
          'opacity-60 group-data-[state=done]/attachment:opacity-100 group-data-[state=idle]/attachment:opacity-100 *:[img]:aspect-square *:[img]:w-full *:[img]:object-cover',
      },
    },
    defaultVariants: {
      variant: 'icon',
    },
  },
);

type AttachmentMediaState = {
  slot: 'attachment-media';
  variant: NonNullable<VariantProps<typeof attachmentMediaVariants>['variant']>;
};

function AttachmentMedia({
  className,
  variant = 'icon',
  render,
  ...props
}: ElementPartProps<'div', AttachmentMediaState> & VariantProps<typeof attachmentMediaVariants>) {
  const resolvedVariant = variant ?? 'icon';
  return renderElement(
    'div',
    {
      'data-slot': 'attachment-media',
      'data-variant': resolvedVariant,
      ...props,
      className: mergeClassName(attachmentMediaVariants({ variant: resolvedVariant }), className),
    },
    render,
    { slot: 'attachment-media', variant: resolvedVariant },
  );
}

function AttachmentContent({
  className,
  render,
  ...props
}: ElementPartProps<'div', { slot: 'attachment-content' }>) {
  return renderElement(
    'div',
    {
      'data-slot': 'attachment-content',
      ...props,
      className: mergeClassName(
        'max-w-full min-w-0 flex-1 leading-tight group-data-[orientation=vertical]/attachment:px-1',
        className,
      ),
    },
    render,
    { slot: 'attachment-content' },
  );
}

function AttachmentTitle({
  className,
  render,
  ...props
}: ElementPartProps<'span', { slot: 'attachment-title' }>) {
  return renderElement(
    'span',
    {
      'data-slot': 'attachment-title',
      ...props,
      className: mergeClassName(
        'block max-w-full min-w-0 truncate font-medium group-data-[state=processing]/attachment:shimmer group-data-[state=uploading]/attachment:shimmer',
        className,
      ),
    },
    render,
    { slot: 'attachment-title' },
  );
}

function AttachmentDescription({
  className,
  render,
  ...props
}: ElementPartProps<'span', { slot: 'attachment-description' }>) {
  return renderElement(
    'span',
    {
      'data-slot': 'attachment-description',
      ...props,
      className: mergeClassName(
        'mt-0.5 block max-w-full min-w-0 truncate text-xs text-muted-foreground group-data-[state=error]/attachment:text-destructive/80',
        className,
      ),
    },
    render,
    { slot: 'attachment-description' },
  );
}

function AttachmentActions({
  className,
  render,
  ...props
}: ElementPartProps<'div', { slot: 'attachment-actions' }>) {
  return renderElement(
    'div',
    {
      'data-slot': 'attachment-actions',
      ...props,
      className: mergeClassName(
        'relative z-20 flex shrink-0 items-center group-data-[orientation=vertical]/attachment:absolute group-data-[orientation=vertical]/attachment:top-3 group-data-[orientation=vertical]/attachment:right-3 group-data-[orientation=vertical]/attachment:gap-1',
        className,
      ),
    },
    render,
    { slot: 'attachment-actions' },
  );
}

function AttachmentAction({
  variant,
  size = 'icon-xs',
  ...props
}: React.ComponentProps<typeof Button>) {
  return <Button variant={variant ?? 'ghost'} size={size} {...props} />;
}

function AttachmentTrigger({
  className,
  render,
  type,
  ...props
}: ElementPartProps<'button', { slot: 'attachment-trigger' }>) {
  return renderElement(
    'button',
    {
      'data-slot': 'attachment-trigger',
      ...props,
      type: render ? type : (type ?? 'button'),
      className: mergeClassName('absolute inset-0 z-10 outline-none', className),
    },
    render,
    { slot: 'attachment-trigger' },
  );
}

function AttachmentGroup({
  className,
  render,
  ...props
}: ElementPartProps<'div', { slot: 'attachment-group' }>) {
  return renderElement(
    'div',
    {
      'data-slot': 'attachment-group',
      ...props,
      className: mergeClassName(
        'flex min-w-0 scroll-fade-x snap-x snap-mandatory scroll-px-1 scrollbar-none gap-3 overflow-x-auto overscroll-x-contain py-1 *:data-[slot=attachment]:flex-none *:data-[slot=attachment]:snap-start',
        className,
      ),
    },
    render,
    { slot: 'attachment-group' },
  );
}

export {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
};
