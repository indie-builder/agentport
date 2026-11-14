'use client';

import {
  Collapsible as CollapsiblePrimitive,
  CollapsiblePanel,
  type CollapsiblePanelState,
  CollapsibleTrigger as CollapsibleTriggerPrimitive,
} from '@ui-sdk/react/collapsible';
import type { RenderProp } from '@ui-sdk/react/primitive';
import {
  cloneElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';

type Loose<T> = { [K in keyof T]: T[K] | undefined };

function Collapsible(props: Loose<ComponentProps<typeof CollapsiblePrimitive>>) {
  return (
    <CollapsiblePrimitive
      {...(props as ComponentProps<typeof CollapsiblePrimitive>)}
    />
  );
}

type CollapsibleTriggerProps = Loose<
  Omit<ComponentProps<typeof CollapsibleTriggerPrimitive>, 'children'>
> & {
  children?: ReactNode;
};

function CollapsibleTrigger({ children, ...props }: CollapsibleTriggerProps) {
  return (
    <CollapsibleTriggerPrimitive
      {...(props as ComponentProps<typeof CollapsibleTriggerPrimitive>)}
    >
      {children}
    </CollapsibleTriggerPrimitive>
  );
}

type CollapsibleContentProps = Loose<
  Omit<ComponentProps<typeof CollapsiblePanel>, 'children'>
> & {
  children?: ReactNode;
  'data-slot'?: string | undefined;
};

function CollapsibleContent({
  'data-slot': dataSlot,
  children,
  render,
  ...props
}: CollapsibleContentProps) {
  const slot = dataSlot ?? 'collapsible-content';
  const mark = (element: ReactElement) =>
    cloneElement(element as ReactElement<Record<string, unknown>>, {
      'data-slot': slot,
    }) as ReactElement<Record<string, unknown>>;
  const withSlot: RenderProp<CollapsiblePanelState> =
    render === undefined
      ? <div data-slot={slot} />
      : typeof render === 'function'
        ? (partProps, state) => mark(render(partProps, state))
        : mark(render);
  return (
    <CollapsiblePanel
      render={withSlot}
      {...(props as ComponentProps<typeof CollapsiblePanel>)}
    >
      {children}
    </CollapsiblePanel>
  );
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
