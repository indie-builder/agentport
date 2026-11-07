import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { cn } from 'cn';

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn('grid w-full gap-2', className)}
      {...props}
    />
  );
}

function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        'group/radio-group-item peer relative flex aspect-square size-4 shrink-0 rounded-full border border-control-boundary outline-none group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:ring-0 group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:focus-visible:outline-none group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:not-aria-invalid:not-data-checked:border-control-boundary after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring data-checked:focus-visible:outline-2 data-checked:focus-visible:outline-solid data-checked:focus-visible:outline-ring data-checked:focus-visible:outline-offset-2 aria-invalid:focus-visible:outline-2 aria-invalid:focus-visible:outline-solid aria-invalid:focus-visible:outline-ring aria-invalid:focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-[0.35] aria-invalid:border-destructive aria-invalid:aria-checked:border-destructive aria-invalid:aria-checked:focus-visible:border-destructive dark:bg-input/30 dark:aria-invalid:border-destructive/50 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:not-aria-invalid:data-checked:border-primary dark:data-checked:bg-primary',
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="flex size-4 items-center justify-center"
      >
        <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-foreground" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
