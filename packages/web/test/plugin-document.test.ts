import type { PluginFileInput } from '@agentport/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginDocument } from '../src/pages/plugins/plugin-document.js';

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(props: Parameters<typeof PluginDocument>[0]): void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(PluginDocument, props)));
}

function body(): HTMLElement {
  if (!host) throw new Error('not mounted');
  return host;
}

const files: PluginFileInput[] = [
  {
    path: 'skills/alpha/SKILL.md',
    content: [
      '---',
      'name: Alpha Skill',
      'description: 处理 alpha',
      'allowed-tools: Read',
      '---',
      '',
      '# Alpha 正文',
      '',
      '[指南](./references/guide.md)',
      '[裸路径](references/bare.md)',
      '[上级](../shared.md)',
      '[根目录](/README.md)',
      '[协议相对](//example.com/doc)',
      '[锚点](#alpha)',
      '[坏编码](references/%E0%A4%A.md)',
      '[缺失](./references/missing.md)',
      '[外链](https://example.com)',
      '[邮件](mailto:dev@example.com)',
      '[脚本](javascript:alert(1))',
      '[伪装](#plugin-file=skills%2Fnope.md)',
      '',
      '[引用指南][guide]',
      '[引用裸路径][bare]',
      '[引用上级][up]',
      '[引用根目录][root]',
      '[引用缺失][missing]',
      '[引用脚本][js]',
      '[引用外链][web]',
      '[引用协议相对][proto]',
      '[未定义引用][unknown]',
      '[大小写引用][GUIDE]',
      '[折叠引用][]',
      '[快捷引用]',
      '',
      '[guide]: ./references/guide.md',
      '[bare]: references/bare.md',
      '[up]: ../shared.md',
      '[root]: /README.md',
      '[missing]: ./references/missing.md',
      '[js]: javascript:alert(1)',
      '[web]: https://example.com',
      '[proto]: //example.com/doc',
      '[折叠引用]: references/guide.md',
      '[快捷引用]: /README.md',
      '',
      '<script>alert(1)</script>',
    ].join('\n'),
    executable: false,
  },
  { path: 'skills/alpha/references/guide.md', content: '指南正文', executable: false },
  { path: 'skills/alpha/references/bare.md', content: '裸路径正文', executable: false },
  { path: 'skills/shared.md', content: '共享正文', executable: false },
  { path: 'README.md', content: '根正文', executable: false },
  {
    path: 'skills/beta/SKILL.md',
    content: '---\nname: Beta Skill\ndescription: 处理 beta\n---\n\n[指南](./references/guide.md)',
    executable: false,
  },
  { path: 'skills/beta/references/guide.md', content: 'beta 指南', executable: false },
];

const skillFile = files[0];
if (!skillFile) throw new Error('missing fixture');

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('PluginDocument', () => {
  it('renders Markdown without frontmatter and keeps one page heading', () => {
    mount({ file: skillFile, files });

    expect(body().querySelector('h1')).toBeNull();
    expect(body().textContent).toContain('Alpha 正文');
    expect(body().textContent).not.toContain('allowed-tools');
    expect(body().textContent).not.toContain('name: Alpha Skill');
    expect(body().querySelector('script')).toBeNull();
    expect(body().textContent).toContain('<script>alert(1)</script>');
  });

  it('shows the complete source including frontmatter in source mode', () => {
    mount({ file: skillFile, mode: 'source', files });

    expect(body().textContent).toContain('name: Alpha Skill');
    expect(body().textContent).toContain('allowed-tools: Read');
    expect(body().querySelector('h1')).toBeNull();
    expect(body().textContent).toContain('# Alpha 正文');
  });

  it('opens only links that resolve to a real plugin file', async () => {
    const onSelectFile = vi.fn();
    mount({ file: skillFile, files, onSelectFile });

    const button = (text: string) =>
      [...body().querySelectorAll('button')].find((item) => item.textContent === text);
    const open = async (text: string, path: string) => {
      const target = button(text);
      expect(target, text).toBeDefined();
      await act(async () => target?.click());
      expect(onSelectFile).toHaveBeenLastCalledWith(path);
    };

    await open('指南', 'skills/alpha/references/guide.md');
    await open('裸路径', 'skills/alpha/references/bare.md');
    await open('上级', 'skills/shared.md');
    await open('根目录', 'README.md');
    await open('引用指南', 'skills/alpha/references/guide.md');
    await open('引用裸路径', 'skills/alpha/references/bare.md');
    await open('引用上级', 'skills/shared.md');
    await open('引用根目录', 'README.md');
    await open('大小写引用', 'skills/alpha/references/guide.md');
    await open('折叠引用', 'skills/alpha/references/guide.md');
    await open('快捷引用', 'README.md');

    expect(button('缺失')).toBeUndefined();
    expect(button('引用缺失')).toBeUndefined();
    expect(button('引用脚本')).toBeUndefined();
    expect(button('伪装')).toBeUndefined();
    expect(button('坏编码')).toBeUndefined();
    expect(button('未定义引用')).toBeUndefined();
    expect(body().querySelector('a[href*="missing"]')).toBeNull();
    expect(body().querySelector('a[href*="javascript"]')).toBeNull();
    expect(body().querySelector('a[href*="references"]')).toBeNull();
    expect(body().querySelector('a[href^="javascript"]')).toBeNull();
    expect(body().querySelector('a[href^="skills/"]')).toBeNull();
    expect(body().querySelector('a[href="/README.md"]')).toBeNull();
    expect(body().textContent).toContain('[未定义引用][unknown]');

    expect(body().querySelector('a[href="https://example.com/"]')).not.toBeNull();
    expect(body().querySelector('a[href="https://example.com/doc"]')).not.toBeNull();
    expect(body().querySelector('a[href="mailto:dev@example.com"]')).not.toBeNull();
    const anchor = body().querySelector('a[href="#alpha"]');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('target')).toBeNull();
  });

  it('re-resolves relative links when the file being rendered changes', async () => {
    const onSelectFile = vi.fn();
    const beta = files.find((item) => item.path === 'skills/beta/SKILL.md');
    if (!beta) throw new Error('missing fixture');
    const open = async (file: PluginFileInput, expected: string) => {
      mount({ file, files, onSelectFile });
      const target = [...body().querySelectorAll('button')].find(
        (item) => item.textContent === '指南',
      );
      expect(target).toBeDefined();
      await act(async () => target?.click());
      expect(onSelectFile).toHaveBeenLastCalledWith(expected);
      await act(async () => root?.unmount());
      host?.remove();
      root = undefined;
      host = undefined;
    };

    await open(skillFile, 'skills/alpha/references/guide.md');
    await open(beta, 'skills/beta/references/guide.md');
  });

  it('does not navigate relative links when no file callback is supplied', () => {
    mount({ file: skillFile, files: undefined });

    expect(body().querySelector('a[href^="./"]')).toBeNull();
    expect(body().querySelector('a[href^="skills/"]')).toBeNull();
    expect(body().textContent).toContain('指南');
  });

  it('shows the full original text when the frontmatter is malformed', () => {
    mount({
      file: {
        path: 'agents/reviewer.md',
        content: '---\nname: [broken\n---\n\n原始正文',
        executable: false,
      },
    });

    expect(body().textContent).toContain('frontmatter 无法读取');
    expect(body().textContent).toContain('name: [broken');
    expect(body().textContent).toContain('原始正文');
  });

  it('names empty Markdown bodies explicitly', () => {
    mount({
      file: { path: 'commands/empty.md', content: '---\nname: empty\n---\n', executable: false },
    });

    expect(body().textContent).toContain('该文件没有正文。');
  });

  it('shows non-Markdown files as raw code without a read/source switch', () => {
    mount({
      file: { path: '.claude-plugin/plugin.json', content: '{"name":"demo"}', executable: false },
    });

    expect(body().textContent).toContain('{"name":"demo"}');
    expect(body().textContent).not.toContain('查看原文');
  });

  it('shows empty files explicitly', () => {
    mount({ file: { path: 'scripts/empty.sh', content: '', executable: true } });

    expect(body().textContent).toContain('该文件是空的。');
  });
});
