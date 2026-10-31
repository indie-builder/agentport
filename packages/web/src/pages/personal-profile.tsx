import { updatePersonalProfileInputSchema } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../components/motion-collapsible.js';
import { Page, PageHeader } from '../components/page.js';
import { Button } from '../components/ui/button.js';
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { authenticated } from '../lib/access.js';
import { errorMessage } from '../lib/api.js';
import { useFormBlocker } from '../lib/form.js';
import { meQuery, useUpdatePersonalProfile } from '../lib/queries.js';
import { toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

// 短字段统一 448px；横向标签列 96px，值列与表单、提交按钮共用同一轴线。
const FIELD_VALUE = 'flex w-full min-w-0 max-w-[448px] flex-1 flex-col gap-1.5';
const IDENTITY_GRID = 'grid grid-cols-[96px_minmax(0,1fr)] gap-x-4';

export function PersonalProfilePage() {
  const me = useQuery(meQuery);
  const user = authenticated(me.data);
  const update = useUpdatePersonalProfile();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useZodForm(updatePersonalProfileInputSchema, {
    defaultValues: { name: user?.user.name ?? '' },
  });
  const { register, handleSubmit, reset, formState } = form;
  const dirty = formState.isDirty;
  const blocker = useFormBlocker(dirty, update.isPending);

  if (!user) return null;

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const saved = await update.mutateAsync(values);
      reset({ name: saved.name });
      toastSuccess('姓名已保存');
    } catch (error) {
      setFormError(errorMessage(error));
    }
  });

  return (
    <Page>
      <PageHeader title="个人资料" />

      <form
        aria-label="个人资料"
        noValidate
        className="flex w-full min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FieldGroup>
          <Field
            orientation="horizontal"
            className="items-start gap-x-4"
            data-disabled={update.isPending}
            data-invalid={formState.errors.name ? true : undefined}
          >
            <FieldContent className="w-24 flex-none pt-2">
              <FieldLabel htmlFor="personal-name">显示姓名</FieldLabel>
            </FieldContent>
            <div className={FIELD_VALUE}>
              <Input
                id="personal-name"
                autoComplete="name"
                disabled={update.isPending}
                aria-invalid={formState.errors.name ? true : undefined}
                aria-describedby={formError ? 'personal-name-error' : undefined}
                {...register('name')}
              />
              <FieldError>{formState.errors.name?.message}</FieldError>
              {formError ? <FieldError id="personal-name-error">{formError}</FieldError> : null}
            </div>
          </Field>
        </FieldGroup>
        <div className="ml-28 flex max-w-[448px] justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!dirty || update.isPending}
            onClick={() => {
              setFormError(null);
              reset({ name: user.user.name });
            }}
          >
            取消
          </Button>
          <Button type="submit" disabled={!dirty || update.isPending} aria-busy={update.isPending}>
            {update.isPending ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>

      <section className="flex w-full min-w-0 flex-col gap-3 border-t pt-5">
        <h2 className="text-base font-medium text-fg">身份</h2>
        <dl className={`${IDENTITY_GRID} gap-y-2 text-sm`}>
          <dt className="text-muted-foreground">用户名</dt>
          <dd className="min-w-0 break-words text-fg">{user.user.username}</dd>
          <dt className="text-muted-foreground">角色</dt>
          <dd className="min-w-0 break-words text-fg">
            {user.roles.map((role) => role.name).join('、') || '无角色'}
          </dd>
        </dl>

        <Collapsible>
          <CollapsibleTrigger
            render={
              <Button variant="ghost" size="sm" className="group -ml-2.5 text-muted-foreground" />
            }
          >
            <ChevronDown
              aria-hidden="true"
              data-icon="inline-start"
              className="transition-transform duration-150 ease-out-soft group-data-[panel-open]:rotate-180"
            />
            账号详情
          </CollapsibleTrigger>
          <CollapsibleContent animated>
            <dl className={`${IDENTITY_GRID} mt-2 text-sm`}>
              <dt className="text-muted-foreground">业务 ID</dt>
              <dd className="min-w-0 break-words font-mono text-xs text-fg">
                {user.user.businessId}
              </dd>
            </dl>
          </CollapsibleContent>
        </Collapsible>
      </section>

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="放弃未保存的姓名？"
        description="离开后，本次输入不会保留。"
        confirmLabel="放弃并离开"
        confirmDisabled={update.isPending}
        onConfirm={async () => blocker.proceed()}
      />
    </Page>
  );
}
