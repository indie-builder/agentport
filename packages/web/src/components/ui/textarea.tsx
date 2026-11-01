import { cn } from 'cn';
import type * as React from 'react';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm transition-colors outline-none cds-focus-glow focus-visible:border-[var(--color-button-primary)] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-control-boundary/50 disabled:opacity-[0.35] aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:focus-visible:outline-2 aria-invalid:focus-visible:outline-solid aria-invalid:focus-visible:outline-ring aria-invalid:focus-visible:outline-offset-2 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
