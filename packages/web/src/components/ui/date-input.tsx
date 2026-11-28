'use client';

import {
  createDateInputController,
  DateInput as DateInputPrimitive,
  DateInputSegment as DateInputSegmentPrimitive,
  type DateInputState,
} from '@ui-sdk/react/date-input';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

type WithOptionalClassName<T extends { className?: unknown }> = Omit<T, 'className'> & {
  className?: T['className'] | undefined;
};

type DateInputProps = Omit<
  WithOptionalClassName<ComponentProps<typeof DateInputPrimitive>>,
  'value' | 'defaultValue' | 'controller'
> & {
  value?: ComponentProps<typeof DateInputPrimitive>['value'] | undefined;
  defaultValue?: ComponentProps<typeof DateInputPrimitive>['defaultValue'] | undefined;
  controller?: ComponentProps<typeof DateInputPrimitive>['controller'] | undefined;
};

type DateInputSegmentProps = WithOptionalClassName<
  ComponentProps<typeof DateInputSegmentPrimitive>
>;

const dateInputClassName =
  'flex h-8 w-full min-w-0 items-center rounded-item border border-input bg-transparent px-2.5 py-1 text-sm text-fg tabular-nums transition-colors outline-none has-[:focus-visible]:border-subtle data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:bg-sunken data-disabled:opacity-35 aria-invalid:border-destructive aria-invalid:has-[:focus-visible]:border-destructive data-invalid:border-destructive data-invalid:has-[:focus-visible]:border-destructive';

const dateInputLiteralSegmentClassName = 'px-px text-muted-foreground whitespace-pre select-none';

const dateInputEditableSegmentClassName =
  'h-5.5 w-[calc(2ch+4px)] rounded-[calc(var(--radius-item)/2)] border-0 bg-transparent px-0.5 text-center font-[inherit] text-inherit caret-transparent outline-none placeholder:text-muted-foreground selection:bg-transparent focus:bg-primary focus:text-primary-foreground focus:placeholder:text-primary-foreground disabled:cursor-not-allowed data-[type=year]:w-[calc(4ch+4px)] data-[type=dayPeriod]:w-auto data-[type=dayPeriod]:min-w-[calc(2.6ch+4px)] data-[type=dayPeriod]:px-1';

function mergeClassName<S>(
  base: string,
  className: string | ((state: S) => string | undefined) | undefined,
) {
  return typeof className === 'function'
    ? (state: S) => cn(base, className(state))
    : cn(base, className);
}

function DateInputSegment({ className, ...props }: DateInputSegmentProps) {
  return (
    <DateInputSegmentPrimitive
      className={mergeClassName(
        props.segment.editable
          ? dateInputEditableSegmentClassName
          : dateInputLiteralSegmentClassName,
        className,
      )}
      {...props}
    />
  );
}

function DateInput({
  className,
  children,
  value,
  defaultValue,
  controller,
  ...props
}: DateInputProps) {
  return (
    <DateInputPrimitive
      {...(value === undefined ? {} : { value })}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      {...(controller === undefined ? {} : { controller })}
      className={mergeClassName(dateInputClassName, className)}
      {...props}
    >
      {children ??
        ((state: DateInputState) =>
          state.segments.map((segment) => (
            <DateInputSegment key={segment.key} segment={segment} />
          )))}
    </DateInputPrimitive>
  );
}

export { createDateInputController, DateInput, DateInputSegment };
