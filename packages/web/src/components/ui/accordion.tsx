import {
  AccordionHeader,
  AccordionItem as AccordionItemPrimitive,
  AccordionPanel,
  Accordion as AccordionPrimitive,
  AccordionTrigger as AccordionTriggerPrimitive,
} from '@ui-sdk/react/accordion';
import { cn } from 'cn';
import { ChevronDownIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

function Accordion({ className, ...props }: ComponentProps<typeof AccordionPrimitive>) {
  return <AccordionPrimitive className={cn('flex w-full flex-col', className)} {...props} />;
}

function AccordionItem({ className, ...props }: ComponentProps<typeof AccordionItemPrimitive>) {
  return <AccordionItemPrimitive className={cn('not-last:border-b', className)} {...props} />;
}

function AccordionTrigger({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof AccordionTriggerPrimitive>, 'children'> & { children?: ReactNode }) {
  return (
    <AccordionHeader className="flex">
      <AccordionTriggerPrimitive
        className={cn(
          'group/accordion-trigger relative flex flex-1 items-start justify-between rounded-lg border border-transparent py-2.5 text-left text-sm font-medium transition-colors duration-150 ease-out-soft outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-disabled:opacity-50 **:data-[slot=accordion-trigger-icon]:ml-auto **:data-[slot=accordion-trigger-icon]:size-4 **:data-[slot=accordion-trigger-icon]:text-muted-foreground',
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon
          data-slot="accordion-trigger-icon"
          className="pointer-events-none shrink-0 transition-transform duration-150 ease-out-soft group-data-open/accordion-trigger:rotate-180"
        />
      </AccordionTriggerPrimitive>
    </AccordionHeader>
  );
}

function AccordionContent({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof AccordionPanel>, 'children'> & { children?: ReactNode }) {
  return (
    <AccordionPanel
      className="h-(--accordion-panel-height) overflow-hidden text-sm transition-[height] duration-150 ease-out-soft data-starting-style:h-0 data-ending-style:h-0"
      {...props}
    >
      <div
        className={cn(
          'pt-0 pb-2.5 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4',
          className,
        )}
      >
        {children}
      </div>
    </AccordionPanel>
  );
}

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger };
