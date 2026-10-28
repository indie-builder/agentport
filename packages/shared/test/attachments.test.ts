import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_LIMITS,
  attachmentExtension,
  attachmentMimeForFilename,
  chatAttachmentInputSchema,
  chatAttachmentInputsSchema,
  type MessageAttachment,
  messageAttachmentSchema,
  messageAttachments,
} from '../src/attachments.js';
import { chatRequestSchema } from '../src/chat.js';

const input = { filename: 'notes.md', dataBase64: Buffer.from('# hi').toString('base64') };

const attachment: MessageAttachment = {
  id: '00000000-0000-4000-8000-000000000000',
  filename: 'notes.md',
  mimeType: 'text/markdown',
  size: 4,
  sha256: 'a'.repeat(64),
};

describe('attachment limits and filename mapping', () => {
  it('keeps the agreed byte limits', () => {
    expect(ATTACHMENT_LIMITS.count).toBe(5);
    expect(ATTACHMENT_LIMITS.totalBytes).toBe(10 * 1024 * 1024);
    expect(ATTACHMENT_LIMITS.messageBytes).toBe(64 * 1024);
    expect(ATTACHMENT_LIMITS.bodyBytes).toBe(16 * 1024 * 1024);
  });

  it('maps supported extensions case-insensitively', () => {
    expect(attachmentMimeForFilename('notes.txt')).toBe('text/plain');
    expect(attachmentMimeForFilename('notes.md')).toBe('text/markdown');
    expect(attachmentMimeForFilename('data.csv')).toBe('text/csv');
    expect(attachmentMimeForFilename('data.TSV')).toBe('text/tab-separated-values');
    expect(attachmentMimeForFilename('data.json')).toBe('application/json');
    expect(attachmentMimeForFilename('data.jsonl')).toBe('application/x-ndjson');
    expect(attachmentMimeForFilename('C:\\fakepath\\photo.JPEG')).toBe('image/jpeg');
    expect(attachmentMimeForFilename('photo.png')).toBe('image/png');
    expect(attachmentMimeForFilename('anim.gif')).toBe('image/gif');
    expect(attachmentMimeForFilename('photo.webp')).toBe('image/webp');
    expect(attachmentMimeForFilename('doc.pdf')).toBe('application/pdf');
  });

  it('rejects unsupported or missing extensions', () => {
    expect(attachmentMimeForFilename('report.docx')).toBeNull();
    expect(attachmentMimeForFilename('archive.tar.gz')).toBeNull();
    expect(attachmentMimeForFilename('README')).toBeNull();
    expect(attachmentMimeForFilename('.txt')).toBeNull();
  });

  it('returns canonical disk extensions', () => {
    expect(attachmentExtension('image/jpeg')).toBe('.jpg');
    expect(attachmentExtension('text/tab-separated-values')).toBe('.tsv');
    expect(attachmentExtension('application/x-ndjson')).toBe('.jsonl');
    expect(attachmentExtension('text/markdown')).toBe('.md');
  });
});

describe('attachment schemas', () => {
  it('accepts the input shape and rejects unknown keys', () => {
    expect(chatAttachmentInputSchema.parse(input)).toEqual(input);
    expect(
      chatAttachmentInputSchema.safeParse({ ...input, mimeType: 'text/markdown' }).success,
    ).toBe(false);
    expect(chatAttachmentInputSchema.safeParse({ filename: '', dataBase64: 'aGk=' }).success).toBe(
      false,
    );
  });

  it('caps the number of attachments', () => {
    expect(
      chatAttachmentInputsSchema.safeParse(Array.from({ length: 5 }, () => input)).success,
    ).toBe(true);
    expect(
      chatAttachmentInputsSchema.safeParse(Array.from({ length: 6 }, () => input)).success,
    ).toBe(false);
  });

  it('validates persisted metadata', () => {
    expect(messageAttachmentSchema.parse(attachment)).toEqual(attachment);
    expect(messageAttachmentSchema.safeParse({ ...attachment, id: 'not-a-uuid' }).success).toBe(
      false,
    );
    expect(messageAttachmentSchema.safeParse({ ...attachment, size: 0 }).success).toBe(false);
    expect(messageAttachmentSchema.safeParse({ ...attachment, sha256: 'abc' }).success).toBe(false);
    expect(
      messageAttachmentSchema.safeParse({ ...attachment, mimeType: 'application/zip' }).success,
    ).toBe(false);
  });
});

