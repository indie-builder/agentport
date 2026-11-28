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

const fieldSetVariants = cva(
  'flex flex-col gap-4 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3',
  {
    variants: {
      variant: {
        default: '',
        aside: '@min-[800px]:border-l @min-[800px]:border-line @min-[800px]:pl-6',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function FieldSet({
  className,
  variant = 'default',
  disabled,
  'data-disabled': dataDisabled,
  ...props
}: WithOptionalClassName<ComponentProps<typeof FieldSetPrimitive>> &
  VariantProps<typeof fieldSetVariants> & {
    'data-disabled'?: DataFlag;
  }) {
  const resolvedDisabled = disabled ?? toFlag(dataDisabled);
  return (
    <FieldSetPrimitive
      {...(resolvedDisabled === undefined ? {} : { disabled: resolvedDisabled })}
      className={
        typeof className === 'function'
          ? (state: FieldSetState) => cn(fieldSetVariants({ variant }), className(state))
          : cn(fieldSetVariants({ variant }), className)
      }
      {...props}
    />
  );
}

const fieldLegendVariants = cva(
  'mb-1.5 font-medium data-[variant=label]:text-sm data-[variant=legend]:text-base data-disabled:opacity-50',
  {
    variants: {
      tone: {
        default: '',
        danger: 'text-destructive',
        muted: 'text-muted-foreground',
      },
      inline: {
        false: '',
        true: 'flex items-center gap-2 select-none',
      },
    },
    defaultVariants: {
      tone: 'default',
      inline: false,
    },
  },
);

function FieldLegend({
  className,
  variant = 'legend',
  tone = 'default',
  inline = false,
  ...props
}: WithOptionalClassName<ComponentProps<typeof FieldLegendPrimitive>> &
  VariantProps<typeof fieldLegendVariants> & {
    variant?: 'legend' | 'label' | undefined;
  }) {
  return (
    <FieldLegendPrimitive
      data-variant={variant}
      className={
        typeof className === 'function'
          ? (state: FieldSetState) => cn(fieldLegendVariants({ tone, inline }), className(state))
          : cn(fieldLegendVariants({ tone, inline }), className)
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

const fieldLabelVariants = cva(
  'group/field-label peer/field-label flex text-sm select-none data-disabled:pointer-events-none data-disabled:opacity-50 group-data-disabled/field:pointer-events-none group-data-disabled/field:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 has-data-checked:border-primary/30 has-data-checked:bg-primary/5 has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col has-[>[data-slot=field]]:rounded-lg has-[>[data-slot=field]]:border has-[>[data-slot=field]]:not-has-[:disabled,[data-disabled]]:hover:bg-muted/50 has-[>[data-slot=field]]:has-[:focus-visible]:ring-2 has-[>[data-slot=field]]:has-[:focus-visible]:ring-ring *:data-[slot=field]:p-2.5',
  {
    variants: {
      variant: {
        default: 'w-fit items-center gap-2 font-medium',
        plain: 'w-fit items-center gap-2 font-normal',
        option:
          'w-full cursor-pointer items-start gap-2 rounded-item border border-line px-3 py-2.5 font-normal',
      },
      tone: {
        default: '',
        fg: 'text-fg',
        muted: 'text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
      tone: 'default',
    },
  },
);

function FieldLabel({
  className,
  variant = 'default',
  tone = 'default',
  htmlFor,
  render,
  ...props
}: WithOptionalClassName<ComponentProps<typeof FieldLabelPrimitive>> &
  VariantProps<typeof fieldLabelVariants>) {
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
          ? (state: FieldState) => cn(fieldLabelVariants({ variant, tone }), className(state))
          : cn(fieldLabelVariants({ variant, tone }), className)
      }
      {...props}
    />
  );
}

const fieldTitleVariants = cva(
  'flex w-fit items-center gap-2 text-sm font-medium group-data-disabled/field:opacity-50',
  {
    variants: {
      tone: {
        default: '',
        fg: 'text-fg',
        muted: 'text-muted-foreground',
      },
    },
    defaultVariants: {
      tone: 'default',
    },
  },
);

function FieldTitle({
  className,
  tone = 'default',
  ...props
}: ComponentProps<'div'> & VariantProps<typeof fieldTitleVariants>) {
  return (
    <div
      data-slot="field-label"
      className={cn(fieldTitleVariants({ tone }), className)}
      {...props}
    />
  );
}

const fieldDescriptionVariants = cva(
  'text-start font-normal text-muted-foreground group-data-[orientation=horizontal]/field:text-balance [[data-variant=legend]+&]:-mt-1.5 last:mt-0 nth-last-2:-mt-1 [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary',
  {
    variants: {
      size: {
        default: 'text-sm',
        xs: 'text-xs',
      },
      numeric: {
        false: '',
        true: 'tabular-nums',
      },
    },
    defaultVariants: {
      size: 'default',
      numeric: false,
    },
  },
);

function FieldDescription({
  className,
  size = 'default',
  numeric = false,
  ...props
}: WithOptionalClassName<ComponentProps<typeof FieldDescriptionPrimitive>> &
  VariantProps<typeof fieldDescriptionVariants>) {
  return (
    <FieldDescriptionPrimitive
      className={
        typeof className === 'function'
          ? (state: FieldDescriptionState) =>
              cn(fieldDescriptionVariants({ size, numeric }), className(state))
          : cn(fieldDescriptionVariants({ size, numeric }), className)
      }
      {...props}
    />
  );
}

const fieldErrorVariants = cva('text-sm font-normal text-destructive', {
  variants: {
    inline: {
      false: '',
      true: 'flex items-center gap-1',
    },
  },
  defaultVariants: {
    inline: false,
  },
});

type FieldErrorProps = WithOptionalClassName<ComponentProps<typeof FieldErrorPrimitive>> &
  VariantProps<typeof fieldErrorVariants> & {
    errors?: Array<{ message?: string } | undefined> | undefined;
  };

function FieldError(rawProps: FieldErrorProps) {
  const hasExplicitContent = 'children' in rawProps || 'errors' in rawProps;
  const { className, inline = false, children, errors, match, role = 'alert', ...props } = rawProps;
  const resolvedClassName =
    typeof className === 'function'
      ? (state: FieldErrorState) => cn(fieldErrorVariants({ inline }), className(state))
      : cn(fieldErrorVariants({ inline }), className);

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
