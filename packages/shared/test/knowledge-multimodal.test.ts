import { describe, expect, it } from 'vitest';
import {
  knowledgeBaseSettingsSchema,
  knowledgeChunkSchema,
  knowledgeImageChunkMetadataSchema,
  knowledgeImageRefSchema,
  knowledgeReadImageInputSchema,
  knowledgeReadImageResultSchema,
  knowledgeSearchHitSchema,
} from '../src/knowledge.js';

const settings = { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false };

describe('imageProcessing settings', () => {
  it('fills the documented defaults when the key is absent', () => {
    const parsed = knowledgeBaseSettingsSchema.parse(settings);
    expect(parsed.imageProcessing).toEqual({
      enabled: false,
      model: null,
      ocrEnabled: true,
      captionEnabled: true,
      descriptionLanguage: 'zh-CN',
      customInstructions: '',
      imageVectorEnabled: false,
      imageVectorMinScore: 0.3,
    });
  });

  it('requires a model and at least one action when enabled', () => {
    const parse = (patch: Record<string, unknown>) =>
      knowledgeBaseSettingsSchema.safeParse({
        ...settings,
        imageProcessing: { enabled: true, ...patch },
      });

    expect(parse({ ocrEnabled: true }).success).toBe(false);
    expect(parse({ model: 'vision-model', ocrEnabled: false, captionEnabled: false }).success).toBe(
      false,
    );
    expect(parse({ model: 'vision-model', ocrEnabled: true, captionEnabled: false }).success).toBe(
      true,
    );
    expect(parse({ model: 'vision-model', ocrEnabled: false, captionEnabled: true }).success).toBe(
      true,
    );
  });

  it('keeps the vector score inside the cosine range', () => {
    const parse = (score: number) =>
      knowledgeBaseSettingsSchema.safeParse({
        ...settings,
        imageProcessing: { imageVectorMinScore: score },
      });
    expect(parse(-1).success).toBe(true);
    expect(parse(1).success).toBe(true);
    expect(parse(1.01).success).toBe(false);
    expect(parse(-1.01).success).toBe(false);
  });

  it('refuses image vectors while image processing is off', () => {
    const parsed = knowledgeBaseSettingsSchema.safeParse({
      ...settings,
      imageProcessing: { enabled: false, imageVectorEnabled: true },
    });
    expect(parsed.success).toBe(false);
  });

  it('bounds the optional instructions', () => {
    const parse = (customInstructions: string) =>
      knowledgeBaseSettingsSchema.safeParse({
        ...settings,
        imageProcessing: { customInstructions },
      });
    expect(parse('x'.repeat(2000)).success).toBe(true);
    expect(parse('x'.repeat(2001)).success).toBe(false);
  });
});

describe('knowledgeImageRefSchema', () => {
  it('accepts a single-segment file name and a nullable page', () => {
    expect(
      knowledgeImageRefSchema.parse({ name: 'p1-1.png', mimeType: 'image/png', page: null }),
    ).toEqual({ name: 'p1-1.png', mimeType: 'image/png', page: null });
  });

  it('rejects path traversal and multi-segment names', () => {
    for (const name of ['../x.png', 'a/b.png', 'a\\b.png', '.', '..', '']) {
      expect(
        knowledgeImageRefSchema.safeParse({ name, mimeType: 'image/png', page: 1 }).success,
      ).toBe(false);
    }
  });
});

describe('knowledgeImageChunkMetadataSchema', () => {
  it('accepts the three known roles', () => {
    for (const imageRole of ['ocr', 'caption', 'vector'] as const) {
      expect(
        knowledgeImageChunkMetadataSchema.parse({
          image: { name: 'p1-1.png', mimeType: 'image/png', page: 1 },
          imageRole,
        }).imageRole,
      ).toBe(imageRole);
    }
    expect(
      knowledgeImageChunkMetadataSchema.safeParse({
        image: { name: 'p1-1.png', mimeType: 'image/png', page: 1 },
        imageRole: 'thumbnail',
      }).success,
    ).toBe(false);
  });
});

describe('chunk and hit wire shape', () => {
  const chunk = {
    id: 'chk_1',
    documentId: 'doc_1',
    versionId: 'ver_1',
    ordinal: 0,
    kind: 'image',
    heading: null,
    content: '一张图表',
    enabled: true,
    editedByUser: false,
    pageFrom: 1,
    pageTo: 1,
  };

  it('carries chunk metadata through and defaults it when absent', () => {
    expect(knowledgeChunkSchema.parse(chunk).metadata).toEqual({});
    expect(
      knowledgeChunkSchema.parse({
        ...chunk,
        metadata: { image: { name: 'p1-1.png', mimeType: 'image/png', page: 1 }, imageRole: 'ocr' },
      }).metadata,
    ).toMatchObject({ imageRole: 'ocr' });
  });

  const hit = {
    chunkId: 'chk_1',
    documentId: 'doc_1',
    versionId: 'ver_1',
    target: { kind: 'document', id: 'doc_1' },
    targetVersionId: 'ver_1',
    title: '手册',
    heading: null,
    quote: '正文',
    pageFrom: 1,
    pageTo: 1,
    sourceUrl: null,
    score: 0.9,
    scores: { keyword: 0.5, vector: 0.8, rrf: 0.9, rerank: null },
  };

  it('parses old hits without an image field as image:null', () => {
    expect(knowledgeSearchHitSchema.parse(hit).image).toBeNull();
  });

  it('keeps an explicit image reference', () => {
    expect(
      knowledgeSearchHitSchema.parse({
        ...hit,
        image: { name: 'p1-1.png', mimeType: 'image/png', page: 1 },
      }).image,
    ).toEqual({ name: 'p1-1.png', mimeType: 'image/png', page: 1 });
  });
});

describe('read-image wire contract', () => {
  it('defaults format to description and rejects unknown formats', () => {
    expect(knowledgeReadImageInputSchema.parse({ chunkId: 'chk_1' }).format).toBe('description');
    expect(
      knowledgeReadImageInputSchema.safeParse({ chunkId: 'chk_1', format: 'thumbnail' }).success,
    ).toBe(false);
  });

  it('requires the hit and description in the result', () => {
    const result = {
      hit: {
        chunkId: 'chk_1',
        documentId: 'doc_1',
        versionId: 'ver_1',
        target: { kind: 'document', id: 'doc_1' },
        targetVersionId: 'ver_1',
        title: '手册',
        heading: null,
        quote: '正文',
        pageFrom: 1,
        pageTo: 1,
        sourceUrl: null,
        score: 0.9,
        scores: { keyword: 0.5, vector: 0.8, rrf: 0.9, rerank: null },
      },
      description: '一张图表',
    };
    expect(knowledgeReadImageResultSchema.parse(result).description).toBe('一张图表');
    expect(knowledgeReadImageResultSchema.safeParse({ description: '缺少 hit' }).success).toBe(
      false,
    );
  });
});
