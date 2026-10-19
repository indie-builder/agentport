import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { api, errorMessage } from '../lib/api.js';
import { queryClient } from '../lib/queries.js';

export function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api.login(username, password),
    onSuccess: async () => {
      // 必须等 /me 刷新完成，否则 AppShell 会拿着旧的未登录缓存把人弹回登录页。
      await queryClient.refetchQueries({ queryKey: ['me'] });
      await navigate({ to: '/' });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <div className="size-2 rounded-full bg-emerald-500" />
          <span className="text-sm font-semibold tracking-tight text-zinc-100">Agentport</span>
        </div>
        <form
          className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="username">用户名</Label>
            <Input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
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
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" className="w-full" disabled={login.isPending || !password}>
            {login.isPending ? '登录中…' : '登录'}
          </Button>
        </form>
      </div>
    </div>
  );
}
