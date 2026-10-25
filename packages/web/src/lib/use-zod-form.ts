import { zodResolver } from '@hookform/resolvers/zod';
import { type FieldValues, type UseFormProps, useForm } from 'react-hook-form';
import type { z } from 'zod';

/**
 * 所有表单共用的 RHF 配置：zod 校验、提交时校验、出错聚焦第一个字段。
 *
 * 表单里存 schema 的输入类型（允许未规范化的中间草稿），
 * `handleSubmit` 的回调拿到校验后的输出类型。
 */
export function useZodForm<TValues extends FieldValues, TOutput extends FieldValues = TValues>(
  schema: z.ZodType<TOutput, TValues>,
  options?: Omit<UseFormProps<TValues, unknown, TOutput>, 'resolver'>,
) {
  return useForm<TValues, unknown, TOutput>({
    resolver: zodResolver(schema),
    mode: 'onSubmit',
    reValidateMode: 'onChange',
    ...options,
  });
}
