'use client';

import {
  CollapsiblePanel,
  type CollapsiblePanelState,
  Collapsible as CollapsiblePrimitive,
  CollapsibleTrigger as CollapsibleTriggerPrimitive,
} from '@ui-sdk/react/collapsible';
import type { RenderProp } from '@ui-sdk/react/primitive';
import { type ComponentProps, cloneElement, type ReactElement, type ReactNode } from 'react';

function Collapsible(props: ComponentProps<typeof CollapsiblePrimitive>) {
  return <CollapsiblePrimitive {...props} />;
}

type CollapsibleTriggerProps = Omit<
  ComponentProps<typeof CollapsibleTriggerPrimitive>,
  'children'
> & {
  children?: ReactNode;
};

function CollapsibleTrigger({ children, ...props }: CollapsibleTriggerProps) {
  return <CollapsibleTriggerPrimitive {...props}>{children}</CollapsibleTriggerPrimitive>;
}

type CollapsibleContentProps = Omit<ComponentProps<typeof CollapsiblePanel>, 'children'> & {
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
    render === undefined ? (
      <div data-slot={slot} />
    ) : typeof render === 'function' ? (
      (partProps, state) => mark(render(partProps, state))
    ) : (
      mark(render)
    );
  return (
    <CollapsiblePanel render={withSlot} {...props}>
      {children}
    </CollapsiblePanel>
  );
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
