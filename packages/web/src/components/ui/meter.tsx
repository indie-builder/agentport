import {
  MeterIndicator as MeterIndicatorPrimitive,
  MeterLabel as MeterLabelPrimitive,
  Meter as MeterPrimitive,
  MeterTrack as MeterTrackPrimitive,
  MeterValue as MeterValuePrimitive,
} from '@ui-sdk/react/meter';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const meterClassName = 'grid w-full min-w-0 grid-cols-[1fr_auto] items-center gap-1.5';
const meterLabelClassName = 'text-sm font-medium text-fg';
const meterValueClassName = 'text-xs tabular-nums text-muted-foreground';
const meterTrackClassName =
  'relative col-span-full h-1.5 w-full overflow-hidden rounded-pill bg-sunken';
const meterIndicatorClassName = 'h-full rounded-pill bg-fg transition-[width] duration-150';

type MeterProps = Omit<ComponentProps<typeof MeterPrimitive>, 'className'> & {
  className?: ComponentProps<typeof MeterPrimitive>['className'] | undefined;
};

type MeterLabelProps = Omit<ComponentProps<typeof MeterLabelPrimitive>, 'className'> & {
  className?: ComponentProps<typeof MeterLabelPrimitive>['className'] | undefined;
};

type MeterValueProps = Omit<ComponentProps<typeof MeterValuePrimitive>, 'className'> & {
  className?: ComponentProps<typeof MeterValuePrimitive>['className'] | undefined;
};

type MeterTrackProps = Omit<ComponentProps<typeof MeterTrackPrimitive>, 'className'> & {
  className?: ComponentProps<typeof MeterTrackPrimitive>['className'] | undefined;
};

type MeterIndicatorProps = Omit<ComponentProps<typeof MeterIndicatorPrimitive>, 'className'> & {
  className?: ComponentProps<typeof MeterIndicatorPrimitive>['className'] | undefined;
};

function Meter({ className, ...props }: MeterProps) {
  return (
    <MeterPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(meterClassName, className(state))
          : cn(meterClassName, className)
      }
      {...props}
    />
  );
}

function MeterLabel({ className, ...props }: MeterLabelProps) {
  return (
    <MeterLabelPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(meterLabelClassName, className(state))
          : cn(meterLabelClassName, className)
      }
      {...props}
    />
  );
}

function MeterValue({ className, ...props }: MeterValueProps) {
  return (
    <MeterValuePrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(meterValueClassName, className(state))
          : cn(meterValueClassName, className)
      }
      {...props}
    />
  );
}

function MeterTrack({ className, ...props }: MeterTrackProps) {
  return (
    <MeterTrackPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(meterTrackClassName, className(state))
          : cn(meterTrackClassName, className)
      }
      {...props}
    />
  );
}

function MeterIndicator({ className, ...props }: MeterIndicatorProps) {
  return (
    <MeterIndicatorPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(meterIndicatorClassName, className(state))
          : cn(meterIndicatorClassName, className)
      }
      {...props}
    />
  );
}

export { Meter, MeterIndicator, MeterLabel, MeterTrack, MeterValue };
