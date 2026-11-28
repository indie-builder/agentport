import {
  CheckboxGroup as CheckboxGroupPrimitive,
  CheckboxIndicator,
  Checkbox as CheckboxPrimitive,
} from '@ui-sdk/react/checkbox';
import { CheckIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const checkboxGroupClassName = 'flex flex-col gap-2';

type CheckboxGroupProps<T extends string = string> = Omit<
  ComponentProps<typeof CheckboxGroupPrimitive<T>>,
  'className'
> & {
  className?: ComponentProps<typeof CheckboxGroupPrimitive<T>>['className'] | undefined;
};

function CheckboxGroup<T extends string = string>({ className, ...props }: CheckboxGroupProps<T>) {
  return (
    <CheckboxGroupPrimitive<T>
      className={
        typeof className === 'function'
          ? (state) => cn(checkboxGroupClassName, className(state))
          : cn(checkboxGroupClassName, className)
      }
      {...props}
    />
  );
}

const checkboxClassName =
  'peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-control-boundary transition-colors outline-none group-has-disabled/field:opacity-35 group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:ring-0 group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:focus-visible:outline-none group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:not-aria-invalid:not-data-invalid:not-data-checked:border-control-boundary after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-checked:focus-visible:ring-0 data-checked:focus-visible:outline-2 data-checked:focus-visible:outline-solid data-checked:outline-ring data-checked:focus-visible:outline-offset-2 data-disabled:cursor-not-allowed data-disabled:opacity-35 aria-invalid:border-destructive aria-invalid:data-checked:border-destructive data-invalid:border-destructive data-invalid:data-checked:border-destructive data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:not-aria-invalid:not-data-invalid:data-checked:border-primary';

type CheckboxProps = Omit<
  ComponentProps<typeof CheckboxPrimitive>,
  'checked' | 'defaultChecked' | 'onCheckedChange' | 'className'
> & {
  checked?: ComponentProps<typeof CheckboxPrimitive>['checked'] | undefined;
  defaultChecked?: ComponentProps<typeof CheckboxPrimitive>['defaultChecked'] | undefined;
  indeterminate?: boolean | undefined;
  className?: ComponentProps<typeof CheckboxPrimitive>['className'] | undefined;
  onCheckedChange?:
    | ((
        checked: boolean,
        details: Parameters<
          NonNullable<ComponentProps<typeof CheckboxPrimitive>['onCheckedChange']>
        >[1],
      ) => void)
    | undefined;
};

function Checkbox({
  className,
  checked,
  defaultChecked,
  indeterminate,
  onCheckedChange,
  ...props
}: CheckboxProps) {
  return (
    <CheckboxPrimitive
      {...(indeterminate
        ? { checked: 'indeterminate' as const }
        : checked === undefined
          ? {}
          : { checked })}
      {...(defaultChecked === undefined ? {} : { defaultChecked })}
      {...(onCheckedChange === undefined
        ? {}
        : {
            onCheckedChange: (next, details) => onCheckedChange(next === true, details),
          })}
      className={
        typeof className === 'function'
          ? (state) => cn(checkboxClassName, className(state))
          : cn(checkboxClassName, className)
      }
      {...props}
    >
      <CheckboxIndicator className="grid place-content-center text-current transition-none [&>svg]:size-3.5">
        <CheckIcon />
      </CheckboxIndicator>
    </CheckboxPrimitive>
  );
}

export { Checkbox, CheckboxGroup };
