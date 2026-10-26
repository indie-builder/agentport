import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chunkDocument,
  KnowledgeParseError,
  type ParsedDocument,
  parseDocument,
} from '../src/knowledge/parsing.js';

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/knowledge-parsing/${name}`, import.meta.url));
const fixtureBytes = (name: string): Uint8Array => new Uint8Array(fixture(name));

/** Docling fixtures are served by a real HTTP server so the request shape is exercised for real. */
let server: ReturnType<typeof createServer>;
let parserUrl: string;
let captured: Array<{ path: string; headers: IncomingMessage['headers']; body: Buffer }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url ?? '';
      captured.push({ path, headers: req.headers, body: Buffer.concat(chunks) });
      const route = path.replace(/\/v1\/convert\/file$/, '');
      if (route === '/redirect') {
        res.writeHead(302, { location: '/success/v1/convert/file' });
        res.end();
        return;
      }
      if (route === '/http-error') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('docling exploded');
        return;
      }
      if (route === '/slow') return;
      const body = fixture(
        route === '/json-only'
          ? 'docling-json-only.json'
          : route === '/partial'
            ? 'docling-partial.json'
            : route === '/failure'
              ? 'docling-failure.json'
              : route === '/skipped'
                ? 'docling-skipped.json'
                : route === '/md-blocks'
                  ? 'docling-md-only-blocks.json'
                  : route === '/pictures'
                    ? 'docling-pictures.json'
                    : route === '/invalid'
                      ? 'docling-invalid.json'
                      : 'docling-success.json',
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
  parserUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type MultipartPart = { name: string; filename: string | null; value: Buffer };

function multipartParts(body: Buffer, contentType: string | undefined): MultipartPart[] {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? '');
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) throw new Error(`missing multipart boundary in ${contentType}`);
  const raw = body.toString('latin1');
  return raw
    .split(`--${boundary}`)
    .slice(1)
    .filter((part) => !part.startsWith('--'))
    .map((part) => {
      const trimmed = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
      const split = trimmed.indexOf('\r\n\r\n');
      const headers = trimmed.slice(0, split);
      const value = Buffer.from(trimmed.slice(split + 4), 'latin1');
      const name = /name="([^"]*)"/.exec(headers)?.[1] ?? '';
      const filename = /filename="([^"]*)"/.exec(headers)?.[1] ?? null;
      return { name, filename, value };
    });
}

describe('parseDocument native formats', () => {
  it('keeps markdown heading levels and whole code/table blocks', async () => {
    const bytes = fixtureBytes('sample.md');
    const parsed = await parseDocument({
      bytes,
      filename: 'sample.md',
      mimeType: 'text/markdown',
    });

    expect(parsed.markdown).toBe(new TextDecoder().decode(bytes));
    expect(parsed.blocks.map((block) => [block.heading, block.content.split('\n')[0]])).toEqual([
      ['产品说明', '第一段中文内容。'],
      ['产品说明 > 安装', '使用 pnpm 安装。'],
      ['产品说明 > 安装', '```bash'],
      ['产品说明 > 数据', '| 名称 | 数量 |'],
      ['产品说明 > 数据', '最后一段。'],
    ]);
    expect(parsed.blocks[2]?.content).toBe('```bash\npnpm install\n```');
    expect(parsed.blocks[3]?.content).toContain('| 苹果 | 3 |');
    expect(parsed.blocks[0]?.locator).toMatchObject({ page: 'unknown', line: 3 });
  });

  it('splits plain text into paragraph blocks', async () => {
    const parsed = await parseDocument({
      bytes: fixtureBytes('sample.txt'),
      filename: 'notes.txt',
      mimeType: 'text/plain',
    });

    expect(parsed.blocks.map((block) => block.content)).toEqual(['第一段文本。', '第二段文本。']);
    expect(parsed.blocks.every((block) => block.heading === '')).toBe(true);
  });

  it('renders CSV as a markdown table without corrupting quotes or pipes', async () => {
    const parsed = await parseDocument({
      bytes: fixtureBytes('sample.csv'),
      filename: 'data.csv',
      mimeType: 'text/csv',
    });

    expect(parsed.markdown).toBe(
      [
        '| 名称 | 数量 |',
        '| --- | --- |',
        '| 苹果 | 3 |',
        '| 香蕉 | 5 |',
        '| 备注 | 红, 甜 |',
        '| 竖线 | A\\|B |',
      ].join('\n'),
    );
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]?.locator).toEqual({ page: 'unknown', kind: 'csv', rows: 4 });
  });

  it('pretty-prints JSON in a fenced block', async () => {
    const parsed = await parseDocument({
      bytes: fixtureBytes('sample.json'),
      filename: 'data.json',
      mimeType: 'application/json',
    });

    expect(parsed.markdown).toBe(
      [
        '```json',
        '{',
        '  "name": "知识库",',
        '  "items": [',
        '    1,',
        '    2',
        '  ]',
        '}',
        '```',
      ].join('\n'),
    );
    expect(parsed.blocks[0]?.heading).toBe('');
  });

  it('converts HTML headings, code and tables while dropping chrome', async () => {
    const parsed = await parseDocument({
      bytes: fixtureBytes('sample.html'),
      filename: 'help.html',
      mimeType: 'text/html',
    });

    expect(parsed.markdown).toContain('# 帮助中心');
    expect(parsed.markdown).toContain('## 安装步骤');
    expect(parsed.markdown).toContain('```bash\npnpm install\n```');
    expect(parsed.markdown).toContain('| 步骤 | 说明 |');
    expect(parsed.markdown).toContain('| 1 | 安装依赖 |');
    for (const dropped of ['菜单', '版权', 'alert(1)', '页面标题', 'color: red']) {
      expect(parsed.markdown).not.toContain(dropped);
    }
    expect(parsed.blocks.find((block) => block.content.includes('欢迎使用'))?.heading).toBe(
      '帮助中心',
    );
    expect(
      parsed.blocks.find((block) => block.content.includes('| 1 | 安装依赖 |'))?.locator,
    ).toMatchObject({ page: 'unknown' });
  });

  it('rejects malformed JSON with an explicit error', async () => {
    await expect(
      parseDocument({
        bytes: new TextEncoder().encode('{ nope'),
        filename: 'broken.json',
        mimeType: 'application/json',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('refuses complex formats without a Docling service', async () => {
    await expect(
      parseDocument({
        bytes: new TextEncoder().encode('%PDF-1.7'),
        filename: 'scan.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ code: 'parser_unavailable' });
  });
});

describe('parseDocument standalone images', () => {
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  // 真实可解码的 3x2 小图：magic 之后的视觉校验会真的解码，fixture 不能再是截断头。
  const cases: Array<[string, Buffer, string]> = [
    ['png', TINY_PNG, 'image/png'],
    [
      'jpg',
      Buffer.from(
        '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDgKKKK+eP2E//Z',
        'base64',
      ),
      'image/jpeg',
    ],
    [
      'gif',
      Buffer.from('R0lGODdhAwACAIEAAMwAAMwzMwAAAAAAACwAAAAAAwACAAAICAADAAggMEBAADs=', 'base64'),
      'image/gif',
    ],
    [
      'webp',
      Buffer.from(
        'UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoDAAIAAUAmJaACdLoABDAAAP7x3I/4DdfFtMv/vYL/3YL/3YL/WwAA',
        'base64',
      ),
      'image/webp',
    ],
  ];

  for (const [extension, bytes, mimeType] of cases) {
    it(`accepts a real ${mimeType} by magic and keeps it on the parsed.images path`, async () => {
      const parsed = await parseDocument({ bytes, filename: `upload.${extension}`, mimeType });
      expect(parsed.images).toHaveLength(1);
      expect(parsed.images[0]?.mimeType).toBe(mimeType);
      expect(parsed.images[0]?.page).toBe(1);
      expect(Buffer.from(parsed.images[0]?.data ?? [])).toEqual(bytes);
      // 独立图片同样产出安全相对引用，走与 Docling 图一致的后处理。
      expect(parsed.markdown).toBe(
        `![${parsed.images[0]?.name}](images/${parsed.images[0]?.name})`,
      );
      expect(parsed.images[0]?.name).not.toContain('/');
    });
  }

  it('rejects a truncated standalone image instead of releasing it to the vision model', async () => {
    // 只有 magic 头的截断文件曾经被标成 real image 并成功发布；现在必须在入口失败。
    for (const [extension, bytes, mimeType] of [
      ['png', TINY_PNG.subarray(0, TINY_PNG.length - 8), 'image/png'],
      ['jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), 'image/jpeg'],
      ['gif', Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), 'image/gif'],
      [
        'webp',
        Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]),
        'image/webp',
      ],
    ] as Array<[string, Buffer, string]>) {
      await expect(
        parseDocument({ bytes, filename: `broken.${extension}`, mimeType }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });

  it('rejects a declared image MIME that contradicts the real bytes', async () => {
    await expect(
      parseDocument({ bytes: TINY_PNG, filename: 'fake.jpg', mimeType: 'image/jpeg' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects image MIME without a recognized magic instead of mislabeling it', async () => {
    await expect(
      parseDocument({
        bytes: Buffer.from('BM fake bitmap'),
        filename: 'scan.bmp',
        mimeType: 'image/bmp',
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('parseDocument Docling', () => {
  it('sends the documented multipart request and maps pages from the JSON body', async () => {
    captured = [];
    const bytes = new TextEncoder().encode('%PDF-1.7 fake bytes');
    const parsed = await parseDocument({
      bytes,
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/success`,
      parserKey: 'docling-secret',
    });

    expect(captured[0]?.path).toBe('/success/v1/convert/file');
    expect(captured[0]?.headers['x-api-key']).toBe('docling-secret');
    const parts = multipartParts(
      captured[0]?.body ?? Buffer.alloc(0),
      String(captured[0]?.headers['content-type'] ?? ''),
    );
    const file = parts.find((part) => part.name === 'files');
    expect(file?.filename).toBe('report.pdf');
    expect(file?.value.equals(Buffer.from(bytes))).toBe(true);
    expect(
      parts.filter((part) => part.name === 'to_formats').map((part) => part.value.toString()),
    ).toEqual(['md', 'json']);
    expect(parts.find((part) => part.name === 'do_ocr')?.value.toString()).toBe('true');
    expect(parts.find((part) => part.name === 'do_table_structure')?.value.toString()).toBe('true');

    expect(parsed.markdown).toContain('# 季度报告');
    expect(parsed.markdown).toContain('未匹配的段落。');
    expect(
      parsed.blocks.map((block) => [block.heading, block.content, block.locator.page]),
    ).toEqual([
      ['季度报告', '第一段内容。', 2],
      ['季度报告', ['| 指标 | 数值 |', '| --- | --- |', '| 收入 | 100 |'].join('\n'), 4],
      ['季度报告', '附加说明', 3],
      ['季度报告', '未匹配的段落。', 'unknown'],
    ]);
    expect(parsed.blocks[0]?.locator).toMatchObject({ ref: '#/texts/1', page: 2 });
  });

  it('builds markdown from JSON items when md_content is empty so tables survive', async () => {
    const parsed = await parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'sheet.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/json-only`,
    });

    expect(parsed.markdown).toContain('仅 JSON 的内容');
    expect(parsed.markdown).toContain('| 键 | 值 |');
    expect(parsed.blocks.map((block) => block.locator)).toEqual([
      { page: 7, bbox: { l: 0, t: 0, r: 5, b: 5 }, ref: '#/texts/0' },
      { page: 'unknown', ref: '#/texts/1' },
      { page: 8, bbox: { l: 0, t: 0, r: 5, b: 5 }, ref: '#/tables/0' },
    ]);
  });

  it('keeps markdown-only tables and quotes the JSON body never referenced', async () => {
    const parsed = await parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/md-blocks`,
    });

    const contents = parsed.blocks.map((block) => block.content);
    expect(contents).toContain('正文段落。');
    expect(contents).toContain(['| 环境 | 地址 |', '| --- | --- |', '| 测试 | dev |'].join('\n'));
    expect(contents).toContain('> 引用块只在 Markdown 里');
    expect(contents).not.toContain('# 报表');
    // The JSON title already set the breadcrumb; the markdown-only table has no page of its own.
    expect(parsed.blocks.find((block) => block.content.startsWith('|'))?.heading).toBe(
      '报表 > 环境',
    );
    expect(parsed.blocks.find((block) => block.content.startsWith('|'))?.locator).toEqual({
      page: 'unknown',
    });
  });

  it('surfaces partial_success errors instead of silently accepting content', async () => {
    const failure = parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'partial.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/partial`,
    });

    await expect(failure).rejects.toMatchObject({ code: 'partial_success' });
    await expect(failure).rejects.toThrow(/ocr failed on page 2/);
  });

  it('surfaces upstream failure and unsupported results', async () => {
    await expect(
      parseDocument({
        bytes: new TextEncoder().encode('fake'),
        filename: 'broken.pdf',
        mimeType: 'application/pdf',
        parserUrl: `${parserUrl}/failure`,
      }),
    ).rejects.toThrow(/conversion crashed/);

    await expect(
      parseDocument({
        bytes: new TextEncoder().encode('fake'),
        filename: 'audio.mp3',
        mimeType: 'audio/mpeg',
        parserUrl: `${parserUrl}/skipped`,
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('rejects an invalid response body at the boundary', async () => {
    await expect(
      parseDocument({
        bytes: new TextEncoder().encode('fake'),
        filename: 'bad.pdf',
        mimeType: 'application/pdf',
        parserUrl: `${parserUrl}/invalid`,
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('extracts inline data-URI pictures with real bytes and page numbers, never fetching remote URLs', async () => {
    const parsed = await parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'album.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/pictures`,
    });

    expect(parsed.markdown).toContain('# 图册');
    expect(parsed.images.map((image) => [image.name, image.mimeType, image.page])).toEqual([
      ['image-1.png', 'image/png', 5],
    ]);
    const [image] = parsed.images;
    if (!image) throw new Error('picture fixture lost its image');
    expect(Buffer.from(image.data).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // 图片不在 markdown 里，不产生字符区间；只有正文块给出页码。远程 URI 与缺页图片都被丢弃。
    expect(parsed.pageMap).toEqual([
      {
        page: 1,
        startOffset: parsed.markdown.indexOf('正文。'),
        endOffset: parsed.markdown.indexOf('正文。') + 3,
      },
    ]);
  });

  it('builds a page map over the exact markdown offsets Docling returned', async () => {
    const parsed = await parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/success`,
    });

    const expected = [
      {
        page: 2,
        startOffset: parsed.markdown.indexOf('第一段内容。'),
        endOffset: parsed.markdown.indexOf('第一段内容。') + '第一段内容。'.length,
      },
      {
        page: 4,
        startOffset: parsed.markdown.indexOf('| 指标 | 数值 |'),
        endOffset: parsed.markdown.indexOf('| 收入 | 100 |') + '| 收入 | 100 |'.length,
      },
    ];
    expect(parsed.pageMap).toEqual(expected);
    expect(parsed.images).toEqual([]);
    // 标题和未匹配段落没有可靠页码，不得出现在页码表里。
    expect(parsed.pageMap).toHaveLength(2);
  });

  it('reports upstream HTTP failures with status', async () => {
    await expect(
      parseDocument({
        bytes: new TextEncoder().encode('fake'),
        filename: 'bad.pdf',
        mimeType: 'application/pdf',
        parserUrl: `${parserUrl}/http-error`,
      }),
    ).rejects.toMatchObject({ code: 'upstream_http' });
  });

  it('does not follow redirects', async () => {
    await expect(
      parseDocument({
        bytes: new TextEncoder().encode('fake'),
        filename: 'moved.pdf',
        mimeType: 'application/pdf',
        parserUrl: `${parserUrl}/redirect`,
      }),
    ).rejects.toMatchObject({ code: 'redirect' });
  });

  it('honours caller abort signals', async () => {
    const controller = new AbortController();
    const pending = parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'slow.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/slow`,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(KnowledgeParseError);
  });
});

describe('chunkDocument', () => {
  const block = (
    content: string,
    heading: string,
    locator: Record<string, unknown> = { page: 'unknown' },
  ) => ({ content, heading, locator });

  it('merges neighbouring blocks under one heading and flushes on heading change', () => {
    const parsed: ParsedDocument = {
      markdown: '',
      images: [],
      pageMap: [],
      blocks: [
        block('短段落一', 'A', { page: 1 }),
        block('短段落二', 'A', { page: 2 }),
        block('标题B内容', 'B', { page: 3 }),
      ],
    };

    const chunks = chunkDocument(parsed, { chunkSize: 1000, chunkOverlap: 0 });

    expect(chunks.map((chunk) => [chunk.heading, chunk.content])).toEqual([
      ['A', '短段落一\n\n短段落二'],
      ['B', '标题B内容'],
    ]);
    expect(chunks[0]?.locator).toMatchObject({ page: 1, pageTo: 2 });
    expect(chunks[1]?.locator).toMatchObject({ page: 3 });
  });

  it('splits a long Chinese block with a deterministic overlap and explicit ranges', () => {
    const text = '这是一段很长的中文内容。'.repeat(20);
    const parsed: ParsedDocument = {
      markdown: '',
      images: [],
      pageMap: [],
      blocks: [block(text, '测试 > 小节', { page: 3 })],
    };

    const chunks = chunkDocument(parsed, { chunkSize: 80, chunkOverlap: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.heading === '测试 > 小节')).toBe(true);
    expect(chunks.every((chunk) => chunk.content.length <= 80)).toBe(true);
    expect(chunks[0]?.content.slice(-20)).toBe(chunks[1]?.content.slice(0, 20));
    for (let i = 1; i < chunks.length; i += 1) {
      const previous = chunks[i - 1]?.locator as { charStart: number; charEnd: number };
      const current = chunks[i]?.locator as { charStart: number; charEnd: number };
      expect(current.charStart).toBe(previous.charEnd - 20);
      expect(previous.charEnd - previous.charStart).toBeLessThanOrEqual(80);
    }
    expect(chunks.at(-1)?.locator).toMatchObject({ page: 3, charEnd: text.length });
  });

  it('never splits tables or fenced code even when they exceed the chunk size', () => {
    const table = ['| 名称 | 数量 |', '| --- | --- |', '| 苹果 | 3 |', '| 香蕉 | 5 |'].join('\n');
    const code = '```ts\nconst answer = 42;\nconsole.log(answer);\n```';
    const parsed: ParsedDocument = {
      markdown: '',
      images: [],
      pageMap: [],
      blocks: [block(table, '数据', { page: 5 }), block(code, '代码', { page: 6 })],
    };

    const chunks = chunkDocument(parsed, { chunkSize: 20, chunkOverlap: 5 });

    expect(chunks.map((chunk) => chunk.content)).toEqual([table, code]);
    expect(chunks[0]?.locator).not.toHaveProperty('charStart');
  });

  it('does not cut a surrogate pair when splitting long text', () => {
    const text = `${'a'.repeat(9)}😀${'b'.repeat(20)}`;
    const parsed: ParsedDocument = {
      markdown: '',
      images: [],
      pageMap: [],
      blocks: [block(text, 'A')],
    };

    const chunks = chunkDocument(parsed, { chunkSize: 10, chunkOverlap: 0 });

    expect(chunks.map((chunk) => chunk.content).join('')).toBe(text);
    expect(chunks.every((chunk) => !/^[\udc00-\udfff]/.test(chunk.content))).toBe(true);
  });

  it('drops empty blocks and never silently truncates content', () => {
    const long = 'x'.repeat(300);
    const parsed: ParsedDocument = {
      markdown: '',
      images: [],
      pageMap: [],
      blocks: [block('   ', 'A'), block(long, 'A')],
    };

    const chunks = chunkDocument(parsed, { chunkSize: 100, chunkOverlap: 10 });

    expect(chunks.every((chunk) => chunk.content.length > 0)).toBe(true);
    // Removing each chunk's known overlap must rebuild the block exactly: no dropped tail.
    const rebuilt = chunks
      .map((chunk, index) => (index === 0 ? chunk.content : chunk.content.slice(10)))
      .join('');
    expect(rebuilt).toBe(long);
    expect((chunks.at(-1)?.locator as { charEnd: number } | undefined)?.charEnd).toBe(long.length);
  });
});
