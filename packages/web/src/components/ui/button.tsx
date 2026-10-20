import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:bg-sunken disabled:text-subtle [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-ink text-white hover:bg-ink-hover active:bg-ink-hover',
        secondary: 'border border-line bg-surface text-fg hover:bg-sunken',
        outline: 'border border-line-strong bg-surface text-fg hover:bg-sunken',
        ghost: 'text-muted hover:bg-sunken hover:text-fg',
        destructive: 'bg-danger text-white hover:bg-danger/90 active:bg-danger',
      },
      size: {
        default: 'h-8 px-3 text-sm',
        sm: 'h-7 px-2.5 text-xs',
        xs: 'h-6 px-2 text-2xs',
        icon: 'size-8',
        'icon-sm': 'size-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}

export { buttonVariants };
