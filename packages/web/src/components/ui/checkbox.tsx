import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { cn } from 'cn';
import { CheckIcon } from 'lucide-react';

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-control-boundary transition-colors outline-none group-has-disabled/field:opacity-50 group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:ring-0 group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:focus-visible:outline-none group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:not-aria-invalid:not-data-checked:border-control-boundary after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-checked:focus-visible:ring-0 data-checked:focus-visible:outline-2 data-checked:focus-visible:outline-solid data-checked:outline-ring data-checked:focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:aria-checked:border-destructive dark:bg-input/30 dark:aria-invalid:border-destructive/50 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:not-aria-invalid:data-checked:border-primary dark:data-checked:bg-primary',
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
