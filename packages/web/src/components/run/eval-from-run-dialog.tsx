import type { ComponentProps } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { guardedOpenChange, useDialogClose } from '../../lib/dialog-guard.js';
import { shortId } from '../../lib/format.js';
import { useCreateEvalCaseFromRun } from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import { DialogShell } from '../dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../draft-guard.js';
import { RequiredMark } from '../required-mark.js';
import { Button } from '../ui/button.js';
import { Checkbox } from '../ui/checkbox.js';
import { Dialog } from '../ui/dialog.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../ui/field.js';
import { Input } from '../ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';
import { Textarea } from '../ui/textarea.js';

const judgeOptions = [
  { value: 'contains', label: '包含匹配' },
  { value: 'llm', label: 'LLM 评判' },
];

const evalFromRunSchema = z.object({
  name: z.string().trim().min(1, '名称需要填写。').max(128, '名称不能超过 128 字。'),
  expectation: z
    .string()
    .trim()
    .min(1, '期望答案需要人工填写。')
    .max(5_000, '期望答案不能超过 5,000 字。'),
  judgeMode: z.enum(['contains', 'llm']),
  confirmed: z.boolean().refine((value) => value, { message: '请确认已人工核对期望答案。' }),
});

export function EvalFromRunDialog({
  runId,
  conversationTitle,
  prompt,
  feedbackId,
  finalFocus,
  onClose: onClosed,
}: {
  runId: string;
  conversationTitle: string;
  prompt: string;
  feedbackId?: string;
  finalFocus?: ComponentProps<typeof DialogShell>['finalFocus'];
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const create = useCreateEvalCaseFromRun();
  const defaultName = (conversationTitle.trim() || `运行 ${shortId(runId)}`).slice(0, 128);
  const form = useZodForm(evalFromRunSchema, {
    defaultValues: { name: defaultName, expectation: '', judgeMode: 'contains', confirmed: false },
  });
  const { errors } = form.formState;
  const control = form.control;
  const confirmed = form.watch('confirmed');
  const judgeMode = form.watch('judgeMode');
  const pending = create.isPending;
  const guard = useDraftGuard(form.formState.isDirty, pending, dialog.close);
  const formId = `eval-from-run-${runId}`;

  const submit = form.handleSubmit((values) => {
    if (pending) return;
    create.mutate(
      {
        runId,
        name: values.name,
        expectation: values.expectation,
        judgeMode: values.judgeMode,
        confirmed: true,
        ...(feedbackId === undefined ? {} : { feedbackId }),
      },
      {
        onSuccess: () => {
          toastSuccess('已创建评估用例');
          guard.finish();
        },
        onError: toastError,
      },
    );
  });

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell
        title="新建评估用例"
        description="输入取自本次运行；期望答案需要人工填写。"
        closeDisabled={pending}
        finalFocus={finalFocus}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" form={formId} disabled={pending} aria-busy={pending}>
              {pending ? '创建中…' : '创建'}
            </Button>
          </div>
        }
      >
        <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup className="gap-4">
            <Field className="gap-1.5" data-invalid={Boolean(errors.name)} data-disabled={pending}>
              <FieldLabel htmlFor={`${formId}-name`}>
                名称 <RequiredMark />
              </FieldLabel>
              <Input
                {...form.register('name')}
                id={`${formId}-name`}
                disabled={pending}
                required
                aria-required="true"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? `${formId}-name-error` : undefined}
              />
              <FieldError id={`${formId}-name-error`}>{errors.name?.message}</FieldError>
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor={`${formId}-prompt`}>输入</FieldLabel>
              <Textarea
                id={`${formId}-prompt`}
                value={prompt}
                readOnly
                rows={3}
                aria-readonly="true"
                className="max-h-40 overflow-y-auto bg-sunken text-muted-foreground"
              />
            </Field>
            <Field className="gap-1.5" data-disabled={pending}>
              <FieldLabel htmlFor={`${formId}-judge-mode`}>判分方式</FieldLabel>
              <Controller
                control={control}
                name="judgeMode"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(next) => {
                      if (next !== null) field.onChange(next);
                    }}
                    items={judgeOptions}
                    disabled={pending}
                  >
                    <SelectTrigger
                      id={`${formId}-judge-mode`}
                      ref={field.ref}
                      onBlur={field.onBlur}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {judgeOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field
              className="gap-1.5"
              data-invalid={Boolean(errors.expectation)}
              data-disabled={pending}
            >
              <FieldLabel htmlFor={`${formId}-expectation`}>
                {judgeMode === 'llm' ? '评判标准' : '期望答案'} <RequiredMark />
              </FieldLabel>
              <Textarea
                {...form.register('expectation')}
                id={`${formId}-expectation`}
                disabled={pending}
                required
                aria-required="true"
                rows={5}
                aria-invalid={Boolean(errors.expectation)}
                aria-describedby={errors.expectation ? `${formId}-expectation-error` : undefined}
                placeholder={
                  judgeMode === 'llm'
                    ? 'LLM 判定通过的条件，例如：必须说明无法确认并拒绝编造'
                    : '输出中应出现的文本（不区分大小写）'
                }
              />
              <FieldError id={`${formId}-expectation-error`}>
                {errors.expectation?.message}
              </FieldError>
            </Field>
            <Field
              orientation="horizontal"
              className="items-start gap-2"
              data-invalid={Boolean(errors.confirmed)}
              data-disabled={pending}
            >
              <Checkbox
                id={`${formId}-confirmed`}
                checked={confirmed}
                disabled={pending}
                aria-invalid={Boolean(errors.confirmed)}
                aria-describedby={errors.confirmed ? `${formId}-confirmed-error` : undefined}
                onCheckedChange={(checked) =>
                  form.setValue('confirmed', checked, { shouldDirty: true, shouldValidate: true })
                }
              />
              <div className="flex min-w-0 flex-col gap-1">
                <FieldLabel htmlFor={`${formId}-confirmed`} className="text-sm font-normal">
                  我已人工核对期望答案，不使用原回答作为正确答案
                </FieldLabel>
                <FieldError id={`${formId}-confirmed-error`}>
                  {errors.confirmed?.message}
                </FieldError>
              </div>
            </Field>
          </FieldGroup>
        </form>
        <DraftGuardDialogs guard={guard} draft="这条评估用例的草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
