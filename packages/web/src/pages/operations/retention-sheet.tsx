import { type RetentionSettings, retentionUpdateSchema } from '@agentport/shared';
import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { DraftGuardDialogs, useDraftGuard } from '../../components/draft-guard.js';
import { InspectorSheet } from '../../components/inspector-sheet.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { Button } from '../../components/ui/button.js';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../../components/ui/field.js';
import {
  NumberInput,
  NumberInputControl,
  NumberInputGroup,
} from '../../components/ui/number-input.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { formatDateTime } from '../../lib/format.js';
import { useRetention, useUpdateRetention } from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';

const retentionFormSchema = retentionUpdateSchema.required();

type RetentionFormValues = Pick<RetentionSettings, 'runDays' | 'messageDays' | 'agentVersions'>;

const RETENTION_FIELDS = [
  {
    name: 'runDays',
    id: 'retention-run-days',
    label: '运行记录保留天数',
    hint: '超过该天数的运行记录及其消息会被清理。',
  },
  {
    name: 'messageDays',
    id: 'retention-message-days',
    label: '消息保留天数',
    hint: '无运行归属的会话消息与频道消息超过该天数后清理（随运行的对话消息按运行记录保留天数清理）。',
  },
  {
    name: 'agentVersions',
    id: 'retention-agent-versions',
    label: '版本保留个数',
    hint: '每个专家保留最近的历史版本数量。',
  },
] as const satisfies ReadonlyArray<{
  name: keyof RetentionFormValues;
  id: string;
  label: string;
  hint: string;
}>;

const RETENTION_FORM_ID = 'operations-retention-form';

export interface RetentionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canManage: boolean;
  finalFocus?: ComponentProps<typeof InspectorSheet>['finalFocus'];
}

export function RetentionSheet({ open, onOpenChange, canManage, finalFocus }: RetentionSheetProps) {
  if (!open) return null;
  return (
    <RetentionSheetInner
      canManage={canManage}
      onClosed={() => onOpenChange(false)}
      {...(finalFocus === undefined ? {} : { finalFocus })}
    />
  );
}

function RetentionSheetInner({
  canManage,
  onClosed,
  finalFocus,
}: {
  canManage: boolean;
  onClosed: () => void;
  finalFocus?: ComponentProps<typeof InspectorSheet>['finalFocus'];
}) {
  const dialog = useDialogClose(onClosed);
  const retention = useRetention();
  const settings = retention.data;
  const save = useUpdateRetention();
  const { control, handleSubmit, reset, formState } = useZodForm(retentionFormSchema, {
    defaultValues: {
      runDays: settings?.runDays ?? 30,
      messageDays: settings?.messageDays ?? 30,
      agentVersions: settings?.agentVersions ?? 10,
    },
  });
  const { errors, isDirty } = formState;
  const [saved, setSaved] = useState(false);
  const pending = save.isPending && !saved;
  const dirty = !saved && Boolean(settings) && isDirty;
  const disabled = pending || !canManage;
  const guard = useDraftGuard(dirty, pending, dialog.close);

  const settingsRef = useRef(settings);
  useEffect(() => {
    if (!settings || settingsRef.current === settings) return;
    settingsRef.current = settings;
    if (!isDirty) {
      reset({
        runDays: settings.runDays,
        messageDays: settings.messageDays,
        agentVersions: settings.agentVersions,
      });
    }
  }, [settings, isDirty, reset]);

  const submit = handleSubmit(async (values) => {
    if (disabled) return;
    try {
      const updated = await save.mutateAsync(values);
      reset({
        runDays: updated.runDays,
        messageDays: updated.messageDays,
        agentVersions: updated.agentVersions,
      });
      toastSuccess('数据保留策略已保存');
      setSaved(true);
      guard.finish();
    } catch (cause) {
      toastError(cause);
    }
  });

  const footer =
    canManage && settings ? (
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
          取消
        </Button>
        <Button
          type="submit"
          form={RETENTION_FORM_ID}
          disabled={disabled || !dirty}
          aria-busy={pending}
        >
          {pending ? '保存中…' : '保存'}
        </Button>
      </div>
    ) : undefined;

  return (
    <>
      <InspectorSheet
        size="sm"
        open={dialog.open}
        onOpenChange={(next) => {
          if (!next) guard.close();
        }}
        onOpenChangeComplete={dialog.onOpenChangeComplete}
        title="数据保留"
        description="每日维护任务据此清理；修改后下次维护生效。"
        closeDisabled={pending}
        {...(finalFocus === undefined ? {} : { finalFocus })}
        {...(footer === undefined ? {} : { footer })}
      >
        {retention.isPending ? (
          <LoadingState rows={3} />
        ) : settings ? (
          <form
            id={RETENTION_FORM_ID}
            className="flex flex-col gap-5"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <FieldGroup className="gap-4">
              {RETENTION_FIELDS.map((field) => {
                const error = errors[field.name]?.message;
                return (
                  <Field
                    key={field.name}
                    orientation="horizontal"
                    className="items-start gap-3"
                    data-disabled={disabled}
                    data-invalid={Boolean(error)}
                  >
                    <FieldContent>
                      <FieldLabel htmlFor={field.id}>{field.label}</FieldLabel>
                      <FieldDescription id={`${field.id}-hint`}>{field.hint}</FieldDescription>
                      <FieldError id={`${field.id}-error`}>{error}</FieldError>
                    </FieldContent>
                    <Controller
                      control={control}
                      name={field.name}
                      render={({ field: controllerField }) => (
                        <NumberInput
                          name={controllerField.name}
                          value={
                            Number.isFinite(controllerField.value) ? controllerField.value : null
                          }
                          onValueChange={(next, details) => {
                            if (details?.reason === 'input-commit') {
                              details.cancel();
                              return;
                            }
                            controllerField.onChange(next ?? Number.NaN);
                          }}
                          step={1}
                          disabled={disabled}
                          className="w-24"
                        >
                          <NumberInputGroup>
                            <NumberInputControl
                              ref={controllerField.ref}
                              id={field.id}
                              inputMode="numeric"
                              onBlur={controllerField.onBlur}
                              aria-invalid={Boolean(error)}
                            />
                          </NumberInputGroup>
                        </NumberInput>
                      )}
                    />
                  </Field>
                );
              })}
            </FieldGroup>
            {settings.updatedAt && settings.updatedBy ? (
              <p className="text-xs text-muted-foreground">
                上次修改：{formatDateTime(settings.updatedAt)} · {settings.updatedBy}
              </p>
            ) : null}
          </form>
        ) : (
          <ErrorState error={retention.error} onRetry={() => void retention.refetch()} />
        )}
      </InspectorSheet>
      <DraftGuardDialogs guard={guard} draft="未保存的数据保留策略会丢失。" pending={pending} />
    </>
  );
}
