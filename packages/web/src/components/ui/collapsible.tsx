import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import type * as React from 'react';
import { cn } from '../../lib/cn.js';

/**
 * Collapsible（Base UI）。
 * 原 radix 的 `Content` 在 Base UI 里叫 `Panel`；`keepMounted` 语义一致。
 */
function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Trigger>) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(className)}
      {...props}
    />
  );
}

function CollapsibleContent({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Panel>) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      className={cn(className)}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
