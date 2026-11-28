import {
  AvatarFallback as AvatarFallbackPrimitive,
  AvatarImage as AvatarImagePrimitive,
  Avatar as AvatarPrimitive,
} from '@ui-sdk/react/avatar';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const avatarClassName =
  'group/avatar relative inline-flex size-8 shrink-0 items-center justify-center overflow-hidden text-xs font-medium text-muted-foreground select-none';
const avatarImageClassName = 'size-full object-cover';
const avatarFallbackClassName =
  'flex size-full items-center justify-center rounded-[inherit] bg-muted text-muted-foreground group-data-[variant=badge]/avatar:bg-badge-accent-soft';

type AvatarProps = Omit<ComponentProps<typeof AvatarPrimitive>, 'className'> & {
  className?: ComponentProps<typeof AvatarPrimitive>['className'] | undefined;
  variant?: 'default' | 'badge' | undefined;
  bordered?: boolean | undefined;
};

type AvatarImageProps = Omit<ComponentProps<typeof AvatarImagePrimitive>, 'className'> & {
  className?: ComponentProps<typeof AvatarImagePrimitive>['className'] | undefined;
};

type AvatarFallbackProps = Omit<ComponentProps<typeof AvatarFallbackPrimitive>, 'className'> & {
  className?: ComponentProps<typeof AvatarFallbackPrimitive>['className'] | undefined;
};

function Avatar({ className, variant = 'default', bordered = false, ...props }: AvatarProps) {
  const baseClassName = cn(
    avatarClassName,
    variant === 'default' ? 'rounded-full bg-muted' : 'rounded-badge-avatar bg-badge-accent-soft',
    bordered && 'ring-1 ring-line',
  );
  return (
    <AvatarPrimitive
      data-variant={variant}
      className={
        typeof className === 'function'
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      {...props}
    />
  );
}

function AvatarImage({ className, ...props }: AvatarImageProps) {
  return (
    <AvatarImagePrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(avatarImageClassName, className(state))
          : cn(avatarImageClassName, className)
      }
      {...props}
    />
  );
}

function AvatarFallback({ className, ...props }: AvatarFallbackProps) {
  return (
    <AvatarFallbackPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(avatarFallbackClassName, className(state))
          : cn(avatarFallbackClassName, className)
      }
      {...props}
    />
  );
}

export { Avatar, AvatarFallback, AvatarImage };
