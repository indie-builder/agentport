'use client';

import { Switch as SwitchPrimitive, SwitchThumb } from '@ui-sdk/react/switch';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

type SwitchProps = Omit<ComponentProps<typeof SwitchPrimitive>, 'className'> & {
  size?: 'sm' | 'default';
  className?: ComponentProps<typeof SwitchPrimitive>['className'] | undefined;
};

const switchClassName =
  'peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-colors duration-150 ease-out-soft outline-none group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:not-aria-invalid:not-data-invalid:border-transparent group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:ring-0 group-[:has(>[data-slot=field]):has(:focus-visible)]/field-label:focus-visible:outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-checked:focus-visible:ring-0 data-checked:focus-visible:outline-2 data-checked:focus-visible:outline-solid data-checked:outline-ring data-checked:focus-visible:outline-offset-2 aria-invalid:border-destructive data-invalid:border-destructive data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] dark:data-invalid:border-destructive/50 data-checked:bg-primary data-unchecked:bg-control-boundary dark:data-unchecked:bg-input/80 data-disabled:cursor-not-allowed data-disabled:opacity-[0.35]';

function Switch({ className, size = 'default', ...props }: SwitchProps) {
  return (
    <SwitchPrimitive
      data-size={size}
      className={
        typeof className === 'function'
          ? (state) => cn(switchClassName, className(state))
          : cn(switchClassName, className)
      }
      {...props}
    >
      <SwitchThumb className="pointer-events-none block rounded-full bg-background ring-0 transition-transform duration-150 ease-out-soft group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-checked:translate-x-[calc(100%-2px)] rtl:data-checked:-translate-x-[calc(100%-2px)] dark:data-checked:bg-primary-foreground data-unchecked:translate-x-0 dark:data-unchecked:bg-foreground" />
    </SwitchPrimitive>
  );
}

export { Switch };
