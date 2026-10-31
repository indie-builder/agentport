import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createParsingAdapter } from '../src/knowledge/parsing-adapter.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/knowledge-parsing/${name}`, import.meta.url), 'utf8');

let server: Server;
let parserUrl = '';
let captured: Array<{ path: string; headers: IncomingMessage['headers'] }> = [];
let asrRequests: Array<{ headers: IncomingMessage['headers']; body: string }> = [];
let abortedRequests = 0;
let slowTranscribeAborts = 0;

// 1200 字符预算、200 重叠时，第二片的起点会落在 emoji 的低代理项上。
const longAudioText = `${'中'.repeat(999)}😀${'文'.repeat(400)}`;

/** 44 字节 WAV 头即可通过容器识别；这里只验证入口协议，不声称音频可解码。 */
function wavBytes(): Buffer {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(0, 40);
  return buffer;
}

const asrProfile = () => ({
  endpointUrl: `${parserUrl}/transcribe`,
  model: 'whisper-test',
  apiKey: 'asr-secret',
});

const audioInput = {
  filename: 'Talk.WAV',
  mimeType: 'audio/x-wav',
  data: wavBytes(),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url ?? '';
      captured.push({ path, headers: req.headers });
      // 慢服务：不响应，只有客户端断开连接才算结束。
      if (path === '/slow-transcribe') {
        req.on('close', () => {
          slowTranscribeAborts += 1;
        });
        return;
      }
      if (path.startsWith('/slow')) {
        req.on('close', () => {
          abortedRequests += 1;
        });
        return;
      }
      if (path === '/transcribe') {
        asrRequests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            text: '上游全文不应重复',
            duration: 6.5,
            segments: [
              { start: 0, end: 0.5, text: '会议开始。' },
              { start: 0.5, end: 1.25, text: '重复句' },
              { start: 1.25, end: 1.5, text: '   ' },
              { start: 1.5, end: 3.5, text: '重复句 😀' },
            ],
          }),
        );
        return;
      }
      if (path === '/transcribe-long') {
        asrRequests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            text: longAudioText,
            duration: 120,
            segments: [{ start: 1.5, end: 90.25, text: longAudioText }],
          }),
        );
        return;
      }
      if (path === '/transcribe-text') {
        asrRequests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: ' 只有正文\n第二行 ', duration: 3600 }));
        return;
      }
      const regression = /^\/regression-([a-z-]+)\/v1\/convert\/file$/.exec(path);
      if (regression) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(fixture(`docling-${regression[1]}.json`));
        return;
      }
      const name = path.startsWith('/crlf-repeat')
        ? 'docling-crlf-repeat.json'
        : path.startsWith('/crlf')
          ? 'docling-crlf-lines.json'
          : path.startsWith('/formatted-repeat')
            ? 'docling-formatted-repeat.json'
            : path.startsWith('/formatted')
              ? 'docling-formatted-text.json'
              : path.startsWith('/md-gap')
                ? 'docling-md-gap.json'
                : path.startsWith('/same-lines')
                  ? 'docling-same-lines.json'
                  : path.startsWith('/embedded-images')
                    ? 'docling-embedded-images.json'
                    : path.startsWith('/repeated')
                      ? 'docling-repeated.json'
                      : path.startsWith('/extra-repeat')
                        ? 'docling-markdown-extra-repeat.json'
                        : path.startsWith('/long-paragraph')
                          ? 'docling-long-paragraph.json'
                          : 'docling-success.json';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(fixture(name));
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

  it('keeps Docling page/bbox/ref and the real CRLF source offsets in chunks', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/crlf` });
    const parsed = await adapter.parse(doclingInput);

    expect(parsed.markdown).toBe('Alpha\r\nBeta tail.');
    expect(parsed.blocks?.[0]?.locator).toMatchObject({
      page: 3,
      startOffset: 0,
      endOffset: 'Alpha\r\nBeta'.length,
      line: 1,
    });
    expect(parsed.pageMap).toEqual([
      { page: 3, startOffset: 0, endOffset: 'Alpha\r\nBeta'.length },
    ]);
    // JSON 已覆盖 Alpha/Beta；Markdown 只补未覆盖的尾巴，不能把同一段落整段再发一次。
    expect(parsed.blocks?.map((block) => block.content)).toEqual(['Alpha\nBeta', 'tail.']);

    const chunks = adapter.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      {
        chunkTokens: 400,
        overlap: 0,
      },
      parsed.blocks,
    );
    expect(chunks.map((chunk) => chunk.content)).toEqual(['Alpha\nBeta\n\ntail.']);
    expect(chunks.find((chunk) => chunk.content.includes('Alpha'))?.locator).toMatchObject({
      pageFrom: 3,
      lineFrom: 1,
      startOffset: 0,
      endOffset: parsed.markdown.length,
    });
  });

  it('gives repeated identical Docling blocks distinct offsets instead of the first match', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/repeated` });
    const parsed = await adapter.parse(doclingInput);

    expect(parsed.blocks?.map((block) => block.locator)).toMatchObject([
      { page: 1, startOffset: 0, endOffset: 4 },
      { page: 2, startOffset: 6, endOffset: 10 },
      { page: 3, startOffset: 12, endOffset: 16 },
    ]);
    expect(parsed.pageMap).toEqual([
      { page: 1, startOffset: 0, endOffset: 4 },
      { page: 2, startOffset: 6, endOffset: 10 },
      { page: 3, startOffset: 12, endOffset: 16 },
    ]);
    const chunks = adapter.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      {
        chunkTokens: 400,
        overlap: 0,
      },
      parsed.blocks,
    );
    // 合并块保留首尾真实区间，不会把两次 "same" 都算成第一处。
    expect(chunks[0]?.locator).toMatchObject({ startOffset: 0, endOffset: 16 });
  });

  it('keeps a repeated Markdown occurrence the JSON never covered', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/extra-repeat` });
    const parsed = await adapter.parse(doclingInput);

    // JSON 只覆盖前两处 same；第三处按原文区间补入，不能按文本集合被当成重复删掉。
    expect(parsed.blocks?.map((block) => block.content)).toEqual(['same', 'same', 'same']);
    expect(parsed.blocks?.map((block) => block.locator)).toMatchObject([
      { page: 1, startOffset: 0, endOffset: 4 },
      { page: 2, startOffset: 6, endOffset: 10 },
      { page: 'unknown', startOffset: 12, endOffset: 16 },
    ]);
    const chunks = adapter.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      { chunkTokens: 400, overlap: 0 },
      parsed.blocks,
    );
    expect(chunks.map((chunk) => chunk.content)).toEqual(['same\n\nsame\n\nsame']);
  });

  it('splits a long Docling paragraph into exact UTF-16 source ranges over CRLF', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/long-paragraph` });
    const parsed = await adapter.parse(doclingInput);
    const chunks = adapter.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      { chunkTokens: 200, overlap: 20 },
      parsed.blocks,
    );

    expect(chunks.length).toBeGreaterThan(1);
    const lineAt = (offset: number) => parsed.markdown.slice(0, offset).split(/\r\n|\r|\n/).length;
    expect(chunks[0]?.locator.startOffset).toBe(0);
    expect(new Set(chunks.map((chunk) => chunk.locator.startOffset)).size).toBe(chunks.length);
    for (const chunk of chunks) {
      const { startOffset, endOffset, lineFrom } = chunk.locator as {
        startOffset: number;
        endOffset: number;
        lineFrom: number;
      };
      // CRLF 原文下标不能直接拿规范化后的文本下标相加。
      expect(parsed.markdown.slice(startOffset, endOffset).replace(/\r\n?/g, '\n')).toBe(
        chunk.content,
      );
      expect(lineFrom).toBe(lineAt(startOffset));
    }
    expect(chunks.at(-1)?.locator.endOffset).toBe(parsed.markdown.length);
  });

  it('drops the whole-block text range when a table is split by rows', () => {
    const rows = Array.from({ length: 40 }, (_, index) => `| 项目${index} | 说明${index} |`);
    const table = ['| 名称 | 说明 |', '| --- | --- |', ...rows].join('\n');
    const chunks = createParsingAdapter().chunkMarkdown(
      table,
      [],
      { chunkTokens: 200, overlap: 0 },
      [
        {
          content: table,
          heading: '',
          locator: {
            page: 2,
            ref: '#/tables/0',
            bbox: { l: 0, t: 0, r: 1, b: 1 },
            startOffset: 0,
            endOffset: table.length,
          },
        },
      ],
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // 整表 bbox/ref 仍如实保留，但分段文本不能冒充整表原文区间。
      expect(chunk.locator).toMatchObject({
        pageFrom: 2,
        parserRef: '#/tables/0',
        bbox: { left: 0, top: 0, right: 1, bottom: 1 },
      });
      expect(chunk.locator).not.toHaveProperty('startOffset');
      expect(chunk.locator).not.toHaveProperty('endOffset');
    }
  });

  it('carries a real table bbox/ref/offset through the block-aware chunker', async () => {
    const adapter = createParsingAdapter({ parserUrl });
    const parsed = await adapter.parse(doclingInput);
    const chunks = adapter.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      {
        chunkTokens: 400,
        overlap: 0,
      },
      parsed.blocks,
    );
    const table = chunks.find((chunk) => chunk.kind === 'table');
    const at = parsed.markdown.indexOf('| 指标 | 数值 |');
    expect(table?.locator).toMatchObject({
      pageFrom: 4,
      parserRef: '#/tables/0',
      bbox: { left: 0, top: 0, right: 9, bottom: 9 },
      startOffset: at,
      endOffset: at + '| 指标 | 数值 |\n| --- | --- |\n| 收入 | 100 |'.length,
    });
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

  it('keeps the real line, offset, page and heading path in the structured locator', () => {
    const markdown = ['# Alpha', '', 'first line', '', '## Beta', '', 'second line'].join('\n');
    const secondStart = markdown.indexOf('second line');
    const chunks = chunkForIngestion(
      markdown,
      [{ page: 3, startOffset: secondStart, endOffset: secondStart + 'second line'.length }],
      { chunkTokens: 400, overlap: 0 },
    );
    const first = chunks.find((chunk) => chunk.content.includes('first line'));
    expect(first?.locator).toMatchObject({
      lineFrom: 3,
      headingPath: ['Alpha'],
    });
    expect(typeof first?.locator?.startOffset).toBe('number');

    const second = chunks.find((chunk) => chunk.content.includes('second line'));
    expect(second?.locator).toMatchObject({
      pageFrom: 3,
      lineFrom: 7,
      headingPath: ['Alpha', 'Beta'],
    });
  });

  it('does not give a merged chunk a text range when one JSON block has no source position', () => {
    const chunks = chunkForIngestion('located', [], { chunkTokens: 400, overlap: 0 }, [
      { content: 'located', heading: '', locator: { startOffset: 0, endOffset: 7, line: 1 } },
      { content: 'JSON-only OCR', heading: '', locator: { page: 3, ref: '#/texts/1' } },
    ]);
    expect(chunks.map((chunk) => chunk.content)).toEqual(['located\n\nJSON-only OCR']);
    expect(chunks[0]?.locator).toMatchObject({ pageFrom: 3 });
    expect(chunks[0]?.locator).not.toHaveProperty('startOffset');
    expect(chunks[0]?.locator).not.toHaveProperty('endOffset');
    expect(chunks[0]?.locator).not.toHaveProperty('lineFrom');
  });

  it('bounds chunks by the character budget instead of a 4-chars-per-token guess', () => {
    const markdown = '中'.repeat(900);
    const chunks = chunkForIngestion(markdown, [], { chunkTokens: 200, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= 200)).toBe(true);
    expect(chunks.every((chunk) => chunk.pageFrom === null)).toBe(true);
  });

  it('keeps real source offsets through local Markdown parse -> chunk, including long CRLF paragraphs', async () => {
    const adapter = createParsingAdapter();
    const markdown = [
      '# 标题',
      '',
      '第一段内容。',
      '',
      '第二段',
      '内容。',
      '',
      `${'长段落内容'.repeat(60)}`,
    ].join('\r\n');
    const parsed = await adapter.parse({
      filename: 'notes.md',
      mimeType: 'text/markdown',
      data: Buffer.from(markdown),
    });
    const chunks = adapter.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      { chunkTokens: 200, overlap: 20 },
      parsed.blocks,
    );

    expect(parsed.blocks?.every((block) => typeof block.locator.startOffset === 'number')).toBe(
      true,
    );
    const lineAt = (offset: number) => markdown.slice(0, offset).split(/\r\n|\r|\n/).length;
    for (const chunk of chunks) {
      const { startOffset, endOffset, lineFrom } = chunk.locator as {
        startOffset: number;
        endOffset: number;
        lineFrom: number;
      };
      expect(typeof startOffset).toBe('number');
      expect(typeof endOffset).toBe('number');
      expect(markdown.slice(startOffset, endOffset).replace(/\r\n?/g, '\n')).toBe(chunk.content);
      expect(lineFrom).toBe(lineAt(startOffset));
    }
    const paragraph = parsed.blocks?.find((block) => block.content === '第二段\n内容。');
    expect(paragraph?.locator.startOffset).toBe(markdown.indexOf('第二段'));
    expect(paragraph?.locator.endOffset).toBe(
      markdown.indexOf('第二段') + '第二段\r\n内容。'.length,
    );
    expect(chunks.filter((chunk) => chunk.content.includes('长段落内容')).length).toBeGreaterThan(
      1,
    );
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

describe('createParsingAdapter().parse -> chunkMarkdown reading order', () => {
  it('regression: maps formatted JSON items within one paragraph without repeating body', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/regression-formatted-inline` });
    const parsed = await adapter.parse(doclingInput);
    const chunks = adapter.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      { chunkTokens: 400, overlap: 0 },
      parsed.blocks,
    );

    expect(chunks.map((chunk) => chunk.content)).toEqual(['Before **bold** after.\n\nTail']);
    expect(chunks[0]?.locator).toMatchObject({
      pageFrom: 2,
      pageTo: 3,
      startOffset: 0,
      endOffset: 27,
    });
    expect(parsed.blocks?.map((block) => block.locator)).toMatchObject([
      { page: 2, startOffset: 0, endOffset: 22, line: 1 },
      { page: 3, startOffset: 23, endOffset: 27, line: 2 },
    ]);
    expect(parsed.pageMap).toEqual([
      { page: 2, startOffset: 0, endOffset: 22 },
      { page: 3, startOffset: 23, endOffset: 27 },
    ]);
  });

  it('regression: associates formatted table cells with JSON while preserving raw Markdown', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/regression-formatted-table` });
    const parsed = await adapter.parse(doclingInput);
    const chunks = adapter.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      { chunkTokens: 400, overlap: 0 },
      parsed.blocks,
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      kind: 'table',
      content: parsed.markdown,
      pageFrom: 4,
      locator: {
        parserRef: '#/tables/0',
        bbox: { left: 1, top: 2, right: 3, bottom: 4 },
        startOffset: 0,
        endOffset: parsed.markdown.length,
      },
    });
    expect(parsed.pageMap).toEqual([
      { page: 4, startOffset: 0, endOffset: parsed.markdown.length },
    ]);
  });

  it('regression: inserts JSON-only OCR between its reliable reading-order anchors without offsets', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/regression-json-middle-ocr` });
    const parsed = await adapter.parse(doclingInput);
    const chunks = adapter.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      { chunkTokens: 400, overlap: 0 },
      parsed.blocks,
    );

    expect(chunks.map((chunk) => chunk.content)).toEqual(['first\n\nMIDDLE OCR\n\nlast']);
    expect(parsed.blocks?.map((block) => block.content)).toEqual(['first', 'MIDDLE OCR', 'last']);
    const ocr = parsed.blocks?.[1];
    expect(ocr?.locator).toMatchObject({ page: 2, ref: '#/texts/1' });
    for (const field of ['startOffset', 'endOffset', 'line']) {
      expect(ocr?.locator).not.toHaveProperty(field);
    }
    expect(chunks[0]?.locator).not.toHaveProperty('startOffset');
    expect(chunks[0]?.locator).not.toHaveProperty('endOffset');
    expect(parsed.pageMap).toEqual([
      { page: 1, startOffset: 0, endOffset: 5 },
      { page: 3, startOffset: 7, endOffset: 11 },
    ]);
  });

  it('maps display text through formatting boundaries, escapes, entities, CRLF and emoji', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/regression-display-source` });
    const parsed = await adapter.parse(doclingInput);
    const expected = [
      '😀 **bold**',
      'after.',
      'Tail',
      'Prefix [link](https://example.com) &amp; `code` tail.',
      'Next',
      'Escaped \\*star\\* text.',
    ];
    expect(parsed.blocks?.map((block) => block.content)).toEqual(expected);
    expect(parsed.pageMap.map((range) => range.page)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const [index, range] of parsed.pageMap.entries()) {
      expect(parsed.markdown.slice(range.startOffset, range.endOffset)).toBe(expected[index]);
    }
    const chunks = adapter.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      { chunkTokens: 400, overlap: 0 },
      parsed.blocks,
    );
    expect(chunks.map((chunk) => chunk.content)).toEqual([expected.join('\n\n')]);
    expect(chunks[0]?.locator).toMatchObject({ pageFrom: 1, pageTo: 6 });
  });

  it('keeps a Markdown-only paragraph between the JSON blocks in original order', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/md-gap` });
    const parsed = await adapter.parse(doclingInput);

    expect(parsed.blocks?.map((block) => block.content)).toEqual(['first', 'MIDDLE', 'last']);
    expect(parsed.blocks?.map((block) => block.locator)).toMatchObject([
      { startOffset: 0, endOffset: 5 },
      { startOffset: 7, endOffset: 13 },
      { startOffset: 15, endOffset: 19 },
    ]);
    for (const block of parsed.blocks ?? []) {
      const { startOffset, endOffset } = block.locator as {
        startOffset: number;
        endOffset: number;
      };
      // 每个块的位置必须落在原文对应的切片上。
      expect(parsed.markdown.slice(startOffset, endOffset)).toBe(block.content);
    }

    const chunks = adapter.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      { chunkTokens: 400, overlap: 0 },
      parsed.blocks,
    );
    expect(chunks.map((chunk) => chunk.content)).toEqual(['first\n\nMIDDLE\n\nlast']);
  });

  it('keeps an embedded image between the body paragraphs around it', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/embedded-images` });
    const parsed = await adapter.parse(doclingInput);
    const image = '![image-1.png](images/image-1.png)';

    const body = (parsed.blocks ?? [])
      .map((block) => block.content)
      .filter((content) => content === '正文。' || content === image || content === '图片之后。');
    expect(body).toEqual(['正文。', image, '图片之后。']);

    const chunks = adapter.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      { chunkTokens: 400, overlap: 0 },
      parsed.blocks,
    );
    expect(chunks.map((chunk) => chunk.content)).toEqual([
      '正文。\n\n![image-1.png](images/image-1.png)\n\n图片之后。',
    ]);
  });

  it('keeps the original formatted Markdown body and the JSON bbox/ref/page', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/formatted` });
    const parsed = await adapter.parse(doclingInput);

    // JSON 文本丢掉了 ** 标记；正文仍要用原文，只在同一处挂上 JSON 的定位信息。
    expect(parsed.blocks?.map((block) => block.content)).toEqual(['Before **bold** after.']);
    expect(parsed.blocks?.[0]?.locator).toMatchObject({
      page: 2,
      ref: '#/texts/0',
      bbox: { l: 1, t: 2, r: 3, b: 4 },
      startOffset: 0,
      endOffset: 'Before **bold** after.'.length,
    });

    const chunks = adapter.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      { chunkTokens: 400, overlap: 0 },
      parsed.blocks,
    );
    expect(chunks.map((chunk) => chunk.content)).toEqual(['Before **bold** after.']);
    expect(chunks[0]?.locator).toMatchObject({
      pageFrom: 2,
      parserRef: '#/texts/0',
      bbox: { left: 1, top: 2, right: 3, bottom: 4 },
      startOffset: 0,
      endOffset: 'Before **bold** after.'.length,
    });
  });

  it('keeps both formatted occurrences instead of deduping them globally', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/formatted-repeat` });
    const parsed = await adapter.parse(doclingInput);

    expect(parsed.blocks?.map((block) => block.content)).toEqual([
      'Before **bold** after.',
      'Before **bold** after.',
    ]);
    expect(parsed.blocks?.map((block) => block.locator)).toMatchObject([
      { page: 1, ref: '#/texts/0', startOffset: 0, endOffset: 22 },
      { page: 2, ref: '#/texts/1', startOffset: 24, endOffset: 46 },
    ]);

    const chunks = adapter.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      { chunkTokens: 400, overlap: 0 },
      parsed.blocks,
    );
    expect(chunks.map((chunk) => chunk.content)).toEqual([
      'Before **bold** after.\n\nBefore **bold** after.',
    ]);
  });

  it('maps a page to the second identical CRLF paragraph, not the first', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/crlf-repeat` });
    const parsed = await adapter.parse(doclingInput);

    expect(parsed.markdown).toBe(
      'A real repeated paragraph.\r\nSecond line.\r\n\r\nA real repeated paragraph.\r\nSecond line.',
    );
    // 第一段没有页码，pageMap 只能落在第二段原文区间。
    expect(parsed.pageMap).toEqual([{ page: 2, startOffset: 44, endOffset: 84 }]);
    expect(parsed.blocks?.map((block) => block.locator)).toMatchObject([
      { startOffset: 0, endOffset: 40 },
      { startOffset: 44, endOffset: 84 },
    ]);
    for (const block of parsed.blocks ?? []) {
      const { startOffset, endOffset } = block.locator as {
        startOffset: number;
        endOffset: number;
      };
      expect(parsed.markdown.slice(startOffset, endOffset).replace(/\r\n?/g, '\n')).toBe(
        block.content,
      );
    }
  });

  it('gives repeated identical lines their own sequential source ranges', async () => {
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/same-lines` });
    const parsed = await adapter.parse(doclingInput);

    expect(parsed.markdown).toBe('same\nsame\n\nsame');
    expect(parsed.pageMap).toEqual([
      { page: 1, startOffset: 0, endOffset: 4 },
      { page: 2, startOffset: 5, endOffset: 9 },
      { page: 3, startOffset: 11, endOffset: 15 },
    ]);
    expect(parsed.blocks?.map((block) => block.locator)).toMatchObject([
      { startOffset: 0, endOffset: 4 },
      { startOffset: 5, endOffset: 9 },
      { startOffset: 11, endOffset: 15 },
    ]);
  });
});

