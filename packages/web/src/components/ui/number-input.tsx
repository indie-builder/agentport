import {
  createNumberInputController,
  NumberInputControl as NumberInputControlPrimitive,
  NumberInputDecrement as NumberInputDecrementPrimitive,
  NumberInputGroup as NumberInputGroupPrimitive,
  NumberInputIncrement as NumberInputIncrementPrimitive,
  NumberInput as NumberInputPrimitive,
  NumberInputScrubArea,
  NumberInputScrubAreaCursor,
} from '@ui-sdk/react/number-input';
import { cva, type VariantProps } from 'class-variance-authority';
import { Minus, Plus } from 'lucide-react';
import type { ComponentProps } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';

const defaultNumberFormat: Intl.NumberFormatOptions = {
  useGrouping: false,
  maximumFractionDigits: 12,
};

const numberInputClassName = 'flex w-full min-w-0 flex-col gap-1.5';

const numberInputGroupVariants = cva(
  'group/number-input-group relative flex h-8 w-full min-w-0 items-center gap-1 rounded-item border ps-1 pe-1 transition-colors outline-none has-[>[data-slot=number-input-control]:first-child]:ps-2.5 has-[>[data-slot=number-input-control]:last-child]:pe-2.5 data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:bg-sunken data-disabled:opacity-35 has-[[data-slot=number-input-control]:focus-visible]:border-input-focus has-[[data-slot=number-input-control][aria-invalid=true]]:border-destructive has-[[data-slot=number-input-control][aria-invalid=true]:focus-visible]:border-destructive',
  {
    variants: {
      variant: {
        default: 'border-input bg-transparent',
        bare: 'border-transparent bg-transparent',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

const numberInputControlVariants = cva(
  'h-full w-full min-w-0 flex-1 rounded-item border-0 bg-transparent py-1 text-sm text-fg tabular-nums outline-none not-first:ps-1 not-last:pe-1 placeholder:text-muted-foreground disabled:cursor-not-allowed',
  {
    variants: {
      mono: {
        false: '',
        true: 'font-mono',
      },
    },
    defaultVariants: {
      mono: false,
    },
  },
);

const numberInputStepButtonClassName = buttonVariants({
  variant: 'ghost',
  size: 'icon-xs',
  className:
    "rounded-icon text-muted-foreground hover:text-fg [&_svg:not([class*='size-'])]:size-4",
});

type WithOptionalClassName<T extends { className?: unknown }> = Omit<T, 'className'> & {
  className?: T['className'] | undefined;
};

type NumberInputProps = Omit<
  WithOptionalClassName<ComponentProps<typeof NumberInputPrimitive>>,
  'format' | 'value' | 'defaultValue'
> & {
  format?: ComponentProps<typeof NumberInputPrimitive>['format'] | undefined;
  value?: ComponentProps<typeof NumberInputPrimitive>['value'] | undefined;
  defaultValue?: ComponentProps<typeof NumberInputPrimitive>['defaultValue'] | undefined;
};

type NumberInputGroupProps = WithOptionalClassName<
  ComponentProps<typeof NumberInputGroupPrimitive>
> &
  VariantProps<typeof numberInputGroupVariants>;

type NumberInputControlProps = WithOptionalClassName<
  ComponentProps<typeof NumberInputControlPrimitive>
> &
  VariantProps<typeof numberInputControlVariants>;

type NumberInputDecrementProps = WithOptionalClassName<
  ComponentProps<typeof NumberInputDecrementPrimitive>
>;

type NumberInputIncrementProps = WithOptionalClassName<
  ComponentProps<typeof NumberInputIncrementPrimitive>
>;

function mergeClassName<S>(
  base: string,
  className: string | ((state: S) => string | undefined) | undefined,
) {
  return typeof className === 'function'
    ? (state: S) => cn(base, className(state))
    : cn(base, className);
}

function NumberInput({
  className,
  format = defaultNumberFormat,
  value,
  defaultValue,
  ...props
}: NumberInputProps) {
  return (
    <NumberInputPrimitive
      format={format}
      {...(value === undefined ? {} : { value })}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      className={mergeClassName(numberInputClassName, className)}
      {...props}
    />
  );
}

function NumberInputGroup({ className, variant = 'default', ...props }: NumberInputGroupProps) {
  return (
    <NumberInputGroupPrimitive
      className={mergeClassName(numberInputGroupVariants({ variant }), className)}
      {...props}
    />
  );
}

function NumberInputControl({ className, mono = false, ...props }: NumberInputControlProps) {
  return (
    <NumberInputControlPrimitive
      className={mergeClassName(numberInputControlVariants({ mono }), className)}
      {...props}
    />
  );
}

function NumberInputDecrement({
  className,
  children,
  'aria-label': ariaLabel = '减少',
  ...props
}: NumberInputDecrementProps) {
  return (
    <NumberInputDecrementPrimitive
      aria-label={ariaLabel}
      className={mergeClassName(numberInputStepButtonClassName, className)}
      {...props}
    >
      {children ?? <Minus aria-hidden="true" />}
    </NumberInputDecrementPrimitive>
  );
}

function NumberInputIncrement({
  className,
  children,
  'aria-label': ariaLabel = '增加',
  ...props
}: NumberInputIncrementProps) {
  return (
    <NumberInputIncrementPrimitive
      aria-label={ariaLabel}
      className={mergeClassName(numberInputStepButtonClassName, className)}
      {...props}
    >
      {children ?? <Plus aria-hidden="true" />}
    </NumberInputIncrementPrimitive>
  );
}

export {
  createNumberInputController,
  NumberInput,
  NumberInputControl,
  NumberInputDecrement,
  NumberInputGroup,
  NumberInputIncrement,
  NumberInputScrubArea,
  NumberInputScrubAreaCursor,
};
