import { z } from 'zod';

/**
 * 运行产出（conversation-outputs）的类型与解析边界。
 * 这里只描述文件系统快照的形状；路径合法性在双方入口各校验一次，
 * 存储实现见 `@agentport/core` 的 `outputs.ts`。
 */

/** 终端状态：产出由 worker 在运行结束后发布，不存在 queued/running 的版本。 */
export const outputStatusSchema = z.enum(['succeeded', 'failed', 'cancelled', 'timeout']);

export type OutputStatus = z.infer<typeof outputStatusSchema>;

const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** 会话与运行 id 直接成为目录名：只允许非点开头的安全字符，拒绝任何路径语义。 */
export const outputOwnerIdSchema = z.string().regex(segmentPattern, '产出目录名非法');

/**
 * manifest 与快照内的相对路径。绝对路径、反斜杠、`.`/`..` 与空段都拒绝；
 * 读取端因此可以把 manifest 当作唯一成员白名单。
 */
export const outputPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) => {
      if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
      return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
    },
    { message: '产出路径必须是安全的相对路径' },
  );

/** 「基于此版本修改」随用户消息持久化的引用。 */
export const outputRefSchema = z
  .object({ runId: z.string().min(1), path: outputPathSchema })
  .strict();

export type OutputRef = z.infer<typeof outputRefSchema>;

export const outputFileSchema = z.object({
  runId: z.string().min(1),
  path: outputPathSchema,
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
  /** 快照发布时刻；版本排序与游标都用它。 */
  createdAt: z.string().min(1),
  status: outputStatusSchema,
});

export type OutputFile = z.infer<typeof outputFileSchema>;

/** `nextBefore` 是下一页游标；null 表示没有更多。 */
export const outputListSchema = z.object({
  items: z.array(outputFileSchema),
  nextBefore: z.string().nullable(),
});

export type OutputList = z.infer<typeof outputListSchema>;

export const outputContentSchema = z.object({ file: outputFileSchema, content: z.string() });

export type OutputContent = z.infer<typeof outputContentSchema>;

/** manifest 中的单个成员；`changed` 相对上一版快照，首版全部为 true。 */
export const outputManifestFileSchema = z.object({
  path: outputPathSchema,
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
  changed: z.boolean(),
});

export type OutputManifestFile = z.infer<typeof outputManifestFileSchema>;

/**
 * 每轮发布的完整快照索引。`userMessageId`/`afterMessageId` 是本轮边界：
 * fork 只复制两个锚点都在映射内的版本，并重写为分支消息 id。
 */
export const outputManifestSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  createdAt: z.string().min(1),
  status: outputStatusSchema,
  userMessageId: z.string().min(1),
  afterMessageId: z.string().min(1),
  files: z.array(outputManifestFileSchema),
});

export type OutputManifest = z.infer<typeof outputManifestSchema>;
