import { InputClear, InputGroup as InputGroupPrimitive } from '@ui-sdk/react/input';
import { Textarea as TextareaPrimitive } from '@ui-sdk/react/textarea';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';

const inputGroupVariants = cva(
  'group/input-group relative flex w-full min-w-0 items-center border border-input transition-colors outline-none has-[:is([data-slot=input],[data-slot=textarea]):disabled]:bg-sunken has-[[data-slot][aria-invalid=true]]:border-destructive has-[[data-slot][aria-invalid=true]]:has-[:is([data-slot=input],[data-slot=textarea]):focus-visible]:border-destructive has-[[data-slot][aria-invalid=true]]:has-[:is([data-slot=input],[data-slot=textarea]):focus-visible]:outline-2 has-[[data-slot][aria-invalid=true]]:has-[:is([data-slot=input],[data-slot=textarea]):focus-visible]:outline-solid has-[[data-slot][aria-invalid=true]]:has-[:is([data-slot=input],[data-slot=textarea]):focus-visible]:outline-ring has-[[data-slot][aria-invalid=true]]:has-[:is([data-slot=input],[data-slot=textarea]):focus-visible]:outline-offset-2 has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>textarea]:h-auto has-[>[data-align=block-end]]:[&>input]:pt-3 has-[>[data-align=block-start]]:[&>input]:pb-3 has-[>[data-align=inline-end]]:[&>input]:pe-1.5 has-[>[data-align=inline-start]]:[&>input]:ps-1.5',
  {
    variants: {
      variant: {
        default:
          'h-8 rounded-lg has-[:is([data-slot=input],[data-slot=textarea]):focus-visible]:border-subtle',
        composer:
          'h-auto rounded-composer bg-surface shadow-composer hover:shadow-composer-hover has-[:is([data-slot=input],[data-slot=textarea]):focus-visible]:border-input has-[:is([data-slot=input],[data-slot=textarea]):focus-visible]:shadow-composer-focus',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

type InputGroupProps = Omit<ComponentProps<typeof InputGroupPrimitive>, 'className'> &
  VariantProps<typeof inputGroupVariants> & {
    className?: ComponentProps<typeof InputGroupPrimitive>['className'] | undefined;
  };

function InputGroup({ className, variant = 'default', ...props }: InputGroupProps) {
  return (
    <InputGroupPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(inputGroupVariants({ variant }), className(state))
          : cn(inputGroupVariants({ variant }), className)
      }
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text items-center justify-center gap-2 py-1.5 text-sm font-medium text-muted-foreground select-none group-data-disabled/input-group:opacity-50 [&>kbd]:rounded-tag [&>svg:not([class*='size-'])]:size-4",
  {
    variants: {
      align: {
        'inline-start': 'order-first ps-2 has-[>button]:ms-[-0.3rem] has-[>kbd]:ms-[-0.15rem]',
        'inline-end': 'order-last pe-2 has-[>button]:me-[-0.3rem] has-[>kbd]:me-[-0.15rem]',
        'block-start':
          'order-first w-full justify-start px-2.5 pt-2 group-has-[>input]/input-group:pt-2 [.border-b]:pb-2',
        'block-end':
          'order-last w-full justify-start px-2.5 pb-2 group-has-[>input]/input-group:pb-2 [.border-t]:pt-2',
      },
      variant: {
        default: '',
        composer: 'justify-between gap-3 px-4 pt-0 pb-3',
      },
    },
    defaultVariants: {
      align: 'inline-start',
      variant: 'default',
    },
  },
);

function InputGroupAddon({
  className,
  align = 'inline-start',
  variant = 'default',
  ...props
}: ComponentProps<'div'> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align, variant }), className)}
      {...props}
    />
  );
}

const inputGroupButtonVariants = cva('flex items-center gap-2 text-sm shadow-none', {
  variants: {
    size: {
      xs: "h-6 gap-1 rounded-lg px-1.5 [&>svg:not([class*='size-'])]:size-3.5",
      sm: '',
      'icon-xs': "size-6 rounded-lg p-0 has-[>svg]:p-0 [&_svg:not([class*='size-'])]:size-3",
      'icon-sm': 'size-8 p-0 has-[>svg]:p-0',
    },
  },
  defaultVariants: {
    size: 'xs',
  },
});

function InputGroupButton({
  className,
  type = 'button',
  variant = 'ghost',
  size = 'xs',
  ...props
}: Omit<ComponentProps<typeof Button>, 'size' | 'type'> &
  VariantProps<typeof inputGroupButtonVariants> & {
    type?: 'button' | 'submit' | 'reset';
  }) {
  return (
    <Button
      type={type}
      data-size={size}
      variant={variant}
      className={cn(inputGroupButtonVariants({ size }), className)}
      {...props}
    />
  );
}

const inputGroupInputVariants = cva(
  'flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 disabled:bg-transparent aria-invalid:ring-0 aria-invalid:focus-visible:outline-0',
  {
    variants: {
      variant: {
        default: '',
        flush: 'px-0',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function InputGroupInput({
  className,
  variant = 'default',
  ...props
}: Omit<ComponentProps<typeof Input>, 'variant'> & VariantProps<typeof inputGroupInputVariants>) {
  return (
    <Input
      className={
        typeof className === 'function'
          ? (state) => cn(inputGroupInputVariants({ variant }), className(state))
          : cn(inputGroupInputVariants({ variant }), className)
      }
      {...props}
    />
  );
}

const inputGroupTextareaVariants = cva(
  'flex flex-1 field-sizing-content min-h-16 w-full resize-none rounded-none border-0 bg-transparent shadow-none transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-transparent disabled:cursor-not-allowed disabled:bg-transparent disabled:opacity-35 aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:focus-visible:outline-0',
  {
    variants: {
      variant: {
        default: 'px-2.5 py-2 text-sm',
        composer: 'max-h-40 min-w-0 px-4 pt-4 pb-2 text-base md:text-base',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function InputGroupTextarea({
  className,
  variant = 'default',
  ...props
}: ComponentProps<typeof TextareaPrimitive> & VariantProps<typeof inputGroupTextareaVariants>) {
  return (
    <TextareaPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(inputGroupTextareaVariants({ variant }), className(state))
          : cn(inputGroupTextareaVariants({ variant }), className)
      }
      {...props}
    />
  );
}

export {
  InputClear,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupTextarea,
};
