import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Activity, FileCode2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Brand } from '../components/brand.js';
import { Button } from '../components/ui/button.js';
import { FieldError, Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { api, errorMessage } from '../lib/api.js';
import { queryClient } from '../lib/queries.js';

/** 登录页左侧说明平台做什么；三条事实都能在界面里验证，不是营销话术。 */
const facts = [
  {
    icon: FileCode2,
    title: '配置即文件',
    body: '每个智能体渲染成 CLAUDE.md 与 .claude/agents，任何兼容 Host 都能直接读。',
  },
  {
    icon: Activity,
    title: '运行可追溯',
    body: '每次调用都记录工具、参数、耗时与成本，失败给出可执行的下一步。',
  },
  {
    icon: ShieldCheck,
    title: '默认安全',
    body: '内置工具默认禁用，密钥不进沙箱，工具按需审批。',
  },
] as const;

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
    <div className="grid min-h-screen bg-canvas lg:grid-cols-[minmax(0,1fr)_minmax(380px,0.9fr)]">
      {/* 左侧：平台事实。窄屏隐藏，登录本身不被说明文字挤走。 */}
      <section className="hidden flex-col justify-center border-r border-line bg-panel px-10 py-10 lg:flex">
        <div className="max-w-md">
          <p className="text-[28px] font-semibold leading-[1.25] tracking-tight text-fg">
            让智能体以可预测的节奏运行
          </p>
          <p className="mt-3 text-base leading-relaxed text-muted">
            接入 MCP Server，用文件定义智能体，在沙盒里运行并观察每一步。
          </p>
          <dl className="mt-8 space-y-5">
            {facts.map(({ icon: Icon, title, body }) => (
              <div key={title} className="flex gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-icon border border-line bg-surface text-fg">
                  <Icon className="size-3.5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <dt className="text-base font-medium text-fg">{title}</dt>
                  <dd className="mt-0.5 text-xs leading-relaxed text-muted">{body}</dd>
                </div>
              </div>
            ))}
          </dl>
        </div>

        <p className="mt-10 text-2xs text-subtle">配置变更、连接测试与对话都会记入审计。</p>
      </section>

      {/* 右侧：表单。视觉上是一张纸，不是悬浮卡片。 */}
      <section className="flex items-center justify-center border-l border-line bg-surface px-6 py-12">
        <div className="w-full max-w-[340px]">
          <div className="mb-8 lg:hidden">
            <Brand />
          </div>

          <h1 className="text-[20px] font-semibold tracking-tight text-fg">登录</h1>
          <p className="mt-1 text-sm text-muted">使用管理员账号进入控制台。</p>

          <form
            className="mt-6 space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              login.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="username">用户名</Label>
              <Input
                id="username"
                autoComplete="username"
                value={username}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'login-error' : undefined}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
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

          <p className="mt-6 text-2xs leading-relaxed text-subtle">
            单管理员部署。会话以 HttpOnly Cookie 保存在浏览器，退出后立即失效。
          </p>
        </div>
      </section>
    </div>
  );
}
