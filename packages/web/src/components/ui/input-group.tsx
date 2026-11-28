import { InputClear, InputGroup as InputGroupPrimitive } from '@ui-sdk/react/input';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/cn';

const inputGroupClassName =
  'group/input-group relative flex h-8 w-full min-w-0 items-center rounded-lg border border-input transition-colors outline-none has-[:is([data-slot=input],[data-slot=textarea]):disabled]:bg-sunken has-[:is([data-slot=input],[data-slot=textarea]):focus-visible]:border-subtle has-[[data-slot][aria-invalid=true]]:border-destructive has-[[data-slot][aria-invalid=true]]:has-[:is([data-slot=input],[data-slot=textarea]):focus-visible]:border-destructive has-[[data-slot][aria-invalid=true]]:has-[:is([data-slot=input],[data-slot=textarea]):focus-visible]:outline-2 has-[[data-slot][aria-invalid=true]]:has-[:is([data-slot=input],[data-slot=textarea]):focus-visible]:outline-solid has-[[data-slot][aria-invalid=true]]:has-[:is([data-slot=input],[data-slot=textarea]):focus-visible]:outline-ring has-[[data-slot][aria-invalid=true]]:has-[:is([data-slot=input],[data-slot=textarea]):focus-visible]:outline-offset-2 has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>textarea]:h-auto has-[>[data-align=block-end]]:[&>input]:pt-3 has-[>[data-align=block-start]]:[&>input]:pb-3 has-[>[data-align=inline-end]]:[&>input]:pe-1.5 has-[>[data-align=inline-start]]:[&>input]:ps-1.5';

type InputGroupProps = Omit<ComponentProps<typeof InputGroupPrimitive>, 'className'> & {
  className?: ComponentProps<typeof InputGroupPrimitive>['className'] | undefined;
};

function InputGroup({ className, ...props }: InputGroupProps) {
  return (
    <InputGroupPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(inputGroupClassName, className(state))
          : cn(inputGroupClassName, className)
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
    },
    defaultVariants: {
      align: 'inline-start',
    },
  },
);

function InputGroupAddon({
  className,
  align = 'inline-start',
  ...props
}: ComponentProps<'div'> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
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

const inputGroupInputClassName =
  'flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 disabled:bg-transparent aria-invalid:ring-0 aria-invalid:focus-visible:outline-0';

function InputGroupInput({ className, ...props }: ComponentProps<typeof Input>) {
  return (
    <Input
      className={
        typeof className === 'function'
          ? (state) => cn(inputGroupInputClassName, className(state))
          : cn(inputGroupInputClassName, className)
      }
      {...props}
    />
  );
}

const inputGroupTextareaClassName =
  'flex-1 resize-none rounded-none border-0 bg-transparent shadow-none focus-visible:border-transparent disabled:bg-transparent aria-invalid:focus-visible:outline-0';

function InputGroupTextarea({ className, ...props }: ComponentProps<typeof Textarea>) {
  return (
    <Textarea
      className={
        typeof className === 'function'
          ? (state) => cn(inputGroupTextareaClassName, className(state))
          : cn(inputGroupTextareaClassName, className)
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
