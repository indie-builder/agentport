import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import type * as React from 'react';
import { cn } from '../../lib/cn.js';

/** Collapsible（Base UI）；保留内容时，Motion 负责高度，inert 阻止收起内容获得焦点。 */
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
  keepMounted,
  style,
  render,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Panel>) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      className={cn(className)}
      keepMounted={keepMounted}
      hiddenUntilFound={keepMounted}
      // until-found 避开 Tailwind 的 hidden 规则；Motion 管高度，inert 阻止收起内容交互。
      style={
        keepMounted
          ? (state) => ({
              ...(typeof style === 'function' ? style(state) : style),
              contentVisibility: 'visible',
            })
          : style
      }
      render={render ?? ((panelProps, state) => <div {...panelProps} inert={!state.open} />)}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
