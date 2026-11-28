import {
  RadioGroup as RadioGroupPrimitive,
  RadioIndicator,
  Radio as RadioPrimitive,
} from '@ui-sdk/react/radio';
import type { ComponentProps, ReactElement } from 'react';
import { cn } from '@/lib/cn';

const radioGroupClassName = 'grid w-full';

const radioGroupItemClassName =
  'group/radio-group-item peer relative flex aspect-square size-4 shrink-0 rounded-full border border-control-boundary outline-none group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:ring-0 group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:focus-visible:outline-none group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:not-aria-invalid:not-data-invalid:not-data-checked:border-control-boundary after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring data-checked:focus-visible:outline-2 data-checked:focus-visible:outline-solid data-checked:focus-visible:outline-ring data-checked:focus-visible:outline-offset-2 aria-invalid:focus-visible:outline-2 aria-invalid:focus-visible:outline-solid aria-invalid:focus-visible:outline-ring aria-invalid:focus-visible:outline-offset-2 data-invalid:focus-visible:outline-2 data-invalid:focus-visible:outline-solid data-invalid:focus-visible:outline-ring data-invalid:focus-visible:outline-offset-2 data-disabled:cursor-not-allowed data-disabled:opacity-35 aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:data-checked:border-destructive aria-invalid:data-checked:focus-visible:border-destructive data-invalid:border-destructive data-invalid:focus-visible:border-destructive data-invalid:data-checked:border-destructive data-invalid:data-checked:focus-visible:border-destructive data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:not-aria-invalid:not-data-invalid:data-checked:border-primary';

type RadioGroupDetails<T extends string> = Parameters<
  NonNullable<ComponentProps<typeof RadioGroupPrimitive<T>>['onValueChange']>
>[1];

type RadioGroupBaseProps<T extends string = string> = Omit<
  ComponentProps<typeof RadioGroupPrimitive<T>>,
  'className' | 'onValueChange'
> & {
  className?: ComponentProps<typeof RadioGroupPrimitive<T>>['className'] | undefined;
  gap?: 'default' | 'none' | undefined;
};

type RadioGroupNullableProps<T extends string = string> = RadioGroupBaseProps<T> & {
  allowNull: true;
  onValueChange?: ((value: T | null, details: RadioGroupDetails<T>) => void) | undefined;
};

type RadioGroupNonNullProps<T extends string = string> = RadioGroupBaseProps<T> & {
  allowNull?: false | undefined;
  onValueChange?: ((value: T, details: RadioGroupDetails<T>) => void) | undefined;
};

function RadioGroup<T extends string = string>(props: RadioGroupNullableProps<T>): ReactElement;
function RadioGroup<T extends string = string>(props: RadioGroupNonNullProps<T>): ReactElement;
function RadioGroup<T extends string = string>({
  className,
  allowNull,
  gap = 'default',
  onValueChange,
  ...props
}: RadioGroupNullableProps<T> | RadioGroupNonNullProps<T>) {
  const baseClassName = cn(radioGroupClassName, gap === 'default' ? 'gap-2' : 'gap-0');
  return (
    <RadioGroupPrimitive<T>
      {...(onValueChange === undefined
        ? {}
        : {
            onValueChange: (next, details) => {
              if (allowNull) {
                (onValueChange as (value: T | null, details: RadioGroupDetails<T>) => void)(
                  next,
                  details,
                );
              } else if (next !== null) {
                (onValueChange as (value: T, details: RadioGroupDetails<T>) => void)(next, details);
              }
            },
          })}
      className={
        typeof className === 'function'
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

type RadioGroupItemProps = Omit<ComponentProps<typeof RadioPrimitive>, 'className'> & {
  className?: ComponentProps<typeof RadioPrimitive>['className'] | undefined;
};

function RadioGroupItem({ className, ...props }: RadioGroupItemProps) {
  return (
    <RadioPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(radioGroupItemClassName, className(state))
          : cn(radioGroupItemClassName, className)
      }
      {...props}
    >
      <RadioIndicator className="flex size-4 items-center justify-center">
        <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-foreground" />
      </RadioIndicator>
    </RadioPrimitive>
  );
}

export { RadioGroup, RadioGroupItem };
