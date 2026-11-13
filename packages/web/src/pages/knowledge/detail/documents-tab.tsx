import type { KnowledgeDocument } from '@agentport/shared';
import {
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Tags,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { BusinessIllustration } from '../../../components/business-illustration.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
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
import { EmptyState, ErrorState, LoadingState } from '../../../components/states.js';
import { StatusBadge } from '../../../components/status-badge.js';
import { Button } from '../../../components/ui/button.js';
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
import { readFileBase64 } from '../../../lib/browser-files.js';
import { cn } from '../../../lib/cn.js';
import { useFormBlocker } from '../../../lib/form.js';
import { formatDateTime, formatRelative } from '../../../lib/format.js';
import {
  knowledgeShouldPoll,
  useDeleteKnowledgeDocument,
  useDeleteKnowledgeFolder,
  useKnowledgeDocument,
  useKnowledgeDocuments,
  useKnowledgeFolders,
  useKnowledgeTags,
  useReprocessKnowledgeDocument,
  useUploadKnowledgeDocument,
} from '../../../lib/queries.js';
import { toastError, toastSuccess } from '../../../lib/toast.js';
import { useDebouncedValue } from '../../../lib/use-debounced-value.js';
import { DocumentDialog, FolderDialog, TagDialog } from './document-dialogs.js';
import { ManualDocumentDialog, UrlImportDialog } from './document-imports.js';
import { DocumentViewer } from './document-viewer.js';
import type { KnowledgeCaps } from './shared.js';

// ---- 文档 -----------------------------------------------------------------

export function DocumentsTab({
  baseId,
  caps,
  asrEnabled,
  folderId,
  onFolderChange,
  documentId,
  onDocumentChange,
  onViewJobs,
}: {
  baseId: string;
  caps: KnowledgeCaps;
  asrEnabled: boolean;
  folderId: string | undefined;
  onFolderChange: (folderId: string | undefined) => void;
  documentId: string | undefined;
  onDocumentChange: (documentId: string | undefined) => void;
  onViewJobs: (documentId: string) => void;
}) {
  const [query, setQuery] = useState('');
  // 每个字符都换无限查询键会把列表打爆：输入即时回显，停 300ms 再订阅。
  const settledQuery = useDebouncedValue(query.trim(), 300);
  const [status, setStatus] = useState<'all' | KnowledgeDocument['status']>('all');
  const applyStatus = (next: string): void => {
    const value = parseKnowledgeDocumentStatusFilter(next);
    if (value !== undefined) setStatus(value);
  };
  const [tag, setTag] = useState('all');
  const folders = useKnowledgeFolders(baseId);
  const tags = useKnowledgeTags(baseId);
  const deleteFolder = useDeleteKnowledgeFolder(baseId);
  const documents = useKnowledgeDocuments(baseId, {
    ...(folderId === undefined ? {} : { folderId }),
    ...(status === 'all' ? {} : { status }),
    ...(tag === 'all' ? {} : { tag }),
    ...(settledQuery === '' ? {} : { q: settledQuery }),
  });
  const documentItems = documents.data?.pages.flatMap((page) => page.items) ?? [];
  const upload = useUploadKnowledgeDocument(baseId);
  const removeDocument = useDeleteKnowledgeDocument(baseId);
  const reprocessDocument = useReprocessKnowledgeDocument(baseId);
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
  // 创建成功的弹层卸载、blocker 注销后才切 URL：同一 tick 内导航仍会被旧的 dirty/pending 拦下。
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
  // 上传批次结束前不卸载这个面板：切页签、换文件夹或离开路由都会丢失批次状态。
  const uploadBlocker = useFormBlocker(false, uploading !== null);
  useEffect(() => {
    if (uploading === null && uploadBlocker.status === 'blocked') uploadBlocker.proceed();
  }, [uploading, uploadBlocker]);

  const candidateDocument = resolvedDocument ?? knownDocument;
  const viewingDocument =
    documentId !== undefined && candidateDocument?.baseId === baseId ? candidateDocument : null;
  // 选中集合随筛选/轮询收缩：已不在当前列表的文档不能继续参与批量操作。
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
  // 目录补上当前快照：筛选或轮询暂时不含它时仍能标出当前位置，也不改动已挂载的查看器。
  const viewerDocuments =
    viewingDocument !== null && !documentItems.some((item) => item.id === viewingDocument.id)
      ? [...documentItems, viewingDocument]
      : documentItems;

  const targetFolderId = folderId === undefined || folderId === 'null' ? null : folderId;
  // 任一筛选生效时，空结果给「清除筛选」而不是「还没有文档」的误导。
  const filtersActive =
    settledQuery !== '' || status !== 'all' || tag !== 'all' || folderId !== undefined;
  const clearFilters = (): void => {
    setQuery('');
    setStatus('all');
    setTag('all');
    onFolderChange(undefined);
  };

  /**
   * 多文件按顺序上传：每个文件单独一个请求（后端只收单文件），
   * 某个失败时记下文件名并继续；结束时明确告出成功/失败数量，不静默丢文件。
   */
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
      if (file.size > 32 * 1024 * 1024) {
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
          // 后端按相对路径创建或复用真实目录；标题取 basename。
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
                          className="transition-opacity duration-150 ease-out-soft [@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/folder:opacity-100 group-focus-within/folder:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
                          onClick={(event) => setFolderTrigger(event.currentTarget)}
                        >
                          <MoreHorizontal />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end" sideOffset={4} className="w-40">
                      <DropdownMenuGroup>
                        <DropdownMenuItem
                          onClick={() => setFolderDialog({ mode: 'rename', folder: entry })}
                        >
                          <Pencil /> 重命名
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setFolderDialog({ mode: 'create', parentId: entry.id })}
                        >
                          <Plus /> 新建子文件夹
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeletingFolder(entry)}
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
                onValueChange={setTag}
                options={[
                  { value: 'all', label: '全部标签' },
                  ...tags.data.map((item) => ({ value: item.name, label: item.name })),
                ]}
                className="w-36"
              />
            ) : null}
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
              {documents.isPending ? '加载中…' : `已加载 ${documentItems.length} 个文档`}
            </span>
          </div>
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
            <SearchInput
              label="搜索文档"
              placeholder="搜索文档…"
              value={query}
              onChange={setQuery}
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
                      <DropdownMenuItem onClick={() => folderInput.current?.click()}>
                        <FolderOpen /> 上传文件夹
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setManualOpen(true)}>
                        <FileText /> 手写文档
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setUrlOpen(true)}>
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
                  // React 的类型里还没有这个非标准属性；浏览器原生支持目录选择。
                  {...({ webkitdirectory: '' } as Record<string, string>)}
                  // 后端只有一个 folderId，不会按相对路径自动建目录树；
                  // 这里把相对路径作为文件名保留，便于在列表里看出原目录。
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
          <div
            role="toolbar"
            aria-label="批量操作"
            className="flex min-w-0 flex-wrap items-center gap-2 rounded-item bg-sunken px-3 py-2"
          >
            <span className="text-xs text-fg">已选 {selectedDocuments.length} 个</span>
            {caps.content ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setBatchAction('move')}>
                  移动
                </Button>
                <Button variant="outline" size="sm" onClick={() => setBatchAction('copy')}>
                  复制
                </Button>
                <Button variant="outline" size="sm" onClick={() => setBatchAction('tag')}>
                  标签
                </Button>
              </>
            ) : null}
            {caps.execute ? (
              <Button variant="outline" size="sm" onClick={() => setBatchAction('reprocess')}>
                重新解析
              </Button>
            ) : null}
            {caps.content ? (
              <Button variant="destructive" size="sm" onClick={() => setBatchAction('delete')}>
                删除
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setSelectedIds(new Set())}
            >
              取消选择
            </Button>
          </div>
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
        {documents.isError ? (
          <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
        ) : null}
        {documents.isSuccess && documentItems.length === 0 ? (
          <EmptyState
            illustration={<BusinessIllustration name={filtersActive ? 'search' : 'documents'} />}
            title={filtersActive ? '没有匹配的文档' : '还没有文档'}
            action={
              filtersActive ? (
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  清除筛选
                </Button>
              ) : caps.content ? (
                <Button variant="outline" size="sm" onClick={() => uploadInput.current?.click()}>
                  <Upload data-icon="inline-start" aria-hidden="true" /> 上传文件
                </Button>
              ) : undefined
            }
          />
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
                    (caps.execute && document.currentVersionId !== null) ||
                    (document.status === 'failed' && document.currentVersionId === null) ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`操作 ${document.title}`}
                              onClick={(event) => setActionTrigger(event.currentTarget)}
                            >
                              <MoreHorizontal />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end" sideOffset={4} className="w-44">
                          <DropdownMenuGroup>
                            {caps.content ? (
                              <DropdownMenuItem onClick={() => setEditing(document)}>
                                <FolderOpen /> 移动 / 标注
                              </DropdownMenuItem>
                            ) : null}
                            {caps.execute && document.currentVersionId !== null ? (
                              <DropdownMenuItem onClick={() => setConfirmReprocess(document)}>
                                <RefreshCw /> 重新解析
                              </DropdownMenuItem>
                            ) : null}
                            {document.status === 'failed' && document.currentVersionId === null ? (
                              <DropdownMenuItem onClick={() => onViewJobs(document.id)}>
                                <FileText /> 查看处理记录
                              </DropdownMenuItem>
                            ) : null}
                            {caps.content ? (
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setDeleting(document)}
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
        {documents.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={documents.isFetchingNextPage}
            aria-busy={documents.isFetchingNextPage}
            onClick={() => void documents.fetchNextPage()}
          >
            {documents.isFetchingNextPage ? '加载中…' : '加载更多文档'}
          </Button>
        ) : null}
        {documents.isFetchNextPageError ? (
          <ErrorState
            error={documents.error}
            title="更多文档没有加载出来"
            onRetry={() => void documents.fetchNextPage()}
          />
        ) : null}

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
              setConfirmReprocess(null);
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
              setDeleting(null);
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
          onClose={() => uploadBlocker.reset?.()}
          onConfirm={async () => uploadBlocker.proceed()}
        />
      </div>
    </div>
  );
}

/** 文件夹上传保留相对路径（后端只存一个 folderId，不建目录树）。 */
function relativePath(file: File): string {
  return file.webkitRelativePath || file.name;
}
