import type { z } from 'zod';

/**
 * 把 zod 的英文默认文案换成可执行的中文：说明哪里不对，以及该怎么改。
 * 每个字段只保留第一条错误，避免同一输入下面堆一串提示。
 */
export function fieldErrors(issues: z.ZodIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || 'form';
    out[key] ??= messageOf(issue);
  }
  return out;
}

function messageOf(issue: z.ZodIssue): string {
  switch (issue.code) {
    case 'too_small':
      return typeof issue.minimum === 'number' && issue.minimum > 1
        ? `至少需要 ${issue.minimum} 个字符，请补充后再保存`
        : '不能为空，请填写后再保存';
    case 'too_big':
      return `最多 ${String(issue.maximum)} 个字符，请精简后再保存`;
    case 'invalid_format':
      return issue.format === 'url'
        ? '请填写完整地址，例如 https://example.com'
        : '格式不正确，请检查后重新填写';
    case 'invalid_type':
      return '请填写有效内容';
    default:
      return '请检查这项内容后重试';
  }
}
