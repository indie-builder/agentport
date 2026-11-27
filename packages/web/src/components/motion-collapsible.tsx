import type { CollapsiblePanelState } from '@ui-sdk/react/collapsible';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { CollapsibleContent as BaseCollapsibleContent } from './ui/collapsible.js';

type CollapsibleContentProps = ComponentProps<typeof BaseCollapsibleContent> & {
  animated?: boolean;
};

const ANIMATED_PANEL =
  'h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-150 ease-out-soft data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0';

function CollapsibleContent({
  keepMounted,
  animated = false,
  className,
  ...props
}: CollapsibleContentProps) {
  return (
    <BaseCollapsibleContent
      {...(keepMounted === undefined ? {} : { keepMounted, hiddenUntilFound: keepMounted })}
      {...(animated
        ? {
            className: (state: CollapsiblePanelState) =>
              cn(ANIMATED_PANEL, typeof className === 'function' ? className(state) : className),
          }
        : className === undefined
          ? {}
          : { className })}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger } from './ui/collapsible.js';
export { CollapsibleContent };
