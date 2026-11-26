import { channelHandoffInputSchema } from '@agentport/shared';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { DialogShell } from '../../components/dialog-shell.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Field, FieldError, FieldLabel } from '../../components/ui/field.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Textarea } from '../../components/ui/textarea.js';
import { guardedOpenChange, useDialogClose } from '../../lib/dialog-guard.js';
import { useChannelHandoff } from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';

const handoffSchema = z.object({
  targetAgentId: z.string().min(1, '请选择目标智能体'),
  note: channelHandoffInputSchema.shape.note,
});

export function ChannelHandoffDialog({
  channelId,
  sourceRunId,
  sourceAgentId,
  agents,
  onClose: onClosed,
}: {
  channelId: string;
  sourceRunId: string;
  sourceAgentId: string;
  agents: { agentId: string; name: string }[];
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const handoff = useChannelHandoff(channelId);
  const targets = agents.filter((agent) => agent.agentId !== sourceAgentId);
  const form = useZodForm(handoffSchema, {
    defaultValues: { targetAgentId: '', note: '' },
  });
  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
  } = form;
  const pending = handoff.isPending;
  const formId = `channel-handoff-${sourceRunId}`;
  const options = targets.map((agent) => ({ value: agent.agentId, label: agent.name }));

  const submit = handleSubmit(async (values) => {
    try {
      await handoff.mutateAsync({
        sourceRunId,
        targetAgentId: values.targetAgentId,
        ...(values.note ? { note: values.note } : {}),
      });
      toastSuccess('已交接');
      dialog.finish(onClosed);
    } catch (error) {
      toastError(error);
    }
  });

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, dialog.close)}
    >
      <DialogShell
        title="交接运行"
        description="交接消息、上下文摘要和成果附件将发送到本频道，频道成员可见。"
        closeDisabled={pending}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={dialog.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" form={formId} disabled={pending} aria-busy={pending}>
              {pending ? '交接中…' : '确认交接'}
            </Button>
          </div>
        }
      >
        <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
          <Field
            className="gap-1.5"
            data-invalid={Boolean(errors.targetAgentId)}
            data-disabled={pending}
          >
            <FieldLabel htmlFor={`${formId}-target`}>目标智能体</FieldLabel>
            <Controller
              control={control}
              name="targetAgentId"
              render={({ field }) => (
                <Select
                  value={field.value === '' ? null : field.value}
                  onValueChange={(next) => {
                    if (next !== null) field.onChange(next);
                  }}
                  items={options}
                  disabled={pending}
                >
                  <SelectTrigger
                    id={`${formId}-target`}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    aria-invalid={Boolean(errors.targetAgentId)}
                    aria-describedby={errors.targetAgentId ? `${formId}-target-error` : undefined}
                  >
                    <SelectValue placeholder="选择目标智能体" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )}
            />
            <FieldError id={`${formId}-target-error`}>{errors.targetAgentId?.message}</FieldError>
          </Field>
          <Field className="gap-1.5" data-invalid={Boolean(errors.note)} data-disabled={pending}>
            <FieldLabel htmlFor={`${formId}-note`}>备注</FieldLabel>
            <Textarea
              {...register('note')}
              id={`${formId}-note`}
              rows={4}
              placeholder="交接原因或需要对方优先处理的事项"
              disabled={pending}
              aria-invalid={Boolean(errors.note)}
              aria-describedby={errors.note ? `${formId}-note-error` : undefined}
            />
            <FieldError id={`${formId}-note-error`}>{errors.note?.message}</FieldError>
          </Field>
        </form>
      </DialogShell>
    </Dialog>
  );
}
