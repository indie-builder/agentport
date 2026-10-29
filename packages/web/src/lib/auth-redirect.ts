const INTERNAL_ORIGIN = 'http://app.invalid';

/**
 * 登录回跳的信任边界：只接受应用内路径。
 * 用 URL 解析而不是字符串前缀判断，才能挡住 `/\evil`、控制字符被浏览器规范化成 `//evil` 等绕法。
 */
export function safeReturnTo(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/')) return undefined;
  let url: URL;
  try {
    url = new URL(value, INTERNAL_ORIGIN);
  } catch {
    // 反斜杠会触发浏览器规范化（如 `/\evil:bad`），畸形地址直接当作不可信。
    return undefined;
  }
  if (url.origin !== INTERNAL_ORIGIN || /^\/login\/?$/.test(url.pathname)) return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function resolveReturnTo(value: unknown): string {
  return safeReturnTo(value) ?? '/';
}

/** 会话失效时把当前 pathname + search + hash 交给登录页，登录后原样回去。 */
export function loginPath(returnTo: unknown, reason?: 'expired'): string {
  const params = new URLSearchParams({ returnTo: resolveReturnTo(returnTo) });
  if (reason !== undefined) params.set('reason', reason);
  return `/login?${params.toString()}`;
}
