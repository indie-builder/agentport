import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Brand } from '../components/brand.js';
import { Page, PageHeader } from '../components/page.js';
import { Button } from '../components/ui/button.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { ApiError, api, errorMessage } from '../lib/api.js';
import { queryClient } from '../lib/queries.js';

export function LoginPage() {
  const navigate = useNavigate();
  useEffect(() => {
    document.title = '登录 · 控制台';
  }, []);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<{
    username?: string | undefined;
    password?: string | undefined;
  }>({});

  const login = useMutation({
    mutationFn: () => api.login(username, password),
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
    <main className="flex min-h-dvh min-w-0 items-center justify-center bg-canvas p-3">
      <Page className="w-full max-w-sm rounded-shell border border-line bg-surface p-5">
        <Brand />
        <PageHeader title="登录" />
        <form
          aria-label="登录"
          aria-busy={login.isPending}
          aria-describedby={error ? 'login-error' : undefined}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (login.isPending) return;
            const issues = {
              username: username ? undefined : '请填写用户名。',
              password: password ? undefined : '请填写密码。',
            };
            setErrors(issues);
            setError(null);
            if (issues.username || issues.password) {
              event.currentTarget
                .querySelector<HTMLInputElement>(issues.username ? '#username' : '#password')
                ?.focus();
              return;
            }
            login.mutate();
          }}
        >
          <FieldGroup>
            <Field data-disabled={login.isPending} data-invalid={Boolean(errors.username)}>
              <FieldLabel htmlFor="username">用户名</FieldLabel>
              <Input
                id="username"
                required
                autoComplete="username"
                value={username}
                disabled={login.isPending}
                aria-invalid={Boolean(errors.username)}
                aria-describedby={errors.username ? 'username-error' : undefined}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setErrors((previous) => ({ ...previous, username: undefined }));
                }}
              />
              <FieldError id="username-error">{errors.username}</FieldError>
            </Field>
            <Field data-disabled={login.isPending} data-invalid={Boolean(errors.password)}>
              <FieldLabel htmlFor="password">密码</FieldLabel>
              <Input
                id="password"
                required
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                disabled={login.isPending}
                aria-invalid={Boolean(errors.password)}
                aria-describedby={errors.password ? 'password-error' : undefined}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setErrors((previous) => ({ ...previous, password: undefined }));
                }}
              />
              <FieldError id="password-error">{errors.password}</FieldError>
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
