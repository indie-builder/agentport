import { zodResolver } from '@hookform/resolvers/zod';
import { type FieldValues, type UseFormProps, useForm } from 'react-hook-form';
import type { z } from 'zod';

/** 所有表单共用的 RHF 配置：zod 校验、提交时校验、出错聚焦第一个字段。 */
export function useZodForm<T extends FieldValues>(
  schema: z.ZodType<T, T>,
  options?: Omit<UseFormProps<T>, 'resolver'>,
) {
  return useForm<T>({
    resolver: zodResolver(schema),
    mode: 'onSubmit',
    reValidateMode: 'onChange',
    ...options,
  });
}