describe('reading attachments out of message content', () => {
  it('reads an object content and an array content', () => {
    expect(
      messageAttachments({ type: 'text', text: '看看这个', attachments: [attachment] }),
    ).toEqual([attachment]);
    expect(messageAttachments([{ attachments: [attachment] }])).toEqual([attachment]);
  });

  it('returns an empty list for bad or missing data without throwing', () => {
    expect(messageAttachments(null)).toEqual([]);
    expect(messageAttachments('text')).toEqual([]);
    expect(messageAttachments({})).toEqual([]);
    expect(messageAttachments([])).toEqual([]);
    expect(messageAttachments({ attachments: 'nope' })).toEqual([]);
    expect(messageAttachments({ attachments: [{ ...attachment, size: 0 }] })).toEqual([]);
  });
});

describe('chat request with attachments', () => {
  it('accepts an attachment-only message', () => {
    const parsed = chatRequestSchema.parse({
      agentId: 'agent',
      message: null,
      attachments: [input],
    });
    expect(parsed.message).toBeNull();
    expect(parsed.attachments).toEqual([input]);
    expect(
      chatRequestSchema.parse({ agentId: 'agent', message: '', attachments: [input] }).attachments,
    ).toEqual([input]);
  });

  it('requires text or at least one attachment', () => {
    expect(chatRequestSchema.safeParse({ agentId: 'agent', message: null }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ agentId: 'agent', message: '   ' }).success).toBe(false);
    expect(
      chatRequestSchema.safeParse({ agentId: 'agent', message: '', attachments: [] }).success,
    ).toBe(false);
    expect(
      chatRequestSchema.safeParse({ agentId: 'agent', message: 'hi', attachments: [] }).success,
    ).toBe(true);
  });

  it('limits message size by UTF-8 bytes', () => {
    expect(
      chatRequestSchema.safeParse({ agentId: 'agent', message: 'a'.repeat(64 * 1024) }).success,
    ).toBe(true);
    const over = chatRequestSchema.safeParse({
      agentId: 'agent',
      message: 'a'.repeat(64 * 1024 + 1),
    });
    expect(over.success).toBe(false);
    if (!over.success) {
      expect(over.error.issues.some((issue) => issue.message.includes('KiB'))).toBe(true);
    }
    expect(
      chatRequestSchema.safeParse({ agentId: 'agent', message: '中'.repeat(21845) }).success,
    ).toBe(true);
    expect(
      chatRequestSchema.safeParse({ agentId: 'agent', message: '中'.repeat(21846) }).success,
    ).toBe(false);
  });

  it('rejects unknown fields on the request and inside attachments', () => {
    expect(
      chatRequestSchema.safeParse({ agentId: 'agent', message: 'hi', extra: true }).success,
    ).toBe(false);
    expect(
      chatRequestSchema.safeParse({
        agentId: 'agent',
        message: 'hi',
        attachments: [{ ...input, extra: true }],
      }).success,
    ).toBe(false);
  });

  it('allows attachments alongside a selected output', () => {
    const parsed = chatRequestSchema.parse({
      agentId: 'agent',
      message: '基于这版继续改',
      attachments: [input],
      output: { runId: 'run_1', path: 'report.md' },
    });
    expect(parsed.attachments).toEqual([input]);
    expect(parsed.output).toEqual({ runId: 'run_1', path: 'report.md' });
  });
});
