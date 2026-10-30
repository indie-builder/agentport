import { describe, expect, it } from 'vitest';
import { chatRequestSchema } from '../src/chat.js';
import {
  outputContentSchema,
  outputFileSchema,
  outputListSchema,
  outputManifestSchema,
  outputRefSchema,
} from '../src/outputs.js';

const sha = 'a'.repeat(64);

const file = {
  runId: 'run_1',
  path: 'report.md',
  size: 4,
  sha256: sha,
  mediaType: 'text/markdown',
  createdAt: '2026-10-28T00:00:00.000Z',
  status: 'failed',
  userMessageId: 'msg_u',
  afterMessageId: 'msg_a',
} as const;

const manifest = {
  version: 1,
  runId: 'run_1',
  createdAt: '2026-10-28T00:00:00.000Z',
  status: 'succeeded',
  userMessageId: 'msg_u',
  afterMessageId: 'msg_a',
  files: [{ path: 'report.md', size: 4, sha256: sha, mediaType: 'text/markdown', changed: true }],
} as const;

describe('output reference on chat requests', () => {
  it('accepts a published output reference', () => {
    expect(
      chatRequestSchema.parse({
        agentId: 'agent',
        message: '基于这版继续改',
        output: { runId: 'run_1', path: 'report.md' },
      }).output,
    ).toEqual({ runId: 'run_1', path: 'report.md' });
  });

  it('rejects misspelled fields inside the reference', () => {
    expect(
      chatRequestSchema.safeParse({
        agentId: 'agent',
        message: 'hi',
        output: { runId: 'run_1', path: 'a.md', extra: true },
      }).success,
    ).toBe(false);
  });
});

describe('output schemas', () => {
  it('validates a file entry at the trust boundary', () => {
    expect(outputFileSchema.parse(file)).toEqual(file);
    expect(outputFileSchema.safeParse({ ...file, sha256: 'not-a-hash' }).success).toBe(false);
    expect(outputFileSchema.safeParse({ ...file, size: -1 }).success).toBe(false);
    expect(outputFileSchema.safeParse({ ...file, status: 'running' }).success).toBe(false);
  });

  it('requires both halves of an output reference', () => {
    expect(outputRefSchema.safeParse({ runId: '', path: 'a.md' }).success).toBe(false);
    expect(outputRefSchema.safeParse({ runId: 'run_1', path: '' }).success).toBe(false);
  });

  it('parses a version manifest and rejects unknown versions', () => {
    expect(outputManifestSchema.parse(manifest)).toEqual(manifest);
    expect(outputManifestSchema.safeParse({ ...manifest, version: 2 }).success).toBe(false);
    expect(
      outputManifestSchema.safeParse({
        ...manifest,
        files: [{ path: 'a.md', size: 1, sha256: sha, mediaType: 'text/markdown' }],
      }).success,
    ).toBe(false);
  });

  it('parses list and content envelopes', () => {
    expect(outputListSchema.parse({ items: [file], nextBefore: 'cursor' })).toEqual({
      items: [file],
      nextBefore: 'cursor',
    });
    expect(outputListSchema.parse({ items: [], nextBefore: null })).toEqual({
      items: [],
      nextBefore: null,
    });
    expect(outputContentSchema.parse({ file, content: '# 报告\n' })).toEqual({
      file,
      content: '# 报告\n',
    });
  });
});
