import type { CollapsiblePanelState } from '@base-ui/react/collapsible';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { CollapsibleContent as BaseCollapsibleContent } from './ui/collapsible.js';

type CollapsibleContentProps = ComponentProps<typeof BaseCollapsibleContent> & {
  /** Base UI 的 height 变量做开合过渡；已有 Motion 管高度的调用方保持默认 false。 */
  animated?: boolean;
};

// Base UI 在开合阶段提供测量后的 --collapsible-panel-height，静止展开时变量回到 auto。
// 官方推荐常驻 overflow-hidden：height 过渡期间必须裁掉尚未展开的内容。
const ANIMATED_PANEL =
  'h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-150 ease-out-soft data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0';

/**
 * Registry Collapsible unmounts collapsed content, which cuts the Motion exit animation.
 * keepMounted keeps the panel, inert keeps collapsed content out of the focus order.
 * animated uses Base UI's own height variable instead of Motion.
 */
function CollapsibleContent({
  keepMounted,
  animated = false,
  className,
  style,
  render,
  ...props
}: CollapsibleContentProps) {
  return (
    <BaseCollapsibleContent
      data-slot="collapsible-content"
      keepMounted={keepMounted}
      hiddenUntilFound={keepMounted}
      className={
        animated
          ? (state: CollapsiblePanelState) =>
              cn(ANIMATED_PANEL, typeof className === 'function' ? className(state) : className)
          : className
      }
      // until-found 避开 Tailwind 的 hidden 规则；Motion 管高度，inert 阻止收起内容交互。
      style={
        keepMounted
          ? (state) => ({
              ...(typeof style === 'function' ? style(state) : style),
              contentVisibility: 'visible',
            })
          : style
      }
      render={
        render ??
        (keepMounted || animated
          ? (panelProps, state) => <div {...panelProps} inert={!state.open} />
          : undefined)
      }
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger } from './ui/collapsible.js';
export { CollapsibleContent };
