import { readPluginMarkdown } from '@agentport/core/plugin-display';
import type { PluginFileInput } from '@agentport/shared';
import { useMemo } from 'react';
import { CodeBlock } from '../code-block.js';
import { Markdown, type MarkdownFileLinks } from '../markdown.js';
import { PageNote } from '../page.js';
import { InlineEmpty } from '../states.js';

export function pluginFileTitle(path: string): string {
  const skill = /^skills\/([^/]+)\/SKILL\.md$/i.exec(path);
  if (skill?.[1]) return skill[1];
  const base = path.split('/').at(-1) ?? path;
  return base.replace(/\.md$/i, '');
}

export function isPluginMarkdown(path: string): boolean {
  return /\.md$/i.test(path);
}

export function PluginDocument({
  file,
  mode = 'read',
  onSelectFile,
  files,
}: {
  file: PluginFileInput;
  mode?: 'read' | 'source';
  onSelectFile?: (path: string) => void;
  files?: PluginFileInput[];
}) {
  const links = useMemo<MarkdownFileLinks | undefined>(() => {
    if (files === undefined || onSelectFile === undefined) return undefined;
    return {
      from: file.path,
      files: new Set(files.map((item) => item.path)),
      onSelect: onSelectFile,
    };
  }, [file.path, files, onSelectFile]);

  if (!isPluginMarkdown(file.path) || mode === 'source') {
    return file.content.length === 0 ? (
      <InlineEmpty>该文件是空的。</InlineEmpty>
    ) : (
      <CodeBlock key={file.path} code={file.content} lineNumbers maxHeight="65vh" />
    );
  }

  const parsed = readPluginMarkdown(file.content, pluginFileTitle(file.path));
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {parsed.issue === undefined ? null : (
        <PageNote title="frontmatter 无法读取，以下为完整原文" description={parsed.issue} />
      )}
      {parsed.issue !== undefined ? (
        <CodeBlock key={`${file.path}-raw`} code={file.content} lineNumbers maxHeight="65vh" />
      ) : parsed.body.trim() === '' ? (
        <InlineEmpty>该文件没有正文。</InlineEmpty>
      ) : (
        <Markdown
          text={parsed.body}
          staticContent
          {...(links === undefined ? {} : { fileLinks: links })}
        />
      )}
    </div>
  );
}
