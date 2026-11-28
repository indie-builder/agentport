import {
  ProgressIndicator as ProgressIndicatorPrimitive,
  ProgressLabel as ProgressLabelPrimitive,
  Progress as ProgressPrimitive,
  ProgressTrack as ProgressTrackPrimitive,
  ProgressValue as ProgressValuePrimitive,
} from '@ui-sdk/react/progress';
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

const progressClassName = 'grid w-full min-w-0 grid-cols-[1fr_auto] items-center';
const progressGap = {
  default: 'gap-1.5',
  md: 'gap-2',
  sm: 'gap-1',
  none: 'gap-0',
} as const;
const progressLabelClassName = 'text-sm font-medium text-fg';
const progressValueClassName = 'text-xs tabular-nums text-muted-foreground';
const progressTrackClassName =
  'relative col-span-full h-1.5 w-full overflow-hidden rounded-pill bg-sunken';
const progressIndicatorClassName =
  'h-full rounded-pill transition-[width] duration-150 motion-reduce:transition-none data-indeterminate:w-full data-indeterminate:animate-pulse data-indeterminate:bg-subtle/40 motion-reduce:data-indeterminate:animate-none';
const progressIndicatorTone = {
  default: 'bg-fg',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-subtle',
} as const;

type ProgressProps = Omit<ComponentProps<typeof ProgressPrimitive>, 'className' | 'value'> & {
  className?: ComponentProps<typeof ProgressPrimitive>['className'] | undefined;
  value?: number | null | undefined;
  gap?: keyof typeof progressGap | undefined;
};

type ProgressLabelProps = Omit<ComponentProps<typeof ProgressLabelPrimitive>, 'className'> & {
  className?: ComponentProps<typeof ProgressLabelPrimitive>['className'] | undefined;
};

type ProgressValueProps = Omit<ComponentProps<typeof ProgressValuePrimitive>, 'className'> & {
  className?: ComponentProps<typeof ProgressValuePrimitive>['className'] | undefined;
};

type ProgressTrackProps = Omit<ComponentProps<typeof ProgressTrackPrimitive>, 'className'> & {
  className?: ComponentProps<typeof ProgressTrackPrimitive>['className'] | undefined;
};

type ProgressIndicatorProps = Omit<
  ComponentProps<typeof ProgressIndicatorPrimitive>,
  'className'
> & {
  className?: ComponentProps<typeof ProgressIndicatorPrimitive>['className'] | undefined;
  tone?: keyof typeof progressIndicatorTone | undefined;
};

function Progress({ className, value, gap = 'default', ...props }: ProgressProps) {
  return (
    <ProgressPrimitive
      className={mergeClassName(cn(progressClassName, progressGap[gap]), className)}
      {...(value === undefined ? {} : { value })}
      {...props}
    />
  );
}

function ProgressLabel({ className, ...props }: ProgressLabelProps) {
  return (
    <ProgressLabelPrimitive
      className={mergeClassName(progressLabelClassName, className)}
      {...props}
    />
  );
}

function ProgressValue({ className, ...props }: ProgressValueProps) {
  return (
    <ProgressValuePrimitive
      className={mergeClassName(progressValueClassName, className)}
      {...props}
    />
  );
}

function ProgressTrack({ className, ...props }: ProgressTrackProps) {
  return (
    <ProgressTrackPrimitive
      className={mergeClassName(progressTrackClassName, className)}
      {...props}
    />
  );
}

function ProgressIndicator({ className, tone = 'default', ...props }: ProgressIndicatorProps) {
  return (
    <ProgressIndicatorPrimitive
      data-tone={tone}
      className={mergeClassName(
        cn(progressIndicatorClassName, progressIndicatorTone[tone]),
        className,
      )}
      {...props}
    />
  );
}

export { Progress, ProgressIndicator, ProgressLabel, ProgressTrack, ProgressValue };
