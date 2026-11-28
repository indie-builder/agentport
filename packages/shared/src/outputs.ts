import { z } from 'zod';
import { cursorPageSchema } from './pagination.js';
import { terminalRunStatusSchema } from './run-state.js';

export const outputStatusSchema = terminalRunStatusSchema;

export type OutputStatus = z.infer<typeof outputStatusSchema>;

export const segmentIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const outputOwnerIdSchema = z.string().regex(segmentIdPattern, '产出目录名非法');

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

export const outputRefSchema = z
  .object({ runId: z.string().min(1), path: outputPathSchema })
  .strict();

export type OutputRef = z.infer<typeof outputRefSchema>;

export const outputShareSchema = z.object({
  id: z.string(),
  runId: z.string(),
  path: outputPathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  urlPath: z.string(),
});

export type OutputShare = z.infer<typeof outputShareSchema>;

export const publicOutputShareSchema = z.object({
  file: z.object({
    name: z.string(),
    size: z.number().int().nonnegative(),
    mediaType: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string(),
  }),
});

export type PublicOutputShare = z.infer<typeof publicOutputShareSchema>;

export const outputFileSchema = z.object({
  runId: z.string().min(1),
  path: outputPathSchema,
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
  createdAt: z.string().min(1),
  status: outputStatusSchema,
  userMessageId: z.string().min(1),
  afterMessageId: z.string().min(1),
});

export type OutputFile = z.infer<typeof outputFileSchema>;

export const outputListSchema = cursorPageSchema(outputFileSchema);

export type OutputList = z.infer<typeof outputListSchema>;

export const outputContentSchema = z.object({ file: outputFileSchema, content: z.string() });

export type OutputContent = z.infer<typeof outputContentSchema>;

export const outputManifestFileSchema = z.object({
  path: outputPathSchema,
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
  changed: z.boolean(),
});

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
