import type { ComponentProps } from 'react';
import { z } from 'zod';
import { DialogShell } from '../../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../../components/draft-guard.js';
import { RequiredMark } from '../../components/required-mark.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import type { EvalCase, EvalCaseInput } from '../../lib/api.js';
import { guardedOpenChange } from '../../lib/dialog-guard.js';
import { useCreateEvalCase, useUpdateEvalCase } from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';

const evalCaseFormSchema = z.object({
  name: z.string().trim().min(1, '名称需要填写。').max(128, '名称不能超过 128 字。'),
  prompt: z.string().min(1, '输入需要填写。').max(20_000, '输入不能超过 20,000 字。'),
  expectation: z.string().max(5_000, '期望不能超过 5,000 字。'),
});

export function CaseDialog({
  agentId,
  testCase,
  onClose,
  finalFocus,
}: {
  agentId?: string;
  testCase?: EvalCase;
  onClose: () => void;
  finalFocus: ComponentProps<typeof DialogShell>['finalFocus'];
}) {
  const create = useCreateEvalCase();
  const update = useUpdateEvalCase();
  const { register, handleSubmit, watch, formState } = useZodForm(evalCaseFormSchema, {
    defaultValues: testCase
      ? { name: testCase.name, prompt: testCase.prompt, expectation: testCase.expectation }
      : { name: '', prompt: '', expectation: '' },
  });
  const { errors, isDirty } = formState;
  const values = watch();
  const dirty = isDirty;

  const submit = handleSubmit((form) => {
    if (pending) return;
    const input: EvalCaseInput = {
      agentId: agentId ?? testCase?.agentId ?? '',
      ...form,
    };
    const done = (): void => {
      toastSuccess(testCase ? '用例已更新' : '用例已创建');
      guard.finish();
    };
    if (testCase) {
      update.mutate(
        {
          id: testCase.id,
          input: { name: input.name, prompt: input.prompt, expectation: input.expectation },
        },
        { onSuccess: done, onError: toastError },
      );
    } else {
      create.mutate(input, { onSuccess: done, onError: toastError });
    }
  });

  const pending = create.isPending || update.isPending;
  const guard = useDraftGuard(dirty, pending, onClose);

  return (
    <Dialog open onOpenChange={guardedOpenChange(pending, guard.close)}>
      <DialogShell
        title={testCase ? '编辑用例' : '新建用例'}
        description="运行评估时，每个用例都会发起一次真实运行。"
        closeDisabled={pending}
        finalFocus={finalFocus}
      >
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup className="gap-4">
            <Field className="gap-1.5" data-invalid={Boolean(errors.name)} data-disabled={pending}>
              <FieldLabel htmlFor="eval-name">
                名称 <RequiredMark />
              </FieldLabel>
              <Input
                {...register('name')}
                value={values.name}
                id="eval-name"
                disabled={pending}
                required
                aria-required="true"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'eval-name-error' : undefined}
                placeholder="例如：拒绝编造不存在的工具"
              />
              <FieldError id="eval-name-error">{errors.name?.message}</FieldError>
            </Field>
            <Field
              className="gap-1.5"
              data-invalid={Boolean(errors.prompt)}
              data-disabled={pending}
            >
              <FieldLabel htmlFor="eval-prompt">
                输入 <RequiredMark />
              </FieldLabel>
              <Textarea
                {...register('prompt')}
                value={values.prompt}
                id="eval-prompt"
                disabled={pending}
                required
                aria-required="true"
                rows={5}
                aria-invalid={Boolean(errors.prompt)}
                aria-describedby={errors.prompt ? 'eval-prompt-error' : undefined}
                placeholder="发送给专家的完整输入"
              />
              <FieldError id="eval-prompt-error">{errors.prompt?.message}</FieldError>
            </Field>
            <Field
              className="gap-1.5"
              data-invalid={Boolean(errors.expectation)}
              data-disabled={pending}
            >
              <FieldLabel htmlFor="eval-expectation">期望包含</FieldLabel>
              <Textarea
                {...register('expectation')}
                value={values.expectation}
                id="eval-expectation"
                disabled={pending}
                rows={2}
                aria-invalid={Boolean(errors.expectation)}
                aria-describedby={
                  errors.expectation
                    ? 'eval-expectation-error eval-expectation-description'
                    : 'eval-expectation-description'
                }
                placeholder="输出中应出现的文本（不区分大小写）；留空则只要求有文本输出"
              />
              <FieldDescription id="eval-expectation-description">
                最小判定，不做语义判断；需要更严格时写更具体的片段。
              </FieldDescription>
              <FieldError id="eval-expectation-error">{errors.expectation?.message}</FieldError>
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="这条用例的修改会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
