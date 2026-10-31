import { type PersonalSession, passwordSchema } from '@agentport/shared';
import { useNavigate } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../components/motion-collapsible.js';
import { Page, PageHeader, PageNote } from '../components/page.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { ApiError, errorMessage } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { formatDateTime } from '../lib/format.js';
import {
  clearSessionQueries,
  logoutAccount,
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

// 与个人资料一致：短字段 448px，横向标签列 96px。
const FIELD_VALUE = 'flex w-full min-w-0 max-w-[448px] flex-1 flex-col gap-1.5';

function isFreshnessError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** 当前会话固定在最前作为比对锚点，其余按最近活动倒序。 */
function byActivity(a: PersonalSession, b: PersonalSession): number {
  if (a.current !== b.current) return a.current ? -1 : 1;
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

export function PersonalSecurityPage() {
  const navigate = useNavigate();
  const change = useChangePassword();
  const [passwordOpen, setPasswordOpen] = useState(false);
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
      <Collapsible
        open={passwordOpen}
        onOpenChange={(next) => {
          // 改密请求进行中不允许收起，避免表单连同错误一起消失。
          if (change.isPending) return;
          setPasswordOpen(next);
        }}
        className="flex min-w-0 flex-col gap-6"
      >
        <PageHeader
          title="账号安全"
          actions={
            <CollapsibleTrigger disabled={change.isPending} render={<Button variant="outline" />}>
              {passwordOpen ? '收起' : '修改密码'}
            </CollapsibleTrigger>
          }
        />

        <CollapsibleContent animated>
          <section className="flex w-full min-w-0 flex-col gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="text-base font-medium text-fg">修改密码</h2>
              <p className="min-w-0 break-words text-sm text-muted-foreground">
                修改后会撤销全部登录会话，需要用新密码重新登录。
              </p>
            </div>
            <form
              aria-label="修改密码"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <FieldGroup className="gap-4">
                <Field
                  orientation="horizontal"
                  className="items-start gap-x-4"
                  data-disabled={change.isPending}
                >
                  <FieldContent className="w-24 flex-none pt-2">
                    <FieldLabel htmlFor="security-current-password">当前密码</FieldLabel>
                  </FieldContent>
                  <div className={FIELD_VALUE}>
                    <Input
                      id="security-current-password"
                      type="password"
                      autoComplete="current-password"
                      autoFocus
                      disabled={change.isPending}
                      {...register('currentPassword')}
                    />
                    <FieldError>{formState.errors.currentPassword?.message}</FieldError>
                  </div>
                </Field>
                <Field
                  orientation="horizontal"
                  className="items-start gap-x-4"
                  data-disabled={change.isPending}
                  data-invalid={formState.errors.newPassword ? true : undefined}
                >
                  <FieldContent className="w-24 flex-none pt-2">
                    <FieldLabel htmlFor="security-new-password">新密码</FieldLabel>
                  </FieldContent>
                  <div className={FIELD_VALUE}>
                    <Input
                      id="security-new-password"
                      type="password"
                      autoComplete="new-password"
                      disabled={change.isPending}
                      aria-invalid={formState.errors.newPassword ? true : undefined}
                      {...register('newPassword')}
                    />
                    <FieldError>{formState.errors.newPassword?.message}</FieldError>
                  </div>
                </Field>
                <Field
                  orientation="horizontal"
                  className="items-start gap-x-4"
                  data-disabled={change.isPending}
                  data-invalid={formState.errors.confirmPassword ? true : undefined}
                >
                  <FieldContent className="w-24 flex-none pt-2">
                    <FieldLabel htmlFor="security-confirm-password">确认新密码</FieldLabel>
                  </FieldContent>
                  <div className={FIELD_VALUE}>
                    <Input
                      id="security-confirm-password"
                      type="password"
                      autoComplete="new-password"
                      disabled={change.isPending}
                      aria-invalid={formState.errors.confirmPassword ? true : undefined}
                      {...register('confirmPassword')}
                    />
                    <FieldError>{formState.errors.confirmPassword?.message}</FieldError>
                  </div>
                </Field>
                {formError ? <FieldError>{formError}</FieldError> : null}
                <div className="ml-28 flex max-w-[448px] justify-end">
                  <Button type="submit" disabled={change.isPending} aria-busy={change.isPending}>
                    <KeyRound data-icon="inline-start" aria-hidden="true" />
                    {change.isPending ? '正在修改…' : '保存新密码'}
                  </Button>
                </div>
              </FieldGroup>
            </form>
          </section>
        </CollapsibleContent>

        <SessionSection onRelogin={relogin} divided={passwordOpen} />
      </Collapsible>
    </Page>
  );
}

function SessionSection({
  onRelogin,
  divided,
}: {
  onRelogin: () => Promise<void>;
  divided: boolean;
}) {
  const sessions = usePersonalSessions();
  const revoke = useRevokePersonalSession();
  const [target, setTarget] = useState<PersonalSession | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  // 查询或撤销任一处 403 都表示登录不够新。撤销错误仍留在弹层里，不能因本分支卸载确认框。
  const freshness = isFreshnessError(sessions.error) || isFreshnessError(revoke.error);

  let body: ReactNode;
  if (sessions.isPending) {
    body = <LoadingState rows={3} />;
  } else if (freshness) {
    body = (
      <PageNote
        title="请重新登录后管理登录会话"
        description="当前登录状态早于安全操作要求的时限，会话列表暂不可用。"
        action={
          <Button variant="outline" size="sm" onClick={() => void onRelogin()}>
            重新登录
          </Button>
        }
      />
    );
  } else if (sessions.isError || sessions.data === undefined) {
    body = <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />;
  } else {
    const ordered = [...sessions.data.items].sort(byActivity);
    const current = ordered.filter((session) => session.current);
    const others = ordered.filter((session) => !session.current);
    body = (
      <div className="flex min-w-0 flex-col gap-6">
        {current.length > 0 ? (
          <SessionGroup
            title="当前会话"
            sessions={current}
            revoke={revoke}
            onRevoke={(session) => {
              setModalError(null);
              setTarget(session);
            }}
            action={
              <Button variant="outline" size="sm" onClick={() => void sessions.refetch()}>
                刷新
              </Button>
            }
          />
        ) : null}
        {others.length > 0 ? (
          <SessionGroup
            title="其他会话"
            sessions={others}
            revoke={revoke}
            onRevoke={(session) => {
              setModalError(null);
              setTarget(session);
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <section className={cn('flex min-w-0 flex-col gap-4', divided && 'border-t pt-5')}>
      {body}

      <ConfirmDialog
        open={target !== null}
        onClose={() => {
          setTarget(null);
          setModalError(null);
        }}
        title="撤销这次登录会话？"
        description={
          target
            ? `撤销后，最近活动为 ${formatDateTime(target.updatedAt)}、IP ${target.ipAddress || '未记录'} 的登录会立即失效。`
            : ''
        }
        confirmLabel="撤销会话"
        confirmDisabled={revoke.isPending}
        onConfirm={async () => {
          if (!target) return;
          try {
            await revoke.mutateAsync(target.id);
            setTarget(null);
            setModalError(null);
            toastSuccess('会话已撤销');
          } catch (error) {
            setModalError(
              isFreshnessError(error)
                ? '当前登录状态已过期，请重新登录后再撤销这次会话。'
                : errorMessage(error),
            );
            // 继续抛出让 ConfirmDialog 保持弹层，错误已在本弹层内展示。
            throw error;
          }
        }}
      >
        {modalError ? <FieldError>{modalError}</FieldError> : null}
        {freshness ? (
          <div>
            <Button variant="outline" size="sm" onClick={() => void onRelogin()}>
              重新登录
            </Button>
          </div>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}

function SessionGroup({
  title,
  sessions,
  revoke,
  onRevoke,
  action,
}: {
  title: string;
  sessions: PersonalSession[];
  revoke: ReturnType<typeof useRevokePersonalSession>;
  onRevoke: (session: PersonalSession) => void;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center justify-between gap-4">
        <h2 className="text-base font-medium text-fg">{title}</h2>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      <ul className="mt-3 divide-y border-y">
        {sessions.map((session) => (
          <li key={session.id}>
            <Collapsible>
              <div className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-base text-fg">
                    最近活动 {formatDateTime(session.updatedAt)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {session.ipAddress || '未记录 IP'}
                  </span>
                </div>
                <CollapsibleTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="group shrink-0 text-muted-foreground"
                    />
                  }
                >
                  会话详情
                </CollapsibleTrigger>
                {session.current ? null : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={revoke.isPending}
                    aria-label={`撤销 ${formatDateTime(session.updatedAt)} 的会话`}
                    onClick={() => onRevoke(session)}
                  >
                    撤销
                  </Button>
                )}
              </div>
              <CollapsibleContent animated>
                <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-4 gap-y-1 pb-3 text-xs text-muted-foreground">
                  <dt>用户代理</dt>
                  <dd className="min-w-0 break-all">{session.userAgent || '未记录用户代理'}</dd>
                  <dt>登录</dt>
                  <dd>{formatDateTime(session.createdAt)}</dd>
                  <dt>到期</dt>
                  <dd>{formatDateTime(session.expiresAt)}</dd>
                </dl>
              </CollapsibleContent>
            </Collapsible>
          </li>
        ))}
      </ul>
    </div>
  );
}
