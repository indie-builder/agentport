import { updatePersonalProfileInputSchema } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { Page, PageBody, PageHeader, PageTopbar } from '../../components/page.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import {
  Field,
  FieldContent,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import { authenticated } from '../../lib/access.js';
import { errorMessage } from '../../lib/api.js';
import { useFormBlocker } from '../../lib/form.js';
import { formatDateTime } from '../../lib/format.js';
import { meQuery, usePersonalSessions, useUpdatePersonalProfile } from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';

// 短字段统一 448px；横向标签列 96px，值列与表单、提交按钮共用同一轴线。
const FIELD_VALUE = 'flex w-full min-w-0 max-w-112 flex-1 flex-col gap-1.5';

export function PersonalProfilePage() {
  const me = useQuery(meQuery);
  const user = authenticated(me.data);
  const update = useUpdatePersonalProfile();
  const sessions = usePersonalSessions();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useZodForm(updatePersonalProfileInputSchema, {
    defaultValues: { name: user?.user.name ?? '' },
  });
  const { register, handleSubmit, reset, formState } = form;
  const dirty = formState.isDirty;
  const nameErrorIds = [
    formState.errors.name ? 'personal-name-field-error' : null,
    formError ? 'personal-name-error' : null,
  ].filter((id): id is string => id !== null);
  const blocker = useFormBlocker(dirty, update.isPending);

  if (!user) return null;

  const initial = (
    Array.from(user.user.name.trim())[0] ??
    Array.from(user.user.username)[0] ??
    ''
  ).toUpperCase();
  const roleLabel = user.roles.map((role) => role.name).join('、') || '无角色';
  const currentSession =
    sessions.isError || sessions.isRefetchError
      ? undefined
      : sessions.data?.items.find((session) => session.current);

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
      <PageTopbar>
        <PageHeader title="个人资料" />
      </PageTopbar>

      <PageBody>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_320px] items-start gap-6">
          <Card className="min-w-0">
            <CardContent className="flex flex-col gap-4">
              <div className="flex min-w-0 items-center gap-4">
                <div
                  aria-hidden="true"
                  className="flex size-12 shrink-0 items-center justify-center rounded-full bg-sunken text-lg font-medium text-fg"
                >
                  {initial}
                </div>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="min-w-0 truncate text-base font-medium text-fg">{user.user.name}</p>
                  <p className="min-w-0 break-words text-sm text-muted-foreground">
                    @{user.user.username} · {roleLabel}
                  </p>
                </div>
              </div>

              <div className="h-px bg-line" />

              <h2 className="text-base font-medium text-fg">基本资料</h2>

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
                        aria-invalid={Boolean(formState.errors.name || formError)}
                        aria-describedby={
                          nameErrorIds.length > 0 ? nameErrorIds.join(' ') : undefined
                        }
                        {...register('name')}
                      />
                      <FieldError id="personal-name-field-error">
                        {formState.errors.name?.message}
                      </FieldError>
                      {formError ? (
                        <FieldError id="personal-name-error">{formError}</FieldError>
                      ) : null}
                    </div>
                  </Field>
                </FieldGroup>
                <div className="ml-28 flex max-w-112 justify-end gap-2">
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
                  <Button
                    type="submit"
                    disabled={!dirty || update.isPending}
                    aria-busy={update.isPending}
                  >
                    {update.isPending ? '保存中…' : '保存'}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <div className="flex min-w-0 flex-col gap-4">
            <Card className="min-w-0">
              <CardContent className="flex flex-col gap-3">
                <h2 className="text-base font-medium text-fg">账号</h2>
                <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">角色</dt>
                  <dd className="min-w-0 break-words text-fg">{roleLabel}</dd>
                  <dt className="text-muted-foreground">业务 ID</dt>
                  <dd className="min-w-0 break-all font-mono text-xs text-fg">
                    {user.user.businessId}
                  </dd>
                </dl>
                <p className="text-xs text-muted-foreground">业务 ID 由管理员分配，不可修改。</p>
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardContent className="flex flex-col gap-3">
                <h2 className="text-base font-medium text-fg">登录安全</h2>
                {currentSession ? (
                  <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg">
                    <StatusBadge tone="brand">当前设备</StatusBadge>
                    <span className="min-w-0 break-words">
                      最近活动 {formatDateTime(currentSession.updatedAt)}
                    </span>
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">暂时无法获取当前登录会话。</p>
                )}
                <Link
                  to="/personal/security"
                  className={buttonVariants({
                    variant: 'link',
                    size: 'sm',
                    className: 'self-start px-0 underline',
                  })}
                >
                  前往账号安全
                  <ArrowRight data-icon="inline-end" aria-hidden="true" />
                </Link>
              </CardContent>
            </Card>
          </div>
        </div>
      </PageBody>

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
