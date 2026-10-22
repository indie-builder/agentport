import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Brand } from '../components/brand.js';
import { Page, PageHeader } from '../components/page.js';
import { Button } from '../components/ui/button.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { api, errorMessage } from '../lib/api.js';
import { queryClient } from '../lib/queries.js';

export function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const login = useMutation({
    mutationFn: () => api.login(username, password),
    onSuccess: async () => {
      // 必须等 /me 刷新完成，否则 AppShell 会拿着旧的未登录缓存把人弹回登录页。
      await queryClient.refetchQueries({ queryKey: ['me'] });
      await navigate({ to: '/' });
    },
    onError: (cause) => setError(errorMessage(cause)),
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
            if (login.isPending || !username || !password) return;
            setError(null);
            login.mutate();
          }}
        >
          <FieldGroup>
            <Field data-disabled={login.isPending}>
              <FieldLabel htmlFor="username">用户名</FieldLabel>
              <Input
                id="username"
                autoComplete="username"
                value={username}
                disabled={login.isPending}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
            <Field data-disabled={login.isPending}>
              <FieldLabel htmlFor="password">密码</FieldLabel>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                disabled={login.isPending}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <FieldError id="login-error" className="break-words">
              {error ?? undefined}
            </FieldError>
            <Button
              type="submit"
              className="w-full"
              disabled={login.isPending || !password || !username}
              aria-busy={login.isPending}
            >
              {login.isPending ? '登录中…' : '登录'}
            </Button>
          </FieldGroup>
        </form>
      </Page>
    </main>
  );
}
