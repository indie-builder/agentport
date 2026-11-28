'use client';

import {
  createTimeInputController,
  TimeInput as TimeInputPrimitive,
  TimeInputSegment as TimeInputSegmentPrimitive,
  type TimeInputState,
} from '@ui-sdk/react/time-input';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

type WithOptionalClassName<T extends { className?: unknown }> = Omit<T, 'className'> & {
  className?: T['className'] | undefined;
};

type TimeInputProps = Omit<
  WithOptionalClassName<ComponentProps<typeof TimeInputPrimitive>>,
  'value' | 'defaultValue' | 'controller'
> & {
  value?: ComponentProps<typeof TimeInputPrimitive>['value'] | undefined;
  defaultValue?: ComponentProps<typeof TimeInputPrimitive>['defaultValue'] | undefined;
  controller?: ComponentProps<typeof TimeInputPrimitive>['controller'] | undefined;
};

type TimeInputSegmentProps = WithOptionalClassName<
  ComponentProps<typeof TimeInputSegmentPrimitive>
>;

const timeInputClassName =
  'flex h-8 w-full min-w-0 items-center rounded-item border border-input bg-transparent px-2.5 py-1 text-sm text-fg tabular-nums transition-colors outline-none has-[:focus-visible]:border-subtle data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:bg-sunken data-disabled:opacity-35 aria-invalid:border-destructive aria-invalid:has-[:focus-visible]:border-destructive data-invalid:border-destructive data-invalid:has-[:focus-visible]:border-destructive';

const timeInputLiteralSegmentClassName = 'px-px text-muted-foreground whitespace-pre select-none';

const timeInputEditableSegmentClassName =
  'h-5.5 w-[calc(2ch+4px)] rounded-[calc(var(--radius-item)/2)] border-0 bg-transparent px-0.5 text-center font-[inherit] text-inherit caret-transparent outline-none placeholder:text-muted-foreground selection:bg-transparent focus:bg-primary focus:text-primary-foreground focus:placeholder:text-primary-foreground disabled:cursor-not-allowed data-[type=dayPeriod]:w-auto data-[type=dayPeriod]:min-w-[calc(2.6ch+4px)] data-[type=dayPeriod]:px-1';

function mergeClassName<S>(
  base: string,
  className: string | ((state: S) => string | undefined) | undefined,
) {
  return typeof className === 'function'
    ? (state: S) => cn(base, className(state))
    : cn(base, className);
}

function TimeInputSegment({ className, ...props }: TimeInputSegmentProps) {
  return (
    <TimeInputSegmentPrimitive
      className={mergeClassName(
        props.segment.editable
          ? timeInputEditableSegmentClassName
          : timeInputLiteralSegmentClassName,
        className,
      )}
      {...props}
    />
  );
}

function TimeInput({
  className,
  children,
  value,
  defaultValue,
  controller,
  ...props
}: TimeInputProps) {
  return (
    <TimeInputPrimitive
      {...(value === undefined ? {} : { value })}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      {...(controller === undefined ? {} : { controller })}
      className={mergeClassName(timeInputClassName, className)}
      {...props}
    >
      {children ??
        ((state: TimeInputState) =>
          state.segments.map((segment) => (
            <TimeInputSegment key={segment.key} segment={segment} />
          )))}
    </TimeInputPrimitive>
  );
}

export { createTimeInputController, TimeInput, TimeInputSegment };
