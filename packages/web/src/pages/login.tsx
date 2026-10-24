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
    document.title = 'PACE';
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
    <main className="flex min-h-dvh min-w-0 items-center justify-center bg-surface px-6 py-10">
      <Page className="w-full max-w-xs gap-8">
        <PageHeader title="进入 PACE" className="sr-only" />
        <Brand className="h-24 self-center" />
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
          <FieldGroup className="gap-5">
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
              className="h-11 w-full"
              disabled={login.isPending}
              aria-busy={login.isPending}
            >
              {login.isPending ? '正在进入…' : error ? '重试' : '进入工作台'}
            </Button>
          </FieldGroup>
        </form>
      </Page>
    </main>
  );
}
