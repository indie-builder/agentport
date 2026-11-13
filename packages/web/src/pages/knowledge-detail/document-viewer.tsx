import { type KnowledgeDocument, knowledgeAudioMetadataSchema } from '@agentport/shared';
import { PanelLeftDashed, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { CodeBlock } from '../../components/code-block.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../../components/draft-guard.js';
import {
  KnowledgeImage,
  stripImageReferences,
} from '../../components/knowledge/knowledge-citations.js';
import {
  DocumentVersionPicker,
  ManualDraftDialog,
} from '../../components/knowledge/knowledge-documents.js';
import {
  documentStatusLabel,
  documentStatusTone,
  isAudioMimeType,
  locatorLabel,
  versionLabel,
} from '../../components/knowledge/knowledge-shared.js';
import { Markdown } from '../../components/markdown.js';
import { PageSection } from '../../components/page.js';
import { ReaderToolbar } from '../../components/reader-toolbar.js';
import { ErrorState, InlineEmpty, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Field, FieldError, FieldLabel } from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import {
  api,
  errorMessage,
  type KnowledgeChunk,
  type KnowledgeVersionImage,
} from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { guardedOpenChange } from '../../lib/dialog-guard.js';
import { formatRelative } from '../../lib/format.js';
import {
  useCreateKnowledgeChunk,
  useDeleteKnowledgeChunk,
  useKnowledgeDocumentChunks,
  useKnowledgeDocumentVersions,
  useKnowledgeMarkdown,
  useKnowledgeVersionDetails,
  usePublishKnowledgeDocumentVersion,
  useRollbackKnowledgeDocument,
  useUpdateKnowledgeChunk,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';

// ---- 文档查看 -------------------------------------------------------------

/** 图片 chunk 的角色来自 metadata.imageRole；普通 chunk 没有。 */
function imageRoleLabel(chunk: KnowledgeChunk): string | null {
  const role = chunk.metadata?.imageRole;
  if (role === 'ocr') return 'OCR';
  if (role === 'caption') return '图片描述';
  if (role === 'vector') return '图片向量';
  return null;
}

/** 分块定位优先用解析器 locator（含音视频时码）；旧数据没有 locator 时退回页码。 */
function chunkLocatorLabel(chunk: KnowledgeChunk): string | null {
  const locator = locatorLabel(chunk.locator);
  if (locator !== null) return locator;
  if (chunk.pageFrom === null) return null;
  const range = chunk.pageTo !== null && chunk.pageTo !== chunk.pageFrom ? `–${chunk.pageTo}` : '';
  return `第 ${chunk.pageFrom}${range} 页`;
}

/** 版本图片与引用图共用同一套鉴权加载与 401/403/404 错误说明。 */
function VersionImage({ versionId, image }: { versionId: string; image: KnowledgeVersionImage }) {
  return (
    <KnowledgeImage
      versionId={versionId}
      name={image.name}
      alt={`第 ${image.page} 页的图片 ${image.name}`}
      className="max-h-64 w-full rounded-card border border-line object-contain"
    />
  );
}

export function DocumentViewer({
  document,
  documents,
  canManage,
  canPublish,
  onSelect,
  onClose,
  onEdit,
}: {
  document: KnowledgeDocument;
  documents: KnowledgeDocument[];
  canManage: boolean;
  canPublish: boolean;
  onSelect: (document: KnowledgeDocument) => void;
  onClose: () => void;
  onEdit: () => void;
}) {
  const versionQuery = useKnowledgeDocumentVersions(document.id);
  const versions = versionQuery.versions;
  const currentVersionId =
    versions.find((version) => version.isCurrent)?.id ?? document.currentVersionId;
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const versionId = selectedVersionId ?? currentVersionId;
  const selectedVersion = versions.find((version) => version.id === versionId);
  const isCurrent = versionId !== null && versionId === currentVersionId;
  useEffect(() => {
    if (
      selectedVersionId !== null &&
      versions.length > 0 &&
      !versions.some((version) => version.id === selectedVersionId)
    ) {
      setSelectedVersionId(null);
    }
  }, [selectedVersionId, versions]);
  const markdown = useKnowledgeMarkdown(versionId);
  const details = useKnowledgeVersionDetails(versionId);
  const versionImages = details.data?.images ?? [];
  const chunks = useKnowledgeDocumentChunks(document.id, versionId);
  const rollback = useRollbackKnowledgeDocument(document.baseId);
  const publish = usePublishKnowledgeDocumentVersion(document.baseId);
  const toggle = useUpdateKnowledgeChunk(document.baseId, document.id, versionId);
  const remove = useDeleteKnowledgeChunk(document.baseId, document.id, versionId);
  const [mode, setMode] = useState<'read' | 'source'>('read');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [editing, setEditing] = useState<KnowledgeChunk | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeChunk | null>(null);
  const [addingChunk, setAddingChunk] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const chunkItems = chunks.data?.pages.flatMap((page) => page.items) ?? [];
  const identity = document.sourcePath ?? details.data?.originalFilename ?? document.title;
  const isDraft = selectedVersion?.metadata.publication === 'draft';
  const manual = document.contentKind === 'document' && document.sourceType === 'manual';
  const audio = isAudioMimeType(document.mimeType);
  const audioMetadata = selectedVersion
    ? knowledgeAudioMetadataSchema.safeParse(selectedVersion.metadata.audio)
    : null;
  const audioWithoutTime =
    audio &&
    selectedVersion !== undefined &&
    (audioMetadata?.success !== true || audioMetadata.data.segments.length === 0);

  return (
    <>
      <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
        <DialogShell
          title={document.title}
          className="max-h-[85dvh] max-w-275 sm:max-w-275"
          closeDisabled={toggle.isPending || remove.isPending}
        >
          <div
            className={cn(
              'grid min-w-0 gap-5 md:items-start',
              sidebarOpen ? 'md:grid-cols-[320px_minmax(0,1fr)]' : 'md:grid-cols-1',
            )}
          >
            {sidebarOpen ? (
              <nav
                id="knowledge-document-files"
                aria-label="知识文档"
                className="flex min-w-0 flex-col gap-0.5 md:sticky md:top-0 md:max-h-[calc(85dvh-9rem)] md:overflow-y-auto"
              >
                {documents.length === 0 ? <InlineEmpty>当前筛选没有文档</InlineEmpty> : null}
                {documents.map((item) => {
                  const active = item.id === document.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => onSelect(item)}
                      className={cn(
                        'flex w-full min-w-0 flex-col gap-0.5 rounded-item px-2 py-1.5 text-left text-sm transition-colors duration-150 ease-out-soft',
                        active
                          ? 'bg-selected font-medium text-selected-foreground'
                          : 'text-muted-foreground hover:bg-hover hover:text-fg',
                      )}
                    >
                      <span className="truncate" title={item.title}>
                        {item.title}
                      </span>
                      <span className="truncate text-xs">{documentStatusLabel[item.status]}</span>
                    </button>
                  );
                })}
              </nav>
            ) : null}

            <div className="flex min-w-0 flex-col gap-4">
              <div className="flex min-w-0 items-start gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={sidebarOpen ? '收起文件列表' : '展开文件列表'}
                  title={sidebarOpen ? '收起文件列表' : '展开文件列表'}
                  aria-expanded={sidebarOpen}
                  aria-controls="knowledge-document-files"
                  onClick={() => setSidebarOpen((open) => !open)}
                  className="hidden shrink-0 text-muted-foreground hover:text-fg md:inline-flex"
                >
                  <PanelLeftDashed />
                </Button>
                <div className="min-w-0 flex-1">
                  <ReaderToolbar
                    identity={
                      <span className="block truncate" title={identity}>
                        {identity}
                      </span>
                    }
                    meta={
                      <>
                        <StatusBadge tone={documentStatusTone[document.status]}>
                          {documentStatusLabel[document.status]}
                        </StatusBadge>
                        {selectedVersion ? <span>{versionLabel(selectedVersion)}</span> : null}
                        {audioWithoutTime ? <span>无时码</span> : null}
                        <span>{document.mimeType}</span>
                        <span>{formatRelative(document.updatedAt)}</span>
                      </>
                    }
                    {...(versionId && markdown.data !== undefined
                      ? { mode, onModeChange: setMode }
                      : {})}
                    {...(markdown.data !== undefined
                      ? { copy: { value: markdown.data, label: `复制 ${document.title}` } }
                      : {})}
                    {...(versionId
                      ? {
                          download: {
                            href: api.knowledgeOriginalUrl(versionId),
                            label: audio ? '下载音频原件' : '下载原件',
                            text: '下载原件',
                          },
                        }
                      : {})}
                    actions={
                      <>
                        <DocumentVersionPicker
                          versions={versions}
                          selectedVersionId={versionId}
                          onSelect={setSelectedVersionId}
                        />
                        {manual && canManage ? (
                          <Button variant="outline" size="sm" onClick={() => setManualOpen(true)}>
                            编辑正文
                          </Button>
                        ) : null}
                        {selectedVersion !== undefined && !isCurrent && canPublish ? (
                          isDraft ? (
                            <Button
                              size="sm"
                              disabled={publish.isPending}
                              aria-busy={publish.isPending}
                              onClick={() =>
                                publish.mutate(
                                  {
                                    documentId: document.id,
                                    versionId: selectedVersion.id,
                                    expectedVersionId: currentVersionId,
                                  },
                                  {
                                    onSuccess: () => {
                                      toastSuccess('草稿已发布');
                                      setSelectedVersionId(null);
                                    },
                                    onError: toastError,
                                  },
                                )
                              }
                            >
                              发布草稿
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={rollback.isPending}
                              onClick={() => setConfirmRollback(true)}
                            >
                              设为当前版本
                            </Button>
                          )
                        ) : null}
                        {canManage ? (
                          <Button variant="outline" size="sm" onClick={onEdit}>
                            编辑属性
                          </Button>
                        ) : null}
                      </>
                    }
                  />
                </div>
              </div>

              {document.sourceUrl ? (
                <a
                  href={document.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="w-fit text-xs underline underline-offset-2"
                >
                  查看来源
                </a>
              ) : null}

              <PageSection title="解析正文" divided={false}>
                {!versionId ? <InlineEmpty>还没有解析完成的版本</InlineEmpty> : null}
                {versionId && markdown.isPending ? <LoadingState rows={3} /> : null}
                {versionId && markdown.isError ? (
                  <ErrorState error={markdown.error} onRetry={() => void markdown.refetch()} />
                ) : null}
                {markdown.data ? (
                  mode === 'read' ? (
                    <Markdown text={stripImageReferences(markdown.data)} />
                  ) : (
                    <CodeBlock code={markdown.data} lineNumbers maxHeight="60vh" copyable={false} />
                  )
                ) : null}
              </PageSection>

              {versionId ? (
                <PageSection title="图片">
                  {details.isPending ? <LoadingState rows={2} /> : null}
                  {details.isError ? (
                    <ErrorState error={details.error} onRetry={() => void details.refetch()} />
                  ) : null}
                  {details.isSuccess && versionImages.length === 0 ? (
                    <InlineEmpty>该版本没有提取到图片</InlineEmpty>
                  ) : null}
                  {versionImages.length > 0 ? (
                    <ul className="grid gap-3 sm:grid-cols-2">
                      {versionImages.map((image) => (
                        <li key={image.name} className="flex min-w-0 flex-col gap-1">
                          <VersionImage versionId={versionId} image={image} />
                          <span className="truncate text-xs text-muted-foreground">
                            第 {image.page} 页 · {image.name}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </PageSection>
              ) : null}

              <PageSection title="分块">
                {!versionId ? <InlineEmpty>还没有分块</InlineEmpty> : null}
                {versionId && !isCurrent ? (
                  <p className="text-sm text-muted-foreground">
                    历史版本只读；切回当前版本后可编辑分块。
                  </p>
                ) : null}
                {versionId && isCurrent && canManage ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={() => setAddingChunk(true)}
                  >
                    <Plus data-icon="inline-start" aria-hidden="true" /> 新增分块
                  </Button>
                ) : null}
                {versionId && chunks.isPending ? <LoadingState rows={3} /> : null}
                {versionId && chunks.isError ? (
                  <ErrorState error={chunks.error} onRetry={() => void chunks.refetch()} />
                ) : null}
                {versionId && chunks.isSuccess && chunkItems.length === 0 ? (
                  <InlineEmpty>还没有分块</InlineEmpty>
                ) : null}
                {chunkItems.length > 0 ? (
                  <ul className="flex flex-col">
                    {chunkItems.map((chunk, index) => {
                      const locator = chunkLocatorLabel(chunk);
                      const label = imageRoleLabel(chunk) ?? chunk.kind;
                      return (
                        <li
                          key={chunk.id}
                          className="flex min-w-0 items-start gap-3 border-b py-3 last:border-b-0"
                        >
                          <span className="w-6 shrink-0 pt-0.5 text-right font-mono text-2xs text-muted-foreground">
                            {index + 1}
                          </span>
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              {chunk.heading ? (
                                <span className="min-w-0 truncate text-xs font-medium text-fg">
                                  {chunk.heading}
                                </span>
                              ) : null}
                              {chunk.editedByUser ? (
                                <StatusBadge tone="warn">人工编辑</StatusBadge>
                              ) : null}
                              {!chunk.enabled ? (
                                <StatusBadge tone="outline">已停用</StatusBadge>
                              ) : null}
                              <span className="text-2xs text-muted-foreground">
                                {locator === null ? label : `${label} · ${locator}`}
                              </span>
                            </div>
                            <p className="line-clamp-3 text-sm text-muted-foreground">
                              {chunk.content}
                            </p>
                          </div>
                          {canManage ? (
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`${chunk.enabled ? '停用' : '启用'}分块 ${index + 1}`}
                                disabled={toggle.isPending || !isCurrent}
                                onClick={() =>
                                  toggle.mutate(
                                    { chunkId: chunk.id, patch: { enabled: !chunk.enabled } },
                                    {
                                      onSuccess: () =>
                                        toastSuccess(chunk.enabled ? '分块已停用' : '分块已启用'),
                                      onError: toastError,
                                    },
                                  )
                                }
                              >
                                {chunk.enabled ? '停用' : '启用'}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`编辑分块 ${index + 1}`}
                                disabled={!isCurrent}
                                onClick={() => setEditing(chunk)}
                              >
                                <Pencil />
                              </Button>
                              <Button
                                variant="destructive"
                                size="icon-sm"
                                aria-label={`删除分块 ${index + 1}`}
                                disabled={remove.isPending || !isCurrent}
                                onClick={() => setDeleting(chunk)}
                              >
                                <Trash2 />
                              </Button>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {chunks.hasNextPage ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start"
                    disabled={chunks.isFetchingNextPage}
                    aria-busy={chunks.isFetchingNextPage}
                    onClick={() => void chunks.fetchNextPage()}
                  >
                    {chunks.isFetchingNextPage ? '加载中…' : '加载更多分块'}
                  </Button>
                ) : null}
              </PageSection>
            </div>
          </div>
        </DialogShell>
      </Dialog>
      {editing ? (
        <ChunkDialog
          baseId={document.baseId}
          documentId={document.id}
          versionId={versionId}
          chunk={editing}
          onClose={() => setEditing(null)}
          onReload={async () => {
            await chunks.refetch();
            setEditing(null);
          }}
        />
      ) : null}
      {addingChunk ? (
        <ChunkDialog
          baseId={document.baseId}
          documentId={document.id}
          versionId={versionId}
          onClose={() => setAddingChunk(false)}
          onReload={async () => {
            await chunks.refetch();
            setAddingChunk(false);
          }}
        />
      ) : null}
      {manualOpen ? (
        <ManualDraftDialog
          baseId={document.baseId}
          documentId={document.id}
          title={document.title}
          onClose={() => setManualOpen(false)}
        />
      ) : null}
      <ConfirmDialog
        open={confirmRollback}
        title="设为当前版本"
        description={
          selectedVersion
            ? `将 v${selectedVersion.version} 设为当前版本；线上读取会切到该版，历史版本继续保留。`
            : ''
        }
        confirmLabel="切换"
        confirmDisabled={rollback.isPending}
        onClose={() => setConfirmRollback(false)}
        onConfirm={async () => {
          if (!selectedVersion) return;
          await rollback.mutateAsync({
            documentId: document.id,
            versionId: selectedVersion.id,
            expectedVersionId: currentVersionId,
          });
          toastSuccess('已切换当前版本');
          setSelectedVersionId(null);
          setConfirmRollback(false);
        }}
      />
      {deleting ? (
        <ConfirmDialog
          open
          title="删除分块"
          description="删除后会生成新版本；重新解析不会恢复人工删除的分块。"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toastSuccess('分块已删除');
            setDeleting(null);
          }}
        />
      ) : null}
    </>
  );
}

const chunkFormSchema = z.object({
  heading: z.string(),
  content: z.string(),
});
type ChunkFormValues = z.infer<typeof chunkFormSchema>;

function ChunkDialog({
  baseId,
  documentId,
  versionId,
  chunk,
  onClose,
  onReload,
}: {
  baseId: string;
  documentId: string;
  versionId: string | null;
  /** 缺省为新增分块；只能操作当前版本。 */
  chunk?: KnowledgeChunk;
  onClose: () => void;
  /** 冲突后由调用方重新拉取分块并关闭，草稿只在这里明确放弃。 */
  onReload: () => Promise<void>;
}) {
  const update = useUpdateKnowledgeChunk(baseId, documentId, versionId);
  const create = useCreateKnowledgeChunk(baseId, documentId, versionId);
  const creating = chunk === undefined;
  // 基线取打开时的正文：父级分块查询刷新不能覆盖用户正在改的草稿。
  const { register, handleSubmit, watch, formState } = useZodForm(chunkFormSchema, {
    defaultValues: { heading: chunk?.heading ?? '', content: chunk?.content ?? '' },
  });
  const { isDirty } = formState;
  const trimmed = watch('content').trim();
  const [error, setError] = useState<string | null>(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const pending = update.isPending || create.isPending;
  const dirty = isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);
  // 图片向量是真实图 embedding；改正文会让它和图片脱节，只允许在列表里启停。
  const vectorChunk = chunk?.metadata?.imageRole === 'vector';

  if (vectorChunk) {
    return (
      <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
        <DialogShell title="编辑分块">
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              图片向量分块只能启停，正文和图片定位由图片处理生成。
            </p>
            <div className="flex justify-end">
              <Button variant="outline" onClick={onClose}>
                关闭
              </Button>
            </div>
          </div>
        </DialogShell>
      </Dialog>
    );
  }

  const submit = handleSubmit((values: ChunkFormValues) => {
    setError(null);
    const patch = {
      content: values.content.trim(),
      heading: values.heading.trim() === '' ? null : values.heading.trim(),
    };
    const handlers = {
      onSuccess: () => {
        toastSuccess(creating ? '分块已新增，正在补建向量' : '分块已保存，正在补建向量');
        guard.finish();
      },
      onError: (reason: unknown) => {
        setError(errorMessage(reason));
      },
    };
    if (chunk) update.mutate({ chunkId: chunk.id, patch }, handlers);
    else create.mutate(patch, handlers);
  });

  return (
    <Dialog open onOpenChange={guardedOpenChange(pending, guard.close)}>
      <DialogShell title={creating ? '新增分块' : '编辑分块'} closeDisabled={pending}>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="knowledge-chunk-heading">标题</FieldLabel>
            <Input id="knowledge-chunk-heading" {...register('heading')} disabled={pending} />
          </Field>
          <Field className="gap-1.5" data-invalid={error !== null}>
            <FieldLabel htmlFor="knowledge-chunk-content">正文</FieldLabel>
            <Textarea
              id="knowledge-chunk-content"
              {...register('content')}
              rows={10}
              disabled={pending}
              aria-invalid={error !== null}
            />
            <FieldError>{error}</FieldError>
          </Field>
          <div className="flex justify-end gap-2">
            {error ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  if (dirty) setConfirmReload(true);
                  else {
                    if (creating) create.reset();
                    else update.reset();
                    void onReload();
                  }
                }}
              >
                重新加载
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending || trimmed === ''} aria-busy={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="分块正文草稿会丢失。" pending={pending} />
        <ConfirmDialog
          open={confirmReload}
          onClose={() => setConfirmReload(false)}
          title="放弃未保存的更改？"
          description="重新加载会用服务端版本覆盖当前草稿。"
          confirmLabel="放弃并重新加载"
          confirmDisabled={pending}
          onConfirm={async () => {
            if (pending) return;
            if (creating) create.reset();
            else await update.reset();
            await onReload();
          }}
        />
      </DialogShell>
    </Dialog>
  );
}
