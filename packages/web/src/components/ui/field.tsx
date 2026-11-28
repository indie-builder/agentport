import {
  FieldDescription as FieldDescriptionPrimitive,
  type FieldDescriptionState,
  FieldError as FieldErrorPrimitive,
  type FieldErrorState,
  FieldGroup as FieldGroupPrimitive,
  FieldLabel as FieldLabelPrimitive,
  FieldLegend as FieldLegendPrimitive,
  Field as FieldPrimitive,
  FieldSet as FieldSetPrimitive,
  type FieldSetState,
  type FieldState,
} from '@ui-sdk/react/field';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ComponentProps, cloneElement, type ReactElement, useMemo } from 'react';
import { cn } from '@/lib/cn';

type DataFlag = boolean | string | undefined;

type WithOptionalClassName<T extends { className?: unknown }> = Omit<T, 'className'> & {
  className?: T['className'] | undefined;
};

function toFlag(value: DataFlag): true | undefined {
  return value === true || value === '' || value === 'true' ? true : undefined;
}

const fieldSetClassName =
  'flex flex-col gap-4 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3';

function FieldSet({
  className,
  disabled,
  'data-disabled': dataDisabled,
  ...props
}: WithOptionalClassName<ComponentProps<typeof FieldSetPrimitive>> & {
  'data-disabled'?: DataFlag;
}) {
  const resolvedDisabled = disabled ?? toFlag(dataDisabled);
  return (
    <FieldSetPrimitive
      {...(resolvedDisabled === undefined ? {} : { disabled: resolvedDisabled })}
      className={
        typeof className === 'function'
          ? (state: FieldSetState) => cn(fieldSetClassName, className(state))
          : cn(fieldSetClassName, className)
      }
      {...props}
    />
  );
}

const fieldLegendClassName =
  'mb-1.5 font-medium data-[variant=label]:text-sm data-[variant=legend]:text-base';

function FieldLegend({
  className,
  variant = 'legend',
  ...props
}: WithOptionalClassName<ComponentProps<typeof FieldLegendPrimitive>> & {
  variant?: 'legend' | 'label' | undefined;
}) {
  return (
    <FieldLegendPrimitive
      data-variant={variant}
      className={
        typeof className === 'function'
          ? (state: FieldSetState) => cn(fieldLegendClassName, className(state))
          : cn(fieldLegendClassName, className)
      }
      {...props}
    />
  );
}

const fieldGroupClassName =
  'group/field-group @container/field-group flex w-full flex-col gap-5 data-[slot=checkbox-group]:gap-3 *:data-[slot=field-group]:gap-4';

function FieldGroup({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof FieldGroupPrimitive>>) {
  return (
    <FieldGroupPrimitive
      className={
        typeof className === 'function'
          ? (state) => cn(fieldGroupClassName, className(state))
          : cn(fieldGroupClassName, className)
      }
      {...props}
    />
  );
}

const fieldVariants = cva('group/field flex w-full gap-2 data-invalid:text-destructive', {
  variants: {
    orientation: {
      vertical: 'flex-col *:w-full [&>.sr-only]:w-auto',
      horizontal:
        'flex-row items-center has-[>[data-slot=field-content]]:items-start *:data-[slot=field-label]:flex-auto has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
      responsive:
        'flex-col *:w-full @md/field-group:flex-row @md/field-group:items-center @md/field-group:*:w-auto @md/field-group:has-[>[data-slot=field-content]]:items-start @md/field-group:*:data-[slot=field-label]:flex-auto [&>.sr-only]:w-auto @md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
    },
  },
  defaultVariants: {
    orientation: 'vertical',
  },
});

function Field({
  className,
  orientation = 'vertical',
  invalid,
  disabled,
  'data-invalid': dataInvalid,
  'data-disabled': dataDisabled,
  ...props
}: WithOptionalClassName<ComponentProps<typeof FieldPrimitive>> &
  VariantProps<typeof fieldVariants> & {
    'data-invalid'?: DataFlag;
    'data-disabled'?: DataFlag;
  }) {
  const resolvedInvalid = invalid ?? toFlag(dataInvalid);
  const resolvedDisabled = disabled ?? toFlag(dataDisabled);
  return (
    <FieldPrimitive
      data-orientation={orientation}
      {...(resolvedInvalid === undefined ? {} : { invalid: resolvedInvalid })}
      {...(resolvedDisabled === undefined ? {} : { disabled: resolvedDisabled })}
      className={
        typeof className === 'function'
          ? (state: FieldState) => cn(fieldVariants({ orientation }), className(state))
          : cn(fieldVariants({ orientation }), className)
      }
      {...props}
    />
  );
}

function FieldContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-content"
      className={cn('group/field-content flex flex-1 flex-col gap-0.5', className)}
      {...props}
    />
  );
}

