import { z } from 'zod';

export const idParams = z.object({ id: z.string().min(1) });

export const expectedUpdatedAtSchema = z.iso.datetime().optional();

export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, '仅允许小写字母、数字、- 和 _');
