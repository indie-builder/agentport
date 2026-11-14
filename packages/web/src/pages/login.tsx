import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { animateBrand, Brand } from '../components/brand.js';
import { Button } from '../components/ui/button.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { ApiError, api, errorMessage } from '../lib/api.js';
import { resolveReturnTo } from '../lib/auth-redirect.js';
import { clearSessionQueries, meQuery, queryClient } from '../lib/queries.js';
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
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const describedBy =
    [expired ? 'login-expired' : null, error ? 'login-error' : null].filter(Boolean).join(' ') ||
    undefined;
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useZodForm(loginSchema, { defaultValues: { username: '', password: '' } });

  const login = useMutation({
    mutationFn: ({ username, password }: z.infer<typeof loginSchema>) =>
      api.login(username, password),
    onSuccess: async () => {
      // 换账户后不能复用前一个人的列表与正文；先清空再取当前身份。
      clearSessionQueries();
      // refetchQueries 只刷新缓存里已有的查询，清空后不会发请求；必须显式 fetch 并等它完成，
      // 否则会带着空的 /me 缓存导航，AppShell 再把新会话弹回登录页。
      let identity: Awaited<ReturnType<typeof api.me>>;
      try {
        identity = await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
      } catch (cause) {
        // 登录已成功但身份没取到：留在表单让用户重试，不带着空缓存导航。
        setError(errorMessage(cause));
        return;
      }
      if (!identity.authenticated) {
        setError('登录状态确认失败，请重试。');
        return;
      }
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
    <main className="min-h-dvh min-w-0 bg-surface">
      <div className="grid min-h-dvh grid-cols-2">
        <aside className="relative flex flex-col justify-between overflow-hidden border-r border-line bg-sidebar p-12">
          <Button
            type="button"
            variant="plain"
            aria-label="切换 PACE Logo"
            className="h-auto self-start p-0"
            onClick={animateBrand}
          >
            <Brand className="h-9" />
          </Button>
          <div className="flex flex-1 items-center justify-center py-8">
            <div className="w-[86%] overflow-hidden rounded-xl border border-line bg-surface shadow-panel">
              <img
                src="/brand/product-showcase.png"
                alt="PACE 工作台界面预览"
                className="block w-full"
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">PACE · 内部智能体工作台</p>
        </aside>
        <section className="flex min-h-dvh min-w-0 items-center justify-center px-6 py-12">
          <div className="w-full min-w-0 max-w-sm">
            <h1 className="text-2xl font-semibold tracking-tight text-fg">登录 PACE</h1>
            <p className="mt-2 text-sm text-muted-foreground">使用账号登录，继续你的智能体工作。</p>
            <form
              className="mt-8"
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
                    autoFocus
                    disabled={login.isPending}
                    aria-invalid={Boolean(errors.username)}
                    aria-describedby={errors.username ? 'username-error' : undefined}
                    {...register('username')}
                  />
                  <FieldError id="username-error">{errors.username?.message}</FieldError>
                </Field>
                <Field data-disabled={login.isPending} data-invalid={Boolean(errors.password)}>
                  <FieldLabel htmlFor="password">密码</FieldLabel>
                  <div>
                    <div className="relative">
                      <Input
                        id="password"
                        className="h-11 pr-10"
                        required
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        disabled={login.isPending}
                        aria-invalid={Boolean(errors.password)}
                        aria-describedby={errors.password ? 'password-error' : undefined}
                        onKeyDown={(event) => setCapsLock(event.getModifierState('CapsLock'))}
                        onKeyUp={(event) => setCapsLock(event.getModifierState('CapsLock'))}
                        {...register('password')}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-0 text-muted-foreground"
                        aria-label={showPassword ? '隐藏密码' : '显示密码'}
                        aria-pressed={showPassword}
                        disabled={login.isPending}
                        onClick={() => setShowPassword((visible) => !visible)}
                      >
                        {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </Button>
                    </div>
                    {capsLock ? (
                      <p className="mt-1.5 text-xs text-muted-foreground">大写锁定已开启</p>
                    ) : null}
                  </div>
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
          </div>
        </section>
      </div>
    </main>
  );
}
