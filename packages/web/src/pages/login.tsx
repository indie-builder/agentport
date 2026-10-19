import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '../components/ui/button.js';
import { FieldError, Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
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
    <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex items-end gap-[2px]" aria-hidden="true">
            {[4, 8, 12, 8].map((height, index) => (
              <span
                key={height}
                className={
                  index === 2 ? 'w-[3px] rounded-sm bg-accent' : 'w-[3px] rounded-sm bg-line-strong'
                }
                style={{ height }}
              />
            ))}
          </span>
          <span className="text-[13px] font-semibold tracking-[0.08em] text-fg">PACE</span>
        </div>
        <form
          className="space-y-3 rounded-xl border border-line bg-surface p-5 shadow-xl shadow-black/20"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            login.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="username">用户名</Label>
            <Input
              id="username"
              autoComplete="username"
              value={username}
              aria-invalid={Boolean(error)}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'login-error' : undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
            <FieldError id="login-error">{error ?? undefined}</FieldError>
          </div>
          <Button
            type="submit"
            className="w-full"
            disabled={login.isPending || !password || !username}
            aria-busy={login.isPending}
          >
            {login.isPending ? '登录中…' : '登录'}
          </Button>
        </form>
        <p className="mt-4 text-center text-[11px] text-subtle">
          配置变更、连接测试与对话都会记入审计。
        </p>
      </div>
    </div>
  );
}
