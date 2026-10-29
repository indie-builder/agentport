import type { OutputFile, OutputList, OutputRef } from '@agentport/shared';
import { History, Pencil } from 'lucide-react';
import { useMemo } from 'react';
import { api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { formatBytes, formatDateTime, formatRelative } from '../lib/format.js';
import { useConversationOutputs, useOutputContent } from '../lib/queries.js';
import { CodeBlock } from './code-block.js';
import { Markdown } from './markdown.js';
import { ReaderToolbar } from './reader-toolbar.js';
import { EmptyState, ErrorState, LoadingState } from './states.js';
import { Button } from './ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';

export interface OutputSelection {
  runId: string;
  path: string;
  mode: 'read' | 'source';
}

/** Markdown 可切换阅读/源码；其余文本一律源码，二进制不伪造预览。 */
type PreviewKind = 'markdown' | 'text' | 'binary';

const TEXT_MEDIA = /^(text\/|application\/json$|image\/svg\+xml$)/;

/** 与预览接口同一判定：文本走源码/静态阅读，其余只下载。 */
function previewKind(file: Pick<OutputFile, 'mediaType'>): PreviewKind {
  if (file.mediaType === 'text/markdown') return 'markdown';
  return TEXT_MEDIA.test(file.mediaType) ? 'text' : 'binary';
}

/** 列表按发布版本倒序返回；同一路径只展示最新一版，旧版在预览里可选。 */
function latestByPath(list: OutputList): OutputFile[] {
  const latest = new Map<string, OutputFile>();
  for (const file of list.items) {
    const current = latest.get(file.path);
    if (!current || file.createdAt > current.createdAt) latest.set(file.path, file);
  }
  return [...latest.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function versionsOf(list: OutputList, path: string): OutputFile[] {
  return list.items
    .filter((file) => file.path === path)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 右侧工作区：会话成果的版本列表与预览。 */
export function ConversationOutputs({
  inline = false,
  conversationId,
  selection,
  onSelect,
  onFeedback,
}: {
  inline?: boolean;
  conversationId: string | null;
  selection: OutputSelection | null;
  onSelect: (selection: OutputSelection) => void;
  onFeedback: (ref: OutputRef) => void;
}) {
  const outputs = useConversationOutputs(conversationId);
  const list: OutputList | null = outputs.data ?? null;
  const files = useMemo(() => (list ? latestByPath(list) : []), [list]);
  const versions = list && selection ? versionsOf(list, selection.path) : [];
  const meta = versions.find((file) => file.runId === selection?.runId) ?? null;
  // URL 指向本页之外的旧版时只能先按路径猜；正文响应带回真实元信息后以它为准。
  const kind = selection ? (meta ? previewKind(meta) : 'text') : null;
  const content = useOutputContent(
    conversationId,
    selection && kind !== 'binary' ? selection.runId : null,
    selection && kind !== 'binary' ? selection.path : null,
  );
  const shownKind = kind === 'text' && content.data ? previewKind(content.data.file) : kind;
  const shown = content.data?.file ?? meta;

  return (
    <aside
      id={inline ? 'chat-workspace' : undefined}
      aria-label="会话成果"
      className={cn(
        'flex h-full flex-col overflow-y-auto bg-surface',
        inline ? 'border-l' : 'min-h-0 flex-1',
      )}
    >
      <div className="flex shrink-0 items-center border-b px-3 py-2.5">
        <h2 className="min-w-0 truncate text-sm font-medium text-fg">会话成果</h2>
      </div>
      <div className="@container min-h-0 flex-1 overflow-y-auto p-3">
        {conversationId === null ? (
          <EmptyState title="当前会话没有成果文件" description="此处用于查看报告等会话成果。" />
        ) : outputs.isPending ? (
          <LoadingState rows={4} />
        ) : outputs.isError ? (
          <ErrorState error={outputs.error} onRetry={() => void outputs.refetch()} />
        ) : files.length === 0 ? (
          <EmptyState title="当前会话没有成果文件" description="此处用于查看报告等会话成果。" />
        ) : (
          <div
            className={cn(
              'grid min-w-0 gap-4',
              selection !== null && '@2xl:grid-cols-[320px_minmax(0,1fr)] @2xl:items-start',
            )}
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <ul className="flex flex-col gap-0.5">
                {files.map((file) => {
                  const active = selection?.path === file.path;
                  return (
                    <li key={file.path}>
                      <Button
                        variant="ghost"
                        aria-current={active ? 'true' : undefined}
                        onClick={() =>
                          onSelect({
                            runId: file.runId,
                            path: file.path,
                            mode: previewKind(file) === 'markdown' ? 'read' : 'source',
                          })
                        }
                        className={cn(
                          'h-auto w-full min-w-0 items-start justify-between gap-2 px-2 py-1.5 text-left font-normal whitespace-normal',
                          active
                            ? 'bg-selected text-selected-foreground hover:bg-selected hover:text-selected-foreground'
                            : 'text-muted-foreground hover:bg-hover',
                        )}
                      >
                        <span className="min-w-0 break-words text-sm">{file.path}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {formatRelative(file.createdAt)}
                        </span>
                      </Button>
                    </li>
                  );
                })}
              </ul>

              {outputs.hasNextPage ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start text-muted-foreground"
                  disabled={outputs.isFetchingNextPage}
                  onClick={() => void outputs.fetchNextPage()}
                >
                  {outputs.isFetchingNextPage ? '正在加载…' : '加载更多版本'}
                </Button>
              ) : null}
            </div>

            {selection ? (
              <div className="flex min-w-0 flex-col gap-2 border-t pt-3 @2xl:border-t-0 @2xl:pt-0">
                <ReaderToolbar
                  identity={
                    <span className="block truncate" title={selection.path}>
                      {selection.path}
                    </span>
                  }
                  {...(shown ? { meta: <span>{formatBytes(shown.size)}</span> } : {})}
                  {...(shownKind === 'markdown'
                    ? {
                        mode: selection.mode,
                        onModeChange: (mode: 'read' | 'source') => onSelect({ ...selection, mode }),
                      }
                    : {})}
                  {...(shownKind !== 'binary' && content.data
                    ? { copy: { value: content.data.content, label: `复制 ${selection.path}` } }
                    : {})}
                  download={{
                    href: api.outputDownloadUrl(
                      conversationId ?? '',
                      selection.runId,
                      selection.path,
                    ),
                    label: `下载 ${selection.path}`,
                    text: '下载',
                  }}
                  actions={
                    <>
                      {versions.length > 1 ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label="选择版本"
                                className="text-muted-foreground"
                              />
                            }
                          >
                            <History />
                            {formatDateTime(shown?.createdAt)}
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="w-44">
                            <DropdownMenuGroup>
                              {versions.map((file) => (
                                <DropdownMenuItem
                                  key={file.runId}
                                  onClick={() => onSelect({ ...selection, runId: file.runId })}
                                >
                                  {formatDateTime(file.createdAt)}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(shown?.createdAt)}
                        </span>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onFeedback({ runId: selection.runId, path: selection.path })}
                      >
                        <Pencil data-icon="inline-start" />
                        基于此版本修改
                      </Button>
                    </>
                  }
                />

                {shownKind === 'binary' ? (
                  <p className="rounded-card border border-dashed border-line-strong/70 px-3 py-4 text-xs leading-relaxed text-muted-foreground">
                    二进制文件，请下载后查看。
                  </p>
                ) : content.isPending ? (
                  <LoadingState rows={3} />
                ) : content.isError ? (
                  <ErrorState
                    error={content.error}
                    title="这个文件无法在面板内预览"
                    onRetry={() => void content.refetch()}
                  />
                ) : content.data ? (
                  selection.mode === 'read' && previewKind(content.data.file) === 'markdown' ? (
                    <Markdown text={content.data.content} staticContent />
                  ) : (
                    <CodeBlock
                      code={content.data.content}
                      maxHeight="50vh"
                      copyable={false}
                      json={
                        content.data.file.mediaType === 'application/json' ||
                        /\.json$/i.test(content.data.file.path)
                      }
                    />
                  )
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}
