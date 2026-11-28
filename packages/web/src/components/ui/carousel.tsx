'use client';

import {
  CarouselContent as CarouselContentPrimitive,
  CarouselItem as CarouselItemPrimitive,
  CarouselNext as CarouselNextPrimitive,
  CarouselPrevious as CarouselPreviousPrimitive,
  Carousel as CarouselPrimitive,
  CarouselViewport as CarouselViewportPrimitive,
} from '@ui-sdk/react/carousel';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';

function Carousel({ className, ...props }: ComponentProps<typeof CarouselPrimitive>) {
  return (
    <CarouselPrimitive
      className={(state) =>
        cn('relative', typeof className === 'function' ? className(state) : className)
      }
      {...props}
    />
  );
}

function CarouselViewport({
  className,
  ...props
}: ComponentProps<typeof CarouselViewportPrimitive>) {
  return (
    <CarouselViewportPrimitive
      className={(state) =>
        cn(
          'scrollbar-none outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function CarouselContent({
  className,
  padding = 'default',
  gap = 'default',
  ...props
}: ComponentProps<typeof CarouselContentPrimitive> & {
  padding?: 'default' | 'y' | undefined;
  gap?: 'default' | 'variable' | undefined;
}) {
  return (
    <CarouselContentPrimitive
      className={(state) =>
        cn(
          padding === 'y' && 'py-2',
          gap === 'variable' && 'gap-(--carousel-gap)',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function CarouselItem({ className, ...props }: ComponentProps<typeof CarouselItemPrimitive>) {
  return (
    <CarouselItemPrimitive
      className={(state) =>
        cn(
          'min-w-0 shrink-0 grow-0 basis-full',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function CarouselPrevious({
  className,
  children,
  position = 'overlay',
  ...props
}: ComponentProps<typeof CarouselPreviousPrimitive> & {
  position?: 'overlay' | 'inline' | undefined;
}) {
  return (
    <CarouselPreviousPrimitive
      className={(state) =>
        cn(
          buttonVariants({ variant: 'outline', size: 'icon-sm' }),
          'touch-manipulation rounded-icon',
          position === 'overlay'
            ? 'absolute inset-y-0 -start-12 my-auto'
            : 'static inset-auto translate-y-0',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    >
      {children ?? (
        <>
          <ChevronLeftIcon aria-hidden="true" className="rtl:rotate-180" />
          <span className="sr-only">上一张</span>
        </>
      )}
    </CarouselPreviousPrimitive>
  );
}

function CarouselNext({
  className,
  children,
  position = 'overlay',
  ...props
}: ComponentProps<typeof CarouselNextPrimitive> & {
  position?: 'overlay' | 'inline' | undefined;
}) {
  return (
    <CarouselNextPrimitive
      className={(state) =>
        cn(
          buttonVariants({ variant: 'outline', size: 'icon-sm' }),
          'touch-manipulation rounded-icon',
          position === 'overlay'
            ? 'absolute inset-y-0 -end-12 my-auto'
            : 'static inset-auto translate-y-0',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    >
      {children ?? (
        <>
          <ChevronRightIcon aria-hidden="true" className="rtl:rotate-180" />
          <span className="sr-only">下一张</span>
        </>
      )}
    </CarouselNextPrimitive>
  );
}

export {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  CarouselViewport,
};
