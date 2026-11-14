'use client';

import {
  CalendarDay as CalendarDayPrimitive,
  CalendarGrid,
  CalendarHeading as CalendarHeadingPrimitive,
  CalendarNext as CalendarNextPrimitive,
  CalendarPrevious as CalendarPreviousPrimitive,
  Calendar as CalendarPrimitive,
  CalendarWeekday,
  CalendarWeekdays,
  CalendarWeeks,
} from '@ui-sdk/react/calendar';
import { cn } from 'cn';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { buttonVariants } from '@/components/ui/button';

function CalendarPrevious({
  className,
  children,
  ...props
}: ComponentProps<typeof CalendarPreviousPrimitive>) {
  return (
    <CalendarPreviousPrimitive
      aria-label="上个月"
      className={(state) =>
        cn(
          buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    >
      {children ?? <ChevronLeftIcon aria-hidden="true" />}
    </CalendarPreviousPrimitive>
  );
}

function CalendarNext({
  className,
  children,
  ...props
}: ComponentProps<typeof CalendarNextPrimitive>) {
  return (
    <CalendarNextPrimitive
      aria-label="下个月"
      className={(state) =>
        cn(
          buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    >
      {children ?? <ChevronRightIcon aria-hidden="true" />}
    </CalendarNextPrimitive>
  );
}

function CalendarHeading({ className, ...props }: ComponentProps<typeof CalendarHeadingPrimitive>) {
  return (
    <CalendarHeadingPrimitive
      className={(state) =>
        cn(
          'text-sm font-medium select-none',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function CalendarDay({ className, ...props }: ComponentProps<typeof CalendarDayPrimitive>) {
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
          state.rangeStart && !state.rangeEnd && 'rounded-l-(--cell-radius) rounded-r-none',
          state.rangeEnd && !state.rangeStart && 'rounded-r-(--cell-radius) rounded-l-none',
          state.inRange && !state.rangeStart && !state.rangeEnd && 'rounded-none',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    >
      {(state) => Number(state.date.slice(8, 10))}
    </CalendarDayPrimitive>
  );
}

function Calendar({ className, children, ...props }: ComponentProps<typeof CalendarPrimitive>) {
  return (
    <CalendarPrimitive
      className={(state) =>
        cn(
          'flex w-fit flex-col gap-4 bg-background p-2 [--cell-radius:var(--radius-md)] [--cell-size:--spacing(7)] in-data-[slot=card-content]:bg-transparent in-data-[slot=popover-content]:bg-transparent',
          typeof className === 'function' ? className(state) : className,
        )
      }
      {...props}
    >
      {children ?? (
        <>
          <div className="relative flex items-center justify-between gap-1">
            <CalendarPrevious />
            <CalendarHeading className="flex-1 text-center" />
            <CalendarNext />
          </div>
          <CalendarGrid className="w-full border-collapse">
            <CalendarWeekdays>
              {(index) => (
                <CalendarWeekday
                  index={index}
                  className="h-7 p-0 text-xs font-normal text-muted-foreground select-none"
                />
              )}
            </CalendarWeekdays>
            <CalendarWeeks className="[&_tr]:h-9">
              {(cell) => <CalendarDay value={cell.date} />}
            </CalendarWeeks>
          </CalendarGrid>
        </>
      )}
    </CalendarPrimitive>
  );
}

export { Calendar };
