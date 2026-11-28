import { type AlertSettings, alertSettingsSchema } from '@agentport/shared';
import { useState } from 'react';
import { type Control, Controller, type FieldPath } from 'react-hook-form';
import type { z } from 'zod';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { Button } from '../../components/ui/button.js';
import { FieldError } from '../../components/ui/field.js';
import {
  NumberInput,
  NumberInputControl,
  NumberInputGroup,
} from '../../components/ui/number-input.js';
import { Switch } from '../../components/ui/switch.js';
import { errorMessage } from '../../lib/api.js';
import { useFormBlocker } from '../../lib/form.js';
import { useAlertSettings, useUpdateAlertSettings } from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';

const alertsFormSchema = alertSettingsSchema.omit({ updatedAt: true });

type AlertsFormValues = z.infer<typeof alertsFormSchema>;

export function AlertsSection({ canManage }: { canManage: boolean }) {
  const alerts = useAlertSettings();
  if (alerts.isPending) return <LoadingState rows={3} />;
  if (alerts.isError) {
    return <ErrorState error={alerts.error} onRetry={() => void alerts.refetch()} />;
  }
  return alerts.data ? <AlertsForm settings={alerts.data} canManage={canManage} /> : null;
}

type AlertsThresholdPath =
  | 'runFailures.threshold'
  | 'runFailures.windowMinutes'
  | 'queueFailed.threshold'
  | 'queueWaiting.threshold';

function AlertThresholdField({
  control,
  name,
  id,
  unit,
  label,
  error,
  disabled,
}: {
  control: Control<AlertsFormValues>;
  name: Extract<FieldPath<AlertsFormValues>, AlertsThresholdPath>;
  id: string;
  unit: string;
  label: string;
  error: string | undefined;
  disabled: boolean;
}) {
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <Controller
          control={control}
          name={name}
          render={({ field }) => (
            <NumberInput
              name={field.name}
              value={Number.isFinite(field.value) ? field.value : null}
              onValueChange={(next, details) => {
                if (details?.reason === 'input-commit') {
                  details.cancel();
                  return;
                }
                field.onChange(next ?? Number.NaN);
              }}
              step={1}
              disabled={disabled}
              className="w-24"
            >
              <NumberInputGroup>
                <NumberInputControl
                  ref={field.ref}
                  id={id}
                  inputMode="numeric"
                  onBlur={field.onBlur}
                  aria-label={label}
                  aria-invalid={Boolean(error)}
                  {...(error ? { 'aria-describedby': errorId } : {})}
                />
              </NumberInputGroup>
            </NumberInput>
          )}
        />
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}

function AlertsForm({ settings, canManage }: { settings: AlertSettings; canManage: boolean }) {
  const update = useUpdateAlertSettings();
  const { control, handleSubmit, reset, formState } = useZodForm(alertsFormSchema, {
    defaultValues: {
      runFailures: settings.runFailures,
      queueFailed: settings.queueFailed,
      queueWaiting: settings.queueWaiting,
    },
  });
  const { errors } = formState;
  const [error, setError] = useState<string | null>(null);
  const pending = update.isPending;
  const blocker = useFormBlocker(formState.isDirty, pending);

  const submit = handleSubmit(async (values: AlertsFormValues) => {
    if (pending) return;
    setError(null);
    try {
      const saved = await update.mutateAsync({ ...values, updatedAt: settings.updatedAt });
      reset({
        runFailures: saved.runFailures,
        queueFailed: saved.queueFailed,
        queueWaiting: saved.queueWaiting,
      });
      toastSuccess('告警设置已保存');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  });

  return (
    <>
      <form
        aria-label="告警设置"
        noValidate
        className="flex min-w-0 flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex min-w-0 flex-col">
          <div className="grid grid-cols-[minmax(0,1fr)_72px_140px_140px] items-center gap-4 border-b pb-2 text-xs text-muted-foreground">
            <span>告警</span>
            <span>启用</span>
            <span>阈值</span>
            <span>窗口</span>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_72px_140px_140px] items-start gap-4 border-b py-4">
            <div className="min-w-0">
              <p className="text-sm text-fg">运行失败</p>
              <p className="text-xs text-muted-foreground">窗口内失败运行数</p>
            </div>
            <Controller
              control={control}
              name="runFailures.enabled"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  disabled={!canManage || pending}
                  aria-label="启用运行失败告警"
                  onCheckedChange={field.onChange}
                />
              )}
            />
            <AlertThresholdField
              control={control}
              name="runFailures.threshold"
              id="alerts-run-threshold"
              unit="次"
              label="运行失败阈值（次）"
              error={errors.runFailures?.threshold?.message}
              disabled={!canManage || pending}
            />
            <AlertThresholdField
              control={control}
              name="runFailures.windowMinutes"
              id="alerts-run-window"
              unit="分钟"
              label="运行失败统计窗口（分钟）"
              error={errors.runFailures?.windowMinutes?.message}
              disabled={!canManage || pending}
            />
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_72px_140px_140px] items-start gap-4 border-b py-4">
            <div className="min-w-0">
              <p className="text-sm text-fg">队列失败</p>
              <p className="text-xs text-muted-foreground">失败队列任务数</p>
            </div>
            <Controller
              control={control}
              name="queueFailed.enabled"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  disabled={!canManage || pending}
                  aria-label="启用队列失败告警"
                  onCheckedChange={field.onChange}
                />
              )}
            />
            <AlertThresholdField
              control={control}
              name="queueFailed.threshold"
              id="alerts-queue-failed-threshold"
              unit="个"
              label="队列失败阈值（个）"
              error={errors.queueFailed?.threshold?.message}
              disabled={!canManage || pending}
            />
            <span className="text-xs text-muted-foreground">—</span>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_72px_140px_140px] items-start gap-4 border-b py-4">
            <div className="min-w-0">
              <p className="text-sm text-fg">队列积压</p>
              <p className="text-xs text-muted-foreground">等待中的队列任务数</p>
            </div>
            <Controller
              control={control}
              name="queueWaiting.enabled"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  disabled={!canManage || pending}
                  aria-label="启用队列积压告警"
                  onCheckedChange={field.onChange}
                />
              )}
            />
            <AlertThresholdField
              control={control}
              name="queueWaiting.threshold"
              id="alerts-queue-waiting-threshold"
              unit="个"
              label="队列积压阈值（个）"
              error={errors.queueWaiting?.threshold?.message}
              disabled={!canManage || pending}
            />
            <span className="text-xs text-muted-foreground">—</span>
          </div>
        </div>

        <FieldError>{error ?? undefined}</FieldError>
        <div className="flex items-center justify-end gap-2">
          <Button type="submit" disabled={!canManage || pending} aria-busy={pending}>
            {pending ? '正在保存…' : '保存设置'}
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="放弃未保存的告警设置？"
        description="离开后，本次修改不会保留。"
        confirmLabel="放弃并离开"
        confirmDisabled={pending}
        onConfirm={async () => blocker.proceed()}
      />
    </>
  );
}
