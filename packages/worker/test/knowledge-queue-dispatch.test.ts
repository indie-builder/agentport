import { describe, expect, it, vi } from 'vitest';

/**
 * wiki_generate 必须由队列分派到 runWikiGenerate，而不是落到摄取分派里抛错。
 * 这里只验证分派选择，真实生成行为由 knowledge-wiki.test.ts 覆盖。
 */
const runWikiGenerate = vi.fn(async () => undefined);
const runKnowledgeJob = vi.fn(async () => undefined);

vi.mock('../src/knowledge/wiki.js', () => ({ runWikiGenerate }));
vi.mock('../src/knowledge/ingestion.js', async () => {
  const actual = await vi.importActual<typeof import('../src/knowledge/ingestion.js')>(
    '../src/knowledge/ingestion.js',
  );
  return { ...actual, runKnowledgeJob };
});

describe('knowledge queue dispatch', () => {
  it('routes wiki_generate to the wiki generator', async () => {
    const { dispatchKnowledgeJob } = await import('../src/knowledge/queue.js');
    const row = { id: 'kjob_1', type: 'wiki_generate', payload: {} } as never;
    await dispatchKnowledgeJob(row, {
      db: {} as never,
      logger: { info: () => undefined, warn: () => undefined } as never,
      knowledgeDir: '/tmp/kb',
      wikiModel: 'test-model',
      decrypt: () => ({}),
      parse: async () => ({ markdown: '', images: [], pageMap: [] }),
      chunkMarkdown: () => [],
      connectors: {},
      signal: new AbortController().signal,
    });
    expect(runWikiGenerate).toHaveBeenCalledOnce();
    expect(runKnowledgeJob).not.toHaveBeenCalled();
  });
});
