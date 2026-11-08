import type { KnowledgeBase } from '@agentport/shared';
import { z } from 'zod';
import { useUpdateKnowledgeBase } from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';
import { DialogShell } from './dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from './knowledge-shared.js';
import { RequiredMark } from './required-mark.js';
import { Button } from './ui/button.js';
import { Dialog } from './ui/dialog.js';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from './ui/field.js';
import { Input } from './ui/input.js';
import { Textarea } from './ui/textarea.js';

const DESCRIPTION_MAX = 500;

const baseInfoSchema = z.object({
  name: z.string().trim().min(1, '不能为空，请填写后再保存').max(120, '最多 120 个字符'),
  description: z.string().max(DESCRIPTION_MAX, `最多 ${DESCRIPTION_MAX} 个字符`),
});

type BaseInfoForm = z.infer<typeof baseInfoSchema>;

/** 只编辑用户可见的名称与描述；模型、分块等设置留在设置弹层。 */
export function BaseInfoDialog({
  base,
  onClose,
  finalFocus,
}: {
  base: KnowledgeBase;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const update = useUpdateKnowledgeBase();
  const form = useZodForm(baseInfoSchema, {
    defaultValues: { name: base.name, description: base.description } satisfies BaseInfoForm,
  });
  const errors = form.formState.errors;
  const description = form.watch('description');
  const pending = update.isPending;
  const guard = useDraftGuard(form.formState.isDirty, pending, onClose);

  const submit = form.handleSubmit((values) => {
    update.mutate(
      { baseId: base.id, patch: { name: values.name, description: values.description } },
      {
        onSuccess: () => {
          toastSuccess('已保存知识库信息');
          guard.finish();
        },
        onError: toastError,
      },
    );
  });

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) guard.close();
      }}
    >
      <DialogShell title="编辑信息" closeDisabled={pending} finalFocus={finalFocus}>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            return submit();
          }}
        >
          <FieldGroup className="gap-3">
            <Field className="gap-1.5" data-invalid={Boolean(errors.name)}>
              <FieldLabel htmlFor="knowledge-base-info-name">
                名称 <RequiredMark />
              </FieldLabel>
              <Input
                {...form.register('name')}
                id="knowledge-base-info-name"
                disabled={pending}
                maxLength={120}
                aria-required="true"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'knowledge-base-info-name-error' : undefined}
              />
              <FieldError id="knowledge-base-info-name-error">{errors.name?.message}</FieldError>
            </Field>
            <Field className="gap-1.5" data-invalid={Boolean(errors.description)}>
              <FieldLabel htmlFor="knowledge-base-info-description">描述</FieldLabel>
              <Textarea
                {...form.register('description')}
                id="knowledge-base-info-description"
                rows={3}
                disabled={pending}
                maxLength={DESCRIPTION_MAX}
                aria-invalid={Boolean(errors.description)}
                aria-describedby={
                  errors.description
                    ? 'knowledge-base-info-count knowledge-base-info-description-error'
                    : 'knowledge-base-info-count'
                }
              />
              <FieldDescription
                id="knowledge-base-info-count"
                className="text-right text-xs tabular-nums"
              >
                {description.length}/{DESCRIPTION_MAX}
              </FieldDescription>
              <FieldError id="knowledge-base-info-description-error">
                {errors.description?.message}
              </FieldError>
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending || !form.formState.isDirty} aria-busy={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="知识库信息草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
