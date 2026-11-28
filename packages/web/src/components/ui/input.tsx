import { Input as InputPrimitive } from '@ui-sdk/react/input';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const inputVariants = cva(
  'h-8 w-full min-w-0 py-1 text-sm transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-35',
  {
    variants: {
      variant: {
        default:
          'rounded-lg border border-input bg-transparent px-2.5 cds-focus-glow focus-visible:border-subtle data-disabled:bg-sunken aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive',
        ghost:
          'rounded-lg border border-transparent bg-transparent px-2.5 cds-focus-glow focus-visible:border-subtle data-disabled:bg-sunken aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive',
        bare: 'rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:border-0 data-disabled:bg-transparent aria-invalid:border-transparent',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

type InputProps = Omit<
  ComponentProps<typeof InputPrimitive>,
  'className' | 'value' | 'defaultValue'
> &
  VariantProps<typeof inputVariants> & {
    className?: ComponentProps<typeof InputPrimitive>['className'] | undefined;
    value?: string | number | null | undefined;
    defaultValue?: string | number | null | undefined;
  };

function Input({ className, variant = 'default', value, defaultValue, ...props }: InputProps) {
  return (
    <InputPrimitive
      {...(value === undefined ? {} : { value: value === null ? '' : String(value) })}
      {...(defaultValue === undefined
        ? {}
        : { defaultValue: defaultValue === null ? '' : String(defaultValue) })}
      className={
        typeof className === 'function'
          ? (state) => cn(inputVariants({ variant }), className(state))
          : cn(inputVariants({ variant }), className)
      }
      {...props}
    />
  );
}

export { Input };
