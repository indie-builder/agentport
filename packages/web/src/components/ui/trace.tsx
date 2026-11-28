import { ChevronRightIcon } from 'lucide-react';
import type * as React from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/cn';

function Trace({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="trace"
      className={cn(
        'flex w-full min-w-0 flex-col gap-2 *:has-[>[data-slot=trace-line]]:flex *:has-[>[data-slot=trace-line]]:w-fit *:has-[>[data-slot=trace-line]]:max-w-full *:has-[>[data-slot=trace-line]]:min-w-0 *:has-[>[data-slot=trace-line]]:rounded-md *:has-[>[data-slot=trace-line]]:text-start *:has-[>[data-slot=trace-line]]:outline-none *:has-[>[data-slot=trace-line]]:focus-visible:ring-3 *:has-[>[data-slot=trace-line]]:focus-visible:ring-ring/50',
        className,
      )}
      {...props}
    />
  );
}

function TraceLine({
  className,
  status,
  ...props
}: React.ComponentProps<'span'> & {
  status?: 'running' | 'error' | 'pending' | undefined;
}) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        'flex w-fit max-w-full min-w-0 items-center gap-2 text-sm text-muted-foreground transition-colors in-[a,button]:cursor-pointer in-[a:hover,button:hover]:text-foreground data-[status=error]:text-destructive data-[status=error]:in-[a:hover,button:hover]:text-destructive data-[status=pending]:[&_[data-slot=trace-icon]]:opacity-60 data-[status=running]:*:data-[slot=trace-title]:shimmer',
        className,
      )}
      {...props}
    />
  );
}

function TraceIcon({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [[data-slot=trace-title]~&]:-ms-1",
        className,
      )}
      {...props}
    />
  );
}

function TraceTitle({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="trace-title" className={cn('min-w-0 truncate', className)} {...props} />;
}

function TraceDescription({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="trace-description"
      className={cn('shrink-0 text-muted-foreground tabular-nums', className)}
      {...props}
    />
  );
}

const traceCollapsibleTriggerClassName =
  'group/trace-collapsible-trigger flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-md text-start text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 has-[[data-status=error]]:text-destructive';

const traceCollapsibleContentInnerClassName =
  'mt-2 mb-1 ms-[calc(--spacing(2)-1px)] min-w-0 border-s pe-1 ps-4 leading-relaxed wrap-break-word text-muted-foreground';

function TraceCollapsible({
  className,
  open,
  onOpenChange,
  ...props
}: Omit<React.ComponentProps<typeof Collapsible>, 'open' | 'className'> & {
  className?: React.ComponentProps<typeof Collapsible>['className'] | undefined;
} & (
    | { open?: undefined }
    | {
        open: boolean;
        onOpenChange: NonNullable<React.ComponentProps<typeof Collapsible>['onOpenChange']>;
      }
  )) {
  return (
    <Collapsible
      className={
        typeof className === 'function'
          ? (state) => cn('flex w-full min-w-0 flex-col', className(state))
          : cn('flex w-full min-w-0 flex-col', className)
      }
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
      {...props}
    />
  );
}

function TraceCollapsibleTrigger({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof CollapsibleTrigger>, 'className'> & {
  className?: React.ComponentProps<typeof CollapsibleTrigger>['className'] | undefined;
}) {
  const icon = (
    <TraceIcon className="transition-transform group-aria-expanded/trace-collapsible-trigger:rotate-90">
      <ChevronRightIcon />
    </TraceIcon>
  );
  return (
    <CollapsibleTrigger
      className={
        typeof className === 'function'
          ? (state) => cn(traceCollapsibleTriggerClassName, className(state))
          : cn(traceCollapsibleTriggerClassName, className)
      }
      {...props}
    >
      {typeof children === 'function' ? (
        (state) => (
          <>
            {children(state)}
            {icon}
          </>
        )
      ) : (
        <>
          {children}
          {icon}
        </>
      )}
    </CollapsibleTrigger>
  );
}

function TraceCollapsibleContent({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof CollapsibleContent>, 'className'> & {
  className?: React.ComponentProps<typeof CollapsibleContent>['className'] | undefined;
}) {
  return (
    <CollapsibleContent
      className="h-(--collapsible-panel-height) min-w-0 overflow-hidden transition-[height] duration-200 data-ending-style:h-0 data-starting-style:h-0"
      {...props}
    >
      {(state) => (
        <div
          data-slot="trace-collapsible-content-inner"
          className={cn(
            traceCollapsibleContentInnerClassName,
            typeof className === 'function' ? className(state) : className,
          )}
        >
          {typeof children === 'function' ? children(state) : children}
        </div>
      )}
    </CollapsibleContent>
  );
}

export {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
};
