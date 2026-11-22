import { z } from 'zod';

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

export function attachmentMimeForFilename(filename: string): AttachmentMimeType | null {
  const base = filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return EXTENSION_MIME.get(base.slice(dot + 1).toLowerCase()) ?? null;
}

export function attachmentExtension(mime: AttachmentMimeType): string {
  return MIME_EXTENSION[mime];
}

export function isTextAttachment(mimeType: AttachmentMimeType): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/x-ndjson'
  );
}

export function attachmentByteLimit(mimeType: AttachmentMimeType): number {
  if (mimeType.startsWith('image/')) return ATTACHMENT_LIMITS.imageBytes;
  if (mimeType === 'application/pdf') return ATTACHMENT_LIMITS.pdfBytes;
  return ATTACHMENT_LIMITS.textBytes;
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

export const messageAttachmentSchema = z.object({
  id: z.uuid('附件 id 必须是 UUID'),
  filename: z.string().min(1),
  mimeType: attachmentMimeTypeSchema,
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, '附件 sha256 非法'),
});

export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

export function messageAttachments(content: unknown): MessageAttachment[] {
  const candidate = Array.isArray(content) ? content[0] : content;
  if (typeof candidate !== 'object' || candidate === null) return [];
  if (!('attachments' in candidate)) return [];
  const parsed = z.array(messageAttachmentSchema).safeParse(candidate.attachments);
  return parsed.success ? parsed.data : [];
}
