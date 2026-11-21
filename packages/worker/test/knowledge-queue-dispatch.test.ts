import { describe, expect, it, mock } from 'bun:test';

const runWikiGenerate = mock(async () => undefined);
const runKnowledgeJob = mock(async () => undefined);

mock.module('../src/knowledge/wiki.js', () => ({ runWikiGenerate }));
const ingestionActual = await import('../src/knowledge/ingestion.js');
mock.module('../src/knowledge/ingestion.js', () => ({ ...ingestionActual, runKnowledgeJob }));

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
