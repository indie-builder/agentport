import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createParsingAdapter } from '../src/knowledge/parsing-adapter.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/knowledge-parsing/${name}`, import.meta.url), 'utf8');

let server: Server;
let parserUrl = '';
let captured: Array<{ path: string; headers: IncomingMessage['headers'] }> = [];
let abortedRequests = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      captured.push({ path: req.url ?? '', headers: req.headers });
      // 慢解析服务：不响应，只有客户端断开连接才算结束。
      if (req.url?.startsWith('/slow')) {
        req.on('close', () => {
          abortedRequests += 1;
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(fixture('docling-success.json'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  parserUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const doclingInput = {
  filename: 'report.pdf',
  mimeType: 'application/pdf',
  data: Buffer.from('%PDF-1.7'),
};

describe('createParsingAdapter', () => {
  it('takes the Docling endpoint and key from the runtime adapter, not the document', async () => {
    captured = [];
    const adapter = createParsingAdapter({ parserUrl, parserKey: 'docling-secret' });
    const parsed = await adapter.parse(doclingInput);

    expect(captured[0]?.path).toBe('/v1/convert/file');
    expect(captured[0]?.headers['x-api-key']).toBe('docling-secret');
    expect(parsed.markdown).toContain('# 季度报告');
  });

  it('does not accept an endpoint from the document input', () => {
    const adapter = createParsingAdapter();
    expect(Object.keys(adapter)).toEqual(['parse', 'chunkMarkdown']);
  });

  it('reports a binary format as unconfigured when the adapter has no parser', async () => {
    const adapter = createParsingAdapter();
    await expect(adapter.parse(doclingInput)).rejects.toThrow(/Docling/);
  });

  it('passes the caller abort signal through', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/slow` });
    const controller = new AbortController();
    const pending = adapter.parse({ ...doclingInput, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/取消|abort/i);
  });

  it('aborts the in-flight Docling request so the parser slot is released', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/slow` });
    const controller = new AbortController();
    const before = abortedRequests;
    const pending = adapter.parse({ ...doclingInput, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(pending).rejects.toThrow(/取消|abort/i);
    // 真实连接被断开，而不是只让本地 promise 先返回。
    const deadline = Date.now() + 2_000;
    while (abortedRequests === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(abortedRequests).toBe(before + 1);
  });

  it('keeps page map offsets aligned with the real markdown', async () => {
    const adapter = createParsingAdapter({ parserUrl });
    const parsed = await adapter.parse(doclingInput);

    expect(parsed.pageMap.length).toBeGreaterThan(0);
    for (const range of parsed.pageMap) {
      expect(parsed.markdown.slice(range.startOffset, range.endOffset).trim()).not.toBe('');
      expect(range.endOffset).toBeLessThanOrEqual(parsed.markdown.length);
      expect(range.startOffset).toBeLessThan(range.endOffset);
    }
    // 页码来自解析结果的 prov，不是按 blocks 长度估算。
    expect(parsed.pageMap.map((range) => range.page)).toEqual([2, 4]);
    expect(
      parsed.markdown.slice(parsed.pageMap[0]?.startOffset, parsed.pageMap[0]?.endOffset),
    ).toBe('第一段内容。');
    expect(
      parsed.markdown.slice(parsed.pageMap[1]?.startOffset, parsed.pageMap[1]?.endOffset),
    ).toBe(['| 指标 | 数值 |', '| --- | --- |', '| 收入 | 100 |'].join('\n'));
  });

  it('maps pages by original offsets across CRLF and surrogate pairs', () => {
    const markdown = ['# 第一页', '', '😀 第一页内容', '', '# 第二页', '', '第二页内容'].join(
      '\r\n',
    );
    const first = markdown.indexOf('😀 第一页内容');
    const second = markdown.indexOf('第二页内容');
    const pageMap = [
      { page: 2, startOffset: first, endOffset: first + '😀 第一页内容'.length },
      { page: 3, startOffset: second, endOffset: second + '第二页内容'.length },
    ];

    const chunks = createParsingAdapter().chunkMarkdown(markdown, pageMap, {
      chunkTokens: 50,
      overlap: 0,
    });

    expect(chunks.map((chunk) => chunk.pageFrom)).toEqual([2, 3]);
  });
});

describe('createParsingAdapter().parse', () => {
  it('parses markdown locally and keeps headings in blocks', async () => {
    const parsed = await createParsingAdapter().parse({
      filename: 'notes.md',
      mimeType: 'text/markdown',
      data: Buffer.from('# 标题\n\n第一段内容。\n\n## 小节\n\n第二段内容。', 'utf8'),
    });
    expect(parsed.markdown).toContain('第一段内容');
    expect(parsed.pageMap).toEqual([]);
    expect(parsed.images).toEqual([]);
  });

  it('refuses a binary format when no parser service is configured', async () => {
    await expect(
      createParsingAdapter().parse({
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        data: Buffer.from('%PDF-1.4'),
      }),
    ).rejects.toThrow(/Docling/);
  });
});

describe('createParsingAdapter().chunkMarkdown', () => {
  const chunkForIngestion = createParsingAdapter().chunkMarkdown;
  it('keeps a fenced code block in one chunk', () => {
    const markdown = ['# 标题', '', '说明', '', '```ts', 'const a = 1;', '```'].join('\n');
    const chunks = chunkForIngestion(markdown, [], { chunkTokens: 50, overlap: 0 });
    const code = chunks.filter((chunk) => chunk.content.includes('const a = 1;'));
    expect(code).toHaveLength(1);
    expect(code[0]?.content).toContain('```');
    expect(code[0]?.heading).toBe('标题');
  });

  it('assigns page numbers from the page map instead of guessing', () => {
    const markdown = ['第一页内容', '', '第二页内容'].join('\n');
    const pageMap = [{ page: 3, startOffset: 0, endOffset: markdown.length }];
    const chunks = chunkForIngestion(markdown, pageMap, { chunkTokens: 50, overlap: 0 });
    expect(chunks.every((chunk) => chunk.pageFrom === 3)).toBe(true);
  });

  it('leaves page numbers empty when the page map does not cover the block', () => {
    const markdown = ['# A', '', '第一段。', '', '# B', '', '第二段。'].join('\n');
    const start = markdown.indexOf('第一段。');
    const pageMap = [{ page: 3, startOffset: start, endOffset: start + '第一段。'.length }];
    const chunks = chunkForIngestion(markdown, pageMap, { chunkTokens: 50, overlap: 0 });
    expect(chunks.find((chunk) => chunk.content.includes('第一段。'))?.pageFrom).toBe(3);
    expect(chunks.find((chunk) => chunk.content.includes('第二段。'))?.pageFrom).toBeNull();
  });

  it('bounds chunks by the character budget instead of a 4-chars-per-token guess', () => {
    const markdown = '中'.repeat(900);
    const chunks = chunkForIngestion(markdown, [], { chunkTokens: 200, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= 200)).toBe(true);
    expect(chunks.every((chunk) => chunk.pageFrom === null)).toBe(true);
  });

  it('splits an oversized table by rows and repeats the header in every part', () => {
    const rows = Array.from({ length: 40 }, (_, index) => `| 项目${index} | 说明${index} |`);
    const markdown = ['| 名称 | 说明 |', '| --- | --- |', ...rows].join('\n');
    const chunks = chunkForIngestion(markdown, [], { chunkTokens: 200, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(200);
      expect(chunk.content.startsWith('| 名称 | 说明 |\n| --- | --- |')).toBe(true);
      expect(chunk.content.includes('```')).toBe(false);
    }
    const rebuiltRows = chunks.flatMap((chunk) => chunk.content.split('\n').slice(2));
    expect(rebuiltRows).toEqual(rows);
  });

  it('splits an oversized fenced block into balanced fences without losing lines', () => {
    const code = Array.from({ length: 60 }, (_, index) => `const value${index} = ${index};`);
    const markdown = ['```ts', ...code, '```'].join('\n');
    const chunks = chunkForIngestion(markdown, [], { chunkTokens: 200, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(200);
      expect(chunk.content.startsWith('```ts\n')).toBe(true);
      expect(chunk.content.endsWith('\n```')).toBe(true);
    }
    const rebuilt = chunks.flatMap((chunk) => chunk.content.split('\n').slice(1, -1));
    expect(rebuilt).toEqual(code);
  });

  it('splits GFM tables without outer pipes and keeps them typed as tables', () => {
    const rows = Array.from({ length: 40 }, (_, index) => `项目${index} | 说明${index}`);
    const markdown = ['名称 | 说明', '--- | ---', ...rows].join('\n');
    const chunks = chunkForIngestion(markdown, [], { chunkTokens: 200, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.kind).toBe('table');
      expect(chunk.content.length).toBeLessThanOrEqual(200);
      expect(chunk.content.startsWith('名称 | 说明\n--- | ---')).toBe(true);
    }
    const rebuiltRows = chunks.flatMap((chunk) => chunk.content.split('\n').slice(2));
    expect(rebuiltRows).toEqual(rows);
  });

  it('splits tilde and longer fences by lines', () => {
    const code = Array.from({ length: 60 }, (_, index) => `const value${index} = ${index};`);
    const cases: Array<[string, string, string[], string]> = [
      [['~~~ts', ...code, '~~~'].join('\n'), '~~~ts', code, '~~~'],
      [
        ['````md', '```ts', ...code, '```', '````'].join('\n'),
        '````md',
        ['```ts', ...code, '```'],
        '````',
      ],
    ];

    for (const [markdown, opener, body, closer] of cases) {
      const chunks = chunkForIngestion(markdown, [], { chunkTokens: 200, overlap: 0 });
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(200);
        expect(chunk.content.startsWith(`${opener}\n`)).toBe(true);
        expect(chunk.content.endsWith(`\n${closer}`)).toBe(true);
      }
      expect(chunks.flatMap((chunk) => chunk.content.split('\n').slice(1, -1))).toEqual(body);
    }
  });

  it('does not mistake a table inside a fence for a table block', () => {
    const table = [
      '名称 | 说明',
      '--- | ---',
      ...Array.from({ length: 40 }, (_, index) => `项目${index} | 说明${index}`),
    ];
    const markdown = ['```md', ...table, '```'].join('\n');
    const chunks = chunkForIngestion(markdown, [], { chunkTokens: 200, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.kind).toBe('text');
      expect(chunk.content.startsWith('```md\n')).toBe(true);
      expect(chunk.content.endsWith('\n```')).toBe(true);
    }
    expect(chunks.flatMap((chunk) => chunk.content.split('\n').slice(1, -1))).toEqual(table);
  });
});
