'use client';

import {
  CalendarDay as CalendarDayPrimitive,
  CalendarGrid as CalendarGridPrimitive,
  CalendarHeading as CalendarHeadingPrimitive,
  CalendarMonthSelect,
  CalendarNext as CalendarNextPrimitive,
  CalendarPrevious as CalendarPreviousPrimitive,
  CalendarWeekday as CalendarWeekdayPrimitive,
  CalendarWeekdays,
  CalendarWeeks,
  CalendarYearSelect,
  createDatePickerController,
  DatePickerClear as DatePickerClearPrimitive,
  DatePickerContent as DatePickerContentPrimitive,
  DatePickerHint as DatePickerHintPrimitive,
  DatePickerInput as DatePickerInputPrimitive,
  DatePickerPreset as DatePickerPresetPrimitive,
  DatePicker as DatePickerPrimitive,
  DatePickerTrigger as DatePickerTriggerPrimitive,
} from '@ui-sdk/react/date-picker';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { type ComponentProps, createContext, useContext } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';

type WithOptionalClassName<T extends { className?: unknown }> = Omit<T, 'className'> & {
  className?: T['className'] | undefined;
};

type DatePickerProps = Omit<
  WithOptionalClassName<ComponentProps<typeof DatePickerPrimitive>>,
  'value' | 'defaultValue' | 'month' | 'defaultMonth' | 'open' | 'defaultOpen' | 'months'
> & {
  value?: ComponentProps<typeof DatePickerPrimitive>['value'] | undefined;
  defaultValue?: ComponentProps<typeof DatePickerPrimitive>['defaultValue'] | undefined;
  month?: ComponentProps<typeof DatePickerPrimitive>['month'] | undefined;
  defaultMonth?: ComponentProps<typeof DatePickerPrimitive>['defaultMonth'] | undefined;
  open?: ComponentProps<typeof DatePickerPrimitive>['open'] | undefined;
  defaultOpen?: ComponentProps<typeof DatePickerPrimitive>['defaultOpen'] | undefined;
  months?: ComponentProps<typeof DatePickerPrimitive>['months'] | undefined;
};

const DatePickerMonthsContext = createContext(1);

const datePickerClassName = 'group/date-picker flex w-full min-w-0 flex-col gap-1.5';

const datePickerGroupClassName =
  'group/date-picker-group relative flex h-8 w-full min-w-0 items-center gap-1 rounded-[var(--radius-item)] border border-input bg-transparent ps-1 pe-1 transition-colors outline-none has-[>[data-slot=date-picker-input]:first-child]:ps-2.5 has-[>[data-slot=date-picker-input]:last-child]:pe-2.5 group-data-disabled/date-picker:pointer-events-none group-data-disabled/date-picker:cursor-not-allowed group-data-disabled/date-picker:bg-sunken group-data-disabled/date-picker:opacity-[0.35] has-[[data-slot=date-picker-input]:focus-visible]:border-input-focus has-[[data-slot=date-picker-input][aria-invalid=true]]:border-destructive has-[[data-slot=date-picker-input][aria-invalid=true]:focus-visible]:border-destructive has-[[data-slot=date-picker-input][data-invalid]]:border-destructive has-[[data-slot=date-picker-input][data-invalid]:focus-visible]:border-destructive dark:bg-input/30 dark:group-data-disabled/date-picker:bg-input/80 dark:has-[[data-slot=date-picker-input][aria-invalid=true]]:border-destructive/50';

const datePickerInputClassName =
  'h-8 w-full min-w-0 flex-1 rounded-[var(--radius-item)] border border-input bg-transparent px-2.5 py-1 text-sm text-fg tabular-nums transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-input-focus disabled:cursor-not-allowed data-disabled:bg-sunken data-disabled:opacity-[0.35] aria-invalid:border-destructive data-invalid:border-destructive in-data-[slot=date-picker-group]:h-full in-data-[slot=date-picker-group]:border-0 in-data-[slot=date-picker-group]:bg-transparent in-data-[slot=date-picker-group]:px-0 in-data-[slot=date-picker-group]:not-first:ps-1 in-data-[slot=date-picker-group]:not-last:pe-1 in-data-[slot=date-picker-group]:data-disabled:bg-transparent in-data-[slot=date-picker-group]:data-disabled:opacity-100';

const datePickerClearClassName = buttonVariants({
  variant: 'ghost',
  size: 'icon-xs',
  className:
    "shrink-0 rounded-[var(--radius-icon)] text-muted-foreground hover:text-fg data-empty:hidden in-data-[slot=date-picker-group]:data-disabled:opacity-100 [&_svg:not([class*='size-'])]:size-3.5",
});

