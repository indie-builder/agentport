import { updatePersonalProfileInputSchema } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { ArrowLeft, LogOut } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Page, PageHeader, PageSection } from '../components/page.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { authenticated, canAny, PERSONAL_MENU } from '../lib/access.js';
import { errorMessage } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { useFormBlocker } from '../lib/form.js';
import { logoutAccount, meQuery, useUpdatePersonalProfile } from '../lib/queries.js';
import { toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

/** 个人模块外壳：子页直达、返回工作区与独立登出；权限不因整合扩大。 */
export function PersonalLayout() {
  const me = useQuery(meQuery);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const items = PERSONAL_MENU.filter(
    (item) => item.permissionIds.length === 0 || canAny(me.data, item.permissionIds),
  );

  const logout = async (): Promise<void> => {
    await logoutAccount();
    await navigate({ to: '/login' });
  };

  return (
    <div className="flex min-w-0 flex-col gap-5 pt-6">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b pb-3">
        <nav aria-label="个人导航" className="flex min-w-0 flex-wrap items-center gap-1">
          {items.map((item) => {
            const active = pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? 'page' : undefined}
                activeOptions={{ exact: true }}
                className={cn(
                  'rounded-item px-2.5 py-1.5 text-sm text-fg transition-colors duration-150',
                  active ? 'bg-selected font-medium text-selected-foreground' : 'hover:bg-hover',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Link to="/chat" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <ArrowLeft data-icon="inline-start" aria-hidden="true" />
            返回工作区
          </Link>
          <Button variant="outline" size="sm" onClick={() => void logout()}>
            <LogOut data-icon="inline-start" aria-hidden="true" />
            退出登录
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}

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
      <PageHeader
        title="个人资料"
        actions={
          <>
            <Button
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
              disabled={!dirty || update.isPending}
              aria-busy={update.isPending}
              onClick={() => void submit()}
            >
              {update.isPending ? '保存中…' : '保存'}
            </Button>
          </>
        }
      />

      <form
        aria-label="个人资料"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FieldGroup className="max-w-md gap-5">
          <Field
            data-disabled={update.isPending}
            data-invalid={formState.errors.name ? true : undefined}
          >
            <FieldLabel htmlFor="personal-name">显示姓名</FieldLabel>
            <Input
              id="personal-name"
              autoComplete="name"
              disabled={update.isPending}
              aria-invalid={formState.errors.name ? true : undefined}
              aria-describedby={formError ? 'personal-name-error' : undefined}
              {...register('name')}
            />
            <FieldError>{formState.errors.name?.message}</FieldError>
          </Field>
          {formError ? <FieldError id="personal-name-error">{formError}</FieldError> : null}
        </FieldGroup>
      </form>

      <PageSection title="身份">
        <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
          <dt className="text-muted-foreground">用户名</dt>
          <dd className="min-w-0 break-words text-fg">{user.user.username}</dd>
          <dt className="text-muted-foreground">业务 ID</dt>
          <dd className="min-w-0 break-words font-mono text-xs text-fg">{user.user.businessId}</dd>
          <dt className="text-muted-foreground">角色</dt>
          <dd className="min-w-0 break-words text-fg">
            {user.roles.map((role) => role.name).join('、') || '无角色'}
          </dd>
        </dl>
      </PageSection>

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