const fieldLabelClassName =
  'group/field-label peer/field-label flex w-fit items-center gap-2 text-sm font-medium select-none data-disabled:pointer-events-none data-disabled:opacity-50 group-data-disabled/field:pointer-events-none group-data-disabled/field:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 has-data-checked:border-primary/30 has-data-checked:bg-primary/5 has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col has-[>[data-slot=field]]:rounded-lg has-[>[data-slot=field]]:border has-[>[data-slot=field]]:not-has-[:disabled,[data-disabled]]:hover:bg-muted/50 has-[>[data-slot=field]]:has-[:focus-visible]:ring-2 has-[>[data-slot=field]]:has-[:focus-visible]:ring-ring *:data-[slot=field]:p-2.5 dark:has-data-checked:border-primary/20 dark:has-data-checked:bg-primary/10';

function FieldLabel({
  className,
  htmlFor,
  render,
  ...props
}: WithOptionalClassName<ComponentProps<typeof FieldLabelPrimitive>>) {
  const resolvedRender: ComponentProps<typeof FieldLabelPrimitive>['render'] =
    htmlFor === undefined
      ? render
      : (partProps, state) => {
          if (render === undefined) {
            return (
              <label {...partProps} htmlFor={htmlFor}>
                {partProps.children}
              </label>
            );
          }
          const merged = { ...partProps, htmlFor };
          if (typeof render === 'function') return render(merged, state);
          return cloneElement(render as ReactElement<Record<string, unknown>>, merged);
        };
  return (
    <FieldLabelPrimitive
      {...(resolvedRender === undefined ? {} : { render: resolvedRender })}
      className={
        typeof className === 'function'
          ? (state: FieldState) => cn(fieldLabelClassName, className(state))
          : cn(fieldLabelClassName, className)
      }
      {...props}
    />
  );
}

function FieldTitle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-label"
      className={cn(
        'flex w-fit items-center gap-2 text-sm font-medium group-data-disabled/field:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

const fieldDescriptionClassName =
  'text-start text-sm font-normal text-muted-foreground group-data-[orientation=horizontal]/field:text-balance [[data-variant=legend]+&]:-mt-1.5 last:mt-0 nth-last-2:-mt-1 [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary';

function FieldDescription({
  className,
  ...props
}: WithOptionalClassName<ComponentProps<typeof FieldDescriptionPrimitive>>) {
  return (
    <FieldDescriptionPrimitive
      className={
        typeof className === 'function'
          ? (state: FieldDescriptionState) => cn(fieldDescriptionClassName, className(state))
          : cn(fieldDescriptionClassName, className)
      }
      {...props}
    />
  );
}

const fieldErrorClassName = 'text-sm font-normal text-destructive';

type FieldErrorProps = WithOptionalClassName<ComponentProps<typeof FieldErrorPrimitive>> & {
  errors?: Array<{ message?: string } | undefined> | undefined;
};

function FieldError(rawProps: FieldErrorProps) {
  const hasExplicitContent = 'children' in rawProps || 'errors' in rawProps;
  const { className, children, errors, match, role = 'alert', ...props } = rawProps;
  const resolvedClassName =
    typeof className === 'function'
      ? (state: FieldErrorState) => cn(fieldErrorClassName, className(state))
      : cn(fieldErrorClassName, className);

  const content = useMemo(() => {
    if (typeof children === 'function') {
      return children;
    }
    if (children) {
      return children;
    }
    if (!errors?.length) {
      return null;
    }
    const messages = [
      ...new Set(
        errors
          .map((error) => error?.message)
          .filter((message): message is string => Boolean(message)),
      ),
    ];
    if (messages.length === 0) {
      return null;
    }
    if (messages.length === 1) {
      return messages[0];
    }
    return (
      <ul className="ms-4 flex list-disc flex-col gap-1">
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    );
  }, [children, errors]);

  if (typeof content === 'function') {
    return (
      <FieldErrorPrimitive
        role={role}
        {...(match === undefined ? {} : { match })}
        className={resolvedClassName}
        {...props}
      >
        {content}
      </FieldErrorPrimitive>
    );
  }

  if (hasExplicitContent) {
    if (!content) {
      return null;
    }
    return (
      <FieldErrorPrimitive
        role={role}
        match={match ?? true}
        className={resolvedClassName}
        {...props}
      >
        {content}
      </FieldErrorPrimitive>
    );
  }

  return (
    <FieldErrorPrimitive
      role={role}
      {...(match === undefined ? {} : { match })}
      className={resolvedClassName}
      {...props}
    />
  );
}

export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
};
