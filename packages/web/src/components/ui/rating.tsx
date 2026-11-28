import {
  RatingItem as RatingItemPrimitive,
  type RatingItemState,
  Rating as RatingPrimitive,
} from '@ui-sdk/react/rating';
import { Star } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const ratingClassName =
  'inline-flex items-center gap-1 data-disabled:pointer-events-none data-disabled:opacity-35';

const ratingItemClassName =
  "relative inline-flex size-7 shrink-0 items-center justify-center rounded-icon text-subtle transition-colors not-data-readonly:not-data-disabled:hover:bg-hover data-filled:text-fg data-highlighted:text-fg [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_[data-slot=rating-radio]]:absolute [&_[data-slot=rating-radio]]:inset-0 [&_[data-slot=rating-radio]]:cursor-pointer [&_[data-slot=rating-radio]]:rounded-icon [&_[data-slot=rating-radio]]:outline-none [&_[data-slot=rating-radio]]:focus-visible:ring-2 [&_[data-slot=rating-radio]]:focus-visible:ring-ring [&_[data-slot=rating-radio]]:in-data-disabled:cursor-default [&_[data-slot=rating-radio]]:in-data-readonly:cursor-default";

type RatingProps = Omit<ComponentProps<typeof RatingPrimitive>, 'className' | 'value'> & {
  className?: ComponentProps<typeof RatingPrimitive>['className'] | undefined;
  value?: number | null | undefined;
};

type RatingItemProps = Omit<ComponentProps<typeof RatingItemPrimitive>, 'className'> & {
  className?: ComponentProps<typeof RatingItemPrimitive>['className'] | undefined;
};

function Rating({ className, value, children, ...props }: RatingProps) {
  return (
    <RatingPrimitive
      {...(value === undefined ? {} : { value })}
      className={
        typeof className === 'function'
          ? (state) => cn(ratingClassName, className(state))
          : cn(ratingClassName, className)
      }
      {...props}
    >
      {children ?? <RatingItem />}
    </RatingPrimitive>
  );
}

function RatingItem({ className, children, ...props }: RatingItemProps) {
  return (
    <RatingItemPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(ratingItemClassName, className(state))
          : cn(ratingItemClassName, className)
      }
      {...props}
    >
      {children ??
        ((state: RatingItemState) => (
          <Star
            aria-hidden="true"
            className={cn(state.fill >= 1 ? 'fill-current text-fg' : 'text-subtle')}
          />
        ))}
    </RatingItemPrimitive>
  );
}

export { Rating, RatingItem };
