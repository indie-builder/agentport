import {
  createScrollAreaController,
  ScrollAreaContent as ScrollAreaContentPrimitive,
  ScrollAreaCorner as ScrollAreaCornerPrimitive,
  ScrollArea as ScrollAreaPrimitive,
  ScrollAreaScrollbar as ScrollAreaScrollbarPrimitive,
  ScrollAreaScrollToEnd as ScrollAreaScrollToEndPrimitive,
  ScrollAreaThumb as ScrollAreaThumbPrimitive,
  ScrollAreaViewport as ScrollAreaViewportPrimitive,
} from '@ui-sdk/react/scroll-area';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

function mergeClassName<State>(
  base: string,
  className: string | ((state: State) => string | undefined) | undefined,
) {
  return typeof className === 'function'
    ? (state: State) => cn(base, className(state))
    : cn(base, className);
}

const scrollAreaClassName = 'relative min-w-0 overflow-hidden';

const scrollAreaViewportClassName =
  'size-full min-w-0 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

const scrollAreaContentClassName = 'min-w-0';

const scrollAreaScrollbarClassName =
  'flex touch-none p-0.5 opacity-0 transition-opacity duration-150 ease-out-soft select-none data-[orientation=vertical]:w-2.5 data-[orientation=vertical]:flex-col data-[orientation=horizontal]:h-2.5 data-visible:opacity-100 motion-reduce:transition-none';

const scrollAreaThumbClassName =
  'relative rounded-pill bg-scrollbar-thumb transition-colors duration-150 hover:bg-scrollbar-thumb-hover data-dragging:bg-scrollbar-thumb-hover data-[orientation=vertical]:w-full data-[orientation=horizontal]:h-full motion-reduce:transition-none';

const scrollAreaCornerClassName = 'bg-transparent';

const scrollAreaScrollToEndClassName =
  'inline-flex items-center justify-center rounded-pill border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg shadow-sm transition-opacity duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-hover opacity-0 data-visible:opacity-100 motion-reduce:transition-none';

type ScrollAreaProps = Omit<ComponentProps<typeof ScrollAreaPrimitive>, 'className'> & {
  className?: ComponentProps<typeof ScrollAreaPrimitive>['className'] | undefined;
};

type ScrollAreaViewportProps = Omit<
  ComponentProps<typeof ScrollAreaViewportPrimitive>,
  'className'
> & {
  className?: ComponentProps<typeof ScrollAreaViewportPrimitive>['className'] | undefined;
};

type ScrollAreaContentProps = Omit<
  ComponentProps<typeof ScrollAreaContentPrimitive>,
  'className'
> & {
  className?: ComponentProps<typeof ScrollAreaContentPrimitive>['className'] | undefined;
};

type ScrollAreaScrollbarProps = Omit<
  ComponentProps<typeof ScrollAreaScrollbarPrimitive>,
  'className'
> & {
  className?: ComponentProps<typeof ScrollAreaScrollbarPrimitive>['className'] | undefined;
};

type ScrollAreaThumbProps = Omit<ComponentProps<typeof ScrollAreaThumbPrimitive>, 'className'> & {
  className?: ComponentProps<typeof ScrollAreaThumbPrimitive>['className'] | undefined;
};

type ScrollAreaCornerProps = Omit<ComponentProps<typeof ScrollAreaCornerPrimitive>, 'className'> & {
  className?: ComponentProps<typeof ScrollAreaCornerPrimitive>['className'] | undefined;
};

type ScrollAreaScrollToEndProps = Omit<
  ComponentProps<typeof ScrollAreaScrollToEndPrimitive>,
  'className'
> & {
  className?: ComponentProps<typeof ScrollAreaScrollToEndPrimitive>['className'] | undefined;
};

function ScrollArea({ className, ...props }: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive className={mergeClassName(scrollAreaClassName, className)} {...props} />
  );
}

function ScrollAreaViewport({ className, ...props }: ScrollAreaViewportProps) {
  return (
    <ScrollAreaViewportPrimitive
      className={mergeClassName(scrollAreaViewportClassName, className)}
      {...props}
    />
  );
}

function ScrollAreaContent({ className, ...props }: ScrollAreaContentProps) {
  return (
    <ScrollAreaContentPrimitive
      className={mergeClassName(scrollAreaContentClassName, className)}
      {...props}
    />
  );
}

function ScrollAreaScrollbar({ className, ...props }: ScrollAreaScrollbarProps) {
  return (
    <ScrollAreaScrollbarPrimitive
      className={mergeClassName(scrollAreaScrollbarClassName, className)}
      {...props}
    />
  );
}

function ScrollAreaThumb({ className, ...props }: ScrollAreaThumbProps) {
  return (
    <ScrollAreaThumbPrimitive
      className={mergeClassName(scrollAreaThumbClassName, className)}
      {...props}
    />
  );
}

function ScrollAreaCorner({ className, ...props }: ScrollAreaCornerProps) {
  return (
    <ScrollAreaCornerPrimitive
      className={mergeClassName(scrollAreaCornerClassName, className)}
      {...props}
    />
  );
}

function ScrollAreaScrollToEnd({ className, ...props }: ScrollAreaScrollToEndProps) {
  return (
    <ScrollAreaScrollToEndPrimitive
      className={mergeClassName(scrollAreaScrollToEndClassName, className)}
      {...props}
    />
  );
}

export {
  createScrollAreaController,
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaCorner,
  ScrollAreaScrollbar,
  ScrollAreaScrollToEnd,
  ScrollAreaThumb,
  ScrollAreaViewport,
};
