import { z } from 'zod';

export const idParams = z.object({ id: z.string().min(1) });

/**
 * slug 会变成工作区目录名与 URL 片段：agent、skill、server、tool 共用同一条规则。
 * 首字符限定为字母或数字，避免隐藏目录与 `-`/`_` 开头的歧义名称。
 */
export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, '仅允许小写字母、数字、- 和 _');
