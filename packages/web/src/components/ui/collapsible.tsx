'use client';

import {
  CollapsiblePanel,
  Collapsible as CollapsiblePrimitive,
  CollapsibleTrigger as CollapsibleTriggerPrimitive,
} from '@ui-sdk/react/collapsible';
import type { ComponentProps } from 'react';

function Collapsible({
  className,
  ...props
}: Omit<ComponentProps<typeof CollapsiblePrimitive>, 'className'> & {
  className?: ComponentProps<typeof CollapsiblePrimitive>['className'] | undefined;
}) {
  return <CollapsiblePrimitive {...(className === undefined ? {} : { className })} {...props} />;
}

function CollapsibleTrigger({
  className,
  ...props
}: Omit<ComponentProps<typeof CollapsibleTriggerPrimitive>, 'className'> & {
  className?: ComponentProps<typeof CollapsibleTriggerPrimitive>['className'] | undefined;
}) {
  return (
    <CollapsibleTriggerPrimitive {...(className === undefined ? {} : { className })} {...props} />
  );
}

function CollapsibleContent({
  className,
  ...props
}: Omit<ComponentProps<typeof CollapsiblePanel>, 'className'> & {
  className?: ComponentProps<typeof CollapsiblePanel>['className'] | undefined;
}) {
  return <CollapsiblePanel {...(className === undefined ? {} : { className })} {...props} />;
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
