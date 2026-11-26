import { evalToolNamesSchema } from '@agentport/shared';
import type { ComponentProps } from 'react';
import { Controller } from 'react-hook-form';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Textarea } from '../../components/ui/textarea.js';
import type { EvalCase } from '../../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../../lib/dialog-guard.js';
import { useCreateEvalCase, useUpdateEvalCase } from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';

export function parseToolList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((tool) => tool.trim())
        .filter(Boolean),
    ),
  ];
}

function toolListTextSchema(initial: string) {
  return z
    .string()
    .max(20_000, '工具名列表过长。')
    .superRefine((text, ctx) => {
      if (text === initial) return;
      const parsed = evalToolNamesSchema.safeParse(parseToolList(text));
      if (!parsed.success) {
        ctx.addIssue({
          code: 'custom',
          message: parsed.error.issues[0]?.message ?? '工具名列表不合法。',
        });
      }
    })
    .transform(parseToolList);
}

function evalCaseFormSchema(initial: { expectedTools: string; forbiddenTools: string }) {
  return z.object({
    name: z.string().trim().min(1, '名称需要填写。').max(128, '名称不能超过 128 字。'),
    prompt: z.string().min(1, '输入需要填写。').max(20_000, '输入不能超过 20,000 字。'),
    expectation: z.string().max(5_000, '期望不能超过 5,000 字。'),
    judgeMode: z.enum(['contains', 'llm']),
    expectedTools: toolListTextSchema(initial.expectedTools),
    forbiddenTools: toolListTextSchema(initial.forbiddenTools),
  });
}

const judgeOptions = [
  { value: 'contains', label: '包含匹配' },
  { value: 'llm', label: 'LLM 评判' },
];

export function CaseDialog({
  agentId,
  testCase,
  onClose: onClosed,
  finalFocus,
}: {
  agentId?: string;
  testCase?: EvalCase;
  onClose: () => void;
  finalFocus: ComponentProps<typeof DialogShell>['finalFocus'];
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const create = useCreateEvalCase();
  const update = useUpdateEvalCase();
  const initialTools = {
    expectedTools: testCase?.expectedTools?.join('\n') ?? '',
    forbiddenTools: testCase?.forbiddenTools?.join('\n') ?? '',
  };
  const { register, handleSubmit, watch, control, formState } = useZodForm(
    evalCaseFormSchema(initialTools),
    {
      defaultValues: testCase
        ? {
            name: testCase.name,
            prompt: testCase.prompt,
            expectation: testCase.expectation,
            judgeMode: testCase.judgeMode,
            ...initialTools,
          }
        : {
            name: '',
            prompt: '',
            expectation: '',
            judgeMode: 'contains',
            expectedTools: '',
            forbiddenTools: '',
          },
    },
  );
  const { errors, isDirty } = formState;
  const values = watch();
  const judgeMode = values.judgeMode;
  const dirty = isDirty;

  const submit = handleSubmit((form) => {
    if (pending) return;
    const base = {
      name: form.name,
      prompt: form.prompt,
      expectation: form.expectation,
      judgeMode: form.judgeMode,
      ...(values.expectedTools === initialTools.expectedTools
        ? {}
        : { expectedTools: form.expectedTools }),
      ...(values.forbiddenTools === initialTools.forbiddenTools
        ? {}
        : { forbiddenTools: form.forbiddenTools }),
    };
    const done = (): void => {
      toastSuccess(testCase ? '用例已更新' : '用例已创建');
      guard.finish();
    };
    if (testCase) {
      update.mutate({ id: testCase.id, input: base }, { onSuccess: done, onError: toastError });
    } else {
      create.mutate({ agentId: agentId ?? '', ...base }, { onSuccess: done, onError: toastError });
    }
  });

  const pending = create.isPending || update.isPending;
  const guard = useDraftGuard(dirty, pending, onClose);

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell
        title={testCase ? '编辑用例' : '新建用例'}
        description="运行评估时，每个用例都会发起一次真实运行。"
        closeDisabled={pending}
        finalFocus={finalFocus}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" form="eval-case-form" disabled={pending} aria-busy={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        }
      >
        <form id="eval-case-form" noValidate onSubmit={submit} className="flex flex-col gap-4">
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
            <Field className="gap-1.5" data-disabled={pending}>
              <FieldLabel htmlFor="eval-judge-mode">判分方式</FieldLabel>
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
                    <SelectTrigger id="eval-judge-mode" ref={field.ref} onBlur={field.onBlur}>
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
              <FieldLabel htmlFor="eval-expectation">
                {judgeMode === 'llm' ? '评判标准' : '期望包含'}
              </FieldLabel>
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
                placeholder={
                  judgeMode === 'llm'
                    ? 'LLM 判定通过的条件，例如：必须说明无法确认并拒绝编造'
                    : '输出中应出现的文本（不区分大小写）；留空则只要求有文本输出'
                }
              />
              <FieldDescription id="eval-expectation-description">
                {judgeMode === 'llm'
                  ? '由 LLM 依据这条标准判断输出是否通过，并记录评判理由。'
                  : '最小判定，不做语义判断；需要更严格时写更具体的片段。'}
              </FieldDescription>
              <FieldError id="eval-expectation-error">{errors.expectation?.message}</FieldError>
            </Field>
            <Field
              className="gap-1.5"
              data-invalid={Boolean(errors.expectedTools)}
              data-disabled={pending}
            >
              <FieldLabel htmlFor="eval-expected-tools">期望工具</FieldLabel>
              <Textarea
                {...register('expectedTools')}
                value={values.expectedTools}
                id="eval-expected-tools"
                disabled={pending}
                rows={2}
                aria-invalid={Boolean(errors.expectedTools)}
                aria-describedby={
                  errors.expectedTools
                    ? 'eval-expected-tools-error eval-expected-tools-description'
                    : 'eval-expected-tools-description'
                }
                placeholder="Read"
              />
              <FieldDescription id="eval-expected-tools-description">
                每行或逗号分隔一个工具名；留空表示不约束。缺少这些工具时用例不通过。
              </FieldDescription>
              <FieldError id="eval-expected-tools-error">
                {errors.expectedTools?.message}
              </FieldError>
            </Field>
            <Field
              className="gap-1.5"
              data-invalid={Boolean(errors.forbiddenTools)}
              data-disabled={pending}
            >
              <FieldLabel htmlFor="eval-forbidden-tools">禁止工具</FieldLabel>
              <Textarea
                {...register('forbiddenTools')}
                value={values.forbiddenTools}
                id="eval-forbidden-tools"
                disabled={pending}
                rows={2}
                aria-invalid={Boolean(errors.forbiddenTools)}
                aria-describedby={
                  errors.forbiddenTools
                    ? 'eval-forbidden-tools-error eval-forbidden-tools-description'
                    : 'eval-forbidden-tools-description'
                }
                placeholder="Write"
              />
              <FieldDescription id="eval-forbidden-tools-description">
                每行或逗号分隔一个工具名；留空表示不约束。调用这些工具时用例不通过。
              </FieldDescription>
              <FieldError id="eval-forbidden-tools-error">
                {errors.forbiddenTools?.message}
              </FieldError>
            </Field>
          </FieldGroup>
        </form>
        <DraftGuardDialogs guard={guard} draft="这条用例的修改会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
