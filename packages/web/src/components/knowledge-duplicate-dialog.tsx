import type { KnowledgeBase } from '@agentport/shared';
import { slugSchema } from '@agentport/shared';
import { z } from 'zod';
import { useDuplicateKnowledgeBase } from '../lib/queries.js';
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
const NAME_MAX = 120;
const NAME_COPY_SUFFIX = ' 副本';
const SLUG_MAX = 64;
const SLUG_COPY_SUFFIX = '-copy';

/** 复用共享 slug 规则的提示文案，前端不另写一份正则。 */
const SLUG_RULE_MESSAGE =
  slugSchema.safeParse('-').error?.issues[0]?.message ?? '仅允许小写字母、数字、- 和 _';

const duplicateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, '不能为空，请填写后再保存')
    .max(NAME_MAX, `最多 ${NAME_MAX} 个字符`),
  // 留空交给服务端自动生成（-copy、-2…），填了才按共享规则校验。
  slug: z
    .string()
    .trim()
    .refine((value) => value === '' || slugSchema.safeParse(value).success, SLUG_RULE_MESSAGE),
  description: z.string().max(DESCRIPTION_MAX, `最多 ${DESCRIPTION_MAX} 个字符`),
});

type DuplicateForm = z.infer<typeof duplicateSchema>;

/** 复制知识库：只重建库与配置，不带原库的文档、Wiki 与索引。 */
export function DuplicateBaseDialog({
  base,
  onClose,
  finalFocus,
  onDuplicated,
}: {
  base: KnowledgeBase;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
  onDuplicated: (baseId: string) => void;
}) {
  const duplicate = useDuplicateKnowledgeBase();
  const form = useZodForm(duplicateSchema, {
    defaultValues: {
      // 截断源名让「 副本」后缀完整保留，源名接近上限时也不会一打开就超限。
      name: `${base.name.slice(0, NAME_MAX - NAME_COPY_SUFFIX.length)}${NAME_COPY_SUFFIX}`,
      // 默认留空：由服务端挑一个没被占用的副本 slug。
      slug: '',
      description: base.description,
    } satisfies DuplicateForm,
  });
  const errors = form.formState.errors;
  const description = form.watch('description');
  const pending = duplicate.isPending;
  const guard = useDraftGuard(form.formState.isDirty, pending, onClose);

  const submit = form.handleSubmit((values) => {
    duplicate.mutate(
      {
        baseId: base.id,
        // 只有用户明确填了 slug 才传给服务端，空字符串会让自动后缀分支不可达。
        body: {
          name: values.name,
          description: values.description,
          ...(values.slug ? { slug: values.slug } : {}),
        },
      },
      {
        onSuccess: (created) => {
          toastSuccess(`已复制为「${created.name}」`);
          guard.finish();
          onDuplicated(created.id);
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
      <DialogShell title="复制知识库" closeDisabled={pending} finalFocus={finalFocus}>
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
              <FieldLabel htmlFor="knowledge-duplicate-name">
                名称 <RequiredMark />
              </FieldLabel>
              <Input
                {...form.register('name')}
                id="knowledge-duplicate-name"
                disabled={pending}
                maxLength={NAME_MAX}
                aria-required="true"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'knowledge-duplicate-name-error' : undefined}
              />
              <FieldError id="knowledge-duplicate-name-error">{errors.name?.message}</FieldError>
            </Field>
            <Field className="gap-1.5" data-invalid={Boolean(errors.slug)}>
              <FieldLabel htmlFor="knowledge-duplicate-slug">Slug</FieldLabel>
              <Input
                {...form.register('slug')}
                id="knowledge-duplicate-slug"
                disabled={pending}
                maxLength={SLUG_MAX}
                className="font-mono"
                placeholder={`${base.slug.slice(0, SLUG_MAX - SLUG_COPY_SUFFIX.length)}${SLUG_COPY_SUFFIX}`}
                aria-invalid={Boolean(errors.slug)}
                aria-describedby={
                  errors.slug
                    ? 'knowledge-duplicate-slug-hint knowledge-duplicate-slug-error'
                    : 'knowledge-duplicate-slug-hint'
                }
              />
              <FieldDescription id="knowledge-duplicate-slug-hint">
                留空自动生成（-copy、-2…）
              </FieldDescription>
              <FieldError id="knowledge-duplicate-slug-error">{errors.slug?.message}</FieldError>
            </Field>
            <Field className="gap-1.5" data-invalid={Boolean(errors.description)}>
              <FieldLabel htmlFor="knowledge-duplicate-description">描述</FieldLabel>
              <Textarea
                {...form.register('description')}
                id="knowledge-duplicate-description"
                rows={3}
                disabled={pending}
                maxLength={DESCRIPTION_MAX}
                aria-invalid={Boolean(errors.description)}
                aria-describedby={
                  errors.description
                    ? 'knowledge-duplicate-count knowledge-duplicate-description-error'
                    : 'knowledge-duplicate-count'
                }
              />
              <FieldDescription
                id="knowledge-duplicate-count"
                className="text-right text-xs tabular-nums"
              >
                {description.length}/{DESCRIPTION_MAX}
              </FieldDescription>
              <FieldError id="knowledge-duplicate-description-error">
                {errors.description?.message}
              </FieldError>
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? '复制中…' : '复制'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="复制草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
