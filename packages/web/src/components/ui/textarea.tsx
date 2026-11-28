import { Textarea as TextareaPrimitive } from '@ui-sdk/react/textarea';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const textareaVariants = cva(
  'field-sizing-content min-h-16 w-full px-2.5 py-2 text-sm transition-colors outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        default:
          'flex rounded-lg border border-input bg-transparent cds-focus-glow focus-visible:border-subtle disabled:bg-sunken disabled:opacity-35 aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive',
        ghost:
          'flex rounded-lg border border-transparent bg-transparent cds-focus-glow focus-visible:border-subtle disabled:bg-sunken disabled:opacity-35 aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive',
        sunken:
          'flex rounded-lg border border-input bg-sunken text-muted-foreground cds-focus-glow focus-visible:border-subtle disabled:bg-sunken disabled:opacity-35 aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive',
        bare: 'block resize-none rounded-none border-0 bg-transparent text-inherit focus-visible:border-transparent disabled:bg-transparent disabled:opacity-100 aria-invalid:border-transparent',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Textarea({
  className,
  variant = 'default',
  ...props
}: ComponentProps<typeof TextareaPrimitive> & VariantProps<typeof textareaVariants>) {
  return (
    <TextareaPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(textareaVariants({ variant }), className(state))
          : cn(textareaVariants({ variant }), className)
      }
      {...props}
    />
  );
}

export { Textarea };
