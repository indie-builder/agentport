import { Input as InputPrimitive } from '@ui-sdk/react/input';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const inputClassName =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none cds-focus-glow focus-visible:border-[var(--color-subtle)] file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:bg-sunken data-disabled:opacity-[0.35] aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive dark:bg-input/30 dark:data-disabled:bg-input/80 dark:aria-invalid:border-destructive/50';

type InputProps = Omit<
  ComponentProps<typeof InputPrimitive>,
  'className' | 'value' | 'defaultValue'
> & {
  className?: ComponentProps<typeof InputPrimitive>['className'] | undefined;
  value?: string | number | undefined;
  defaultValue?: string | number | undefined;
};

function Input({ className, value, defaultValue, ...props }: InputProps) {
  return (
    <InputPrimitive
      {...(value === undefined ? {} : { value: String(value) })}
      {...(defaultValue === undefined ? {} : { defaultValue: String(defaultValue) })}
      className={
        typeof className === 'function'
          ? (state) => cn(inputClassName, className(state))
          : cn(inputClassName, className)
      }
      {...props}
    />
  );
}

export { Input };
