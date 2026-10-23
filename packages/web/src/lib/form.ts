import { useBlocker } from '@tanstack/react-router';
import type { z } from 'zod';

export function useFormBlocker(dirty: boolean, pending: boolean) {
  const blocker = useBlocker({
    shouldBlockFn: () => dirty || pending,
    withResolver: true,
    enableBeforeUnload: dirty || pending,
  });
  return {
    ...blocker,
    proceed: () => {
      if (!pending) blocker.proceed?.();
    },
  };
}

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
      if (issue.origin === 'string') {
        return typeof issue.minimum === 'number' && issue.minimum > 1
          ? `至少需要 ${issue.minimum} 个字符，请补充后再保存`
          : '不能为空，请填写后再保存';
      }
      if (issue.origin === 'array') return `至少需要 ${issue.minimum} 项，请补充后再保存`;
      if (['number', 'int', 'bigint'].includes(issue.origin)) {
        return `必须${issue.inclusive ? '大于或等于' : '大于'} ${issue.minimum}，请调整后再保存`;
      }
      return '请检查这项内容后重试';
    case 'too_big':
      if (issue.origin === 'string') return `最多 ${String(issue.maximum)} 个字符，请精简后再保存`;
      if (issue.origin === 'array') return `最多 ${issue.maximum} 项，请减少后再保存`;
      if (['number', 'int', 'bigint'].includes(issue.origin)) {
        return `必须${issue.inclusive ? '小于或等于' : '小于'} ${issue.maximum}，请调整后再保存`;
      }
      return '请检查这项内容后重试';
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
