import {
  PasswordInputControl as PasswordInputControlPrimitive,
  PasswordInput as PasswordInputPrimitive,
  type PasswordInputState,
  PasswordInputToggle as PasswordInputTogglePrimitive,
} from '@ui-sdk/react/password-input';
import { Eye, EyeOff } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const passwordInputClassName =
  'group/password-input relative flex h-8 w-full min-w-0 items-center gap-1 rounded-[var(--radius-item)] border border-input bg-transparent pr-1.5 transition-colors outline-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:bg-sunken data-disabled:opacity-[0.35] has-[[data-slot=password-input-control]:focus-visible]:border-input-focus has-[[data-slot=password-input-control][aria-invalid=true]]:border-destructive has-[[data-slot=password-input-control][aria-invalid=true]:focus-visible]:border-destructive dark:bg-input/30 dark:data-disabled:bg-input/80 dark:has-[[data-slot=password-input-control][aria-invalid=true]]:border-destructive/50';

const passwordInputControlClassName =
  'h-full w-full min-w-0 flex-1 rounded-[var(--radius-item)] border-0 bg-transparent px-2.5 py-1 text-sm text-fg outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed';

const passwordInputToggleClassName =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-icon)] text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-disabled:opacity-[0.35] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

type PasswordInputProps = Omit<ComponentProps<typeof PasswordInputPrimitive>, 'className'> & {
  className?: ComponentProps<typeof PasswordInputPrimitive>['className'] | undefined;
};

type PasswordInputControlProps = Omit<
  ComponentProps<typeof PasswordInputControlPrimitive>,
  'className'
> & {
  className?: ComponentProps<typeof PasswordInputControlPrimitive>['className'] | undefined;
};

type PasswordInputToggleProps = Omit<
  ComponentProps<typeof PasswordInputTogglePrimitive>,
  'className'
> & {
  className?: ComponentProps<typeof PasswordInputTogglePrimitive>['className'] | undefined;
};

function PasswordInput({ className, ...props }: PasswordInputProps) {
  return (
    <PasswordInputPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(passwordInputClassName, className(state))
          : cn(passwordInputClassName, className)
      }
      {...props}
    />
  );
}

function PasswordInputControl({ className, ...props }: PasswordInputControlProps) {
  return (
    <PasswordInputControlPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(passwordInputControlClassName, className(state))
          : cn(passwordInputControlClassName, className)
      }
      {...props}
    />
  );
}

function PasswordInputToggle({
  className,
  children,
  'aria-label': ariaLabel = '显示密码',
  ...props
}: PasswordInputToggleProps) {
  return (
    <PasswordInputTogglePrimitive
      aria-label={ariaLabel}
      className={
        typeof className === 'function'
          ? (state) => cn(passwordInputToggleClassName, className(state))
          : cn(passwordInputToggleClassName, className)
      }
      {...props}
    >
      {children ??
        ((state: PasswordInputState) =>
          state.visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />)}
    </PasswordInputTogglePrimitive>
  );
}

export { PasswordInput, PasswordInputControl, PasswordInputToggle };
