import { zodResolver } from '@hookform/resolvers/zod';
import { type FieldValues, type UseFormProps, useForm } from 'react-hook-form';
import type { z } from 'zod';

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
