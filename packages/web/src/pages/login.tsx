import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { animateBrand, Brand } from '../components/brand.js';
import { Page, PageHeader } from '../components/page.js';
import { Button } from '../components/ui/button.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { ApiError, api, errorMessage } from '../lib/api.js';
import { resolveReturnTo } from '../lib/auth-redirect.js';
import { meQuery, queryClient } from '../lib/queries.js';
import { useZodForm } from '../lib/use-zod-form.js';

const loginSchema = z.object({
  username: z.string().min(1, '请填写用户名。'),
  password: z.string().min(1, '请填写密码。'),
});

export function LoginPage() {
  const navigate = useNavigate();
  const { returnTo, reason } = useSearch({ from: '/login' });
  // 只接受站内路径；外部地址与登录页自身都回到首页。
  const target = resolveReturnTo(returnTo);
  // 非阻塞复用 /me 缓存：表单立即可用，只有这次挂载后的检查确认已登录才回跳。
  const me = useQuery({ ...meQuery, staleTime: 0 });
  const checkedSession = useRef(false);
  const authenticated = me.isSuccess && me.data.authenticated;
  useEffect(() => {
    if (checkedSession.current || !me.isFetchedAfterMount) return;
    checkedSession.current = true;
    // 旧缓存里的 authenticated 不算数；检查失败就留在表单，避免登录页与目标页来回弹。
    if (authenticated) void navigate({ href: target, replace: true });
  }, [authenticated, me.isFetchedAfterMount, navigate, target]);
  // 过期原因只在 401 跳转时出现；冻结成一次提示，随后的地址清理不再重复显示。
  const [expired] = useState(reason === 'expired');
  useEffect(() => {
    if (reason !== 'expired') return;
    // 清掉 reason，刷新或再次打开登录页时不再重复提示，同时保留 returnTo。
    void navigate({ to: '/login', search: { returnTo }, replace: true });
  }, [reason, returnTo, navigate]);
  useEffect(() => {
    document.title = 'PACE';
  }, []);
  const [error, setError] = useState<string | null>(null);
  const describedBy =
    [expired ? 'login-expired' : null, error ? 'login-error' : null].filter(Boolean).join(' ') ||
    undefined;
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useZodForm(loginSchema, { defaultValues: { username: 'admin', password: '' } });

  const login = useMutation({
    mutationFn: ({ username, password }: z.infer<typeof loginSchema>) =>
      api.login(username, password),
    onSuccess: async () => {
      // 必须等 /me 刷新完成，否则 AppShell 会拿着旧的未登录缓存把人弹回登录页。
      await queryClient.refetchQueries({ queryKey: ['me'] });
      await navigate({ href: target, replace: true });
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError && cause.status === 401
          ? '用户名或密码错误，请检查后重试。'
          : errorMessage(cause),
      ),
  });

  return (
    <main className="flex min-h-dvh min-w-0 items-center justify-center bg-surface px-6 py-10">
      <Page className="w-full max-w-xs gap-8">
        <PageHeader title="进入 PACE" className="sr-only" />
        <Button
          type="button"
          variant="plain"
          aria-label="切换 PACE Logo"
          className="h-auto self-center p-0"
          onClick={animateBrand}
        >
          <Brand className="h-24 self-center" />
        </Button>
        <form
          aria-label="登录"
          aria-busy={login.isPending}
          aria-describedby={describedBy}
          noValidate
          onSubmit={handleSubmit((values) => {
            if (login.isPending) return;
            setError(null);
            login.mutate(values);
          })}
        >
          <FieldGroup className="gap-5">
            {expired ? (
              <p id="login-expired" role="status" className="text-sm text-muted-foreground">
                登录已过期，请重新登录。
              </p>
            ) : null}
            <Field data-disabled={login.isPending} data-invalid={Boolean(errors.username)}>
              <FieldLabel htmlFor="username">用户名</FieldLabel>
              <Input
                id="username"
                className="h-11"
                required
                autoComplete="username"
                disabled={login.isPending}
                aria-invalid={Boolean(errors.username)}
                aria-describedby={errors.username ? 'username-error' : undefined}
                {...register('username')}
              />
              <FieldError id="username-error">{errors.username?.message}</FieldError>
            </Field>
            <Field data-disabled={login.isPending} data-invalid={Boolean(errors.password)}>
              <FieldLabel htmlFor="password">密码</FieldLabel>
              <Input
                id="password"
                className="h-11"
                required
                type="password"
                autoComplete="current-password"
                autoFocus
                disabled={login.isPending}
                aria-invalid={Boolean(errors.password)}
                aria-describedby={errors.password ? 'password-error' : undefined}
                {...register('password')}
              />
              <FieldError id="password-error">{errors.password?.message}</FieldError>
            </Field>
            <FieldError id="login-error" className="break-words">
              {error ?? undefined}
            </FieldError>
            <Button
              type="submit"
              variant="solid"
              className="h-11 w-full"
              disabled={login.isPending}
              aria-busy={login.isPending}
            >
              {login.isPending ? '正在登录…' : error ? '重试' : '登录'}
            </Button>
          </FieldGroup>
        </form>
      </Page>
    </main>
  );
}
