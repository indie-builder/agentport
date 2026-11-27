import { KNOWLEDGE_DOCUMENT_MAX_BYTES, type KnowledgeDocument } from '@agentport/shared';
import { Toolbar, ToolbarButton } from '@ui-sdk/react/toolbar';
import {
  ChevronDown,
  Download,
  EllipsisVertical,
  FileText,
  Folder,
  FolderOpen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Tags,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { CursorListFooter } from '../../../components/cursor-list-footer.js';
import { FilterSelect } from '../../../components/filter-select.js';
import { BatchActionDialog } from '../../../components/knowledge/knowledge-documents.js';
import {
  AUDIO_MAX_BYTES,
  documentStatusLabel,
  documentStatusTone,
  isAudioUpload,
  parseKnowledgeDocumentStatusFilter,
  treeFolders,
} from '../../../components/knowledge/knowledge-shared.js';
import { PageNote, PageToolbar } from '../../../components/page.js';
import { SearchInput } from '../../../components/search-input.js';
import {
  type EmptyFilterChip,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../components/states.js';
import { StatusBadge } from '../../../components/status-badge.js';
import { Button, buttonVariants } from '../../../components/ui/button.js';
import { Checkbox } from '../../../components/ui/checkbox.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table.js';
import type { KnowledgeFolder } from '../../../lib/api.js';
import { downloadBlob, readFileBase64 } from '../../../lib/browser-files.js';
import { cn } from '../../../lib/cn.js';
import { useFormBlocker } from '../../../lib/form.js';
import { formatDateTime, formatRelative } from '../../../lib/format.js';
import {
  knowledgeShouldPoll,
  useDeleteKnowledgeDocument,
  useDeleteKnowledgeFolder,
  useDownloadKnowledgeDocuments,
  useKnowledgeDocument,
  useKnowledgeDocuments,
  useKnowledgeFolders,
  useKnowledgeTags,
  useReprocessKnowledgeDocument,
  useUploadKnowledgeDocument,
} from '../../../lib/queries.js';
import { toastError, toastSuccess } from '../../../lib/toast.js';
import { DocumentDialog, FolderDialog, TagDialog } from './document-dialogs.js';
import { ManualDocumentDialog, UrlImportDialog } from './document-imports.js';
import { DocumentViewer } from './document-viewer.js';
import type { KnowledgeCaps } from './shared.js';

type DocumentSort = 'updated' | 'created' | 'title';

type DocumentSearchPatch = {
  q?: string | undefined;
  status?: KnowledgeDocument['status'] | undefined;
  tag?: string | undefined;
  sort?: DocumentSort | undefined;
  folder?: string | undefined;
};

export function DocumentsTab({
  baseId,
  baseSlug,
  caps,
  asrEnabled,
  folderId,
  onFolderChange,
  documentId,
  onDocumentChange,
  query,
  status,
  tag,
  sort,
  onSearchChange,
  onViewJobs,
}: {
  baseId: string;
  baseSlug: string | undefined;
  caps: KnowledgeCaps;
  asrEnabled: boolean;
  folderId: string | undefined;
  onFolderChange: (folderId: string | undefined) => void;
  documentId: string | undefined;
  onDocumentChange: (documentId: string | undefined) => void;
  query: string;
  status: 'all' | KnowledgeDocument['status'];
  tag: string;
  sort: DocumentSort | undefined;
  onSearchChange: (patch: DocumentSearchPatch, replace?: boolean) => void;
  onViewJobs: (documentId: string) => void;
}) {
  const [queryDraft, setQueryDraft] = useState(query);
  const [composing, setComposing] = useState(false);
  const lastSyncedQuery = useRef(query);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const onSearchChangeRef = useRef(onSearchChange);
  onSearchChangeRef.current = onSearchChange;

  useEffect(() => {
    const node = searchBoxRef.current;
    if (!node) return;
    const onStart = (): void => setComposing(true);
    const onEnd = (): void => setComposing(false);
    node.addEventListener('compositionstart', onStart);
    node.addEventListener('compositionend', onEnd);
    return () => {
      node.removeEventListener('compositionstart', onStart);
      node.removeEventListener('compositionend', onEnd);
    };
  }, []);

  useEffect(() => {
    if (query === lastSyncedQuery.current) return;
    lastSyncedQuery.current = query;
    setQueryDraft(query);
  }, [query]);

  useEffect(() => {
    if (composing) return;
    const trimmed = queryDraft.trim();
    if (trimmed === lastSyncedQuery.current) return;
    const timer = window.setTimeout(() => {
      lastSyncedQuery.current = trimmed;
      onSearchChangeRef.current({ q: trimmed === '' ? undefined : trimmed }, true);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [queryDraft, composing]);

  const settledQuery = query.trim();
  const applyStatus = (next: string): void => {
    const value = parseKnowledgeDocumentStatusFilter(next);
    if (value !== undefined) {
      onSearchChange({ status: value === 'all' ? undefined : value }, true);
    }
  };
  const folders = useKnowledgeFolders(baseId);
  const tags = useKnowledgeTags(baseId);
  const deleteFolder = useDeleteKnowledgeFolder(baseId);
  const documents = useKnowledgeDocuments(baseId, {
    ...(folderId === undefined ? {} : { folderId }),
    ...(status === 'all' ? {} : { status }),
    ...(tag === 'all' ? {} : { tag }),
    ...(settledQuery === '' ? {} : { q: settledQuery }),
    ...(sort === undefined ? {} : { sort, order: sort === 'title' ? 'asc' : 'desc' }),
  });
  const documentItems = documents.data?.pages.flatMap((page) => page.items) ?? [];
  const upload = useUploadKnowledgeDocument(baseId);
  const removeDocument = useDeleteKnowledgeDocument(baseId);
  const reprocessDocument = useReprocessKnowledgeDocument(baseId);
  const downloadDocuments = useDownloadKnowledgeDocuments(baseId);
  const uploadInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [actionTrigger, setActionTrigger] = useState<HTMLElement | null>(null);
  const [confirmReprocess, setConfirmReprocess] = useState<KnowledgeDocument | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeDocument | null>(null);
  const [editing, setEditing] = useState<KnowledgeDocument | null>(null);
  const [viewingSnapshot, setViewingSnapshot] = useState<KnowledgeDocument | null>(null);
  const listedDocument = documentItems.find((item) => item.id === documentId);
  const knownDocument =
    listedDocument ?? (viewingSnapshot?.id === documentId ? viewingSnapshot : undefined);
  const selectedDocument = useKnowledgeDocument(documentId ?? null, knownDocument === undefined);
  const resolvedDocument = knownDocument ?? selectedDocument.data;
  useEffect(() => {
    if (listedDocument && listedDocument !== viewingSnapshot) setViewingSnapshot(listedDocument);
  }, [listedDocument, viewingSnapshot]);
  const [folderDialog, setFolderDialog] = useState<
    { mode: 'create'; parentId: string | null } | { mode: 'rename'; folder: KnowledgeFolder } | null
  >(null);
  const [createdFolder, setCreatedFolder] = useState<string | null>(null);
  useEffect(() => {
    if (folderDialog !== null || createdFolder === null) return;
    onFolderChange(createdFolder);
    setCreatedFolder(null);
  }, [createdFolder, folderDialog, onFolderChange]);
  const [deletingFolder, setDeletingFolder] = useState<KnowledgeFolder | null>(null);
  const [managingTags, setManagingTags] = useState(false);
  const [folderTrigger, setFolderTrigger] = useState<HTMLElement | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [batchAction, setBatchAction] = useState<
    'move' | 'copy' | 'tag' | 'delete' | 'reprocess' | null
  >(null);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [leaveCancelled, setLeaveCancelled] = useState(false);
  const uploadBlocker = useFormBlocker(false, uploading !== null);
  useEffect(() => {
    if (uploading === null && uploadBlocker.status === 'blocked' && !leaveCancelled) {
      uploadBlocker.proceed();
    }
  }, [uploading, uploadBlocker, leaveCancelled]);

  const candidateDocument = resolvedDocument ?? knownDocument;
  const viewingDocument =
    documentId !== undefined && candidateDocument?.baseId === baseId ? candidateDocument : null;
  useEffect(() => {
    const visibleIds = new Set(documentItems.map((item) => item.id));
    setSelectedIds((previous) => {
      const next = new Set([...previous].filter((id) => visibleIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [documentItems]);
  const selectedDocuments = documentItems.filter((item) => selectedIds.has(item.id));
  const allSelected =
    documentItems.length > 0 && documentItems.every((item) => selectedIds.has(item.id));
  const toggleSelected = (id: string): void => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const viewerDocuments =
    viewingDocument !== null && !documentItems.some((item) => item.id === viewingDocument.id)
      ? [...documentItems, viewingDocument]
      : documentItems;

  const targetFolderId = folderId === undefined || folderId === 'null' ? null : folderId;
  const filtersActive =
    settledQuery !== '' || status !== 'all' || tag !== 'all' || folderId !== undefined;
  const clearQuery = (): void => {
    lastSyncedQuery.current = '';
    setQueryDraft('');
    onSearchChange({ q: undefined }, true);
  };
  const clearFilters = (): void => {
    lastSyncedQuery.current = '';
    setQueryDraft('');
    onSearchChange({ q: undefined, status: undefined, tag: undefined, folder: undefined }, true);
  };

  const onFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    const failed: string[] = [];
    setUploading({ done: 0, total: files.length });
    for (const [index, file] of files.entries()) {
      setUploading({ done: index, total: files.length });
      if (isAudioUpload(file) && file.size > AUDIO_MAX_BYTES) {
        failed.push(`${file.name}（音频超过 25 MB）`);
        continue;
      }
      if (file.size > KNOWLEDGE_DOCUMENT_MAX_BYTES) {
        failed.push(`${file.name}（超过 32 MB）`);
        continue;
      }
      try {
        const dataBase64 = await readFileBase64(file);
        const path = relativePath(file);
        await upload.mutateAsync({
          filename: path,
          mimeType: file.type || 'application/octet-stream',
          dataBase64,
          folderId: targetFolderId,
          ...(file.webkitRelativePath ? { relativePath: path } : {}),
        });
      } catch {
        failed.push(file.name);
      }
    }
    setUploading(null);
    const uploaded = files.length - failed.length;
    if (uploaded > 0) toastSuccess(`已上传 ${uploaded} 个文件，正在解析`);
    if (failed.length > 0) {
      toastError(new Error(`${failed.length} 个文件未上传：${failed.join('、')}`));
    }
  };

  const folderOptions = [
    { id: 'all', label: '全部文档', depth: 0 },
    { id: 'null', label: '未分类', depth: 0 },
    ...treeFolders(folders.data ?? []),
  ];

  return (
    <div className="grid min-w-0 gap-5 md:grid-cols-[220px_minmax(0,1fr)] md:items-start">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-medium text-fg">文件夹</h2>
          {caps.content ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="新建文件夹"
              title="新建文件夹"
              onClick={() => setFolderDialog({ mode: 'create', parentId: null })}
            >
              <Plus />
            </Button>
          ) : null}
        </div>
        {folders.isPending ? <LoadingState rows={3} /> : null}
        {folders.isError ? (
          <Button variant="link" size="xs" onClick={() => void folders.refetch()}>
            文件夹没有加载出来，重试
          </Button>
        ) : null}
        <ul className="flex flex-col">
          {folderOptions.map((folder) => {
            const active = (folderId ?? 'all') === folder.id;
            const entry =
              folder.id === 'all' || folder.id === 'null'
                ? null
                : (folders.data ?? []).find((item) => item.id === folder.id);
            return (
              <li key={folder.id} className="group/folder flex items-center gap-0.5">
                <button
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  style={{ paddingLeft: `${8 + folder.depth * 12}px` }}
                  onClick={() => onFolderChange(folder.id === 'all' ? undefined : folder.id)}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-1.5 rounded-item py-1.5 pr-2 text-left text-sm transition-colors duration-150 ease-out-soft',
                    active
                      ? 'bg-selected font-medium text-selected-foreground'
                      : 'text-muted-foreground hover:bg-hover hover:text-fg',
                  )}
                >
                  {folder.depth === 0 ? (
                    <FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <Folder className="size-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span className="truncate">{folder.label}</span>
                </button>
                {entry && caps.content ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`文件夹操作 ${entry.name}`}
                          className="transition-opacity duration-150 ease-out-soft [@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/folder:opacity-100 group-focus-within/folder:opacity-100 focus-visible:opacity-100 data-open:opacity-100"
                          onFocus={(event) => setFolderTrigger(event.currentTarget)}
                          onClick={(event) => setFolderTrigger(event.currentTarget)}
                        >
                          <EllipsisVertical />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end" sideOffset={4} className="w-40">
                      <DropdownMenuGroup>
                        <DropdownMenuItem
                          onSelect={() => setFolderDialog({ mode: 'rename', folder: entry })}
                        >
                          <Pencil /> 重命名
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => setFolderDialog({ mode: 'create', parentId: entry.id })}
                        >
                          <Plus /> 新建子文件夹
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setDeletingFolder(entry)}
                        >
                          <Trash2 /> 删除
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <PageToolbar>
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <FilterSelect
              label="按状态筛选"
              value={status}
              onValueChange={applyStatus}
              options={[
                { value: 'all', label: '全部状态' },
                ...Object.entries(documentStatusLabel).map(([value, label]) => ({ value, label })),
              ]}
              className="w-36"
            />
            {tags.data && tags.data.length > 0 ? (
              <FilterSelect
                label="按标签筛选"
                value={tag}
                onValueChange={(next) =>
                  onSearchChange({ tag: next === 'all' ? undefined : next }, true)
                }
                options={[
                  { value: 'all', label: '全部标签' },
                  ...tags.data.map((item) => ({ value: item.name, label: item.name })),
                ]}
                className="w-36"
              />
            ) : null}
            <FilterSelect
              label="按排序展示文档"
              value={sort ?? 'created'}
              onValueChange={(next) =>
                onSearchChange(
                  { sort: next === 'updated' || next === 'title' ? next : undefined },
                  true,
                )
              }
              options={[
                { value: 'updated', label: '最近更新' },
                { value: 'created', label: '最近创建' },
                { value: 'title', label: '名称' },
              ]}
              className="w-32"
            />
            {tags.isError ? (
              <Button variant="link" size="xs" onClick={() => void tags.refetch()}>
                标签没有加载出来，重试
              </Button>
            ) : null}
            {caps.content ? (
              <Button variant="ghost" size="sm" onClick={() => setManagingTags(true)}>
                <Tags data-icon="inline-start" aria-hidden="true" /> 管理标签
              </Button>
            ) : null}
            <span role="status" className="text-xs text-muted-foreground">
              {documents.isPending
                ? '加载中…'
                : documents.hasNextPage
                  ? `已加载 ${documentItems.length} 个文档`
                  : `共 ${documentItems.length} 个文档`}
            </span>
          </div>
          <div
            ref={searchBoxRef}
            className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2"
          >
            <SearchInput
              label="搜索文档"
              placeholder="搜索文档…"
              value={queryDraft}
              onChange={setQueryDraft}
              className="min-w-40 flex-1 sm:w-56 sm:flex-none"
            />
            {caps.content ? (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="outline" disabled={uploading !== null}>
                        导入
                        <ChevronDown data-icon="inline-end" aria-hidden="true" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" sideOffset={4} className="w-44">
                    <DropdownMenuGroup>
                      <DropdownMenuItem onSelect={() => folderInput.current?.click()}>
                        <FolderOpen /> 上传文件夹
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setManualOpen(true)}>
                        <FileText /> 手写文档
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setUrlOpen(true)}>
                        <Search /> 导入网址
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  disabled={uploading !== null}
                  aria-busy={uploading !== null}
                  onClick={() => uploadInput.current?.click()}
                >
                  <Upload data-icon="inline-start" aria-hidden="true" />
                  {uploading ? `上传中 ${uploading.done}/${uploading.total}` : '上传文件'}
                </Button>
                <input
                  ref={uploadInput}
                  type="file"
                  multiple
                  className="hidden"
                  aria-label="选择要上传的文件"
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = '';
                    void onFiles(files);
                  }}
                />
                <input
                  ref={folderInput}
                  type="file"
                  multiple
                  webkitdirectory=""
                  className="hidden"
                  aria-label="选择要上传的文件夹"
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = '';
                    void onFiles(files);
                  }}
                />
              </>
            ) : null}
          </div>
        </PageToolbar>

        {caps.content ? (
          <p className="text-sm text-muted-foreground">
            音频支持 mp3、wav、m4a、flac、ogg，单个不超过 25 MB。
            {asrEnabled
              ? '上传后会调用已配置的转录模型，可能计费；失败重试可能再次计费。'
              : '先在知识库设置里绑定音频转录模型。'}
          </p>
        ) : null}

        {(caps.content || caps.execute) && selectedDocuments.length > 0 ? (
          <Toolbar
            aria-label="批量操作"
            className="flex min-w-0 flex-wrap items-center gap-2 rounded-item bg-sunken px-3 py-2"
          >
            <span className="text-xs text-fg">已选 {selectedDocuments.length} 个</span>
            {caps.content ? (
              <>
                <ToolbarButton
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  onClick={() => setBatchAction('move')}
                >
                  移动
                </ToolbarButton>
                <ToolbarButton
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  onClick={() => setBatchAction('copy')}
                >
                  复制
                </ToolbarButton>
                <ToolbarButton
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  onClick={() => setBatchAction('tag')}
                >
                  标签
                </ToolbarButton>
              </>
            ) : null}
            {caps.execute ? (
              <ToolbarButton
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                onClick={() => setBatchAction('reprocess')}
              >
                重新解析
              </ToolbarButton>
            ) : null}
            <ToolbarButton
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              disabled={downloadDocuments.isPending || selectedDocuments.length > 200}
              aria-busy={downloadDocuments.isPending}
              title={selectedDocuments.length > 200 ? '一次最多下载 200 个文档' : undefined}
              onClick={async () => {
                try {
                  const blob = await downloadDocuments.mutateAsync(
                    selectedDocuments.map((item) => item.id),
                  );
                  downloadBlob(blob, baseSlug ? `${baseSlug}-documents.zip` : 'documents.zip');
                  toastSuccess('已开始下载文档 ZIP');
                  setSelectedIds(new Set());
                } catch (err) {
                  toastError(err);
                }
              }}
            >
              <Download data-icon="inline-start" aria-hidden="true" />
              {downloadDocuments.isPending ? '下载中…' : '下载'}
            </ToolbarButton>
            {caps.content ? (
              <ToolbarButton
                className={buttonVariants({ variant: 'destructive', size: 'sm' })}
                onClick={() => setBatchAction('delete')}
              >
                删除
              </ToolbarButton>
            ) : null}
            <ToolbarButton
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'ml-auto')}
              onClick={() => setSelectedIds(new Set())}
            >
              取消选择
            </ToolbarButton>
          </Toolbar>
        ) : null}

        {documentItems.some((doc) => doc.status === 'pending' || doc.status === 'processing') &&
        !knowledgeShouldPoll(documentItems) ? (
          <PageNote
            title="已停止自动刷新"
            description="解析已超过 30 分钟仍未结束，可能已经卡住；刷新查看状态，或在任务页取消后重试。"
            action={
              <Button variant="outline" size="sm" onClick={() => void documents.refetch()}>
                刷新
              </Button>
            }
          />
        ) : null}
        {documents.isPending ? <LoadingState rows={4} /> : null}
        {documents.isError && !documents.isFetchNextPageError ? (
          <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
        ) : null}
        {documents.isSuccess && documentItems.length === 0 ? (
          filtersActive ? (
            <EmptyState
              variant="filter"
              scale="section"
              title="没有匹配的文档"
              activeFilters={
                [
                  ...(folderId !== undefined
                    ? [
                        {
                          key: 'folder',
                          label: '文件夹',
                          value:
                            folderOptions.find((option) => option.id === folderId)?.label ??
                            (folderId === 'null' ? '未分类' : folderId),
                          onRemove: () => onFolderChange(undefined),
                        },
                      ]
                    : []),
                  ...(status !== 'all'
                    ? [
                        {
                          key: 'status',
                          label: '状态',
                          value: documentStatusLabel[status],
                          onRemove: () => onSearchChange({ status: undefined }, true),
                        },
                      ]
                    : []),
                  ...(tag !== 'all'
                    ? [
                        {
                          key: 'tag',
                          label: '标签',
                          value: tag,
                          onRemove: () => onSearchChange({ tag: undefined }, true),
                        },
                      ]
                    : []),
                  ...(settledQuery !== ''
                    ? [
                        {
                          key: 'q',
                          label: '关键词',
                          value: settledQuery,
                          onRemove: clearQuery,
                        },
                      ]
                    : []),
                ] satisfies EmptyFilterChip[]
              }
              action={
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  清除全部筛选
                </Button>
              }
            />
          ) : (
            <EmptyState
              variant="stage"
              scale="section"
              specimen="documents"
              title="上传你的第一份文档"
              description="支持文件上传、文件夹导入、手写文档或抓取网页。"
              action={
                caps.content ? (
                  <Button onClick={() => uploadInput.current?.click()}>
                    <Upload data-icon="inline-start" aria-hidden="true" /> 上传文件
                  </Button>
                ) : undefined
              }
              secondaryAction={
                caps.content ? (
                  <Button variant="outline" onClick={() => setManualOpen(true)}>
                    手写文档
                  </Button>
                ) : undefined
              }
              footer={caps.content ? undefined : '当前账户没有上传文档的权限。'}
            />
          )
        ) : null}
        {documentItems.length > 0 ? (
          <Table aria-label="文档列表">
            <TableHeader>
              <TableRow>
                {caps.content || caps.execute ? (
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={(checked) =>
                        setSelectedIds(
                          checked ? new Set(documentItems.map((item) => item.id)) : new Set(),
                        )
                      }
                      aria-label="选择全部文档"
                    />
                  </TableHead>
                ) : null}
                <TableHead>标题</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-40">更新</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documentItems.map((document) => (
                <TableRow
                  key={document.id}
                  data-selected={selectedIds.has(document.id) || undefined}
                >
                  {caps.content || caps.execute ? (
                    <TableCell>
                      <Checkbox
                        checked={selectedIds.has(document.id)}
                        onCheckedChange={() => toggleSelected(document.id)}
                        aria-label={`选择 ${document.title}`}
                      />
                    </TableCell>
                  ) : null}
                  <TableCell className="max-w-0">
                    <button
                      type="button"
                      className="block w-full truncate text-left text-fg hover:underline"
                      title={document.title}
                      onClick={() => {
                        setActionTrigger(null);
                        onDocumentChange(document.id);
                      }}
                    >
                      {document.title}
                    </button>
                    {document.tags.length > 0 ? (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {document.tags.join(' · ')}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={documentStatusTone[document.status]}>
                      {documentStatusLabel[document.status]}
                    </StatusBadge>
                  </TableCell>
                  <TableCell
                    className="text-xs text-muted-foreground"
                    title={formatDateTime(document.updatedAt)}
                  >
                    {formatRelative(document.updatedAt)}
                  </TableCell>
                  <TableCell>
                    {caps.content ||
                    (caps.execute &&
                      document.disabledReason === null &&
                      document.status !== 'disabled' &&
                      document.currentVersionId !== null) ||
                    (document.status === 'failed' && document.currentVersionId === null) ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`操作 ${document.title}`}
                              onFocus={(event) => setActionTrigger(event.currentTarget)}
                              onClick={(event) => setActionTrigger(event.currentTarget)}
                            >
                              <EllipsisVertical />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end" sideOffset={4} className="w-44">
                          <DropdownMenuGroup>
                            {caps.content ? (
                              <DropdownMenuItem onSelect={() => setEditing(document)}>
                                <FolderOpen /> 移动 / 标注
                              </DropdownMenuItem>
                            ) : null}
                            {caps.execute &&
                            document.disabledReason === null &&
                            document.status !== 'disabled' &&
                            (document.currentVersionId !== null || document.status === 'failed') ? (
                              <DropdownMenuItem onSelect={() => setConfirmReprocess(document)}>
                                <RefreshCw /> 重新解析
                              </DropdownMenuItem>
                            ) : null}
                            {document.status === 'failed' && document.currentVersionId === null ? (
                              <DropdownMenuItem onSelect={() => onViewJobs(document.id)}>
                                <FileText /> 查看处理记录
                              </DropdownMenuItem>
                            ) : null}
                            {caps.content ? (
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => setDeleting(document)}
                              >
                                <Trash2 /> 删除
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        <CursorListFooter
          query={documents}
          label="文档"
          errorTitle="更多文档没有加载出来"
          className="justify-start"
        />

        {confirmReprocess ? (
          <ConfirmDialog
            open
            title="重新解析文档"
            description={`将重新解析「${confirmReprocess.title}」并生成新版本；人工编辑过的分块会被丢弃。`}
            confirmLabel="重新解析"
            finalFocus={() => actionTrigger}
            onClose={() => setConfirmReprocess(null)}
            onConfirm={async () => {
              await reprocessDocument.mutateAsync(confirmReprocess.id);
              toastSuccess('已提交重新解析任务');
            }}
          />
        ) : null}
        {deleting ? (
          <ConfirmDialog
            open
            title="删除文档"
            description={`将删除「${deleting.title}」及其分块。引用它的 Wiki 页面会标记为待刷新。`}
            finalFocus={() => actionTrigger}
            onClose={() => setDeleting(null)}
            onConfirm={async () => {
              await removeDocument.mutateAsync(deleting.id);
              toastSuccess('文档已删除');
            }}
          />
        ) : null}
        {editing ? (
          <DocumentDialog
            baseId={baseId}
            document={editing}
            folders={folders.data ?? []}
            onClose={() => setEditing(null)}
          />
        ) : null}
        {documentId && selectedDocument.isPending && !viewingDocument ? (
          <LoadingState rows={2} />
        ) : null}
        {documentId && selectedDocument.isError ? (
          <ErrorState
            error={selectedDocument.error}
            onRetry={() => void selectedDocument.refetch()}
          />
        ) : null}
        {viewingDocument ? (
          <DocumentViewer
            document={viewingDocument}
            documents={viewerDocuments}
            key={viewingDocument.id}
            canManage={caps.content}
            canPublish={caps.publish}
            onSelect={(document) => {
              onDocumentChange(document.id);
            }}
            onClose={() => {
              onDocumentChange(undefined);
            }}
            onEdit={() => {
              setEditing(viewingDocument);
              onDocumentChange(undefined);
            }}
          />
        ) : null}
        {batchAction ? (
          <BatchActionDialog
            baseId={baseId}
            action={batchAction}
            documentIds={selectedDocuments.map((item) => item.id)}
            titles={Object.fromEntries(selectedDocuments.map((item) => [item.id, item.title]))}
            folders={folders.data ?? []}
            onClose={() => {
              setBatchAction(null);
              setSelectedIds(new Set());
            }}
          />
        ) : null}
        {folderDialog ? (
          <FolderDialog
            baseId={baseId}
            state={folderDialog}
            finalFocus={() => (folderTrigger?.isConnected ? folderTrigger : null)}
            onCreated={(folder) => {
              setFolderDialog(null);
              setCreatedFolder(folder.id);
            }}
            onClose={() => setFolderDialog(null)}
          />
        ) : null}
        {deletingFolder ? (
          <ConfirmDialog
            open
            title="删除文件夹"
            description={`将删除「${deletingFolder.name}」及其子文件夹。其中的文档会移到未分类，不会被删除。`}
            finalFocus={() => (folderTrigger?.isConnected ? folderTrigger : null)}
            onClose={() => setDeletingFolder(null)}
            onConfirm={async () => {
              await deleteFolder.mutateAsync(deletingFolder.id);
              if (folderId === deletingFolder.id) onFolderChange(undefined);
              toastSuccess('文件夹已删除');
            }}
          />
        ) : null}
        {managingTags ? <TagDialog baseId={baseId} onClose={() => setManagingTags(false)} /> : null}
        {manualOpen ? (
          <ManualDocumentDialog
            baseId={baseId}
            folderId={targetFolderId}
            folders={folders.data ?? []}
            onClose={() => setManualOpen(false)}
          />
        ) : null}
        {urlOpen ? (
          <UrlImportDialog
            baseId={baseId}
            folderId={targetFolderId}
            folders={folders.data ?? []}
            onClose={() => setUrlOpen(false)}
          />
        ) : null}
        <ConfirmDialog
          open={uploadBlocker.status === 'blocked'}
          title="上传尚未完成"
          description="文件正在上传；批次结束前不能切换页签或离开知识库。"
          confirmLabel="继续离开"
          confirmDisabled={uploading !== null}
          onCancel={() => setLeaveCancelled(true)}
          onClose={() => {
            setLeaveCancelled(false);
            uploadBlocker.reset?.();
          }}
          onConfirm={async () => uploadBlocker.proceed()}
        />
      </div>
    </div>
  );
}

function relativePath(file: File): string {
  return file.webkitRelativePath || file.name;
}