describe('createParsingAdapter audio branch', () => {
  it('transcribes real multipart audio and keeps exact UTF-16 offsets plus segment times', async () => {
    captured = [];
    asrRequests = [];
    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/docling-should-not-run` });
    const parsed = await adapter.parse({
      ...audioInput,
      asr: asrProfile(),
      asrProfileName: '默认 ASR',
    });

    // 实际音频优先于 Docling，不把二进制送解析服务。
    expect(captured.map((entry) => entry.path)).toEqual(['/transcribe']);
    expect(parsed.markdown).toBe('会议开始。\n\n重复句\n\n重复句 😀');
    // 重复句与 emoji 各自按拼接位置独立计偏移；空白段不产块但保留上游下标。
    expect(parsed.blocks).toEqual([
      {
        content: '会议开始。',
        heading: '',
        locator: {
          startOffset: 0,
          endOffset: 5,
          timeFromMs: 0,
          timeToMs: 500,
          ref: 'asr:segment:0',
        },
      },
      {
        content: '重复句',
        heading: '',
        locator: {
          startOffset: 7,
          endOffset: 10,
          timeFromMs: 500,
          timeToMs: 1250,
          ref: 'asr:segment:1',
        },
      },
      {
        content: '重复句 😀',
        heading: '',
        locator: {
          startOffset: 12,
          endOffset: 18,
          timeFromMs: 1500,
          timeToMs: 3500,
          ref: 'asr:segment:3',
        },
      },
    ]);
    expect(parsed.audio).toEqual({
      protocol: 'openai_transcriptions',
      profileName: '默认 ASR',
      model: 'whisper-test',
      durationMs: 6500,
      segments: [
        { startOffset: 0, endOffset: 5, timeFromMs: 0, timeToMs: 500 },
        { startOffset: 7, endOffset: 10, timeFromMs: 500, timeToMs: 1250 },
        { startOffset: 12, endOffset: 18, timeFromMs: 1500, timeToMs: 3500 },
      ],
    });

    const request = asrRequests[0];
    expect(request?.headers.authorization).toBe('Bearer asr-secret');
    // 声明别名与小写后缀会被入口换成 canonical MIME / 真实后缀。
    expect(request?.body).toContain('filename="Talk.wav"');
    expect(request?.body).toMatch(/content-type: audio\/wav/i);
    expect(request?.body).toContain('name="model"\r\n\r\nwhisper-test');
    expect(request?.body).toContain('name="response_format"\r\n\r\nverbose_json');
    expect(request?.body).toContain('name="timestamp_granularities[]"\r\n\r\nsegment');
  });

  it('keeps long audio overlap starts and ends on complete code points', async () => {
    const adapter = createParsingAdapter();
    const parsed = await adapter.parse({
      ...audioInput,
      asr: { endpointUrl: `${parserUrl}/transcribe-long`, model: 'whisper-test' },
      asrProfileName: '默认 ASR',
    });
    expect(parsed.markdown.isWellFormed()).toBe(true);

    const chunks = adapter.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      { chunkTokens: 1200, overlap: 200 },
      parsed.blocks,
    );

    // 第二片从 emoji 开始，而不是从它的低代理项开始。
    expect(chunks.map((chunk) => chunk.content)).toEqual([
      `${'中'.repeat(999)}😀${'文'.repeat(199)}`,
      `😀${'文'.repeat(400)}`,
    ]);
    for (const chunk of chunks) {
      expect(chunk.content.isWellFormed()).toBe(true);
      const { startOffset, endOffset, timeFromMs, timeToMs } = chunk.locator as {
        startOffset: number;
        endOffset: number;
        timeFromMs: number;
        timeToMs: number;
      };
      // 区间仍是原文 UTF-16 下标；逐字切片必须精确等于分片内容。
      expect(parsed.markdown.slice(startOffset, endOffset)).toBe(chunk.content);
      // 每片沿用整段的真实时码，不按字数插值。
      expect({ timeFromMs, timeToMs }).toEqual({ timeFromMs: 1500, timeToMs: 90_250 });
    }
  });

  it('indexes text-only transcripts without inventing timing from duration', async () => {
    captured = [];
    const adapter = createParsingAdapter();
    const parsed = await adapter.parse({
      ...audioInput,
      asr: { endpointUrl: `${parserUrl}/transcribe-text`, model: 'whisper-test' },
      asrProfileName: '默认 ASR',
    });

    expect(parsed.markdown).toBe('只有正文\n第二行');
    expect(parsed.blocks).toEqual([
      { content: '只有正文\n第二行', heading: '', locator: { startOffset: 0, endOffset: 8 } },
    ]);
    expect(parsed.audio).toEqual({
      protocol: 'openai_transcriptions',
      profileName: '默认 ASR',
      model: 'whisper-test',
      durationMs: 3_600_000,
      segments: [],
    });
    expect(parsed.blocks?.[0]?.locator).not.toHaveProperty('timeFromMs');
  });

  it('fails clearly before any request when the base has no usable ASR profile', async () => {
    captured = [];
    asrRequests = [];
    const adapter = createParsingAdapter({ parserUrl });

    await expect(adapter.parse(audioInput)).rejects.toMatchObject({
      name: 'KnowledgeParseError',
      code: 'invalid_input',
      message: '知识库没有可用的音频转录模型',
    });
    expect(captured).toHaveLength(0);
    expect(asrRequests).toHaveLength(0);
  });

  it('rejects real audio disguised as text instead of sending it to Docling', async () => {
    captured = [];
    const adapter = createParsingAdapter({ parserUrl });
    await expect(
      adapter.parse({
        filename: 'notes.txt',
        mimeType: 'text/plain',
        data: wavBytes(),
        asr: asrProfile(),
        asrProfileName: '默认 ASR',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(captured).toHaveLength(0);
  });

  it('releases the transcription request when the caller aborts', async () => {
    captured = [];
    const before = slowTranscribeAborts;
    const adapter = createParsingAdapter();
    const controller = new AbortController();
    const pending = adapter.parse({
      ...audioInput,
      asr: { endpointUrl: `${parserUrl}/slow-transcribe`, model: 'whisper-test' },
      asrProfileName: '默认 ASR',
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: 'KnowledgeParseError',
      code: 'aborted',
    });
    const deadline = Date.now() + 2_000;
    while (slowTranscribeAborts === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(slowTranscribeAborts).toBe(before + 1);
  });
});
