import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { cn } from 'cn';
import { CheckIcon } from 'lucide-react';

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-control-boundary transition-colors outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:not-aria-invalid:border-ring focus-visible:aria-invalid:border-2 group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:focus-visible:border-control-boundary group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:focus-visible:data-checked:border-primary group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:focus-visible:aria-invalid:border group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:focus-visible:aria-invalid:border-destructive group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:focus-visible:data-checked:aria-invalid:border-destructive data-disabled:cursor-not-allowed data-disabled:border-input data-disabled:bg-sunken data-disabled:text-muted-foreground data-disabled:data-checked:border-input data-disabled:data-checked:bg-sunken data-disabled:data-checked:text-muted-foreground aria-invalid:border-destructive aria-invalid:aria-checked:border-destructive dark:bg-input/30 dark:aria-invalid:border-destructive/50 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
      >
        <CheckIcon />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
