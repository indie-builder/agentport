import {
  AccordionHeader,
  AccordionItem as AccordionItemPrimitive,
  AccordionPanel,
  Accordion as AccordionPrimitive,
  AccordionTrigger as AccordionTriggerPrimitive,
} from '@ui-sdk/react/accordion';
import { ChevronDownIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const accordionTriggerClassName =
  'group/accordion-trigger relative flex flex-1 items-start justify-between rounded-lg border border-transparent text-start text-sm font-medium transition-colors duration-150 ease-out-soft outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-disabled:opacity-50 **:data-[slot=accordion-trigger-icon]:ms-auto **:data-[slot=accordion-trigger-icon]:size-4 **:data-[slot=accordion-trigger-icon]:text-muted-foreground';

const accordionContentInnerClassName =
  'pt-0 pb-2.5 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4';

function Accordion<T extends string = string>({
  className,
  ...props
}: Omit<ComponentProps<typeof AccordionPrimitive<T>>, 'className'> & {
  className?: ComponentProps<typeof AccordionPrimitive<T>>['className'] | undefined;
}) {
  return (
    <AccordionPrimitive<T>
      className={
        typeof className === 'function'
          ? (state) => cn('flex w-full flex-col', className(state))
          : cn('flex w-full flex-col', className)
      }
      {...props}
    />
  );
}

function AccordionItem({
  className,
  ...props
}: Omit<ComponentProps<typeof AccordionItemPrimitive>, 'className'> & {
  className?: ComponentProps<typeof AccordionItemPrimitive>['className'] | undefined;
}) {
  return (
    <AccordionItemPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn('not-last:border-b', className(state))
          : cn('not-last:border-b', className)
      }
      {...props}
    />
  );
}

function AccordionTrigger({
  className,
  children,
  gap = 'default',
  padding = 'default',
  underline = true,
  ...props
}: Omit<ComponentProps<typeof AccordionTriggerPrimitive>, 'className'> & {
  className?: ComponentProps<typeof AccordionTriggerPrimitive>['className'] | undefined;
  gap?: 'default' | 'sm' | undefined;
  padding?: 'default' | 'md' | undefined;
  underline?: boolean | undefined;
}) {
  const baseClassName = cn(
    accordionTriggerClassName,
    gap === 'sm' && 'gap-2',
    padding === 'default' ? 'py-2.5' : 'py-3',
    underline ? 'hover:underline' : 'hover:no-underline',
  );
  const icon = (
    <ChevronDownIcon
      data-slot="accordion-trigger-icon"
      className="pointer-events-none shrink-0 transition-transform duration-150 ease-out-soft group-data-open/accordion-trigger:rotate-180"
    />
  );
  return (
    <AccordionHeader className="flex">
      <AccordionTriggerPrimitive
        className={
          typeof className === 'function'
            ? (state) => cn(baseClassName, className(state))
            : cn(baseClassName, className)
        }
        {...props}
      >
        {typeof children === 'function' ? (
          (state) => (
            <>
              {children(state)}
              {icon}
            </>
          )
        ) : (
          <>
            {children}
            {icon}
          </>
        )}
      </AccordionTriggerPrimitive>
    </AccordionHeader>
  );
}

function AccordionContent({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof AccordionPanel>, 'className'> & {
  className?: ComponentProps<typeof AccordionPanel>['className'] | undefined;
}) {
  return (
    <AccordionPanel
      className="h-(--accordion-panel-height) overflow-hidden text-sm transition-[height] duration-150 ease-out-soft data-starting-style:h-0 data-ending-style:h-0"
      {...props}
    >
      {(state) => (
        <div
          className={cn(
            accordionContentInnerClassName,
            typeof className === 'function' ? className(state) : className,
          )}
        >
          {typeof children === 'function' ? children(state) : children}
        </div>
      )}
    </AccordionPanel>
  );
}

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger };
