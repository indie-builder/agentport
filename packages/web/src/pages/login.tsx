import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { Brand } from '../components/brand.js';
import { Page, PageHeader } from '../components/page.js';
import { Button } from '../components/ui/button.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { ApiError, api, errorMessage } from '../lib/api.js';
import { queryClient } from '../lib/queries.js';
import { useZodForm } from '../lib/use-zod-form.js';

const loginSchema = z.object({
  username: z.string().min(1, '请填写用户名。'),
  password: z.string().min(1, '请填写密码。'),
});

export function LoginPage() {
  const navigate = useNavigate();
  useEffect(() => {
    document.title = '登录 · 控制台';
  }, []);
  const [error, setError] = useState<string | null>(null);
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
      await navigate({ to: '/' });
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError && cause.status === 401
          ? '用户名或密码错误，请检查后重试。'
          : errorMessage(cause),
      ),
  });

  return (
    <main className="app-canvas-wash flex min-h-dvh min-w-0 items-center justify-center p-3">
      <Page className="w-full max-w-sm rounded-shell border border-line bg-surface p-5">
        <Brand />
        <PageHeader title="登录" />
        <form
          aria-label="登录"
          aria-busy={login.isPending}
          aria-describedby={error ? 'login-error' : undefined}
          noValidate
          onSubmit={handleSubmit((values) => {
            if (login.isPending) return;
            setError(null);
            login.mutate(values);
          })}
        >
          <FieldGroup>
            <Field data-disabled={login.isPending} data-invalid={Boolean(errors.username)}>
              <FieldLabel htmlFor="username">用户名</FieldLabel>
              <Input
                id="username"
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
              className="w-full"
              disabled={login.isPending}
              aria-busy={login.isPending}
            >
              {login.isPending ? '登录中…' : error ? '重试登录' : '登录'}
            </Button>
          </FieldGroup>
        </form>
      </Page>
    </main>
  );
}
