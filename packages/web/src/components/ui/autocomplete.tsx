'use client';

import {
  Autocomplete,
  AutocompleteArrow,
  AutocompleteClear as AutocompleteClearPrimitive,
  AutocompleteContent as AutocompleteContentPrimitive,
  AutocompleteEmpty as AutocompleteEmptyPrimitive,
  AutocompleteGroupLabel as AutocompleteGroupLabelPrimitive,
  AutocompleteGroup as AutocompleteGroupPrimitive,
  AutocompleteInput as AutocompleteInputPrimitive,
  AutocompleteItemIcon as AutocompleteItemIconPrimitive,
  AutocompleteItem as AutocompleteItemPrimitive,
  AutocompleteItems,
  AutocompleteItemText as AutocompleteItemTextPrimitive,
  AutocompleteLabel as AutocompleteLabelPrimitive,
  AutocompleteList as AutocompleteListPrimitive,
  AutocompleteSeparator as AutocompleteSeparatorPrimitive,
  AutocompleteStatus as AutocompleteStatusPrimitive,
  AutocompleteTrigger as AutocompleteTriggerPrimitive,
  createAutocompleteController,
} from '@ui-sdk/react/autocomplete';
import { ChevronDownIcon, XIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';

type WithOptionalClassName<T extends { className?: unknown }> = Omit<T, 'className'> & {
  className?: T['className'] | undefined;
};

function mergeClassName<S>(
  base: string,
  className: string | ((state: S) => string | undefined) | undefined,
) {
  return typeof className === 'function'
    ? (state: S) => cn(base, className(state))
    : cn(base, className);
}

const autocompleteLabelClassName =
  'block text-sm font-medium select-none data-disabled:pointer-events-none data-disabled:opacity-50';

const autocompleteInputClassName =
  'h-8 w-full min-w-0 rounded-[var(--radius-item)] border border-input bg-transparent px-2.5 py-1 text-sm text-fg transition-colors outline-none cds-focus-glow focus-visible:border-[var(--color-subtle)] placeholder:text-muted-foreground data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:bg-sunken data-disabled:opacity-[0.35] aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive data-invalid:border-destructive data-invalid:focus-visible:border-destructive dark:bg-input/30 dark:data-disabled:bg-input/80 dark:aria-invalid:border-destructive/50';

const autocompleteContentClassName =
  'z-50 max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) min-w-(--anchor-width) overflow-hidden rounded-[var(--radius-popover)] bg-popover text-popover-foreground shadow-md ring-1 ring-line outline-hidden cds-overlay-enter [--autocomplete-list-height:var(--available-height)]';

const autocompleteListClassName =
  'scrollbar-none max-h-[min(calc(var(--spacing)*72-var(--spacing)*9),calc(var(--autocomplete-list-height)-var(--spacing)*9))] scroll-py-1 overflow-y-auto overscroll-contain p-1';

const autocompleteItemClassName =
  "relative flex w-full cursor-default items-center gap-2 rounded-md py-1 ps-2 pe-2 text-start text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-highlighted:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

const autocompleteItemTextClassName =
  'min-w-0 [&_mark]:bg-transparent [&_mark]:font-medium [&_mark]:text-current';

const autocompleteItemIconClassName =
  'inline-flex shrink-0 items-center justify-center text-muted-foreground data-mirror:rtl:-scale-x-100';

const autocompleteGroupClassName = 'scroll-my-1';

const autocompleteGroupLabelClassName =
  'px-2 py-1 text-start text-xs font-medium text-muted-foreground';

const autocompleteSeparatorClassName = '-mx-1 my-1 h-px bg-border';

const autocompleteEmptyClassName =
  'hidden w-full justify-center px-2 py-2 text-center text-sm text-muted-foreground data-empty:flex';

const autocompleteStatusClassName = 'px-2 py-1 text-start text-xs text-muted-foreground';

function AutocompleteLabel({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof AutocompleteLabelPrimitive>>) {
  return (
    <AutocompleteLabelPrimitive
      className={mergeClassName(autocompleteLabelClassName, className)}
      {...props}
    />
  );
}

function AutocompleteInput({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof AutocompleteInputPrimitive>>) {
  return (
    <AutocompleteInputPrimitive
      className={mergeClassName(autocompleteInputClassName, className)}
      {...props}
    />
  );
}

function AutocompleteTrigger({
  className,
  children,
  'aria-label': ariaLabel,
  ...props
}: WithOptionalClassName<ComponentProps<typeof AutocompleteTriggerPrimitive>>) {
  const resolvedAriaLabel = ariaLabel ?? (children === undefined ? '展开建议' : undefined);
  return (
    <AutocompleteTriggerPrimitive
      {...(resolvedAriaLabel === undefined ? {} : { 'aria-label': resolvedAriaLabel })}
      className={(state) =>
        buttonVariants({
          variant: 'ghost',
          size: 'icon-xs',
          className: cn(
            'text-muted-foreground hover:text-fg',
            typeof className === 'function' ? className(state) : className,
          ),
        })
      }
      {...props}
    >
      {children ?? <ChevronDownIcon aria-hidden="true" />}
    </AutocompleteTriggerPrimitive>
  );
}

function AutocompleteClear({
  className,
  children,
  'aria-label': ariaLabel,
  ...props
}: WithOptionalClassName<ComponentProps<typeof AutocompleteClearPrimitive>>) {
  const resolvedAriaLabel = ariaLabel ?? (children === undefined ? '清除' : undefined);
  return (
    <AutocompleteClearPrimitive
      {...(resolvedAriaLabel === undefined ? {} : { 'aria-label': resolvedAriaLabel })}
      className={(state) =>
        buttonVariants({
          variant: 'ghost',
          size: 'icon-xs',
          className: cn(
            'text-muted-foreground hover:text-fg',
            typeof className === 'function' ? className(state) : className,
          ),
        })
      }
      {...props}
    >
      {children ?? <XIcon aria-hidden="true" />}
    </AutocompleteClearPrimitive>
  );
}

function AutocompleteContent({
  className,
  side = 'bottom',
  sideOffset = 6,
  align = 'start',
  alignOffset = 0,
  ...props
}: WithOptionalClassName<ComponentProps<typeof AutocompleteContentPrimitive>>) {
  return (
    <AutocompleteContentPrimitive
      side={side}
      sideOffset={sideOffset}
      align={align}
      alignOffset={alignOffset}
      className={mergeClassName(autocompleteContentClassName, className)}
      {...props}
    />
  );
}

function AutocompleteList({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof AutocompleteListPrimitive>>) {
  return (
    <AutocompleteListPrimitive
      className={mergeClassName(autocompleteListClassName, className)}
      {...props}
    />
  );
}

function AutocompleteItem({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof AutocompleteItemPrimitive>>) {
  return (
    <AutocompleteItemPrimitive
      className={mergeClassName(autocompleteItemClassName, className)}
      {...props}
    />
  );
}

function AutocompleteItemText({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof AutocompleteItemTextPrimitive>>) {
  return (
    <AutocompleteItemTextPrimitive
      className={mergeClassName(autocompleteItemTextClassName, className)}
      {...props}
    />
  );
}

function AutocompleteItemIcon({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof AutocompleteItemIconPrimitive>>) {
  return (
    <AutocompleteItemIconPrimitive
      className={mergeClassName(autocompleteItemIconClassName, className)}
      {...props}
    />
  );
}

function AutocompleteGroup({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof AutocompleteGroupPrimitive>>) {
  return (
    <AutocompleteGroupPrimitive
      className={mergeClassName(autocompleteGroupClassName, className)}
      {...props}
    />
  );
}

function AutocompleteGroupLabel({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof AutocompleteGroupLabelPrimitive>>) {
  return (
    <AutocompleteGroupLabelPrimitive
      className={mergeClassName(autocompleteGroupLabelClassName, className)}
      {...props}
    />
  );
}

function AutocompleteSeparator({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof AutocompleteSeparatorPrimitive>>) {
  return (
    <AutocompleteSeparatorPrimitive
      className={mergeClassName(autocompleteSeparatorClassName, className)}
      {...props}
    />
  );
}

function AutocompleteEmpty({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof AutocompleteEmptyPrimitive>>) {
  return (
    <AutocompleteEmptyPrimitive
      className={mergeClassName(autocompleteEmptyClassName, className)}
      {...props}
    />
  );
}

function AutocompleteStatus({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof AutocompleteStatusPrimitive>>) {
  return (
    <AutocompleteStatusPrimitive
      className={mergeClassName(autocompleteStatusClassName, className)}
      {...props}
    />
  );
}

export {
  Autocomplete,
  AutocompleteArrow,
  AutocompleteClear,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteItemIcon,
  AutocompleteItems,
  AutocompleteItemText,
  AutocompleteLabel,
  AutocompleteList,
  AutocompleteSeparator,
  AutocompleteStatus,
  AutocompleteTrigger,
  createAutocompleteController,
};
