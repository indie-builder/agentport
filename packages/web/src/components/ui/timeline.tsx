import {
  createTimelineController,
  TimelineConnector as TimelineConnectorPrimitive,
  TimelineDescription as TimelineDescriptionPrimitive,
  TimelineItem as TimelineItemPrimitive,
  TimelineMarker as TimelineMarkerPrimitive,
  Timeline as TimelinePrimitive,
  type TimelineStatus,
  TimelineTime as TimelineTimePrimitive,
  TimelineTitle as TimelineTitlePrimitive,
} from '@ui-sdk/react/timeline';
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

const timelineClassName =
  'group/timeline flex w-full min-w-0 flex-col data-[orientation=horizontal]:flex-row data-[orientation=horizontal]:items-start';

const timelineItemClassName =
  'group/timeline-item relative grid grid-cols-[1.5rem_minmax(0,1fr)] items-start rounded-icon outline-none focus-visible:ring-2 focus-visible:ring-ring data-[orientation=vertical]:[&>:not([data-slot=timeline-marker]):not([data-slot=timeline-connector])]:col-start-2 data-[orientation=horizontal]:grid-cols-[auto_1fr] data-[orientation=horizontal]:pb-0 data-[orientation=horizontal]:pe-6 data-[orientation=horizontal]:last:pe-0 data-[orientation=horizontal]:data-last:pe-0 data-[orientation=horizontal]:[&>:not([data-slot=timeline-marker]):not([data-slot=timeline-connector])]:col-start-1 data-[orientation=horizontal]:[&>:not([data-slot=timeline-marker]):not([data-slot=timeline-connector])]:col-span-full data-[orientation=horizontal]:[&>:not([data-slot=timeline-marker]):not([data-slot=timeline-connector])]:row-start-2';

const timelineMarkerClassName =
  'relative z-10 col-start-1 row-start-1 flex size-6 shrink-0 items-center justify-center rounded-pill font-mono text-xs tabular-nums text-muted-foreground empty:before:block empty:before:size-2 empty:before:rounded-pill';

const timelineConnectorClassName =
  'pointer-events-none absolute bg-line group-last/timeline-item:hidden group-data-last/timeline-item:hidden data-[orientation=vertical]:top-6 data-[orientation=vertical]:bottom-0 data-[orientation=vertical]:start-[calc(0.75rem-0.5px)] data-[orientation=vertical]:w-px data-[orientation=horizontal]:top-[calc(0.75rem-0.5px)] data-[orientation=horizontal]:start-6 data-[orientation=horizontal]:end-0 data-[orientation=horizontal]:h-px data-complete:bg-success/40';

const timelineTitleClassName = 'min-w-0 break-words';

const timelineTimeClassName = 'text-xs tabular-nums text-muted-foreground';

const timelineDescriptionClassName = 'min-w-0 break-words';

type TimelineProps = Omit<ComponentProps<typeof TimelinePrimitive>, 'className'> & {
  className?: ComponentProps<typeof TimelinePrimitive>['className'] | undefined;
  density?: 'default' | 'compact' | undefined;
};

type TimelineItemProps = Omit<ComponentProps<typeof TimelineItemPrimitive>, 'className'> & {
  className?: ComponentProps<typeof TimelineItemPrimitive>['className'] | undefined;
  density?: 'default' | 'compact' | 'flush' | undefined;
  size?: 'default' | 'base' | 'xs' | undefined;
};

type TimelineMarkerProps = Omit<ComponentProps<typeof TimelineMarkerPrimitive>, 'className'> & {
  className?: ComponentProps<typeof TimelineMarkerPrimitive>['className'] | undefined;
  variant?: 'default' | 'bare' | undefined;
  tone?: 'default' | 'danger' | undefined;
};

type TimelineConnectorProps = Omit<
  ComponentProps<typeof TimelineConnectorPrimitive>,
  'className'
> & {
  className?: ComponentProps<typeof TimelineConnectorPrimitive>['className'] | undefined;
};

type TimelineTimeProps = Omit<ComponentProps<typeof TimelineTimePrimitive>, 'className'> & {
  className?: ComponentProps<typeof TimelineTimePrimitive>['className'] | undefined;
};

type TimelineTitleProps = Omit<ComponentProps<typeof TimelineTitlePrimitive>, 'className'> & {
  className?: ComponentProps<typeof TimelineTitlePrimitive>['className'] | undefined;
  size?: 'default' | 'base' | 'xs' | undefined;
  weight?: 'default' | 'normal' | undefined;
  tone?: 'default' | 'muted' | undefined;
};

type TimelineDescriptionProps = Omit<
  ComponentProps<typeof TimelineDescriptionPrimitive>,
  'className'
> & {
  className?: ComponentProps<typeof TimelineDescriptionPrimitive>['className'] | undefined;
  size?: 'default' | 'base' | 'xs' | undefined;
  tone?: 'default' | 'danger' | undefined;
};

function Timeline({ className, density = 'default', ...props }: TimelineProps) {
  return (
    <TimelinePrimitive
      className={mergeClassName(cn(timelineClassName, density === 'compact' && 'gap-1'), className)}
      {...props}
    />
  );
}

function TimelineItem({
  className,
  density = 'default',
  size = 'default',
  ...props
}: TimelineItemProps) {
  return (
    <TimelineItemPrimitive
      className={mergeClassName(
        cn(
          timelineItemClassName,
          density === 'default' && 'gap-x-2.5 gap-y-1 pb-4 last:pb-0 data-last:pb-0',
          density === 'compact' && 'gap-x-2.5 gap-y-1 pb-2.5 last:pb-0 data-last:pb-0',
          density === 'flush' && 'gap-x-1.5 pb-0',
          size === 'base' && 'text-base',
          size === 'xs' && 'text-2xs',
        ),
        className,
      )}
      {...props}
    />
  );
}

function TimelineMarker({
  className,
  variant = 'default',
  tone = 'default',
  ...props
}: TimelineMarkerProps) {
  return (
    <TimelineMarkerPrimitive
      className={mergeClassName(
        cn(
          timelineMarkerClassName,
          variant === 'default'
            ? 'not-empty:bg-chip not-empty:data-complete:bg-success-soft not-empty:data-complete:text-success not-empty:data-current:bg-selected not-empty:data-current:font-medium not-empty:data-current:text-fg'
            : 'not-empty:bg-transparent not-empty:data-complete:bg-transparent not-empty:data-current:bg-transparent',
          tone === 'default'
            ? 'empty:before:bg-line-strong data-complete:empty:before:bg-success data-current:empty:before:bg-fg'
            : 'empty:before:bg-danger',
        ),
        className,
      )}
      {...props}
    />
  );
}

function TimelineConnector({ className, ...props }: TimelineConnectorProps) {
  return (
    <TimelineConnectorPrimitive
      className={mergeClassName(timelineConnectorClassName, className)}
      {...props}
    />
  );
}

function TimelineTime({ className, ...props }: TimelineTimeProps) {
  return (
    <TimelineTimePrimitive
      className={mergeClassName(timelineTimeClassName, className)}
      {...props}
    />
  );
}

function TimelineTitle({
  className,
  size = 'default',
  weight = 'default',
  tone = 'default',
  ...props
}: TimelineTitleProps) {
  return (
    <TimelineTitlePrimitive
      className={mergeClassName(
        cn(
          timelineTitleClassName,
          size === 'default' && 'text-sm',
          size === 'base' && 'text-base',
          size === 'xs' && 'text-2xs',
          weight === 'default' ? 'font-medium' : 'font-normal',
          tone === 'default' ? 'text-fg' : 'text-muted-foreground',
        ),
        className,
      )}
      {...props}
    />
  );
}

function TimelineDescription({
  className,
  size = 'default',
  tone = 'default',
  ...props
}: TimelineDescriptionProps) {
  return (
    <TimelineDescriptionPrimitive
      className={mergeClassName(
        cn(
          timelineDescriptionClassName,
          size === 'default' && 'text-sm',
          size === 'base' && 'text-base',
          size === 'xs' && 'text-2xs',
          tone === 'default' ? 'text-muted-foreground' : 'text-danger',
        ),
        className,
      )}
      {...props}
    />
  );
}

export {
  createTimelineController,
  Timeline,
  TimelineConnector,
  TimelineDescription,
  TimelineItem,
  TimelineMarker,
  type TimelineStatus,
  TimelineTime,
  TimelineTitle,
};
