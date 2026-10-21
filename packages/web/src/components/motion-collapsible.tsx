import type { ComponentProps } from 'react';
import { CollapsibleContent as BaseCollapsibleContent } from './ui/collapsible.js';

/**
 * Registry Collapsible unmounts collapsed content, which cuts the Motion exit animation.
 * keepMounted keeps the panel, inert keeps collapsed content out of the focus order.
 */
function CollapsibleContent({
  keepMounted,
  style,
  render,
  ...props
}: ComponentProps<typeof BaseCollapsibleContent>) {
  return (
    <BaseCollapsibleContent
      data-slot="collapsible-content"
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

export { Collapsible, CollapsibleTrigger } from './ui/collapsible.js';
export { CollapsibleContent };
