import { Input as InputPrimitive } from '@ui-sdk/react/input';
import { cn } from 'cn';
import type * as React from 'react';

type InputProps = React.ComponentProps<'input'> & {
  'data-slot'?: string;
};

function Input({ className, type, 'data-slot': dataSlot, ...props }: InputProps) {
  return (
    <InputPrimitive
      type={type}
      {...(dataSlot === undefined || dataSlot === 'input'
        ? {}
        : { render: <input data-slot={dataSlot} /> })}
      className={cn(
        'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none cds-focus-glow focus-visible:border-[var(--color-subtle)] file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:bg-sunken data-disabled:opacity-[0.35] aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive dark:bg-input/30 dark:data-disabled:bg-input/80 dark:aria-invalid:border-destructive/50',
        className,
      )}
      {...(props as React.ComponentProps<typeof InputPrimitive>)}
    />
  );
}

export { Input };
