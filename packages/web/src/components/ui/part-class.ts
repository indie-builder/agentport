import type { PartProps } from '@ui-sdk/react/primitive';
import type * as React from 'react';
import { cn } from '@/lib/cn';

type PartClassName<State> = string | ((state: State) => string | undefined) | undefined;

type ElementPartProps<Tag extends keyof React.JSX.IntrinsicElements, State> = Omit<
  PartProps<Tag, State>,
  'className' | 'style' | 'render' | 'children'
> & {
  className?: PartProps<Tag, State>['className'] | undefined;
  style?: PartProps<Tag, State>['style'] | undefined;
  render?: PartProps<Tag, State>['render'] | undefined;
  children?: PartProps<Tag, State>['children'] | undefined;
};

function mergeClassName<State>(base: string, className: PartClassName<State>) {
  return typeof className === 'function'
    ? (state: State) => cn(base, className(state))
    : cn(base, className);
}

export { type ElementPartProps, mergeClassName };
