import type { CollapsiblePanelState } from '@ui-sdk/react/collapsible';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { CollapsibleContent as BaseCollapsibleContent } from './ui/collapsible.js';

type CollapsibleContentProps = ComponentProps<typeof BaseCollapsibleContent> & {
  animated?: boolean;
};

// ui-sdk 在开合阶段提供测量后的 --collapsible-panel-height，静止展开时变量回到 auto。
// 官方推荐常驻 overflow-hidden：height 过渡期间必须裁掉尚未展开的内容。
const ANIMATED_PANEL =
  'h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-150 ease-out-soft data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0';

function CollapsibleContent({
  keepMounted,
  animated = false,
  className,
  render,
  ...props
}: CollapsibleContentProps) {
  return (
    <BaseCollapsibleContent
      data-slot="collapsible-content"
      {...(keepMounted === undefined ? {} : { keepMounted, hiddenUntilFound: keepMounted })}
      {...(animated
        ? {
            className: (state: CollapsiblePanelState) =>
              cn(ANIMATED_PANEL, typeof className === 'function' ? className(state) : className),
          }
        : className === undefined
          ? {}
          : { className })}
      {...(render === undefined && !keepMounted && !animated
        ? {}
        : {
            render: render ?? ((panelProps) => <div {...panelProps} />),
          })}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger } from './ui/collapsible.js';
export { CollapsibleContent };
