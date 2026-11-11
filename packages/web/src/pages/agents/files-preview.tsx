import { CodeBlock } from '../../components/code-block.js';
import { ErrorState, InlineEmpty, LoadingState } from '../../components/states.js';
import type { useAgentFiles } from '../../lib/queries.js';
import type { FileEntry } from './shared.js';

/** 文件与版本来自上次保存；编辑中的草稿在内联预览里。文件切换由外层的三栏布局承载。 */
export function FilesPreview({
  entry,
  dirty,
  files,
}: {
  entry: FileEntry | undefined;
  dirty: boolean;
  files: ReturnType<typeof useAgentFiles>;
}) {
  const disabled = files.isPending || files.isError || !files.data;

  return (
    <div className="flex flex-col gap-3">
      {entry?.id === '.mcp.json' ? (
        <p className="rounded-item bg-chip px-3 py-2 text-sm text-muted-foreground">
          密钥在运行时注入，此处显示为占位符。
        </p>
      ) : null}
      {dirty ? (
        <p className="rounded-item bg-chip px-3 py-2 text-sm text-muted-foreground">
          显示上次保存的文件；未保存内容见配置草稿。
        </p>
      ) : null}
      {files.isPending ? <LoadingState rows={6} /> : null}
      {files.isError ? (
        <ErrorState error={files.error} onRetry={() => void files.refetch()} />
      ) : null}
      {!disabled && entry && entry.content ? (
        <CodeBlock
          key={entry.id}
          code={entry.content}
          lineNumbers
          maxHeight="calc(100vh - 22rem)"
        />
      ) : null}
      {!disabled && entry && !entry.content ? <InlineEmpty>该文件当前为空。</InlineEmpty> : null}
      <p className="py-2 text-sm text-muted-foreground">
        除根文件外，路径相对 <code className="font-mono">.claude/</code>；agent md
        仅供预览，不落盘。
      </p>
    </div>
  );
}
