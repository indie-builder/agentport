import { cn } from 'cn';
import type * as React from 'react';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm transition-colors outline-none hover:not-focus:border-control-boundary focus:not-aria-invalid:border-ring focus:ring-0 focus:shadow-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-sunken disabled:text-muted-foreground disabled:hover:border-input aria-invalid:border-destructive aria-invalid:hover:border-destructive dark:aria-invalid:border-destructive/50',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
