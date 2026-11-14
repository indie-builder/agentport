import {
  RadioGroup as RadioGroupPrimitive,
  RadioIndicator,
  Radio as RadioPrimitive,
} from '@ui-sdk/react/radio';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

type Loose<T> = { [K in keyof T]: T[K] | undefined };

type RadioGroupProps = Loose<Omit<ComponentProps<typeof RadioGroupPrimitive>, 'onValueChange'>> & {
  onValueChange?: ((value: string) => void) | undefined;
};

function RadioGroup({ className, onValueChange, ...props }: RadioGroupProps) {
  return (
    <RadioGroupPrimitive
      {...(onValueChange === undefined
        ? {}
        : {
            onValueChange: (next: string | null) => {
              if (next !== null) onValueChange(next);
            },
          })}
      className={cn('grid w-full gap-2', className)}
      {...(props as ComponentProps<typeof RadioGroupPrimitive>)}
    />
  );
}

function RadioGroupItem({ className, ...props }: Loose<ComponentProps<typeof RadioPrimitive>>) {
  return (
    <RadioPrimitive
      className={cn(
        'group/radio-group-item peer relative flex aspect-square size-4 shrink-0 rounded-full border border-control-boundary outline-none group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:ring-0 group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:focus-visible:outline-none group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:not-aria-invalid:not-data-invalid:not-data-checked:border-control-boundary after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring data-checked:focus-visible:outline-2 data-checked:focus-visible:outline-solid data-checked:focus-visible:outline-ring data-checked:focus-visible:outline-offset-2 aria-invalid:focus-visible:outline-2 aria-invalid:focus-visible:outline-solid aria-invalid:focus-visible:outline-ring aria-invalid:focus-visible:outline-offset-2 data-invalid:focus-visible:outline-2 data-invalid:focus-visible:outline-solid data-invalid:focus-visible:outline-ring data-invalid:focus-visible:outline-offset-2 data-disabled:cursor-not-allowed data-disabled:opacity-[0.35] aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:data-checked:border-destructive aria-invalid:data-checked:focus-visible:border-destructive data-invalid:border-destructive data-invalid:focus-visible:border-destructive data-invalid:data-checked:border-destructive data-invalid:data-checked:focus-visible:border-destructive dark:bg-input/30 dark:data-invalid:border-destructive/50 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:not-aria-invalid:not-data-invalid:data-checked:border-primary dark:data-checked:bg-primary',
        className,
      )}
      {...(props as ComponentProps<typeof RadioPrimitive>)}
    >
      <RadioIndicator className="flex size-4 items-center justify-center">
        <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-foreground" />
      </RadioIndicator>
    </RadioPrimitive>
  );
}

export { RadioGroup, RadioGroupItem };
