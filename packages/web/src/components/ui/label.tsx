import { Label as LabelPrimitive } from '@ui-sdk/react/label';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

const labelClassName =
  'flex items-center gap-2 text-sm font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50';

function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive>) {
  return (
    <LabelPrimitive
      data-slot="label"
      className={
        typeof className === 'function'
          ? (state) => cn(labelClassName, className(state))
          : cn(labelClassName, className)
      }
      {...props}
    />
  );
}

export { Label };
