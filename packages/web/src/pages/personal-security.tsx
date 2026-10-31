import { type PersonalSession, passwordSchema } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Page, PageHeader, PageNote, PageSection } from '../components/page.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { ApiError, errorMessage } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import {
  clearSessionQueries,
  logoutAccount,
  meQuery,
  useChangePassword,
  usePersonalSessions,
  useRevokePersonalSession,
} from '../lib/queries.js';
import { toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

const passwordFormSchema = z
  .object({
    currentPassword: z.string().min(1, '请填写当前密码'),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .superRefine((values, ctx) => {
    if (values.newPassword !== values.confirmPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmPassword'],
        message: '两次输入的新密码不一致',
      });
    }
  });

function isFreshnessError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function PersonalSecurityPage() {
  const navigate = useNavigate();
  const change = useChangePassword();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useZodForm(passwordFormSchema, {
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });
  const { register, handleSubmit, reset, formState } = form;

  const relogin = async (): Promise<void> => {
    // 这是用户主动选择重新登录，不是 403 自动踢出；先结束当前会话再进登录页。
    await logoutAccount();
    await navigate({ to: '/login', search: { returnTo: '/personal/security' } });
  };

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await change.mutateAsync({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      toastSuccess('密码已修改，请重新登录。');
      clearSessionQueries();
      await navigate({ to: '/login', search: { returnTo: '/personal/security' } });
    } catch (error) {
      setFormError(errorMessage(error));
      reset(values);
    }
  });

  return (
    <Page>
      <PageHeader title="安全与会话" />

      <PageSection title="修改密码" description="修改后会撤销全部登录会话，需要用新密码重新登录。">
        <form
          aria-label="修改密码"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup className="max-w-md gap-5">
            <Field data-disabled={change.isPending}>
              <FieldLabel htmlFor="security-current-password">当前密码</FieldLabel>
              <Input
                id="security-current-password"
                type="password"
                autoComplete="current-password"
                disabled={change.isPending}
                {...register('currentPassword')}
              />
              <FieldError>{formState.errors.currentPassword?.message}</FieldError>
            </Field>
            <Field
              data-disabled={change.isPending}
              data-invalid={formState.errors.newPassword ? true : undefined}
            >
              <FieldLabel htmlFor="security-new-password">新密码</FieldLabel>
              <Input
                id="security-new-password"
                type="password"
                autoComplete="new-password"
                disabled={change.isPending}
                aria-invalid={formState.errors.newPassword ? true : undefined}
                {...register('newPassword')}
              />
              <FieldError>{formState.errors.newPassword?.message}</FieldError>
            </Field>
            <Field
              data-disabled={change.isPending}
              data-invalid={formState.errors.confirmPassword ? true : undefined}
            >
              <FieldLabel htmlFor="security-confirm-password">确认新密码</FieldLabel>
              <Input
                id="security-confirm-password"
                type="password"
                autoComplete="new-password"
                disabled={change.isPending}
                aria-invalid={formState.errors.confirmPassword ? true : undefined}
                {...register('confirmPassword')}
              />
              <FieldError>{formState.errors.confirmPassword?.message}</FieldError>
            </Field>
            {formError ? <FieldError>{formError}</FieldError> : null}
            <div className="flex justify-end">
              <Button type="submit" disabled={change.isPending} aria-busy={change.isPending}>
                <KeyRound data-icon="inline-start" aria-hidden="true" />
                {change.isPending ? '正在修改…' : '修改密码'}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </PageSection>

      <SessionSection onRelogin={relogin} />
    </Page>
  );
}

function SessionSection({ onRelogin }: { onRelogin: () => Promise<void> }) {
  const me = useQuery(meQuery);
  const sessions = usePersonalSessions();
  const revoke = useRevokePersonalSession();
  const [target, setTarget] = useState<PersonalSession | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const freshness = isFreshnessError(sessions.error) || isFreshnessError(revoke.error);

  if (sessions.isPending) {
    return (
      <PageSection title="登录会话">
        <LoadingState rows={3} />
      </PageSection>
    );
  }

  if (freshness) {
    return (
      <PageSection title="登录会话">
        <PageNote
          title="请重新登录后管理登录会话"
          description="当前登录状态早于安全操作要求的时限，会话列表暂不可用。"
          action={
            <Button variant="outline" size="sm" onClick={() => void onRelogin()}>
              重新登录
            </Button>
          }
        />
      </PageSection>
    );
  }

  if (sessions.isError || sessions.data === undefined) {
    return (
      <PageSection title="登录会话">
        <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
      </PageSection>
    );
  }

  const currentName = me.data?.authenticated ? me.data.user.name || me.data.user.username : '';

  return (
    <PageSection
      title="登录会话"
      {...(currentName ? { description: `当前账户：${currentName}` } : {})}
      actions={
        <Button variant="outline" size="sm" onClick={() => void sessions.refetch()}>
          刷新
        </Button>
      }
    >
      {actionError ? (
        <div role="alert" className="text-sm text-danger">
          {actionError}
        </div>
      ) : null}
      <ul className="divide-y border-y">
        {sessions.data.items.map((session) => (
          <li key={session.id}>
            <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="min-w-0 break-words text-sm font-medium text-fg"
                    title={session.userAgent ?? undefined}
                  >
                    {session.userAgent || '未知设备'}
                  </span>
                  {session.current ? <StatusBadge tone="success">当前会话</StatusBadge> : null}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span title={session.createdAt}>登录 {formatDateTime(session.createdAt)}</span>
                  <span title={session.updatedAt}>
                    最近活动 {formatDateTime(session.updatedAt)}
                  </span>
                  <span title={session.expiresAt}>到期 {formatDateTime(session.expiresAt)}</span>
                  <span>{session.ipAddress || '未记录 IP'}</span>
                </div>
              </div>
              {session.current ? (
                <span className="text-xs text-muted-foreground">修改密码可撤销全部会话</span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={revoke.isPending}
                  aria-label={`撤销 ${formatDateTime(session.createdAt)} 的会话`}
                  onClick={() => {
                    setActionError(null);
                    setTarget(session);
                  }}
                >
                  撤销
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title="撤销这次登录会话？"
        description={
          target
            ? `将让 ${target.userAgent || '该设备'} 在 ${formatDateTime(target.createdAt)} 的登录立即失效。`
            : ''
        }
        confirmLabel="撤销会话"
        confirmDisabled={revoke.isPending}
        onConfirm={async () => {
          if (!target) return;
          try {
            await revoke.mutateAsync(target.id);
            setTarget(null);
            toastSuccess('会话已撤销');
          } catch (error) {
            setActionError(errorMessage(error));
          }
        }}
      />
    </PageSection>
  );
}
