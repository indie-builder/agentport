'use client';

import { Separator as SeparatorPrimitive } from '@ui-sdk/react/separator';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

type Loose<T> = { [K in keyof T]: T[K] | undefined };

function Separator({
  className,
  orientation = 'horizontal',
  ...props
}: Loose<ComponentProps<typeof SeparatorPrimitive>>) {
  return (
    <SeparatorPrimitive
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch',
        className,
      )}
      {...(props as ComponentProps<typeof SeparatorPrimitive>)}
    />
  );
}

export { Separator };
