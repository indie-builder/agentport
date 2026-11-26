const INTERNAL_ORIGIN = 'http://app.invalid';
const MAX_INTERNAL_PATH_LENGTH = 2048;

/**
 * 站内路径的信任边界：只接受应用内的绝对路径。
 * 先拒绝反斜杠、空白与超长值，再用 URL 解析兜底挡住 `/\evil`、控制字符被规范化成 `//evil` 等绕法。
 */
export function safeInternalPath(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > MAX_INTERNAL_PATH_LENGTH ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\s]/.test(value)
  )
    return undefined;
  let url: URL;
  try {
    url = new URL(value, INTERNAL_ORIGIN);
  } catch {
    return undefined;
  }
  if (url.origin !== INTERNAL_ORIGIN || /^\/login\/?$/.test(url.pathname)) return undefined;
  if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function resolveReturnTo(value: unknown): string {
  return safeInternalPath(value) ?? '/';
}

export function loginPath(returnTo: unknown, reason?: 'expired'): string {
  const params = new URLSearchParams({ returnTo: resolveReturnTo(returnTo) });
  if (reason !== undefined) params.set('reason', reason);
  return `/login?${params.toString()}`;
}
