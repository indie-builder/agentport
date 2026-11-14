'use client';

import {
  CarouselContent,
  CarouselItem as CarouselItemPrimitive,
  CarouselNext as CarouselNextPrimitive,
  CarouselPrevious as CarouselPreviousPrimitive,
  Carousel as CarouselPrimitive,
  CarouselViewport as CarouselViewportPrimitive,
} from '@ui-sdk/react/carousel';
import { cn } from 'cn';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { buttonVariants } from '@/components/ui/button';

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
  ...props
}: ComponentProps<typeof CarouselPreviousPrimitive>) {
  return (
    <CarouselPreviousPrimitive
      className={(state) =>
        cn(
          buttonVariants({ variant: 'outline', size: 'icon-sm' }),
          'absolute inset-y-0 -left-12 my-auto touch-manipulation rounded-icon',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    >
      {children ?? (
        <>
          <ChevronLeftIcon />
          <span className="sr-only">上一张</span>
        </>
      )}
    </CarouselPreviousPrimitive>
  );
}

function CarouselNext({
  className,
  children,
  ...props
}: ComponentProps<typeof CarouselNextPrimitive>) {
  return (
    <CarouselNextPrimitive
      className={(state) =>
        cn(
          buttonVariants({ variant: 'outline', size: 'icon-sm' }),
          'absolute inset-y-0 -right-12 my-auto touch-manipulation rounded-icon',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    >
      {children ?? (
        <>
          <ChevronRightIcon />
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
