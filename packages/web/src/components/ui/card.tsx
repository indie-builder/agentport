import type * as React from 'react';
import { cn } from '@/lib/cn';

function Card({
  className,
  size = 'default',
  hover = 'shadow',
  gap = 'default',
  muted = false,
  ...props
}: React.ComponentProps<'div'> & {
  size?: 'default' | 'sm';
  hover?: 'static' | 'shadow' | 'lift';
  gap?: 'default' | 'sm';
  muted?: boolean;
}) {
  return (
    <div
      data-slot="card"
      data-size={size}
      data-hover={hover}
      className={cn(
        'group/card flex flex-col overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl',
        gap === 'sm' ? 'gap-3' : 'gap-(--card-spacing)',
        muted && 'opacity-70',
        'cds-card-surface',
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({
  className,
  bordered = false,
  ...props
}: React.ComponentProps<'div'> & { bordered?: boolean }) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        'group/card-header @container/card-header grid auto-rows-min items-center gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] has-data-[slot=card-description]:items-start [.border-b]:pb-(--card-spacing)',
        bordered && 'border-b pb-(--card-spacing)',
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-title"
      className={cn('text-base font-medium group-data-[size=sm]/card:text-sm', className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        'col-start-2 row-start-1 self-center justify-self-end group-has-data-[slot=card-description]/card-header:row-span-2 group-has-data-[slot=card-description]/card-header:self-start [&>:last-child[data-variant=ghost][data-size=default]]:-me-2.5 [&>:last-child[data-variant=ghost][data-size=sm]]:-me-2.5 [&>:last-child[data-variant=ghost][data-size=icon]]:-me-2 [&>:last-child[data-variant=ghost][data-size=icon-sm]]:-me-1.5 [&>:last-child[data-variant=ghost][data-size=icon-xs]]:-me-1.5',
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="card-content" className={cn('px-(--card-spacing)', className)} {...props} />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        'flex items-center rounded-b-xl border-t-[length:var(--hairline)] border-line p-(--card-spacing) [&>:last-child[data-variant=ghost][data-size=default]]:-me-2.5 [&>:last-child[data-variant=ghost][data-size=sm]]:-me-2.5 [&>:last-child[data-variant=link][data-size=default]]:-me-2.5 [&>:last-child[data-variant=link][data-size=sm]]:-me-2.5 [&>:last-child[data-variant=ghost][data-size=icon]]:-me-2 [&>:last-child[data-variant=ghost][data-size=icon-sm]]:-me-1.5 [&>:last-child[data-variant=ghost][data-size=icon-xs]]:-me-1.5',
        className,
      )}
      {...props}
    />
  );
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
