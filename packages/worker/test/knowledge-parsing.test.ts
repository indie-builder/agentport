import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chunkDocument,
  KnowledgeParseError,
  type ParsedDocument,
  parseDocument,
} from '../src/knowledge/parsing.js';
import { createParsingAdapter } from '../src/knowledge/parsing-adapter.js';

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
        route === '/json-only-heading'
          ? 'docling-json-only-heading.json'
          : route === '/json-only'
            ? 'docling-json-only.json'
            : route === '/partial'
              ? 'docling-partial.json'
              : route === '/failure'
                ? 'docling-failure.json'
                : route === '/skipped'
                  ? 'docling-skipped.json'
                  : route === '/md-blocks'
                    ? 'docling-md-only-blocks.json'
                    : route === '/dedup'
                      ? 'docling-dedup-blocks.json'
                      : route === '/pictures'
                        ? 'docling-pictures.json'
                        : route === '/embedded-images'
                          ? 'docling-embedded-images.json'
                          : route === '/null-markdown'
                            ? 'docling-null-markdown.json'
                            : route === '/null-json'
                              ? 'docling-null-json.json'
                              : route === '/invalid-errors'
                                ? 'docling-invalid-errors.json'
                                : route === '/invalid'
                                  ? 'docling-invalid.json'
                                  : route === '/fence-trailing'
                                    ? 'docling-fence-trailing.json'
                                    : route === '/fence-short'
                                      ? 'docling-fence-short.json'
                                      : route === '/fence-opposite'
                                        ? 'docling-fence-opposite.json'
                                        : route === '/aligned-table-ocr'
                                          ? 'docling-aligned-table-ocr.json'
                                          : route === '/crlf-lines'
                                            ? 'docling-crlf-lines.json'
                                            : route === '/same-paragraph'
                                              ? 'docling-same-paragraph.json'
                                              : route === '/heading-only'
                                                ? 'docling-heading-only.json'
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

  it('keeps Markdown-looking syntax as literal plain text with exact offsets', async () => {
    const text = '# literal heading\r\n\r\n**literal text**';
    const parsed = await parseDocument({
      bytes: new TextEncoder().encode(text),
      filename: 'notes.txt',
      mimeType: 'text/plain',
    });
    expect(parsed.blocks.map((block) => [block.content, block.heading])).toEqual([
      ['# literal heading', ''],
      ['**literal text**', ''],
    ]);
    for (const block of parsed.blocks) {
      expect(text.slice(Number(block.locator.startOffset), Number(block.locator.endOffset))).toBe(
        block.content,
      );
    }
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
    expect(parsed.blocks[0]?.locator).toMatchObject({
      page: 'unknown',
      kind: 'csv',
      rows: 4,
      startOffset: 0,
      endOffset: parsed.markdown.length,
      line: 1,
    });
  });

  it('accepts CR-only records and strips a BOM', async () => {
    const parsed = await parseDocument({
      bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a,b\r1,2\r3,4')]),
      filename: 'cr.csv',
      mimeType: 'text/csv',
    });

    expect(parsed.markdown).toBe(
      ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n'),
    );
    expect(parsed.blocks[0]?.locator).toMatchObject({ rows: 2 });
  });

  it('keeps quoted newlines in one cell and pads ragged rows', async () => {
    const parsed = await parseDocument({
      bytes: new TextEncoder().encode('a,b,c\n"x\ny",2\n1,2,3,4\n,\n'),
      filename: 'ragged.csv',
      mimeType: 'text/csv',
    });

    expect(parsed.markdown).toBe(
      [
        '| a | b | c |  |',
        '| --- | --- | --- | --- |',
        '| x y | 2 |  |  |',
        '| 1 | 2 | 3 | 4 |',
      ].join('\n'),
    );
  });

  it('renders 150000 short CSV rows plus a wider trailing row', async () => {
    const csv = [
      'c0,c1',
      ...Array.from({ length: 150_000 }, () => 'x,y'),
      'tail0,tail1,tail2,tail3,tail4,tail5',
    ].join('\n');
    const parsed = await parseDocument({
      bytes: new TextEncoder().encode(csv),
      filename: 'large.csv',
      mimeType: 'text/csv',
    });

    const lines = parsed.markdown.split('\n');
    expect(lines.slice(0, 2)).toEqual([
      '| c0 | c1 |  |  |  |  |',
      '| --- | --- | --- | --- | --- | --- |',
    ]);
    expect(lines.at(-1)).toBe('| tail0 | tail1 | tail2 | tail3 | tail4 | tail5 |');
    expect(parsed.blocks[0]?.locator).toMatchObject({
      page: 'unknown',
      kind: 'csv',
      rows: 150_001,
      startOffset: 0,
      endOffset: parsed.markdown.length,
    });
  });

  it('rejects malformed CSV quotes instead of silently rewriting them', async () => {
    for (const csv of ['a,b\n"x"y,2\n', 'a,b\n"x,2\n']) {
      await expect(
        parseDocument({
          bytes: new TextEncoder().encode(csv),
          filename: 'bad.csv',
          mimeType: 'text/csv',
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
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

describe('markdown line-based blocks', () => {
  const parseMarkdown = (markdown: string) =>
    parseDocument({
      bytes: new TextEncoder().encode(markdown),
      filename: 'doc.md',
      mimeType: 'text/markdown',
    });

  it('keeps a longer fence whole even when it contains triple backticks', async () => {
    const markdown = ['# 代码', '', '````md', '```ts', 'const a = 1;', '```', '````', '', '结尾。'];
    const parsed = await parseMarkdown(markdown.join('\n'));

    expect(parsed.blocks.map((block) => [block.heading, block.content])).toEqual([
      ['代码', '````md\n```ts\nconst a = 1;\n```\n````'],
      ['代码', '结尾。'],
    ]);
  });

  it('treats setext headings as breadcrumbs instead of content', async () => {
    const parsed = await parseMarkdown('标题\n===\n\n正文。\n');

    expect(parsed.blocks.map((block) => [block.heading, block.content])).toEqual([
      ['标题', '正文。'],
    ]);
  });

  it.each([
    ['# Parent\n## First\n## Second\n正文', ['Parent', 'First', '正文']],
    ['# Parent\nChild\n---\n## Second\n正文', ['Parent', 'Child', '正文']],
    ['# Parent\nChild\n---\n正文', ['正文']],
    ['# Parent\n## Child\n```ts\nconst a = 1;\n```', ['```ts\nconst a = 1;\n```']],
    ['# Parent\n## Child\nA | B\n--- | ---\n1 | 2', ['A | B\n--- | ---\n1 | 2']],
  ])('preserves unconsumed ancestors in reading order for %s', async (markdown, contents) => {
    const parsed = await parseMarkdown(markdown);
    expect(parsed.blocks.map((block) => block.content)).toEqual(contents);
    expect(parsed.blocks.at(-1)?.heading).toBe(
      markdown.includes('Second') ? 'Parent > Second' : 'Parent > Child',
    );
  });

  it('keeps GFM tables without outer pipes whole', async () => {
    const parsed = await parseMarkdown(
      ['# 数据', '', '名称 | 数量', '--- | ---', '苹果 | 3', '', '结尾。'].join('\n'),
    );

    expect(parsed.blocks.map((block) => [block.heading, block.content])).toEqual([
      ['数据', '名称 | 数量\n--- | ---\n苹果 | 3'],
      ['数据', '结尾。'],
    ]);
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
    // v1.38.2 同步内联响应 + embedded 图片：图片同时进 md 与 json，正文引用不能是 base64。
    expect(parts.find((part) => part.name === 'target_type')?.value.toString()).toBe('inbody');
    expect(parts.find((part) => part.name === 'image_export_mode')?.value.toString()).toBe(
      'embedded',
    );
    expect(parts.find((part) => part.name === 'include_images')?.value.toString()).toBe('true');

    expect(parsed.markdown).toContain('# 季度报告');
    expect(parsed.markdown).toContain('未匹配的段落。');
    expect(
      parsed.blocks.map((block) => [block.heading, block.content, block.locator.page]),
    ).toEqual([
      ['季度报告', '第一段内容。', 2],
      ['季度报告', ['| 指标 | 数值 |', '| --- | --- |', '| 收入 | 100 |'].join('\n'), 4],
      ['季度报告', '未匹配的段落。', 'unknown'],
      ['季度报告', '附加说明', 3],
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
    expect(parsed.blocks.map((block) => block.locator)).toMatchObject([
      { page: 7, bbox: { l: 0, t: 0, r: 5, b: 5 }, ref: '#/texts/0' },
      { page: 'unknown', ref: '#/texts/1' },
      { page: 8, bbox: { l: 0, t: 0, r: 5, b: 5 }, ref: '#/tables/0' },
    ]);
    // 真实原文偏移一并保留，不再只靠 page/bbox。
    for (const block of parsed.blocks) {
      expect(block.locator.startOffset).toEqual(expect.any(Number));
      expect(block.locator.endOffset).toEqual(expect.any(Number));
      expect(block.locator.line).toEqual(expect.any(Number));
    }
  });

  it('preserves JSON-only headings and literal body syntax without reparsing generated Markdown', async () => {
    const parsed = await parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/json-only-heading`,
    });
    expect(parsed.markdown).toBe('# literal body\n\n**literal tail**');
    expect(
      parsed.blocks.map((block) => [block.content, block.heading, block.locator.page]),
    ).toEqual([
      ['# literal body', 'Report', 2],
      ['**literal tail**', 'Report', 3],
    ]);
    expect(parsed.pageMap).toEqual([
      { page: 2, startOffset: 0, endOffset: 14 },
      { page: 3, startOffset: 16, endOffset: 32 },
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
    expect(parsed.blocks.find((block) => block.content.startsWith('|'))?.locator).toMatchObject({
      page: 'unknown',
      startOffset: expect.any(Number),
      endOffset: expect.any(Number),
    });
  });

  it('deduplicates markdown tables/code against JSON even with different fence or pipe styles', async () => {
    const parsed = await parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'dedup.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/dedup`,
    });

    // 正文保留 Markdown 原样；同一 occurrence 只补 JSON 的来源信息，不重复索引。
    expect(parsed.blocks.map((block) => [block.content, block.locator.page])).toEqual([
      ['段落一。', 1],
      ['````ts\nconst a = 1;\n````', 2],
      [['名称 | 数量', '--- | ---', '苹果 | 3'].join('\n'), 3],
    ]);
    for (const block of parsed.blocks) {
      expect(
        parsed.markdown.slice(Number(block.locator.startOffset), Number(block.locator.endOffset)),
      ).toBe(block.content);
    }
  });

  it.each([
    {
      route: '/fence-trailing',
      jsonBlock: '```ts\nconst a = 1;\n```',
      unclosed: '```ts\nconst a = 1;\n```still code',
      deduped: '~~~ts\nlet t = 1;\n~~~',
    },
    {
      route: '/fence-short',
      jsonBlock: '```py\nprint(3)\n```',
      unclosed: '````py\nprint(3)\n```',
      deduped: null,
    },
    {
      route: '/fence-opposite',
      jsonBlock: '```rb\nputs 4\n```',
      unclosed: '~~~rb\nputs 4\n```',
      deduped: null,
    },
  ])(
    'keeps an unclosed markdown fence that only looks closed ($route)',
    async ({ route, jsonBlock, unclosed, deduped }) => {
      const parsed = await parseDocument({
        bytes: new TextEncoder().encode('fake'),
        filename: 'fence.pdf',
        mimeType: 'application/pdf',
        parserUrl: `${parserUrl}${route}`,
      });

      const contents = parsed.blocks.map((block) => block.content);
      expect(contents).toContain(jsonBlock);
      expect(contents).toContain(unclosed);
      if (deduped) {
        expect(contents.filter((content) => content.includes('let t = 1;'))).toEqual([deduped]);
      }
    },
  );

  it('surfaces partial_success errors instead of silently accepting content', async () => {
    const failure = parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'partial.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/partial`,
    });

    await expect(failure).rejects.toMatchObject({ code: 'partial_success' });
    await expect(failure).rejects.toThrow(/ocr failed on page 2/);
    // v1.38.2 的 errors 是 ErrorItem 对象，详情取 error_message 而不是整段 JSON。
    await expect(failure).rejects.not.toThrow(/\{/);
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
    // 官方 errors 是 ErrorItem 对象数组；字符串条目不在此契约内，入口直接拒绝。
    await expect(
      parseDocument({
        bytes: new TextEncoder().encode('fake'),
        filename: 'bad-errors.pdf',
        mimeType: 'application/pdf',
        parserUrl: `${parserUrl}/invalid-errors`,
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

  it('accepts null picture images and null md_content/json_content, but still requires usable content', async () => {
    const withNullImage = await parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'null-image.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/embedded-images`,
    });
    expect(withNullImage.images.map((image) => image.name)).toEqual(['image-1.png']);

    const noMarkdown = await parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'json-only-null-md.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/null-markdown`,
    });
    expect(noMarkdown.markdown).toContain('只有 JSON 的正文。');

    await expect(
      parseDocument({
        bytes: new TextEncoder().encode('fake'),
        filename: 'md-only-null-json.pdf',
        mimeType: 'application/pdf',
        parserUrl: `${parserUrl}/null-json`,
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rewrites embedded data-URI markdown pictures to stored image references before chunking', async () => {
    const parsed = await parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'embedded.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/embedded-images`,
    });

    // 归一后的最终 md：data URI 换成落盘引用，图片之后的正文保持独立。
    expect(parsed.markdown).toBe(
      ['# 图册', '', '正文。', '', '![image-1.png](images/image-1.png)', '', '图片之后。', ''].join(
        '\n',
      ),
    );
    expect(parsed.markdown).not.toContain('base64');
    expect(parsed.blocks.every((block) => !block.content.includes('base64'))).toBe(true);
    // 偏移必须按归一后的文本计算：图片前后两页都要落在最终 md 的精确切片上。
    expect(parsed.pageMap).toEqual([
      {
        page: 1,
        startOffset: parsed.markdown.indexOf('正文。'),
        endOffset: parsed.markdown.indexOf('正文。') + '正文。'.length,
      },
      {
        page: 3,
        startOffset: parsed.markdown.indexOf('图片之后。'),
        endOffset: parsed.markdown.indexOf('图片之后。') + '图片之后。'.length,
      },
    ]);
    for (const range of parsed.pageMap) {
      expect(parsed.markdown.slice(range.startOffset, range.endOffset)).toBe(
        range.page === 1 ? '正文。' : '图片之后。',
      );
    }
    const chunks = chunkDocument(parsed, { chunkSize: 1200, chunkOverlap: 0 });
    expect(
      chunks.some((chunk) => chunk.content.includes('![image-1.png](images/image-1.png)')),
    ).toBe(true);
    expect(chunks.every((chunk) => !chunk.content.includes('base64'))).toBe(true);
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

  it('locates the JSON table in the aligned markdown and never lets short OCR text claim a substring', async () => {
    const parsed = await parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'sample.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/aligned-table-ocr`,
    });

    // 最终文本保留官方对齐表格、图片引用与只存在于 Markdown 的正文。
    expect(parsed.markdown).toContain(
      [
        '| Metric   |   Value | Unit   |',
        '|----------|---------|--------|',
        '| Revenue  |    1234 | USD    |',
      ].join('\n'),
    );
    expect(parsed.markdown).toContain('![image-1.png](images/image-1.png)');
    expect(parsed.markdown).toContain('Markdown-only paragraph with ticket 1234.');
    expect(parsed.images.map((image) => [image.name, image.page])).toEqual([['image-1.png', 1]]);
    // JSON 角标 OCR "1" 保留为块，但没有可认领的原文位置。
    expect(parsed.blocks.find((block) => block.content === '1')?.locator).toMatchObject({
      page: 1,
    });
    // 短 OCR 文本没有可认领的原文位置，不能被裸 indexOf 定位到 "1234" 里。
    expect(
      parsed.blocks.find((block) => block.content === '1')?.locator.startOffset,
    ).toBeUndefined();

    const tableLine = '| Revenue  |    1234 | USD    |';
    const tableStart = parsed.markdown.indexOf('| Metric');
    const tableEnd = parsed.markdown.indexOf(tableLine) + tableLine.length;
    expect(parsed.pageMap).toContainEqual({
      page: 2,
      startOffset: tableStart,
      endOffset: tableEnd,
    });
    // 页码表按原文顺序、区间有效且互不重叠。
    for (const [index, range] of parsed.pageMap.entries()) {
      expect(range.startOffset).toBeGreaterThanOrEqual(0);
      expect(range.endOffset).toBeGreaterThan(range.startOffset);
      expect(range.endOffset).toBeLessThanOrEqual(parsed.markdown.length);
      const previous = parsed.pageMap[index - 1];
      if (previous) expect(range.startOffset).toBeGreaterThanOrEqual(previous.endOffset);
    }
    // 表格区间独占它覆盖的原文，其它页不得侵入；第 1 页的 "1" 也不能落进 "1234"。
    expect(
      parsed.pageMap.filter(
        (range) =>
          !(range.page === 2 && range.startOffset === tableStart) &&
          range.startOffset < tableEnd &&
          tableStart < range.endOffset,
      ),
    ).toEqual([]);
    expect(
      parsed.pageMap.filter((range) => range.page === 1 && range.startOffset >= tableStart),
    ).toEqual([]);

    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/aligned-table-ocr` });
    const viaAdapter = await adapter.parse({
      filename: 'sample.pdf',
      mimeType: 'application/pdf',
      data: Buffer.from('%PDF-1.7'),
    });
    const chunks = adapter.chunkMarkdown(viaAdapter.markdown, viaAdapter.pageMap, {
      chunkTokens: 1200,
      overlap: 0,
    });
    const tables = chunks.filter((chunk) => chunk.kind === 'table');
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({ pageFrom: 2, pageTo: null });
    expect(tables[0]?.content).toContain(tableLine);
    const all = chunks.map((chunk) => chunk.content).join('\n');
    for (const kept of [
      'ZEBRA-42',
      'Markdown-only paragraph with ticket 1234.',
      '![image-1.png](images/image-1.png)',
    ]) {
      expect(all).toContain(kept);
    }
  });

  it('maps a multi-line block onto CRLF source offsets of the original text', async () => {
    const parsed = await parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'crlf.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/crlf-lines`,
    });

    // JSON 用 LF 拼出 "Alpha\nBeta"，原文是 CRLF；区间必须落在真实来源上，不编造。
    expect(parsed.markdown).toBe('Alpha\r\nBeta tail.');
    expect(parsed.pageMap).toEqual([
      { page: 3, startOffset: 0, endOffset: 'Alpha\r\nBeta'.length },
    ]);
    expect(parsed.markdown.slice(0, 'Alpha\r\nBeta'.length)).toBe('Alpha\r\nBeta');
  });

  it('gives each JSON item in one markdown paragraph its own non-overlapping page range', async () => {
    const parsed = await parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'same-paragraph.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/same-paragraph`,
    });

    expect(parsed.markdown).toBe('Alpha\nBeta');
    expect(parsed.pageMap).toEqual([
      { page: 2, startOffset: 0, endOffset: 5 },
      { page: 4, startOffset: 6, endOffset: 10 },
    ]);
    expect(parsed.markdown.slice(0, 5)).toBe('Alpha');
    expect(parsed.markdown.slice(6, 10)).toBe('Beta');
  });

  it('keeps heading-only Docling items as content and never repeats the breadcrumb in body', async () => {
    const parsed = await parseDocument({
      bytes: new TextEncoder().encode('fake'),
      filename: 'headings.pdf',
      mimeType: 'application/pdf',
      parserUrl: `${parserUrl}/heading-only`,
    });

    // Parent/First 一直没等到正文：保留为内容块；Second 由正文承接，只做面包屑且不重复。
    expect(parsed.blocks.map((block) => [block.content, block.locator.page])).toEqual([
      ['Parent', 1],
      ['First', 2],
      ['INVOICE NUMBER4207', 4],
      ['EOF TITLE', 4],
      ['HEAD ONE', 4],
      ['HEAD TWO', 4],
      ['HEAD THREE', 4],
    ]);
    expect(parsed.blocks.find((block) => block.content === 'INVOICE NUMBER4207')?.heading).toBe(
      'Parent > Second',
    );
    const range = (text: string) => ({
      startOffset: parsed.markdown.indexOf(text),
      endOffset: parsed.markdown.indexOf(text) + text.length,
    });
    expect(parsed.pageMap).toEqual([
      { page: 1, ...range('Parent') },
      { page: 2, ...range('First') },
      { page: 4, ...range('INVOICE NUMBER4207') },
      { page: 4, ...range('EOF TITLE') },
      { page: 4, ...range('HEAD ONE') },
      { page: 4, ...range('HEAD TWO') },
      { page: 4, ...range('HEAD THREE') },
    ]);

    const adapter = createParsingAdapter({ parserUrl: `${parserUrl}/heading-only` });
    const viaAdapter = await adapter.parse({
      filename: 'headings.pdf',
      mimeType: 'application/pdf',
      data: Buffer.from('%PDF-1.7'),
    });
    const chunks = adapter.chunkMarkdown(viaAdapter.markdown, viaAdapter.pageMap, {
      chunkTokens: 1200,
      overlap: 0,
    });
    expect(chunks.find((chunk) => chunk.content.includes('INVOICE NUMBER4207'))).toMatchObject({
      pageFrom: 4,
    });
    expect(chunks.map((chunk) => chunk.content).join('\n')).toContain('INVOICE NUMBER4207');
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

  it('merges a chunk time range only when every composing block has real timing', () => {
    const parsed: ParsedDocument = {
      markdown: '第一段\n\n第二段\n\n第三段',
      images: [],
      pageMap: [],
      blocks: [
        block('第一段', '', { startOffset: 0, endOffset: 3, timeFromMs: 0, timeToMs: 500 }),
        block('第二段', '', { startOffset: 5, endOffset: 8, timeFromMs: 500, timeToMs: 1500 }),
      ],
    };

    const chunks = chunkDocument(parsed, { chunkSize: 1000, chunkOverlap: 0 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.locator).toMatchObject({ timeFromMs: 0, timeToMs: 1500 });
  });

  it('does not give a chunk any time when one block has no timing', () => {
    const parsed: ParsedDocument = {
      markdown: '有声段\n\n无时码段',
      images: [],
      pageMap: [],
      blocks: [
        block('有声段', '', { startOffset: 0, endOffset: 3, timeFromMs: 0, timeToMs: 800 }),
        block('无时码段', '', { startOffset: 5, endOffset: 9 }),
      ],
    };

    const chunks = chunkDocument(parsed, { chunkSize: 1000, chunkOverlap: 0 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.locator).not.toHaveProperty('timeFromMs');
    expect(chunks[0]?.locator).not.toHaveProperty('timeToMs');
  });

  it('keeps the whole source segment time on every split piece instead of interpolating', () => {
    const text = '长段内容。'.repeat(20);
    const parsed: ParsedDocument = {
      markdown: text,
      images: [],
      pageMap: [],
      blocks: [
        block(text, '', {
          startOffset: 0,
          endOffset: text.length,
          timeFromMs: 1200,
          timeToMs: 4800,
        }),
      ],
    };

    const chunks = chunkDocument(parsed, { chunkSize: 40, chunkOverlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.locator).toMatchObject({ timeFromMs: 1200, timeToMs: 4800 });
    }
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

  it('treats tilde fences and longer fences as atomic', () => {
    const tilde = '~~~ts\nconst a = 1;\nconst b = 2;\n~~~';
    const longer = '````md\n```\ninner\n```\n````';
    const parsed: ParsedDocument = {
      markdown: '',
      images: [],
      pageMap: [],
      blocks: [block(tilde, 'T'), block(longer, 'L')],
    };

    const chunks = chunkDocument(parsed, { chunkSize: 10, chunkOverlap: 0 });

    expect(chunks.map((chunk) => chunk.content)).toEqual([tilde, longer]);
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
