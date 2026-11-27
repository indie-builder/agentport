import {
  AvatarFallback as AvatarFallbackPrimitive,
  AvatarImage as AvatarImagePrimitive,
  Avatar as AvatarPrimitive,
} from '@ui-sdk/react/avatar';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const avatarClassName =
  'relative inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium text-muted-foreground select-none';
const avatarImageClassName = 'size-full object-cover';
const avatarFallbackClassName =
  'flex size-full items-center justify-center rounded-full bg-muted text-muted-foreground';

type AvatarProps = Omit<ComponentProps<typeof AvatarPrimitive>, 'className'> & {
  className?: ComponentProps<typeof AvatarPrimitive>['className'] | undefined;
};

type AvatarImageProps = Omit<ComponentProps<typeof AvatarImagePrimitive>, 'className'> & {
  className?: ComponentProps<typeof AvatarImagePrimitive>['className'] | undefined;
};

type AvatarFallbackProps = Omit<ComponentProps<typeof AvatarFallbackPrimitive>, 'className'> & {
  className?: ComponentProps<typeof AvatarFallbackPrimitive>['className'] | undefined;
};

function Avatar({ className, ...props }: AvatarProps) {
  return (
    <AvatarPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(avatarClassName, className(state))
          : cn(avatarClassName, className)
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
