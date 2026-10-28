import { z } from 'zod';

/**
 * 聊天附件的入口契约：客户端只送显示名与 base64，服务端从不信任客户端 MIME，
 * 按扩展名映射规范类型并在 core 里校验真实字节。
 */

const KiB = 1024;
const MiB = 1024 * KiB;

export const ATTACHMENT_LIMITS = {
  count: 5,
  totalBytes: 10 * MiB,
  textBytes: 1 * MiB,
  imageBytes: 5 * MiB,
  pdfBytes: 10 * MiB,
  filenameChars: 120,
  messageBytes: 64 * KiB,
  bodyBytes: 16 * MiB,
} as const;

export const attachmentMimeTypeSchema = z.enum([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/x-ndjson',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

export type AttachmentMimeType = z.infer<typeof attachmentMimeTypeSchema>;

/** 接受的扩展名 → 规范 MIME。jpeg/tsv/ndjson 只接受这里列出的写法。 */
const EXTENSION_MIME = new Map<string, AttachmentMimeType>([
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['csv', 'text/csv'],
  ['tsv', 'text/tab-separated-values'],
  ['json', 'application/json'],
  ['jsonl', 'application/x-ndjson'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['pdf', 'application/pdf'],
]);

/** 规范 MIME → 磁盘扩展名；jpeg 统一 .jpg，ndjson 统一 .jsonl。 */
const MIME_EXTENSION: Record<AttachmentMimeType, string> = {
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'application/json': '.json',
  'application/x-ndjson': '.jsonl',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

/** 不支持的扩展名返回 null；只取最后一段扩展名，大小写不敏感。 */
export function attachmentMimeForFilename(filename: string): AttachmentMimeType | null {
  const base = filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return EXTENSION_MIME.get(base.slice(dot + 1).toLowerCase()) ?? null;
}

/** 规范扩展名带前导点，直接拼在服务端 uuid 后面。 */
export function attachmentExtension(mime: AttachmentMimeType): string {
  return MIME_EXTENSION[mime];
}

export const chatAttachmentInputSchema = z
  .object({
    filename: z.string().min(1, '附件文件名不能为空'),
    dataBase64: z.string().min(1, '附件内容不能为空'),
  })
  .strict();

export type ChatAttachmentInput = z.infer<typeof chatAttachmentInputSchema>;

export const chatAttachmentInputsSchema = z
  .array(chatAttachmentInputSchema)
  .max(ATTACHMENT_LIMITS.count, `每条消息最多 ${ATTACHMENT_LIMITS.count} 个附件`);

/** 落库的用户消息附件元数据；不含宿主路径与 base64。 */
export const messageAttachmentSchema = z.object({
  id: z.uuid('附件 id 必须是 UUID'),
  filename: z.string().min(1),
  mimeType: attachmentMimeTypeSchema,
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, '附件 sha256 非法'),
});

export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

/**
 * 从用户消息 content 安全读取附件元数据：content 可以是
 * `{ type:'text', text, attachments }`，也可以是数组（取首元素）。
 * 历史/损坏数据一律当作没有附件，不抛错。
 */
export function messageAttachments(content: unknown): MessageAttachment[] {
  const candidate = Array.isArray(content) ? content[0] : content;
  if (typeof candidate !== 'object' || candidate === null) return [];
  if (!('attachments' in candidate)) return [];
  const parsed = z.array(messageAttachmentSchema).safeParse(candidate.attachments);
  return parsed.success ? parsed.data : [];
}
