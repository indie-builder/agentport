import { useBlocker } from '@tanstack/react-router';
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';
import type { z } from 'zod';
import { ApiError } from './orpc.js';

export function useFormBlocker(
  dirty: boolean,
  pending: boolean,
  options?: { ignoreSamePath?: boolean },
) {
  const blocker = useBlocker({
    shouldBlockFn: (args) => {
      if (options?.ignoreSamePath && args && args.current.pathname === args.next.pathname) {
        return false;
      }
      return dirty || pending;
    },
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

const WRAPPER_SEGMENTS = new Set(['body', 'query', 'params']);

function fieldPath(pointer: string): string {
  const segments = pointer.split('/');
  if (segments[0] === '') segments.shift();
  if (WRAPPER_SEGMENTS.has(segments[0] ?? '')) segments.shift();
  return segments.map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~')).join('.');
}

export function applyProblemToForm<TValues extends FieldValues>(
  form: Pick<UseFormReturn<TValues>, 'setError'>,
  error: unknown,
): boolean {
  if (!(error instanceof ApiError)) return false;
  const targets = (
    error.errors?.length
      ? error.errors
      : error.path
        ? [{ path: error.path, message: error.message }]
        : []
  )
    .map((item) => ({ name: fieldPath(item.path), message: item.message }))
    .filter((item) => item.name !== '');
  if (targets.length === 0) return false;
  const active = document.activeElement;
  const typing =
    active instanceof HTMLElement &&
    (active.matches('input, textarea, select') || active.isContentEditable);
  targets.forEach((item, index) => {
    form.setError(
      item.name as Path<TValues>,
      { type: 'server', message: item.message },
      {
        shouldFocus: index === 0 && !typing,
      },
    );
  });
  return true;
}

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
    case 'custom':
      return issue.message;
    case 'invalid_type':
      return '请填写有效内容';
    default:
      return '请检查这项内容后重试';
  }
}