const datePickerTriggerClassName = buttonVariants({
  variant: 'ghost',
  size: 'icon-xs',
  className:
    "shrink-0 rounded-[var(--radius-icon)] text-muted-foreground hover:text-fg in-data-[slot=date-picker-group]:data-disabled:opacity-100 [&_svg:not([class*='size-'])]:size-4",
});

const datePickerContentClassName =
  'z-50 flex w-fit max-h-(--available-height) max-w-(--available-width) flex-col gap-2.5 overflow-y-auto overscroll-contain rounded-[var(--radius-popover)] bg-surface p-2.5 text-sm text-fg shadow-overlay ring-1 ring-line outline-none cds-overlay-enter';

const datePickerHintClassName = 'text-xs text-muted-foreground tabular-nums';

const datePickerPresetClassName = buttonVariants({
  variant: 'ghost',
  size: 'sm',
  className: 'justify-start data-selected:bg-selected data-selected:text-selected-foreground',
});

function mergeClassName<S>(
  base: string,
  className: string | ((state: S) => string | undefined) | undefined,
) {
  return typeof className === 'function'
    ? (state: S) => cn(base, className(state))
    : cn(base, className);
}

function DatePicker({
  className,
  value,
  defaultValue,
  month,
  defaultMonth,
  open,
  defaultOpen,
  months,
  children,
  ...props
}: DatePickerProps) {
  return (
    <DatePickerMonthsContext.Provider value={months ?? 1}>
      <DatePickerPrimitive
        {...(value === undefined ? {} : { value })}
        {...(defaultValue === undefined ? {} : { defaultValue })}
        {...(month === undefined ? {} : { month })}
        {...(defaultMonth === undefined ? {} : { defaultMonth })}
        {...(open === undefined ? {} : { open })}
        {...(defaultOpen === undefined ? {} : { defaultOpen })}
        {...(months === undefined ? {} : { months })}
        className={mergeClassName(datePickerClassName, className)}
        {...props}
      >
        {children === undefined ? (
          <>
            <DatePickerGroup>
              <DatePickerInput />
              {props.mode === 'range' ? (
                <>
                  <span aria-hidden="true" className="text-muted-foreground select-none">
                    –
                  </span>
                  <DatePickerInput end />
                </>
              ) : null}
              <DatePickerClear />
              <DatePickerTrigger />
            </DatePickerGroup>
            <DatePickerContent />
          </>
        ) : (
          children
        )}
      </DatePickerPrimitive>
    </DatePickerMonthsContext.Provider>
  );
}

function DatePickerGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="date-picker-group"
      className={cn(datePickerGroupClassName, className)}
      {...props}
    />
  );
}

function DatePickerInput({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof DatePickerInputPrimitive>>) {
  return (
    <DatePickerInputPrimitive
      className={mergeClassName(datePickerInputClassName, className)}
      {...props}
    />
  );
}

function DatePickerClear({
  className,
  children,
  'aria-label': ariaLabel = '清除日期',
  ...props
}: WithOptionalClassName<ComponentProps<typeof DatePickerClearPrimitive>>) {
  return (
    <DatePickerClearPrimitive
      aria-label={ariaLabel}
      className={mergeClassName(datePickerClearClassName, className)}
      {...props}
    >
      {children ?? <X aria-hidden="true" />}
    </DatePickerClearPrimitive>
  );
}

function DatePickerTrigger({
  className,
  children,
  'aria-label': ariaLabel = '选择日期',
  ...props
}: WithOptionalClassName<ComponentProps<typeof DatePickerTriggerPrimitive>>) {
  return (
    <DatePickerTriggerPrimitive
      aria-label={ariaLabel}
      className={mergeClassName(datePickerTriggerClassName, className)}
      {...props}
    >
      {children ?? <CalendarDays aria-hidden="true" />}
    </DatePickerTriggerPrimitive>
  );
}

function DatePickerHint({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof DatePickerHintPrimitive>>) {
  return (
    <DatePickerHintPrimitive
      className={mergeClassName(datePickerHintClassName, className)}
      {...props}
    />
  );
}

function DatePickerPreset({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof DatePickerPresetPrimitive>>) {
  return (
    <DatePickerPresetPrimitive
      className={mergeClassName(datePickerPresetClassName, className)}
      {...props}
    />
  );
}

function DatePickerContent({
  className,
  align = 'start',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  children,
  ...props
}: WithOptionalClassName<ComponentProps<typeof DatePickerContentPrimitive>>) {
  return (
    <DatePickerContentPrimitive
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      className={mergeClassName(datePickerContentClassName, className)}
      {...props}
    >
      {children === undefined ? <DatePickerCalendar /> : children}
    </DatePickerContentPrimitive>
  );
}

function CalendarPrevious({
  className,
  children,
  'aria-label': ariaLabel = '上个月',
  ...props
}: WithOptionalClassName<ComponentProps<typeof CalendarPreviousPrimitive>>) {
  return (
    <CalendarPreviousPrimitive
      aria-label={ariaLabel}
      className={mergeClassName(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), className)}
      {...props}
    >
      {children ?? <ChevronLeft aria-hidden="true" className="rtl:rotate-180" />}
    </CalendarPreviousPrimitive>
  );
}

function CalendarNext({
  className,
  children,
  'aria-label': ariaLabel = '下个月',
  ...props
}: WithOptionalClassName<ComponentProps<typeof CalendarNextPrimitive>>) {
  return (
    <CalendarNextPrimitive
      aria-label={ariaLabel}
      className={mergeClassName(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), className)}
      {...props}
    >
      {children ?? <ChevronRight aria-hidden="true" className="rtl:rotate-180" />}
    </CalendarNextPrimitive>
  );
}

function CalendarHeading({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof CalendarHeadingPrimitive>>) {
  return (
    <CalendarHeadingPrimitive
      className={mergeClassName('text-sm font-medium select-none', className)}
      {...props}
    />
  );
}

function CalendarGrid({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof CalendarGridPrimitive>>) {
  return (
    <CalendarGridPrimitive
      className={mergeClassName('w-full border-collapse', className)}
      {...props}
    />
  );
}

function CalendarWeekday({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof CalendarWeekdayPrimitive>>) {
  return (
    <CalendarWeekdayPrimitive
      className={mergeClassName(
        'h-7 p-0 text-xs font-normal text-muted-foreground select-none',
        className,
      )}
      {...props}
    />
  );
}

function CalendarDay({
  className,
  children,
  ...props
}: WithOptionalClassName<ComponentProps<typeof CalendarDayPrimitive>>) {
  return (
    <CalendarDayPrimitive
      className={(state) =>
        cn(
          'size-(--cell-size) p-0 text-center align-middle text-sm tabular-nums select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          state.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
          !state.disabled && !state.selected && 'hover:bg-hover',
          state.outside && 'text-muted-foreground',
          state.selected && 'bg-selected text-selected-foreground',
          state.today && !state.selected && !state.inRange && 'bg-muted',
          !state.inRange && 'rounded-(--cell-radius)',
          state.rangeStart && state.rangeEnd && 'rounded-(--cell-radius)',
          state.rangeStart && !state.rangeEnd && 'rounded-s-(--cell-radius) rounded-e-none',
          state.rangeEnd && !state.rangeStart && 'rounded-e-(--cell-radius) rounded-s-none',
          state.inRange && !state.rangeStart && !state.rangeEnd && 'rounded-none',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    >
      {children ?? ((state) => Number(state.date.slice(8, 10)))}
    </CalendarDayPrimitive>
  );
}

function DatePickerCalendar({
  months,
  className,
  ...props
}: ComponentProps<'div'> & { months?: number | undefined }) {
  const contextMonths = useContext(DatePickerMonthsContext);
  const count = months ?? contextMonths;
  const offsets = Array.from({ length: count }, (_, offset) => offset);

  return (
    <div
      className={cn(
        'flex w-fit flex-col gap-3 [--cell-radius:var(--radius-md)] [--cell-size:--spacing(7)]',
        className,
      )}
      {...props}
    >
      <div className="relative flex items-center justify-between gap-1">
        <CalendarPrevious />
        <CalendarHeading className="flex-1 text-center" />
        <CalendarNext />
      </div>
      <div className={cn(count > 1 && 'flex items-start gap-4')}>
        {offsets.map((offset) => (
          <CalendarGrid key={offset} offset={offset}>
            <CalendarWeekdays>{(index) => <CalendarWeekday index={index} />}</CalendarWeekdays>
            <CalendarWeeks className="[&_tr]:h-9">
              {(cell) => <CalendarDay value={cell.date} />}
            </CalendarWeeks>
          </CalendarGrid>
        ))}
      </div>
    </div>
  );
}

export {
  CalendarDay,
  CalendarGrid,
  CalendarHeading,
  CalendarMonthSelect,
  CalendarNext,
  CalendarPrevious,
  CalendarWeekday,
  CalendarWeekdays,
  CalendarWeeks,
  CalendarYearSelect,
  createDatePickerController,
  DatePicker,
  DatePickerCalendar,
  DatePickerClear,
  DatePickerContent,
  DatePickerGroup,
  DatePickerHint,
  DatePickerInput,
  DatePickerPreset,
  DatePickerTrigger,
};
