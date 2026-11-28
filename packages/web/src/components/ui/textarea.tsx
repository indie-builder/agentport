import { Textarea as TextareaPrimitive } from '@ui-sdk/react/textarea';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const textareaClassName =
  'flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm transition-colors outline-none cds-focus-glow focus-visible:border-subtle placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-sunken disabled:opacity-35 aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive';

function Textarea({ className, ...props }: ComponentProps<typeof TextareaPrimitive>) {
  return (
    <TextareaPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(textareaClassName, className(state))
          : cn(textareaClassName, className)
      }
      {...props}
    />
  );
}

export { Textarea };
