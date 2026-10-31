import { describe, expect, it } from 'vitest';
import {
  knowledgeAudioMetadataSchema,
  knowledgeBaseSchema,
  knowledgeDocumentSchema,
  knowledgeFaqImportMetadataSchema,
  knowledgeFaqImportResponseSchema,
  knowledgeFaqSchema,
  knowledgeFaqTransferDocumentSchema,
  knowledgeJobPayloadSchema,
  knowledgeJobSchema,
  knowledgeLocatorSchema,
  knowledgeModelProfileSelectionSchema,
  knowledgeReadInputSchema,
  knowledgeSearchHitSchema,
  knowledgeSearchQuerySchema,
  knowledgeSearchResultSchema,
  knowledgeSourceInputSchema,
  knowledgeSourceProbeResultSchema,
  knowledgeSourceRangeExternalIdMax,
  knowledgeSourceRangeInputSchema,
  knowledgeSourceTypeSchema,
  knowledgeSyncItemSchema,
  knowledgeWikiLinksResultSchema,
} from '../src/knowledge.js';

const documentFixture = {
  id: 'kdoc_1',
  baseId: 'kb_1',
  folderId: null,
  title: '文档',
  sourceType: 'manual',
  sourceUrl: null,
  sourcePath: null,
  mimeType: 'text/markdown',
  sizeBytes: 1,
  status: 'ready',
  currentVersionId: null,
  tags: [],
  lastSyncedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('knowledge job wire', () => {
  it('keeps probe results together with job object references and display names', () => {
    const result = { ok: true, checks: [{ rangeId: 'range-1', ok: true }] };
    expect(
      knowledgeJobSchema.parse({
        id: 'kjob_1',
        type: 'source_probe',
        status: 'succeeded',
        step: null,
        progress: 100,
        attempts: 1,
        error: null,
        result,
        documentId: null,
        sourceId: 'ksrc_1',
        documentTitle: null,
        sourceName: '来源',
        createdAt: '2026-10-31T00:00:00Z',
        startedAt: null,
        endedAt: null,
      }),
    ).toMatchObject({ result, sourceId: 'ksrc_1', sourceName: '来源' });
  });
});

describe('knowledge model profile selection wire', () => {
  const selection = {
    id: 'kmp_1',
    name: 'Whisper',
    kind: 'asr',
    enabled: true,
    supportsImageVectors: false,
  };

  it('accepts embedding, rerank and asr selection kinds', () => {
    for (const kind of ['embedding', 'rerank', 'asr'] as const) {
      expect(knowledgeModelProfileSelectionSchema.parse({ ...selection, kind }).kind).toBe(kind);
    }
    expect(
      knowledgeModelProfileSelectionSchema.safeParse({ ...selection, kind: 'chat' }).success,
    ).toBe(false);
  });

  it('keeps stripping management-only profile fields from the selection projection', () => {
    expect(
      knowledgeModelProfileSelectionSchema.parse({
        ...selection,
        endpointUrl: 'https://api.example.com/v1',
        model: 'whisper-1',
        dimensions: 1024,
        embeddingProtocol: 'openai',
        imageInputEnabled: false,
        hasSecret: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual(selection);
  });

  it('requires id/name and boolean flags', () => {
    expect(
      knowledgeModelProfileSelectionSchema.safeParse({ ...selection, id: undefined }).success,
    ).toBe(false);
    expect(
      knowledgeModelProfileSelectionSchema.safeParse({ ...selection, name: undefined }).success,
    ).toBe(false);
    expect(
      knowledgeModelProfileSelectionSchema.safeParse({ ...selection, enabled: 'yes' }).success,
    ).toBe(false);
    expect(
      knowledgeModelProfileSelectionSchema.safeParse({
        ...selection,
        supportsImageVectors: 'no',
      }).success,
    ).toBe(false);
  });
});

describe('knowledge document wire', () => {
  it('defaults contentKind/disabledReason/sourceConnectionId', () => {
    expect(knowledgeDocumentSchema.parse(documentFixture)).toMatchObject({
      contentKind: 'document',
      disabledReason: null,
      sourceConnectionId: null,
    });
  });

  it('accepts FAQ and Wiki content kinds', () => {
    expect(
      knowledgeDocumentSchema.parse({ ...documentFixture, contentKind: 'faq' }).contentKind,
    ).toBe('faq');
    expect(
      knowledgeDocumentSchema.safeParse({ ...documentFixture, contentKind: 'unknown' }).success,
    ).toBe(false);
  });
});

describe('FAQ schema', () => {
  const faq = {
    question: '如何重置密码？',
    similarQuestions: ['忘记密码'],
    negativeQuestions: ['如何开票'],
    answers: ['设置页重置'],
  };

  it('accepts standard/alias/negative questions and multiple answers', () => {
    expect(knowledgeFaqSchema.parse(faq)).toEqual({
      ...faq,
      answerStrategy: 'all',
      isRecommended: true,
    });
  });

  it('keeps explicit answer strategy and recommendation flags', () => {
    expect(
      knowledgeFaqSchema.parse({ ...faq, answerStrategy: 'random', isRecommended: false }),
    ).toMatchObject({ answerStrategy: 'random', isRecommended: false });
    expect(knowledgeFaqSchema.safeParse({ ...faq, answerStrategy: 'first' }).success).toBe(false);
  });

  it('wraps transfer entries with enabled defaulting to true', () => {
    expect(knowledgeFaqTransferDocumentSchema.parse({ items: [faq] }).items[0]).toMatchObject({
      answerStrategy: 'all',
      isRecommended: true,
      enabled: true,
    });
  });

  it('requires at least one non-empty answer', () => {
    expect(knowledgeFaqSchema.safeParse({ ...faq, answers: [] }).success).toBe(false);
    expect(knowledgeFaqSchema.safeParse({ ...faq, answers: ['  '] }).success).toBe(false);
  });

  it('caps question lengths and array sizes', () => {
    expect(knowledgeFaqSchema.safeParse({ ...faq, question: 'q'.repeat(501) }).success).toBe(false);
    expect(
      knowledgeFaqSchema.safeParse({
        ...faq,
        similarQuestions: Array.from({ length: 51 }, (_, index) => `q${index}`),
      }).success,
    ).toBe(false);
    expect(knowledgeFaqSchema.safeParse({ ...faq, answers: ['a'.repeat(20_001)] }).success).toBe(
      false,
    );
  });
});

describe('locator and read/list wire', () => {
  it('keeps only supported locator dimensions', () => {
    expect(
      knowledgeLocatorSchema.parse({
        pageFrom: 1,
        pageTo: 2,
        startOffset: 0,
        endOffset: 4,
        lineFrom: 3,
        lineTo: 3,
        headingPath: ['A', 'B'],
        sheet: 'Sheet1',
        cellRange: 'A1:B2',
        bbox: { left: 1, top: 2, right: 3, bottom: 4 },
        parserRef: 'docling#table-1',
      }),
    ).toMatchObject({ pageFrom: 1, cellRange: 'A1:B2', parserRef: 'docling#table-1' });
  });

  it('requires paired nonnegative safe timecodes with timeTo >= timeFrom', () => {
    expect(knowledgeLocatorSchema.parse({ timeFromMs: 0, timeToMs: 1_250 })).toMatchObject({
      timeFromMs: 0,
      timeToMs: 1_250,
    });
    expect(knowledgeLocatorSchema.safeParse({ timeFromMs: 0 }).success).toBe(false);
    expect(knowledgeLocatorSchema.safeParse({ timeToMs: 10 }).success).toBe(false);
    expect(knowledgeLocatorSchema.safeParse({ timeFromMs: 2_000, timeToMs: 1_999 }).success).toBe(
      false,
    );
    expect(knowledgeLocatorSchema.safeParse({ timeFromMs: -1, timeToMs: 0 }).success).toBe(false);
    expect(knowledgeLocatorSchema.safeParse({ timeFromMs: 0.5, timeToMs: 1 }).success).toBe(false);
    expect(
      knowledgeLocatorSchema.safeParse({
        timeFromMs: 0,
        timeToMs: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
  });

  it('parses audio metadata with UTF-16 offsets and real segment timecodes', () => {
    const audio = {
      protocol: 'openai_transcriptions',
      profileName: '本地 whisper',
      model: 'whisper-1',
      durationMs: 3_500,
      segments: [
        { startOffset: 0, endOffset: 5, timeFromMs: 0, timeToMs: 1_250 },
        { startOffset: 7, endOffset: 12, timeFromMs: 1_250, timeToMs: 3_500 },
      ],
    };
    expect(knowledgeAudioMetadataSchema.parse(audio)).toEqual(audio);
    expect(
      knowledgeAudioMetadataSchema.parse({ ...audio, durationMs: null }).durationMs,
    ).toBeNull();
    expect(
      knowledgeAudioMetadataSchema.safeParse({
        ...audio,
        segments: [{ startOffset: 5, endOffset: 4, timeFromMs: 0, timeToMs: 1 }],
      }).success,
    ).toBe(false);
    expect(
      knowledgeAudioMetadataSchema.safeParse({
        ...audio,
        segments: [{ startOffset: 0, endOffset: 4, timeFromMs: 9, timeToMs: 1 }],
      }).success,
    ).toBe(false);
    expect(
      knowledgeAudioMetadataSchema.safeParse({ ...audio, protocol: 'chat_audio' }).success,
    ).toBe(false);
  });

  it('requires asrProfileId on the knowledge base wire', () => {
    const base = {
      id: 'kb_1',
      serverId: 'srv_1',
      slug: 'kb',
      name: 'KB',
      description: '',
      status: 'active',
      embeddingProfileId: 'kmp_1',
      rerankProfileId: null,
      asrProfileId: null,
      settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(knowledgeBaseSchema.parse(base).asrProfileId).toBeNull();
    expect(knowledgeBaseSchema.safeParse({ ...base, asrProfileId: undefined }).success).toBe(false);
  });

  it('defaults search to all three kinds, 0.3 vector gate and diagnostics off', () => {
    expect(knowledgeSearchQuerySchema.parse({ q: '密码' })).toMatchObject({
      kinds: ['document', 'faq', 'wiki'],
      minVectorScore: 0.3,
      diagnostics: false,
      onlyRecommended: false,
      faqPriority: false,
      faqDirectAnswerThreshold: 0.9,
    });
  });

  it('carries FAQ hit strategy and nullable direct answer', () => {
    const hit = knowledgeSearchHitSchema.parse({
      chunkId: 'kchk_1',
      documentId: 'kdoc_1',
      versionId: 'kdv_1',
      target: { kind: 'faq', id: 'kdoc_1' },
      targetVersionId: 'kdv_1',
      title: 'FAQ',
      heading: null,
      quote: 'answer',
      pageFrom: null,
      pageTo: null,
      sourceUrl: null,
      score: 0.8,
      scores: { keyword: 1, vector: 0.8, rrf: 0.5, rerank: null },
      faq: {
        answers: ['answer'],
        answerStrategy: 'random',
        isRecommended: false,
        matchedQuestion: '如何重置密码？',
        questionKind: 'similar',
      },
    });
    expect(hit.faq).toMatchObject({ answerStrategy: 'random', questionKind: 'similar' });
    expect(knowledgeSearchResultSchema.parse({ hits: [hit] }).directAnswer).toBeNull();
    expect(
      knowledgeSearchResultSchema.parse({
        hits: [],
        directAnswer: {
          target: { kind: 'faq', id: 'kdoc_1' },
          versionId: 'kdv_1',
          answers: ['answer'],
          vectorScore: 0.95,
        },
      }).directAnswer?.vectorScore,
    ).toBe(0.95);
  });

  it('parses FAQ import counts/results and broken wiki links', () => {
    expect(
      knowledgeFaqImportResponseSchema.parse({
        dryRun: true,
        mode: 'replace',
        committed: false,
        importBatchId: null,
        counts: {
          total: 1,
          success: 1,
          failed: 0,
          partialFailed: 0,
          skipped: 0,
          added: 1,
          merged: 0,
        },
        results: [
          {
            row: 1,
            status: 'success',
            operation: 'add',
            documentId: 'kdoc_1',
            issues: [],
          },
        ],
      }).results[0]?.operation,
    ).toBe('add');
    expect(
      knowledgeWikiLinksResultSchema.parse({
        outgoing: [{ targetPageId: null, anchor: 'missing' }],
        incoming: [],
      }).outgoing[0]?.targetPageId,
    ).toBeNull();
  });

  it('requires faqImport metadata to persist expectedVersionId', () => {
    expect(
      knowledgeFaqImportMetadataSchema.safeParse({
        batchId: 'kfimp_1',
        mode: 'append',
        enabled: true,
      }).success,
    ).toBe(false);
    expect(
      knowledgeFaqImportMetadataSchema.parse({
        batchId: 'kfimp_1',
        mode: 'append',
        enabled: true,
        expectedVersionId: null,
      }).expectedVersionId,
    ).toBeNull();
  });

  it('defaults read offset/limit and caps limit at 20000', () => {
    expect(
      knowledgeReadInputSchema.parse({ target: { kind: 'document', id: 'kdoc_1' } }),
    ).toMatchObject({ offset: 0, limit: 10_000 });
    expect(
      knowledgeReadInputSchema.safeParse({
        target: { kind: 'document', id: 'kdoc_1' },
        limit: 20_001,
      }).success,
    ).toBe(false);
  });
});

describe('job payload wire', () => {
  it('keeps ingest version snapshot and metadata instead of stripping them', () => {
    const payload = {
      type: 'ingest' as const,
      documentId: 'kdoc_1',
      publish: 'draft' as const,
      versionId: 'kdv_1',
      versionMetadata: { publication: 'draft', manualChanges: { kchk_1: 'deleted' } },
      input: {
        blobSha256: 'a'.repeat(64),
        filename: 'manual.md',
        mimeType: 'text/markdown',
        expectedCurrentVersionId: null,
      },
    };
    expect(knowledgeJobPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('defaults reindex confirmOverwriteManualChunks to false and keeps true', () => {
    expect(knowledgeJobPayloadSchema.parse({ type: 'reindex', baseId: 'kb_1' })).toMatchObject({
      confirmOverwriteManualChunks: false,
    });
    expect(
      knowledgeJobPayloadSchema.parse({
        type: 'reindex',
        baseId: 'kb_1',
        documentIds: ['kdoc_1'],
        chunksOnly: true,
        confirmOverwriteManualChunks: true,
      }),
    ).toMatchObject({ confirmOverwriteManualChunks: true });
  });
});

describe('job and sync item wire', () => {
  it('parses source_probe result and sync item status', () => {
    expect(
      knowledgeSourceProbeResultSchema.parse({
        ok: false,
        checks: [{ rangeId: 'krng_1', ok: false, code: 'AUTH', message: '401' }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      knowledgeSyncItemSchema.parse({
        id: 'ksit_1',
        syncRunId: 'ksyn_1',
        sourceId: 'ksrc_1',
        rangeId: null,
        documentId: null,
        externalId: 'item-1',
        status: 'skipped',
        code: 'UNSUPPORTED',
        message: '不支持',
        retryable: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      }).status,
    ).toBe('skipped');
  });
});

describe('knowledge source input types', () => {
  const uuid = '01234567-89ab-cdef-0123-456789abcdef';
  const payloads: Record<string, Record<string, unknown>> = {
    lark_wiki: {
      config: { appId: 'cli_a', syncDeletions: true },
      secrets: { appSecret: 's' },
      ranges: [{ kind: 'wiki_space', externalId: 'spc_1' }],
    },
    lark_drive: {
      config: { appId: 'cli_a', syncDeletions: true },
      secrets: { appSecret: 's' },
      ranges: [{ kind: 'drive_folder', externalId: 'fld_1' }],
    },
    notion: {
      config: { syncDeletions: true },
      secrets: { apiKey: 'n' },
      ranges: [{ kind: 'notion_page', externalId: uuid }],
    },
    confluence: {
      config: {
        authMode: 'cloud_scoped',
        baseUrl: 'https://acme.atlassian.net/wiki',
        email: 'owner@example.com',
        cloudId: 'cloud-1',
        syncDeletions: true,
      },
      secrets: { apiToken: 't' },
      ranges: [{ kind: 'confluence_space', externalId: '123' }],
    },
    yuque: {
      config: { syncDeletions: true },
      secrets: { apiToken: 'y' },
      ranges: [{ kind: 'yuque_repo', externalId: '42' }],
    },
    dingtalk: {
      config: { clientId: 'cid', operatorUnionId: 'union-1', syncDeletions: true },
      secrets: { clientSecret: 'c' },
      ranges: [{ kind: 'dingtalk_workspace', externalId: 'workspace-1' }],
    },
    ima: {
      config: { clientId: 'cid', syncDeletions: true },
      secrets: { apiKey: 'k' },
      ranges: [{ kind: 'ima_kb', externalId: 'kb-1' }],
    },
    seafile: {
      config: { baseUrl: 'https://seafile.example.com', syncDeletions: true },
      secrets: { apiToken: 't' },
      ranges: [{ kind: 'seafile_repo', externalId: uuid, paths: ['Documents', 'Manuals'] }],
    },
    nextcloud: {
      config: { baseUrl: 'https://cloud.example.com', username: 'alice', syncDeletions: true },
      secrets: { appPassword: 'p' },
      ranges: [{ kind: 'nextcloud_path', externalId: '/Documents' }],
    },
  };

  it('registers the nine new source types and range kinds', () => {
    const types = knowledgeSourceTypeSchema.options;
    for (const type of Object.keys(payloads)) expect(types).toContain(type);
    for (const kind of [
      'notion_page',
      'notion_database',
      'notion_data_source',
      'confluence_space',
      'confluence_page',
      'yuque_repo',
      'dingtalk_workspace',
      'dingtalk_node',
      'ima_kb',
      'seafile_repo',
      'nextcloud_path',
    ]) {
      expect(knowledgeSourceRangeInputSchema.parse({ kind, externalId: 'x' }).kind).toBe(kind);
    }
    expect(
      knowledgeSourceRangeInputSchema.safeParse({ kind: 'notion_space', externalId: 'x' }).success,
    ).toBe(false);
  });

  it.each(Object.entries(payloads))(
    'parses %s config/secrets/ranges without stripping fields',
    (type, payload) => {
      const parsed = knowledgeSourceInputSchema.parse({ type, name: type, ...payload });
      expect(parsed.type).toBe(type);
      expect(parsed.config.syncDeletions).toBe(true);
      expect(parsed.secrets).toEqual(payload.secrets);
      expect(parsed.ranges[0]?.externalId).toBe(
        (payload.ranges as Array<{ externalId: string }>)[0]?.externalId,
      );
    },
  );

  it('defaults syncDeletions to false instead of dropping it', () => {
    const parsed = knowledgeSourceInputSchema.parse({
      type: 'notion',
      name: 'notion',
      config: {},
      secrets: { apiKey: 'n' },
      ranges: [{ kind: 'notion_page', externalId: uuid }],
    });
    expect(parsed.config).toEqual({ syncDeletions: false });
  });

  it('rejects string syncDeletions instead of storing a value workers never read as true', () => {
    expect(
      knowledgeSourceInputSchema.safeParse({
        type: 'notion',
        name: 'notion',
        config: { syncDeletions: 'true' },
        secrets: { apiKey: 'n' },
        ranges: [{ kind: 'notion_page', externalId: uuid }],
      }).success,
    ).toBe(false);
  });

  it('declares provider-reasonable range ID caps for every new source type', () => {
    for (const type of Object.keys(payloads)) {
      const cap = knowledgeSourceRangeExternalIdMax[type as keyof typeof payloads];
      expect(cap, type).toBeGreaterThan(0);
      // connectionId（ksrc_ 前缀 + 26 字符）+ ':' + 叶 externalId 必须留在 500 内。
      expect(cap, type).toBeLessThanOrEqual(255);
    }
  });

  it('requires the authMode-specific Confluence fields', () => {
    const base = {
      type: 'confluence',
      name: 'confluence',
      config: { baseUrl: 'https://acme.atlassian.net/wiki' },
      secrets: { apiToken: 't' },
      ranges: [{ kind: 'confluence_space', externalId: '1' }],
    };
    expect(
      knowledgeSourceInputSchema.safeParse({
        ...base,
        config: { ...base.config, authMode: 'cloud_basic', email: 'a@b.co' },
      }).success,
    ).toBe(true);
    expect(
      knowledgeSourceInputSchema.safeParse({
        ...base,
        config: { ...base.config, authMode: 'cloud_basic' },
      }).success,
    ).toBe(false);
    expect(
      knowledgeSourceInputSchema.safeParse({
        ...base,
        config: { ...base.config, authMode: 'cloud_scoped', email: 'a@b.co' },
      }).success,
    ).toBe(false);
    expect(
      knowledgeSourceInputSchema.safeParse({
        ...base,
        config: { ...base.config, authMode: 'dc_pat' },
        secrets: { pat: 'p' },
      }).success,
    ).toBe(true);
  });
});
