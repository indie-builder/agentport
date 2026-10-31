import type {
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeJob,
  KnowledgeSearchHit,
  KnowledgeSourceInput,
} from '@agentport/shared';
import { type Query, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  Cloud,
  Code,
  FileText,
  Folder,
  FolderOpen,
  GitFork,
  MoreHorizontal,
  PanelLeftDashed,
  Pencil,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Tags,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CodeBlock } from '../components/code-block.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { FilterSelect } from '../components/filter-select.js';
import { KnowledgeImage, stripImageReferences } from '../components/knowledge-citations.js';
import { KnowledgeSettingsDialog } from '../components/knowledge-settings.js';
import { Markdown } from '../components/markdown.js';
import { Collapsible, CollapsibleContent } from '../components/motion-collapsible.js';
import { Page, PageHeader, PageNote, PageSection, PageToolbar } from '../components/page.js';
import { ReaderToolbar } from '../components/reader-toolbar.js';
import { RequiredMark } from '../components/required-mark.js';
import { SearchInput } from '../components/search-input.js';
import { SourceEditor } from '../components/source-editor.js';
import { EmptyState, ErrorState, InlineEmpty, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import { Checkbox } from '../components/ui/checkbox.js';
import { Dialog } from '../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { Switch } from '../components/ui/switch.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { Textarea } from '../components/ui/textarea.js';
import { can } from '../lib/access.js';
import {
  ApiError,
  api,
  errorMessage,
  type KnowledgeChunk,
  type KnowledgeFolder,
  type KnowledgeSource,
  type KnowledgeTag,
  type KnowledgeVersionImage,
  type KnowledgeWikiVersion,
} from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { useFormBlocker } from '../lib/form.js';
import { formatDateTime, formatDuration, formatRelative } from '../lib/format.js';
import { knowledgeJobErrorText } from '../lib/knowledge-errors.js';
import {
  agentAccessQuery,
  agentDetailQuery,
  agentsQuery,
  knowledgeKeys,
  knowledgeShouldPoll,
  meQuery,
  useCancelKnowledgeJob,
  useCreateKnowledgeFolder,
  useCreateKnowledgeManualDocument,
  useCreateKnowledgeSource,
  useCreateKnowledgeTag,
  useCreateKnowledgeWikiPage,
  useDeleteKnowledgeChunk,
  useDeleteKnowledgeDocument,
  useDeleteKnowledgeFolder,
  useDeleteKnowledgeSource,
  useDeleteKnowledgeTag,
  useGenerateKnowledgeWikiPage,
  useImportKnowledgeUrl,
  useKnowledgeBase,
  useKnowledgeDocumentChunks,
  useKnowledgeDocuments,
  useKnowledgeFolders,
  useKnowledgeJobs,
  useKnowledgeMarkdown,
  useKnowledgeSearch,
  useKnowledgeSourceRuns,
  useKnowledgeSources,
  useKnowledgeTags,
  useKnowledgeVersionDetails,
  useKnowledgeWikiPage,
  useKnowledgeWikiPages,
  useLoadOlderKnowledgeWikiVersions,
  usePublishKnowledgeWikiVersion,
  useReprocessKnowledgeDocument,
  useRetryKnowledgeJob,
  useRollbackKnowledgeWikiPage,
  useSaveKnowledgeWikiPage,
  useSyncKnowledgeSource,
  useTestKnowledgeSource,
  useUpdateKnowledgeChunk,
  useUpdateKnowledgeDocument,
  useUpdateKnowledgeFolder,
  useUpdateKnowledgeSource,
  useUploadKnowledgeDocument,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useDebouncedValue } from '../lib/use-debounced-value.js';

const tabs = [
  { id: 'documents', label: '文档' },
  { id: 'sources', label: '来源' },
  { id: 'search', label: '检索测试' },
  { id: 'wiki', label: 'Wiki' },
  { id: 'jobs', label: '处理记录' },
] as const;

type TabId = (typeof tabs)[number]['id'];

/** 按叶权限控制每个主操作、行菜单与子编辑器；展示与否只由这里决定。 */
type KnowledgeCaps = {
  content: boolean;
  sources: boolean;
  execute: boolean;
  publish: boolean;
  update: boolean;
};

const documentStatusLabel = {
  pending: '排队',
  processing: '解析中',
  ready: '可检索',
  failed: '失败',
  disabled: '已停用',
} as const;

const documentStatusTone = {
  pending: 'default',
  processing: 'warn',
  ready: 'success',
  failed: 'danger',
  disabled: 'outline',
} as const;

const jobStatusLabel = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
} as const;

function isTerminalJobStatus(status: string | undefined): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/** 删除来源会级联删除它的任务：详情 404 表示任务已不存在，不是暂时故障。 */
function isMissingJob(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

const jobStatusTone = {
  queued: 'default',
  running: 'warn',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'outline',
} as const;

const jobTypeLabel = {
  ingest: '文档摄取',
  reindex: '重建索引',
  sync: '来源同步',
  wiki_generate: 'Wiki 生成',
  cleanup: '清理',
} as const;

const sourceStatusLabel = {
  active: '启用',
  paused: '已暂停',
  auth_error: '凭证失效',
  disabled: '已停用',
} as const;

/** 来源类型以 shared 的输入契约为准，与 api.ts 的 wire 类型保持一致。 */
type SourceType = KnowledgeSourceInput['type'];

const sourceProviders: Array<{
  type: SourceType;
  label: string;
  description: string;
  icon: typeof Code;
}> = [
  {
    type: 'github',
    label: 'GitHub',
    description: '读取仓库指定分支与路径下的文本文件',
    icon: Code,
  },
  {
    type: 'gitlab',
    label: 'GitLab',
    description: '读取项目指定分支与路径下的文本文件',
    icon: GitFork,
  },
  {
    type: 'feishu_wiki',
    label: '飞书知识库',
    description: '同步知识空间或知识节点下的文档',
    icon: BookOpen,
  },
  {
    type: 'feishu_drive',
    label: '飞书云盘',
    description: '同步云盘目录中的文件',
    icon: Cloud,
  },
  { type: 'feed', label: 'RSS', description: '抓取 Feed 最近窗口内的条目', icon: Rss },
];

function sourceProvider(type: SourceType): (typeof sourceProviders)[number] {
  const fallback = sourceProviders[0] as (typeof sourceProviders)[number];
  return sourceProviders.find((provider) => provider.type === type) ?? fallback;
}

const pageStatusLabel = {
  draft: '草稿',
  published: '已发布',
  stale: '待刷新',
  failed: '生成失败',
} as const;

/** 弹层草稿保护：dirty 关闭先确认，pending 期间禁止关闭与路由离开。 */
function useDraftGuard(dirty: boolean, pending: boolean, onClose: () => void) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const blocker = useFormBlocker(dirty, pending);
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);
  // 关闭会卸载编辑器并摘掉 blocker：先取消期间被拦下的离开，否则其 resolver 永远挂着。
  const finish = (): void => {
    blockerRef.current.reset?.();
    onClose();
  };
  const close = (): void => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else finish();
  };
  return { blocker, confirmDiscard, setConfirmDiscard, finish, close };
}

/** 弹层内统一的放弃草稿与路由离开确认。 */
function DraftGuardDialogs({
  guard,
  draft,
  pending,
}: {
  guard: ReturnType<typeof useDraftGuard>;
  draft: string;
  pending: boolean;
}) {
  return (
    <>
      <ConfirmDialog
        open={guard.confirmDiscard}
        onClose={() => guard.setConfirmDiscard(false)}
        title="放弃未保存的更改？"
        description={`关闭后${draft}`}
        confirmLabel="放弃并关闭"
        confirmDisabled={pending}
        onConfirm={async () => {
          if (!pending) guard.finish();
        }}
      />
      <ConfirmDialog
        open={guard.blocker.status === 'blocked'}
        onClose={() => guard.blocker.reset?.()}
        title="放弃未保存的更改？"
        description={pending ? '正在保存，请等待请求完成。' : `离开后${draft}`}
        confirmLabel="放弃并离开"
        confirmDisabled={pending}
        onConfirm={async () => guard.blocker.proceed()}
      />
    </>
  );
}

export function KnowledgeDetailPage() {
  const { baseId } = useParams({ from: '/_shell/knowledge/$baseId' });
  const search = useSearch({ from: '/_shell/knowledge/$baseId' });
  const navigate = useNavigate();
  const base = useKnowledgeBase(baseId);
  const me = useQuery(meQuery);
  const tab: TabId = search.panel ?? 'documents';
  const caps: KnowledgeCaps = {
    content: can(me.data, 'knowledge.content.manage'),
    sources: can(me.data, 'knowledge.sources.manage'),
    execute: can(me.data, 'knowledge.execute'),
    publish: can(me.data, 'knowledge.publish'),
    update: can(me.data, 'knowledge.update'),
  };
  const canReadAgents = can(me.data, 'agents.read');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTrigger, setSettingsTrigger] = useState<HTMLElement | null>(null);
  const [expertsOpen, setExpertsOpen] = useState(false);

  // folder / page / document 同属当前视图；离开处理记录时清掉文档过滤，避免下次进入残留。
  const go = (patch: Record<string, string | undefined>, replace = false): void => {
    const next = {
      folder: search.folder,
      page: search.page,
      panel: search.panel,
      document: search.document,
      ...patch,
    };
    void navigate({
      to: '/knowledge/$baseId',
      params: { baseId },
      search: Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)),
      replace,
    });
  };

  return (
    <Page>
      <PageHeader
        title={base.data?.name ?? '知识库'}
        leading={
          <Button
            variant="outline"
            size="icon"
            nativeButton={false}
            render={<Link to="/knowledge" />}
            aria-label="返回知识库列表"
          >
            <ArrowLeft />
          </Button>
        }
        eyebrow={
          base.data ? (
            <StatusBadge tone={base.data.status === 'active' ? 'success' : 'outline'}>
              {base.data.status === 'active' ? '启用' : '已停用'}
            </StatusBadge>
          ) : undefined
        }
        actions={
          <>
            {base.data && canReadAgents ? (
              <Popover open={expertsOpen} onOpenChange={setExpertsOpen}>
                <PopoverTrigger render={<Button variant="outline" />}>
                  使用此库的专家
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80" aria-label="使用此库的专家">
                  <ExpertUsage base={base.data} enabled={expertsOpen} />
                </PopoverContent>
              </Popover>
            ) : null}
            {base.data && caps.update ? (
              <Button
                variant="outline"
                onClick={(event) => {
                  setSettingsTrigger(event.currentTarget);
                  setSettingsOpen(true);
                }}
              >
                设置
              </Button>
            ) : null}
          </>
        }
        className="min-w-0"
      />
      {base.isPending ? <LoadingState rows={2} /> : null}
      {base.isError && base.data === undefined ? (
        <ErrorState error={base.error} onRetry={() => void base.refetch()} />
      ) : null}
      {base.data !== undefined ? (
        <>
          {base.isError ? (
            <ErrorState
              title="知识库信息没有刷新成功"
              error={base.error}
              onRetry={() => void base.refetch()}
            />
          ) : null}
          <Tabs
            value={tab}
            onValueChange={(next) =>
              go(
                {
                  panel: next === 'documents' ? undefined : next,
                  ...(next === 'jobs' ? {} : { document: undefined }),
                },
                true,
              )
            }
            className="flex-col gap-5"
          >
            <TabsList variant="line" aria-label="知识库分区" className="gap-4 border-b pb-3">
              {tabs.map((item) => (
                <TabsTrigger key={item.id} value={item.id}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="documents">
              <DocumentsTab
                baseId={baseId}
                caps={caps}
                folderId={search.folder}
                onFolderChange={(folderId) => go({ folder: folderId }, true)}
                onViewJobs={(documentId) => go({ panel: 'jobs', document: documentId })}
              />
            </TabsContent>
            <TabsContent value="search">
              <SearchTab baseId={baseId} canExecute={caps.execute} />
            </TabsContent>
            <TabsContent value="wiki">
              <WikiTab
                baseId={baseId}
                caps={caps}
                pageId={search.page}
                onSelect={(page) => go({ page })}
              />
            </TabsContent>
            <TabsContent value="sources">
              <SourcesTab baseId={baseId} caps={caps} />
            </TabsContent>
            <TabsContent value="jobs">
              <JobsTab
                baseId={baseId}
                canExecute={caps.execute}
                canUpload={caps.content}
                documentId={search.document}
                onClearDocument={() => go({ document: undefined }, true)}
                onGoDocuments={() => go({ panel: undefined, document: undefined })}
              />
            </TabsContent>
          </Tabs>
        </>
      ) : null}
      {base.data && settingsOpen ? (
        <KnowledgeSettingsDialog
          base={base.data}
          finalFocus={() => (settingsTrigger?.isConnected ? settingsTrigger : null)}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </Page>
  );
}

/**
 * 关系只在弹层打开时查询。/api/agents 摘要没有绑定信息，必须逐个读 access，
 * 再只为拥有 agents.config.read 的专家取详情；读不到的专家标为无法确认，不当作未使用。
 */
function ExpertUsage({ base, enabled }: { base: KnowledgeBase; enabled: boolean }) {
  const agents = useQuery({ ...agentsQuery, enabled });
  const agentIds = agents.data?.map((agent) => agent.id) ?? [];
  const accessQueries = useQueries({
    queries: agentIds.map((id) => ({ ...agentAccessQuery(id), enabled })),
  });
  const readableIds = agentIds.filter((_id, index) =>
    accessQueries[index]?.data?.permissionIds.includes('agents.config.read'),
  );
  const detailQueries = useQueries({
    queries: readableIds.map((id) => ({ ...agentDetailQuery(id), enabled })),
  });
  const detailById = new Map(readableIds.map((id, index) => [id, detailQueries[index]]));
  const pending =
    agents.isPending ||
    accessQueries.some((query) => query.isPending) ||
    detailQueries.some((query) => query.isPending);
  const failed = [
    ...accessQueries.filter((query) => query.isError),
    ...detailQueries.filter((query) => query.isError),
  ];
  const used: Array<{ id: string; name: string }> = [];
  let unknown = failed.length;
  (agents.data ?? []).forEach((agent, index) => {
    const access = accessQueries[index];
    if (access?.isError) return;
    if (!access?.data?.permissionIds.includes('agents.config.read')) {
      unknown += access?.isSuccess ? 1 : 0;
      return;
    }
    const detail = detailById.get(agent.id);
    if (detail?.isError) return;
    if (!detail?.data) return;
    if ((detail.data.serverIds ?? []).includes(base.serverId)) {
      used.push({ id: agent.id, name: agent.name });
    }
  });

  const retry = (): void => {
    for (const query of [...accessQueries, ...detailQueries]) {
      if (query.isError) void query.refetch();
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-sm font-medium text-fg">使用此库的专家</span>
      {agents.isPending || (pending && used.length === 0) ? <LoadingState rows={2} /> : null}
      {agents.isError ? (
        <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
      ) : null}
      {failed.length > 0 ? (
        <Button variant="link" size="xs" className="self-start" onClick={retry}>
          部分关系没有加载出来，重试
        </Button>
      ) : null}
      {used.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {used.map((agent) => (
            <li key={agent.id} className="flex min-w-0 items-center justify-between gap-2">
              <Link
                to="/agents/$agentId"
                params={{ agentId: agent.id }}
                search={{ tab: 'config', section: 'capability' }}
                className="min-w-0 truncate text-sm text-fg underline underline-offset-2"
              >
                {agent.name}
              </Link>
              <span className="shrink-0 text-2xs text-muted-foreground">配置 · 能力</span>
            </li>
          ))}
        </ul>
      ) : null}
      {used.length > 0 ? (
        <Link to="/agents" className="self-start text-xs text-fg underline underline-offset-2">
          选择其他专家
        </Link>
      ) : null}
      {agents.isSuccess && used.length === 0 && unknown === 0 && !pending ? (
        <div className="flex flex-col gap-1">
          <InlineEmpty>没有被任何专家使用</InlineEmpty>
          <span className="text-xs text-muted-foreground">在专家的能力配置中绑定此知识库。</span>
          <Link to="/agents" className="self-start text-xs text-fg underline underline-offset-2">
            选择专家
          </Link>
        </div>
      ) : null}
      {unknown > 0 ? (
        <span className="text-xs text-muted-foreground">部分专家的使用关系无法确认</span>
      ) : null}
    </div>
  );
}

// ---- 文档 -----------------------------------------------------------------

function DocumentsTab({
  baseId,
  caps,
  folderId,
  onFolderChange,
  onViewJobs,
}: {
  baseId: string;
  caps: KnowledgeCaps;
  folderId: string | undefined;
  onFolderChange: (folderId: string | undefined) => void;
  onViewJobs: (documentId: string) => void;
}) {
  const [query, setQuery] = useState('');
  // 每个字符都换无限查询键会把列表打爆：输入即时回显，停 300ms 再订阅。
  const settledQuery = useDebouncedValue(query.trim(), 300);
  const [status, setStatus] = useState('all');
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
  // 只记 ID 与打开时快照：列表轮询到新版本时查看器要跟着更新，列表暂时不含该文档时保留快照不关闭。
  const [viewing, setViewing] = useState<{
    id: string;
    snapshot: KnowledgeDocument;
  } | null>(null);
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
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  // 上传批次结束前不卸载这个面板：切页签、换文件夹或离开路由都会丢失批次状态。
  const uploadBlocker = useFormBlocker(false, uploading !== null);
  useEffect(() => {
    if (uploading === null && uploadBlocker.status === 'blocked') uploadBlocker.proceed();
  }, [uploading, uploadBlocker]);

  // 列表查到更新的对象时刷新快照：之后列表暂时不含该文档，也能显示最近一次看到的内容。
  const viewingMatch = viewing ? documentItems.find((item) => item.id === viewing.id) : undefined;
  useEffect(() => {
    if (viewing && viewingMatch && viewingMatch !== viewing.snapshot) {
      setViewing({ id: viewing.id, snapshot: viewingMatch });
    }
  }, [viewing, viewingMatch]);
  const viewingDocument = viewingMatch ?? viewing?.snapshot ?? null;
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
      if (file.size > 32 * 1024 * 1024) {
        failed.push(`${file.name}（超过 32 MB）`);
        continue;
      }
      try {
        const dataBase64 = await readBase64(file);
        const path = relativePath(file);
        await upload.mutateAsync({
          filename: path,
          mimeType: file.type || 'application/octet-stream',
          dataBase64,
          folderId: targetFolderId,
          // 后端不按相对路径建目录树：把路径写进标题，至少列表里能看出原目录。
          ...(file.webkitRelativePath ? { title: path.replace(/\.[^.]+$/, '').slice(0, 300) } : {}),
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
          <h2 className="text-sm font-medium text-fg">文件夹</h2>
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
                    'flex min-w-0 flex-1 items-center gap-1.5 rounded-item py-1.5 pr-2 text-left text-sm transition-colors',
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
              onValueChange={setStatus}
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
            icon={<FileText className="size-5" />}
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
              <TableRow className="hover:bg-transparent">
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
                <TableRow key={document.id}>
                  <TableCell className="max-w-0">
                    <button
                      type="button"
                      className="block w-full truncate text-left text-fg hover:underline"
                      title={document.title}
                      onClick={() => {
                        setActionTrigger(null);
                        setViewing({ id: document.id, snapshot: document });
                      }}
                    >
                      {document.title}
                    </button>
                    {document.tags.length > 0 ? (
                      <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
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
        {viewingDocument ? (
          <DocumentViewer
            document={viewingDocument}
            documents={viewerDocuments}
            canManage={caps.content}
            onSelect={(document) => setViewing({ id: document.id, snapshot: document })}
            onClose={() => setViewing(null)}
            onEdit={() => {
              setEditing(viewingDocument);
              setViewing(null);
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

function FolderDialog({
  baseId,
  state,
  onClose,
  onCreated,
  finalFocus,
}: {
  baseId: string;
  state: { mode: 'create'; parentId: string | null } | { mode: 'rename'; folder: KnowledgeFolder };
  onClose: () => void;
  onCreated: (folder: KnowledgeFolder) => void;
  finalFocus: () => HTMLElement | null;
}) {
  const create = useCreateKnowledgeFolder(baseId);
  const update = useUpdateKnowledgeFolder(baseId);
  const initialName = state.mode === 'rename' ? state.folder.name : '';
  const [name, setName] = useState(initialName);
  const pending = create.isPending || update.isPending;
  const trimmed = name.trim();
  const unchanged = state.mode === 'rename' && trimmed === state.folder.name;
  const title = state.mode === 'rename' ? '重命名文件夹' : '新建文件夹';
  const guard = useDraftGuard(name !== initialName, pending, onClose);

  const submit = (): void => {
    if (state.mode === 'rename') {
      update.mutate(
        { folderId: state.folder.id, patch: { name: trimmed } },
        {
          onSuccess: () => {
            toastSuccess('文件夹已重命名');
            guard.finish();
          },
          onError: toastError,
        },
      );
      return;
    }
    create.mutate(
      { parentId: state.parentId, name: trimmed },
      {
        onSuccess: (folder) => {
          toastSuccess('文件夹已创建');
          // 先解除本弹层的离开拦截，再让父级切到新文件夹。
          guard.finish();
          onCreated(folder);
        },
        onError: toastError,
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) guard.close();
      }}
    >
      <DialogShell title={title} closeDisabled={pending} finalFocus={finalFocus}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field className="gap-1.5">
            <FieldLabel htmlFor="knowledge-folder-name">
              名称 <RequiredMark />
            </FieldLabel>
            <Input
              id="knowledge-folder-name"
              value={name}
              maxLength={120}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button
              type="submit"
              disabled={pending || trimmed === '' || unchanged}
              aria-busy={pending}
            >
              {pending ? '保存中…' : state.mode === 'rename' ? '保存' : '创建'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="文件夹名称草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

function TagDialog({ baseId, onClose }: { baseId: string; onClose: () => void }) {
  const tags = useKnowledgeTags(baseId);
  const create = useCreateKnowledgeTag(baseId);
  const remove = useDeleteKnowledgeTag(baseId);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<KnowledgeTag | null>(null);
  const trimmed = name.trim();
  const pending = create.isPending || remove.isPending;
  const guard = useDraftGuard(trimmed !== '', pending, onClose);

  return (
    <>
      <Dialog
        open
        onOpenChange={(next, details) => {
          if (pending) {
            details.cancel();
            return;
          }
          if (!next) guard.close();
        }}
      >
        <DialogShell title="管理标签" closeDisabled={pending}>
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate(trimmed, {
                onSuccess: () => {
                  setName('');
                  toastSuccess('标签已添加');
                },
                onError: toastError,
              });
            }}
          >
            <Field className="flex-1 gap-1.5">
              <FieldLabel htmlFor="knowledge-tag-name">标签名称</FieldLabel>
              <Input
                id="knowledge-tag-name"
                value={name}
                maxLength={64}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Button type="submit" disabled={pending || trimmed === ''} aria-busy={create.isPending}>
              添加
            </Button>
          </form>
          {tags.isPending ? <LoadingState rows={2} /> : null}
          {tags.isError ? (
            <ErrorState error={tags.error} onRetry={() => void tags.refetch()} />
          ) : null}
          {tags.data && tags.data.length === 0 ? <InlineEmpty>还没有标签</InlineEmpty> : null}
          {tags.data && tags.data.length > 0 ? (
            <ul className="mt-3 flex flex-col">
              {tags.data.map((tag) => (
                <li
                  key={tag.id}
                  className="flex items-center gap-2 border-b py-2 text-sm last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`删除标签 ${tag.name}`}
                    disabled={pending}
                    onClick={() => setDeleting(tag)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <DraftGuardDialogs guard={guard} draft="标签草稿会丢失。" pending={pending} />
        </DialogShell>
      </Dialog>
      {deleting ? (
        <ConfirmDialog
          open
          title="删除标签"
          description={`将删除标签「${deleting.name}」，并从所有文档上移除；文档本身不会删除。`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toastSuccess('标签已删除');
          }}
        />
      ) : null}
    </>
  );
}

function treeFolders(
  folders: KnowledgeFolder[],
): Array<{ id: string; label: string; depth: number }> {
  const byParent = new Map<string | null, KnowledgeFolder[]>();
  for (const folder of folders) {
    const siblings = byParent.get(folder.parentId) ?? [];
    siblings.push(folder);
    byParent.set(folder.parentId, siblings);
  }
  const rows: Array<{ id: string; label: string; depth: number }> = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const folder of byParent.get(parentId) ?? []) {
      rows.push({ id: folder.id, label: folder.name, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

function DocumentDialog({
  baseId,
  document,
  folders,
  onClose,
}: {
  baseId: string;
  document: KnowledgeDocument;
  folders: KnowledgeFolder[];
  onClose: () => void;
}) {
  const update = useUpdateKnowledgeDocument(baseId);
  // 基线取打开时的值，列表轮询刷新文档对象不重置用户草稿。
  const [initial] = useState(() => ({
    title: document.title,
    folderId: document.folderId ?? 'null',
    tags: document.tags.join(', '),
    status: document.status === 'disabled' ? ('disabled' as const) : ('ready' as const),
  }));
  const [title, setTitle] = useState(initial.title);
  const [folderId, setFolderId] = useState(initial.folderId);
  const [tags, setTags] = useState(initial.tags);
  const [status, setStatus] = useState<'ready' | 'disabled'>(initial.status);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pending = update.isPending;
  const dirty =
    title !== initial.title ||
    folderId !== initial.folderId ||
    tags !== initial.tags ||
    status !== initial.status;
  const blocker = useFormBlocker(dirty, pending);
  // 保存回调在拦截发生前创建，不能读当时的 blocker 快照。
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);
  // 关闭会卸载编辑器并摘掉 blocker：先取消期间被拦下的离开，否则其 resolver 永远挂着。
  const finish = (): void => {
    blockerRef.current.reset?.();
    onClose();
  };
  const close = (): void => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else finish();
  };

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) close();
      }}
    >
      <DialogShell title="编辑文档" closeDisabled={pending}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate(
              {
                documentId: document.id,
                patch: {
                  title: title.trim(),
                  folderId: folderId === 'null' ? null : folderId,
                  tags: tags
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
                  ...(document.status === 'failed' || document.status === 'pending'
                    ? {}
                    : { status }),
                },
              },
              {
                onSuccess: () => {
                  toastSuccess('文档已更新');
                  finish();
                },
                onError: toastError,
              },
            );
          }}
        >
          <FieldGroup>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="document-title">
                标题 <RequiredMark />
              </FieldLabel>
              <Input
                id="document-title"
                value={title}
                disabled={pending}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <FieldGroup className="grid gap-3 sm:grid-cols-2">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="document-folder">文件夹</FieldLabel>
                <Select
                  value={folderId}
                  disabled={pending}
                  onValueChange={(next) => {
                    if (next !== null) setFolderId(next);
                  }}
                  items={[
                    { value: 'null', label: '未分类' },
                    ...treeFolders(folders).map((folder) => ({
                      value: folder.id,
                      label: `${'　'.repeat(folder.depth)}${folder.label}`,
                    })),
                  ]}
                >
                  <SelectTrigger id="document-folder" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="null">未分类</SelectItem>
                      {treeFolders(folders).map((folder) => (
                        <SelectItem key={folder.id} value={folder.id}>
                          {`${'　'.repeat(folder.depth)}${folder.label}`}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="document-status">状态</FieldLabel>
                <Select
                  value={status}
                  disabled={
                    pending || document.status === 'failed' || document.status === 'pending'
                  }
                  onValueChange={(next) => {
                    if (next === 'ready' || next === 'disabled') setStatus(next);
                  }}
                  items={[
                    { value: 'ready', label: '可检索' },
                    { value: 'disabled', label: '已停用' },
                  ]}
                >
                  <SelectTrigger id="document-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="ready">可检索</SelectItem>
                      <SelectItem value="disabled">已停用</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="document-tags">标签</FieldLabel>
              <Input
                id="document-tags"
                value={tags}
                disabled={pending}
                onChange={(event) => setTags(event.target.value)}
                placeholder="以逗号分隔"
              />
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending || title.trim() === ''} aria-busy={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后文档属性草稿会丢失。"
          confirmLabel="放弃并关闭"
          confirmDisabled={pending}
          onConfirm={async () => {
            if (!pending) finish();
          }}
        />
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title="放弃未保存的更改？"
          description={pending ? '正在保存，请等待请求完成。' : '离开后文档属性草稿会丢失。'}
          confirmLabel="放弃并离开"
          confirmDisabled={pending}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}

// ---- 文档查看 -------------------------------------------------------------

/** 图片 chunk 的角色来自 metadata.imageRole；普通 chunk 没有。 */
function imageRoleLabel(chunk: KnowledgeChunk): string | null {
  const role = chunk.metadata?.imageRole;
  if (role === 'ocr') return 'OCR';
  if (role === 'caption') return '图片描述';
  if (role === 'vector') return '图片向量';
  return null;
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

function DocumentViewer({
  document,
  documents,
  canManage,
  onSelect,
  onClose,
  onEdit,
}: {
  document: KnowledgeDocument;
  documents: KnowledgeDocument[];
  canManage: boolean;
  onSelect: (document: KnowledgeDocument) => void;
  onClose: () => void;
  onEdit: () => void;
}) {
  const versionId = document.currentVersionId;
  const markdown = useKnowledgeMarkdown(versionId);
  const details = useKnowledgeVersionDetails(versionId);
  const versionImages = details.data?.images ?? [];
  const chunks = useKnowledgeDocumentChunks(document.id, versionId);
  const toggle = useUpdateKnowledgeChunk(document.baseId, document.id);
  const remove = useDeleteKnowledgeChunk(document.id);
  const [mode, setMode] = useState<'read' | 'source'>('read');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [editing, setEditing] = useState<KnowledgeChunk | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeChunk | null>(null);
  const chunkItems = chunks.data?.pages.flatMap((page) => page.items) ?? [];
  const identity = document.sourcePath ?? details.data?.originalFilename ?? document.title;

  return (
    <>
      <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
        <DialogShell
          title={document.title}
          className="max-h-[85dvh] max-w-[1100px] sm:max-w-[1100px]"
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
                        'flex w-full min-w-0 flex-col gap-0.5 rounded-item px-2 py-1.5 text-left text-sm transition-colors',
                        active
                          ? 'bg-selected font-medium text-selected-foreground'
                          : 'text-muted-foreground hover:bg-hover hover:text-fg',
                      )}
                    >
                      <span className="truncate" title={item.title}>
                        {item.title}
                      </span>
                      <span className="truncate text-2xs">{documentStatusLabel[item.status]}</span>
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
                            label: '下载原件',
                            text: '下载原件',
                          },
                        }
                      : {})}
                    actions={
                      canManage ? (
                        <Button variant="outline" size="sm" onClick={onEdit}>
                          编辑属性
                        </Button>
                      ) : undefined
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
                          <span className="truncate text-2xs text-muted-foreground">
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
                {versionId && chunks.isPending ? <LoadingState rows={3} /> : null}
                {versionId && chunks.isError ? (
                  <ErrorState error={chunks.error} onRetry={() => void chunks.refetch()} />
                ) : null}
                {versionId && chunks.isSuccess && chunkItems.length === 0 ? (
                  <InlineEmpty>还没有分块</InlineEmpty>
                ) : null}
                {chunkItems.length > 0 ? (
                  <ul className="flex flex-col">
                    {chunkItems.map((chunk, index) => (
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
                              {imageRoleLabel(chunk) ?? chunk.kind}
                              {chunk.pageFrom === null
                                ? ''
                                : ` · 第 ${chunk.pageFrom}${chunk.pageTo && chunk.pageTo !== chunk.pageFrom ? `–${chunk.pageTo}` : ''} 页`}
                            </span>
                          </div>
                          <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                            {chunk.content}
                          </p>
                        </div>
                        {canManage ? (
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`${chunk.enabled ? '停用' : '启用'}分块 ${index + 1}`}
                              disabled={toggle.isPending}
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
                              onClick={() => setEditing(chunk)}
                            >
                              <Pencil />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`删除分块 ${index + 1}`}
                              disabled={remove.isPending}
                              onClick={() => setDeleting(chunk)}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    ))}
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
          chunk={editing}
          onClose={() => setEditing(null)}
          onReload={async () => {
            await chunks.refetch();
            setEditing(null);
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除分块"
          description="删除后该段不再参与检索；重新解析不会恢复人工删除的分块。"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toastSuccess('分块已删除');
          }}
        />
      ) : null}
    </>
  );
}

function ChunkDialog({
  baseId,
  documentId,
  chunk,
  onClose,
  onReload,
}: {
  baseId: string;
  documentId: string;
  chunk: KnowledgeChunk;
  onClose: () => void;
  /** 冲突后由调用方重新拉取分块并关闭，草稿只在这里明确放弃。 */
  onReload: () => Promise<void>;
}) {
  const update = useUpdateKnowledgeChunk(baseId, documentId);
  // 基线取打开时的正文：父级分块查询刷新不能覆盖用户正在改的草稿。
  const [initial] = useState(chunk.content);
  const [content, setContent] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const pending = update.isPending;
  const trimmed = content.trim();
  const dirty = content !== initial;
  const blocker = useFormBlocker(dirty, pending);
  // 保存/重载回调在拦截发生前创建，不能读当时的 blocker 快照。
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);
  // 关闭会卸载编辑器并摘掉 blocker：先取消期间被拦下的离开，否则其 resolver 永远挂着。
  const finish = (): void => {
    blockerRef.current.reset?.();
    onClose();
  };
  // 图片向量是真实图 embedding；改正文会让它和图片脱节，只允许在列表里启停。
  const vectorChunk = chunk.metadata?.imageRole === 'vector';

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

  const close = (): void => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else finish();
  };

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) close();
      }}
    >
      <DialogShell title="编辑分块" closeDisabled={pending}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            update.mutate(
              { chunkId: chunk.id, patch: { content: trimmed } },
              {
                onSuccess: () => {
                  toastSuccess('分块已保存，正在补建向量');
                  finish();
                },
                onError: (reason) => {
                  // 保留草稿；服务端拒绝时给出明确的重载入口，不静默丢弃修改。
                  setError(errorMessage(reason));
                },
              },
            );
          }}
        >
          <Field className="gap-1.5" data-invalid={error !== null}>
            <FieldLabel htmlFor="knowledge-chunk-content">正文</FieldLabel>
            <Textarea
              id="knowledge-chunk-content"
              value={content}
              rows={10}
              disabled={pending}
              aria-invalid={error !== null}
              onChange={(event) => setContent(event.target.value)}
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
                    update.reset();
                    void onReload();
                  }
                }}
              >
                重新加载
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending || trimmed === ''} aria-busy={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后分块正文草稿会丢失。"
          confirmLabel="放弃并关闭"
          confirmDisabled={pending}
          onConfirm={async () => {
            if (!pending) finish();
          }}
        />
        <ConfirmDialog
          open={confirmReload}
          onClose={() => setConfirmReload(false)}
          title="放弃未保存的更改？"
          description="重新加载会用服务端版本覆盖当前草稿。"
          confirmLabel="放弃并重新加载"
          confirmDisabled={pending}
          onConfirm={async () => {
            if (pending) return;
            await update.reset();
            await onReload();
          }}
        />
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title="放弃未保存的更改？"
          description={pending ? '正在保存，请等待请求完成。' : '离开后分块正文草稿会丢失。'}
          confirmLabel="放弃并离开"
          confirmDisabled={pending}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}

/** 引用/文档共用的解析正文查看：顶部是命中片段，下面是完整解析文本。 */
function ParsedTextDialog({
  versionId,
  title,
  quote,
  sourceUrl,
  image,
  onClose,
}: {
  versionId: string;
  title: string;
  quote?: string;
  sourceUrl?: string | null;
  /** 图片命中在这里显示原图；普通命中不传。 */
  image?: KnowledgeSearchHit['image'];
  onClose: () => void;
}) {
  const markdown = useKnowledgeMarkdown(versionId);
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogShell title={title} className="max-w-[860px] sm:max-w-[860px]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <a
              href={api.knowledgeOriginalUrl(versionId)}
              className="text-xs underline underline-offset-2"
              download
            >
              下载原件
            </a>
            {sourceUrl ? (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs underline underline-offset-2"
              >
                查看来源
              </a>
            ) : null}
            {image?.page ? (
              <span className="text-xs text-muted-foreground">第 {image.page} 页</span>
            ) : null}
          </div>
          {image ? (
            <KnowledgeImage
              versionId={versionId}
              name={image.name}
              alt={quote || image.name}
              className="max-h-96 w-full rounded-card border border-line object-contain"
            />
          ) : null}
          {quote ? (
            <p className="border-l-2 border-line-strong pl-3 text-sm leading-relaxed text-fg">
              <mark className="bg-warning-soft text-fg">{quote}</mark>
            </p>
          ) : null}
          {markdown.isPending ? <LoadingState rows={3} /> : null}
          {markdown.isError ? (
            <ErrorState error={markdown.error} onRetry={() => void markdown.refetch()} />
          ) : null}
          {markdown.data ? <Markdown text={stripImageReferences(markdown.data)} /> : null}
        </div>
      </DialogShell>
    </Dialog>
  );
}

// ---- 文档导入 -------------------------------------------------------------

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`「${file.name}」读取失败`));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** 文件夹上传保留相对路径（后端只存一个 folderId，不建目录树）。 */
function relativePath(file: File): string {
  return file.webkitRelativePath || file.name;
}

/** 手写正文 / 网址导入共用文件夹选择；默认落在当前浏览的文件夹。 */
function ImportFolderField({
  id,
  value,
  folders,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  folders: KnowledgeFolder[];
  disabled: boolean;
  onChange: (folderId: string) => void;
}) {
  const options = [
    { value: 'null', label: '未分类' },
    ...treeFolders(folders).map((folder) => ({
      value: folder.id,
      label: `${'　'.repeat(folder.depth)}${folder.label}`,
    })),
  ];
  return (
    <Field className="gap-1.5">
      <FieldLabel htmlFor={id}>文件夹</FieldLabel>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
        items={options}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function ManualDocumentDialog({
  baseId,
  folderId,
  folders,
  onClose,
}: {
  baseId: string;
  folderId: string | null;
  folders: KnowledgeFolder[];
  onClose: () => void;
}) {
  const create = useCreateKnowledgeManualDocument(baseId);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const initialTarget = folderId ?? 'null';
  const [target, setTarget] = useState(initialTarget);
  const pending = create.isPending;
  const invalid = title.trim() === '' || content.trim() === '';
  const dirty = title !== '' || content !== '' || tags !== '' || target !== initialTarget;
  const guard = useDraftGuard(dirty, pending, onClose);

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) guard.close();
      }}
    >
      <DialogShell title="手写文档" closeDisabled={pending}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(
              {
                title: title.trim(),
                content,
                folderId: target === 'null' ? null : target,
                tags: tags
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean),
              },
              {
                onSuccess: () => {
                  toastSuccess('已创建手写文档，正在解析');
                  guard.finish();
                },
                onError: toastError,
              },
            );
          }}
        >
          <FieldGroup>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="knowledge-manual-title">
                标题 <RequiredMark />
              </FieldLabel>
              <Input
                id="knowledge-manual-title"
                value={title}
                maxLength={300}
                disabled={pending}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <ImportFolderField
              id="knowledge-manual-folder"
              value={target}
              folders={folders}
              disabled={pending}
              onChange={setTarget}
            />
            <Field className="gap-1.5">
              <FieldLabel htmlFor="knowledge-manual-tags">标签</FieldLabel>
              <Input
                id="knowledge-manual-tags"
                value={tags}
                disabled={pending}
                onChange={(event) => setTags(event.target.value)}
                placeholder="以逗号分隔"
              />
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="knowledge-manual-content">
                正文（Markdown） <RequiredMark />
              </FieldLabel>
              <SourceEditor
                id="knowledge-manual-content"
                aria-label="正文（Markdown）"
                value={content}
                onChange={setContent}
                language="markdown"
                disabled={pending}
                className="min-h-48"
              />
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending || invalid} aria-busy={pending}>
              {pending ? '导入中…' : '导入'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="手写文档草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

function UrlImportDialog({
  baseId,
  folderId,
  folders,
  onClose,
}: {
  baseId: string;
  folderId: string | null;
  folders: KnowledgeFolder[];
  onClose: () => void;
}) {
  const create = useImportKnowledgeUrl(baseId);
  const [url, setUrl] = useState('');
  const initialTarget = folderId ?? 'null';
  const [target, setTarget] = useState(initialTarget);
  const pending = create.isPending;
  // 后端 httpUrlSchema 只收 http(s)；这里只做按钮可用性判断，最终由入口校验。
  const validUrl = /^https?:\/\/\S+$/i.test(url.trim());
  const invalidUrl = url.trim() !== '' && !validUrl;
  const dirty = url.trim() !== '' || target !== initialTarget;
  const guard = useDraftGuard(dirty, pending, onClose);

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) guard.close();
      }}
    >
      <DialogShell title="导入网址" closeDisabled={pending}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(
              {
                url: url.trim(),
                folderId: target === 'null' ? null : target,
              },
              {
                onSuccess: () => {
                  toastSuccess('已提交抓取任务');
                  guard.finish();
                },
                onError: toastError,
              },
            );
          }}
        >
          <FieldGroup>
            <Field className="gap-1.5" data-invalid={invalidUrl}>
              <FieldLabel htmlFor="knowledge-url">
                网址 <RequiredMark />
              </FieldLabel>
              <Input
                id="knowledge-url"
                type="url"
                value={url}
                disabled={pending}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/doc"
                aria-invalid={invalidUrl}
                aria-describedby={invalidUrl ? 'knowledge-url-error' : 'knowledge-url-hint'}
              />
              {invalidUrl ? (
                <FieldError id="knowledge-url-error">
                  请填写以 http:// 或 https:// 开头的完整地址
                </FieldError>
              ) : (
                <FieldDescription id="knowledge-url-hint">
                  支持网页、PDF 与纯文本类文件，最大 32 MB。
                </FieldDescription>
              )}
            </Field>
            <ImportFolderField
              id="knowledge-url-folder"
              value={target}
              folders={folders}
              disabled={pending}
              onChange={setTarget}
            />
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending || !validUrl} aria-busy={pending}>
              {pending ? '导入中…' : '导入'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="网址导入草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

// ---- 检索 -----------------------------------------------------------------

function SearchTab({ baseId, canExecute }: { baseId: string; canExecute: boolean }) {
  const [draft, setDraft] = useState('');
  const [term, setTerm] = useState('');
  const [cited, setCited] = useState<KnowledgeSearchHit | null>(null);
  const results = useKnowledgeSearch(baseId, canExecute ? term : '');

  if (!canExecute) {
    return (
      <PageNote
        title="没有检索权限"
        description="可以查看知识库内容，但检索与处理需要「执行检索与处理」权限。"
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <form
        className="flex min-w-0 flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setTerm(draft.trim());
        }}
      >
        <SearchInput
          label="检索知识库"
          placeholder="输入问题或关键词…"
          value={draft}
          onChange={setDraft}
          className="min-w-48 flex-1 sm:max-w-md"
          inputId="knowledge-search"
        />
        <Button type="submit" disabled={draft.trim() === ''}>
          <Search data-icon="inline-start" aria-hidden="true" /> 检索
        </Button>
      </form>
      {term === '' ? (
        <EmptyState icon={<Search className="size-5" />} title="输入关键词后开始检索" />
      ) : null}
      {term !== '' && results.isPending ? <LoadingState rows={3} /> : null}
      {term !== '' && results.isError ? (
        <ErrorState error={results.error} onRetry={() => void results.refetch()} />
      ) : null}
      {results.data?.degraded ? (
        <PageNote
          title="向量检索不可用"
          description="当前结果只来自关键词匹配；请检查 embedding 模型配置。"
        />
      ) : null}
      {results.data && results.data.hits.length === 0 ? (
        <EmptyState title="没有匹配的分块" description="换一个关键词或扩大检索范围。" />
      ) : null}
      {results.data && results.data.hits.length > 0 ? (
        <ul className="flex flex-col">
          {results.data.hits.map((hit) => (
            <li key={hit.chunkId} className="flex flex-col gap-1 border-b py-3 last:border-b-0">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="min-w-0 truncate text-sm font-medium text-fg" title={hit.title}>
                  {hit.title}
                </span>
                {hit.heading ? (
                  <span className="truncate text-xs text-muted-foreground">{hit.heading}</span>
                ) : null}
                <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
                  {hit.pageFrom === null
                    ? null
                    : `第 ${hit.pageFrom}${hit.pageTo && hit.pageTo !== hit.pageFrom ? `–${hit.pageTo}` : ''} 页 · `}
                  {hit.score.toFixed(3)}
                </span>
              </div>
              <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                {hit.quote}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="link" size="xs" onClick={() => setCited(hit)}>
                  查看原文
                </Button>
                {hit.sourceUrl ? (
                  <a
                    href={hit.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="w-fit text-2xs text-muted-foreground underline underline-offset-2"
                  >
                    查看来源
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {cited ? (
        <ParsedTextDialog
          versionId={cited.versionId}
          title="引用原文"
          quote={cited.quote}
          sourceUrl={cited.sourceUrl}
          image={cited.image}
          onClose={() => setCited(null)}
        />
      ) : null}
    </div>
  );
}

// ---- Wiki -----------------------------------------------------------------

/** 小型集合（来源/Wiki 页面）自动取完剩余游标页；失败后停下，交给调用方的显式重试。 */
function useDrainPages(query: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
}): void {
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
}

function WikiTab({
  baseId,
  caps,
  pageId,
  onSelect,
}: {
  baseId: string;
  caps: KnowledgeCaps;
  pageId: string | undefined;
  onSelect: (pageId: string) => void;
}) {
  const pages = useKnowledgeWikiPages(baseId);
  useDrainPages(pages);
  const [creating, setCreating] = useState(false);
  // 等弹层卸载、blocker 注销后再选中新页面，避免导航被创建弹层的旧 dirty/pending 拦下。
  const [createdPage, setCreatedPage] = useState<string | null>(null);
  useEffect(() => {
    if (creating || createdPage === null) return;
    onSelect(createdPage);
    setCreatedPage(null);
  }, [createdPage, creating, onSelect]);

  return (
    <div className="grid min-w-0 gap-5 md:grid-cols-[220px_minmax(0,1fr)] md:items-start">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-fg">页面</h2>
          {caps.content ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="新建 Wiki 页面"
              onClick={() => setCreating(true)}
            >
              <Plus />
            </Button>
          ) : null}
        </div>
        {pages.isPending ? <LoadingState rows={3} /> : null}
        {pages.isError ? (
          <ErrorState error={pages.error} onRetry={() => void pages.refetch()} />
        ) : null}
        {pages.isFetchNextPageError ? (
          <Button variant="outline" size="sm" onClick={() => void pages.fetchNextPage()}>
            重试加载其余页面
          </Button>
        ) : null}
        {pages.data && pages.data.length === 0 ? <InlineEmpty>还没有 Wiki 页面</InlineEmpty> : null}
        {pages.data && pages.data.length > 0 ? (
          <ul className="flex flex-col">
            {pages.data.map((page) => (
              <li key={page.id}>
                <button
                  type="button"
                  aria-current={page.id === pageId ? 'true' : undefined}
                  onClick={() => onSelect(page.id)}
                  className={cn(
                    'flex w-full flex-col gap-0.5 rounded-item px-2 py-1.5 text-left text-sm transition-colors',
                    page.id === pageId
                      ? 'bg-selected font-medium text-selected-foreground'
                      : 'text-muted-foreground hover:bg-hover hover:text-fg',
                  )}
                >
                  <span className="truncate">{page.title}</span>
                  <span className="truncate text-2xs">{pageStatusLabel[page.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {pageId ? (
          <WikiPageEditor key={pageId} baseId={baseId} caps={caps} pageId={pageId} />
        ) : (
          <EmptyState
            icon={<BookOpen className="size-5" />}
            title="选择一个页面开始编辑"
            action={
              caps.content ? (
                <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                  新建页面
                </Button>
              ) : undefined
            }
          />
        )}
      </div>
      {creating ? (
        <CreateWikiPageDialog
          baseId={baseId}
          onClose={() => setCreating(false)}
          onCreated={(page) => {
            setCreating(false);
            setCreatedPage(page.id);
          }}
        />
      ) : null}
    </div>
  );
}

function WikiPageEditor({
  baseId,
  caps,
  pageId,
}: {
  baseId: string;
  caps: KnowledgeCaps;
  pageId: string;
}) {
  const detail = useKnowledgeWikiPage(pageId);
  const generate = useGenerateKnowledgeWikiPage();
  const rollback = useRollbackKnowledgeWikiPage(baseId);
  const publish = usePublishKnowledgeWikiVersion(baseId);
  const loadOlder = useLoadOlderKnowledgeWikiVersions();
  const jobs = useKnowledgeJobs(baseId);
  const client = useQueryClient();
  const [instruction, setInstruction] = useState('');
  const [mode, setMode] = useState<'read' | 'source'>('read');
  const [generateJobId, setGenerateJobId] = useState<string | null>(null);
  const settledJobRef = useRef<string | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null);
  const [publishTarget, setPublishTarget] = useState<KnowledgeWikiVersion | null>(null);
  const [previewing, setPreviewing] = useState<KnowledgeWikiVersion | null>(null);
  const [editing, setEditing] = useState<{
    versionId: string | null;
    markdown: string;
  } | null>(null);
  const [olderVersions, setOlderVersions] = useState<KnowledgeWikiVersion[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const pending = generate.isPending || rollback.isPending || publish.isPending;
  const page = detail.data;
  const versions = [...(page?.versions ?? []), ...olderVersions];
  const currentVersionId = page?.currentVersionId ?? null;
  const current = versions.find((version) => version.id === currentVersionId);
  // 有 currentVersionId 但版本不在已加载分页里：不能把空正文当成首次发布。
  const currentLoaded = currentVersionId === null || current !== undefined;
  // 首屏游标只在还没请求过更早版本时用；之后由 olderVersions 自己的游标接管。
  const nextCursor = olderCursor === undefined ? page?.nextCursor : olderCursor;
  // 只跟本次提交返回的任务，其他页面的生成任务不会显示在这里。
  const generateJob = generateJobId
    ? jobs.data?.find((job) => job.id === generateJobId)
    : undefined;

  // 任务跨过终态时失效当前页面与列表，只做一次；轮询本身不触发失效。
  useEffect(() => {
    if (!generateJob || !generateJobId || settledJobRef.current === generateJobId) return;
    if (
      generateJob.status !== 'succeeded' &&
      generateJob.status !== 'failed' &&
      generateJob.status !== 'cancelled'
    ) {
      return;
    }
    settledJobRef.current = generateJobId;
    void client.invalidateQueries({ queryKey: knowledgeKeys.wikiPage(pageId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.wikiPages(baseId) });
  }, [baseId, client, generateJob, generateJobId, pageId]);

  if (detail.isPending) return <LoadingState rows={4} />;
  // 已有页面数据时，刷新失败不能整块替换编辑器，否则会丢掉正在编辑的草稿。
  if (!page) {
    if (detail.isError) {
      return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
    }
    return null;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {detail.isError ? (
        <ErrorState
          title="Wiki 页面没有刷新成功"
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      ) : null}
      <ReaderToolbar
        identity={
          <span className="block truncate" title={page.title}>
            {page.title}
          </span>
        }
        meta={
          <>
            <StatusBadge
              tone={
                page.status === 'published'
                  ? 'success'
                  : page.status === 'failed'
                    ? 'danger'
                    : 'outline'
              }
            >
              {pageStatusLabel[page.status]}
            </StatusBadge>
            <span>{formatRelative(page.updatedAt)}</span>
          </>
        }
        {...(current ? { mode, onModeChange: setMode } : {})}
        {...(current ? { copy: { value: current.markdown, label: `复制 ${page.title}` } } : {})}
        actions={
          <>
            {caps.publish ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending || !currentLoaded}
                title={currentLoaded ? undefined : '当前发布版本还没有加载出来'}
                onClick={() => {
                  if (!currentLoaded) return;
                  setEditing(
                    current
                      ? { versionId: current.id, markdown: current.markdown }
                      : { versionId: null, markdown: '' },
                  );
                }}
              >
                编辑正文
              </Button>
            ) : null}
            {caps.execute ? (
              <Button
                size="sm"
                disabled={pending}
                aria-busy={generate.isPending}
                onClick={() =>
                  generate.mutate(
                    { pageId, ...(instruction.trim() ? { instruction: instruction.trim() } : {}) },
                    {
                      onSuccess: (result) => {
                        setGenerateJobId(result.jobId);
                        // Pick up the new job once so its polling starts; terminal handling comes from the job status.
                        void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
                        toastSuccess('已提交生成任务');
                      },
                      onError: toastError,
                    },
                  )
                }
              >
                {page.currentVersionId === null ? '生成草稿' : '重新生成'}
              </Button>
            ) : null}
          </>
        }
      />
      {generateJob ? (
        <PageNote
          title={`生成任务 ${jobStatusLabel[generateJob.status]}`}
          description={generateJob.step ?? `进度 ${generateJob.progress}%`}
        />
      ) : null}
      <Field className="gap-1.5">
        <FieldLabel htmlFor="wiki-instruction">生成指令</FieldLabel>
        <Input
          id="wiki-instruction"
          value={instruction}
          disabled={pending}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="可选，说明这次生成要补充什么"
        />
      </Field>
      {current ? (
        mode === 'read' ? (
          <Markdown text={current.markdown} />
        ) : (
          <CodeBlock code={current.markdown} lineNumbers maxHeight="60vh" copyable={false} />
        )
      ) : currentVersionId !== null ? (
        <InlineEmpty>当前发布版本还没有加载出来；加载更早版本后显示。</InlineEmpty>
      ) : (
        <InlineEmpty>还没有正文</InlineEmpty>
      )}
      <PageSection title="版本" divided>
        {versions.length === 0 ? <InlineEmpty>还没有版本</InlineEmpty> : null}
        <ul className="flex flex-col">
          {versions.map((version) => (
            <li
              key={version.id}
              className="flex flex-wrap items-center gap-2 border-b py-2 text-xs last:border-b-0"
            >
              <span className="font-mono text-fg">v{version.version}</span>
              <span className="text-muted-foreground">
                {version.generatedBy === 'sdk' ? version.model : '人工编辑'}
              </span>
              <span className="text-muted-foreground">{formatDateTime(version.createdAt)}</span>
              {version.id === page.currentVersionId ? (
                <StatusBadge tone="success">当前发布</StatusBadge>
              ) : (
                <div className="ml-auto flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setPreviewing(version)}>
                    预览
                  </Button>
                  {caps.publish ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => setPublishTarget(version)}
                      >
                        发布此版本
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => setRollbackTarget(version.id)}
                      >
                        回退到此版本
                      </Button>
                    </>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
        {nextCursor ? (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={loadOlder.isPending}
            aria-busy={loadOlder.isPending}
            onClick={() =>
              loadOlder.mutate(
                { pageId, cursor: nextCursor },
                {
                  onSuccess: (result) => {
                    setOlderVersions((previous) => [...previous, ...result.items]);
                    setOlderCursor(result.nextCursor);
                  },
                  onError: toastError,
                },
              )
            }
          >
            {loadOlder.isPending ? '加载中…' : '加载更早版本'}
          </Button>
        ) : null}
      </PageSection>
      <ConfirmDialog
        open={rollbackTarget !== null}
        title="回退 Wiki 版本"
        description="回退会把该版本内容写成新的当前版本，历史版本保留。"
        confirmLabel="回退"
        confirmDisabled={pending}
        onClose={() => setRollbackTarget(null)}
        onConfirm={async () => {
          if (!rollbackTarget) return;
          await rollback.mutateAsync({ pageId, versionId: rollbackTarget });
          toastSuccess('已回退');
        }}
      />
      <ConfirmDialog
        open={publishTarget !== null}
        title="发布 Wiki 版本"
        description={
          publishTarget
            ? `将 v${publishTarget.version} 设为当前发布版本；当前版本与历史版本都保留。`
            : ''
        }
        confirmLabel="发布"
        confirmDisabled={pending}
        onClose={() => setPublishTarget(null)}
        onConfirm={async () => {
          if (!publishTarget) return;
          await publish.mutateAsync({ pageId, versionId: publishTarget.id });
          toastSuccess('已发布');
        }}
      />
      {previewing ? (
        <Dialog open onOpenChange={(next) => (next ? undefined : setPreviewing(null))}>
          <DialogShell
            title={`预览 v${previewing.version}`}
            description="尚未发布的版本；发布前先对照正文。"
            className="max-w-[860px] sm:max-w-[860px]"
          >
            <Markdown text={previewing.markdown} />
          </DialogShell>
        </Dialog>
      ) : null}
      {editing ? (
        <WikiMarkdownDialog
          baseId={baseId}
          pageId={pageId}
          versionId={editing.versionId}
          markdown={editing.markdown}
          onClose={() => setEditing(null)}
          onReload={async () => {
            await detail.refetch();
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** 人工改动会写成新版本；不覆盖历史，也不与 SDK 草稿混写。 */
function WikiMarkdownDialog({
  baseId,
  pageId,
  versionId,
  markdown,
  onClose,
  onReload,
}: {
  baseId: string;
  pageId: string;
  /** 打开编辑器时锁定的 currentVersionId；空白页为 null，表示首次发布。 */
  versionId: string | null;
  markdown: string;
  onClose: () => void;
  onReload: () => Promise<void>;
}) {
  const save = useSaveKnowledgeWikiPage(baseId);
  const [value, setValue] = useState(markdown);
  const [error, setError] = useState<string | null>(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const pending = save.isPending;
  const guard = useDraftGuard(value !== markdown, pending, onClose);

  return (
    <>
      <Dialog
        open
        onOpenChange={(next, details) => {
          if (pending) {
            details.cancel();
            return;
          }
          if (!next) guard.close();
        }}
      >
        <DialogShell title="编辑 Wiki 正文" closeDisabled={pending}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              save.mutate(
                { pageId, patch: { markdown: value, expectedVersion: versionId } },
                {
                  onSuccess: () => {
                    toastSuccess('Wiki 已发布为新版本');
                    guard.finish();
                  },
                  onError: (reason) => {
                    // 保留草稿；别人已发布新版本时由用户确认后再重新加载。
                    setError(errorMessage(reason));
                  },
                },
              );
            }}
          >
            <Field className="gap-1.5" data-invalid={error !== null}>
              <FieldLabel htmlFor="knowledge-wiki-markdown">Markdown</FieldLabel>
              <Textarea
                id="knowledge-wiki-markdown"
                value={value}
                rows={14}
                disabled={pending}
                aria-invalid={error !== null}
                onChange={(event) => setValue(event.target.value)}
                className="font-mono"
              />
              <FieldError>{error}</FieldError>
            </Field>
            <div className="flex justify-end gap-2">
              {error ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setConfirmReload(true)}
                >
                  重新加载
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={guard.close} disabled={pending}>
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  pending || value.trim() === '' || (versionId !== null && value === markdown)
                }
                aria-busy={pending}
              >
                {pending ? '保存中…' : '保存'}
              </Button>
            </div>
          </form>
          <DraftGuardDialogs guard={guard} draft="Wiki 正文草稿会丢失。" pending={pending} />
        </DialogShell>
      </Dialog>
      <ConfirmDialog
        open={confirmReload}
        title="重新加载 Wiki 正文"
        description="当前草稿会被放弃，编辑器改为显示最新已发布版本。"
        confirmLabel="重新加载"
        onClose={() => setConfirmReload(false)}
        onConfirm={async () => {
          await onReload();
          setConfirmReload(false);
        }}
      />
    </>
  );
}

function CreateWikiPageDialog({
  baseId,
  onClose,
  onCreated,
}: {
  baseId: string;
  onClose: () => void;
  onCreated: (page: { id: string }) => void;
}) {
  const create = useCreateKnowledgeWikiPage(baseId);
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const slugValid = /^[a-z0-9][a-z0-9-_]*$/.test(slug);
  const pending = create.isPending;
  const guard = useDraftGuard(slug !== '' || title !== '', pending, onClose);

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) guard.close();
      }}
    >
      <DialogShell title="新建 Wiki 页面" closeDisabled={pending}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(
              { slug, title: title.trim() },
              {
                onSuccess: (page) => {
                  toastSuccess('Wiki 页面已创建');
                  guard.finish();
                  onCreated(page);
                },
                onError: toastError,
              },
            );
          }}
        >
          <FieldGroup>
            <Field className="gap-1.5" data-invalid={slug !== '' && !slugValid}>
              <FieldLabel htmlFor="wiki-title">
                标题 <RequiredMark />
              </FieldLabel>
              <Input
                id="wiki-title"
                value={title}
                disabled={pending}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field className="gap-1.5" data-invalid={slug !== '' && !slugValid}>
              <FieldLabel htmlFor="wiki-slug">
                Slug <RequiredMark />
              </FieldLabel>
              <Input
                id="wiki-slug"
                value={slug}
                disabled={pending}
                aria-invalid={slug !== '' && !slugValid}
                aria-describedby={slug !== '' && !slugValid ? 'wiki-slug-error' : undefined}
                onChange={(event) => setSlug(event.target.value)}
                className="font-mono"
              />
              {slug !== '' && !slugValid ? (
                <FieldError id="wiki-slug-error">仅允许小写字母、数字、- 和 _</FieldError>
              ) : null}
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button
              type="submit"
              disabled={pending || title.trim() === '' || !slugValid}
              aria-busy={pending}
            >
              {pending ? '创建中…' : '创建'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="Wiki 页面草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

// ---- 来源 -----------------------------------------------------------------

function SourcesTab({ baseId, caps }: { baseId: string; caps: KnowledgeCaps }) {
  const sources = useKnowledgeSources(baseId);
  useDrainPages(sources);
  const remove = useDeleteKnowledgeSource(baseId);
  const test = useTestKnowledgeSource();
  const sync = useSyncKnowledgeSource(baseId);
  const jobs = useKnowledgeJobs(baseId);
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeSource | null>(null);
  const [deleteDocuments, setDeleteDocuments] = useState(false);
  const [editing, setEditing] = useState<KnowledgeSource | null>(null);
  const [syncJobs, setSyncJobs] = useState<Array<{ id: string; sourceId: string }>>([]);
  const settledJobs = useRef(new Set<string>());
  // 自动 Wiki、批量上传等任务会把刚提交的同步任务挤出任务列表前 50 条，只看列表会永远等不到终态。
  // 列表里缺失的任务改用 GET jobs/:id 定向轮询，终态后与列表中的任务走同一套失效。
  const missingSyncJobs = syncJobs.filter(
    (entry) =>
      !settledJobs.current.has(entry.id) && !jobs.data?.some((item) => item.id === entry.id),
  );
  const syncJobDetails = useQueries({
    queries: missingSyncJobs.map((entry) => ({
      queryKey: knowledgeKeys.job(entry.id),
      queryFn: () => api.knowledgeJob(entry.id),
      // 任务已不存在时重试无意义；网络与 5xx 仍按默认重试一次后继续轮询。
      retry: (failureCount: number, error: unknown) => !isMissingJob(error) && failureCount < 1,
      refetchInterval: (query: Query<KnowledgeJob>) =>
        isTerminalJobStatus(query.state.data?.status) || isMissingJob(query.state.error)
          ? false
          : 2_000,
    })),
  });
  const knownSyncJobs = new Map<string, KnowledgeJob>();
  for (const item of jobs.data ?? []) knownSyncJobs.set(item.id, item);
  missingSyncJobs.forEach((entry, index) => {
    const job = syncJobDetails[index]?.data;
    if (job) knownSyncJobs.set(entry.id, job);
  });

  // 任务随来源一起被删时 404：停止跟踪并提示刷新，不把缺失当完成，也不无限轮询。
  useEffect(() => {
    const gone = missingSyncJobs.filter((entry, index) => {
      if (settledJobs.current.has(entry.id)) return false;
      return isMissingJob(syncJobDetails[index]?.error);
    });
    if (gone.length === 0) return;
    for (const entry of gone) settledJobs.current.add(entry.id);
    setSyncJobs((previous) =>
      previous.filter((entry) => !gone.some((item) => item.id === entry.id)),
    );
    toast.warning('同步任务已不存在，可能来源已删除；请刷新来源列表');
  }, [missingSyncJobs, syncJobDetails]);

  // 同步任务跨过终态时在页面内失效一次受影响的查询；任务列表本身继续轮询。
  useEffect(() => {
    if (syncJobs.length === 0) return;
    const finished = syncJobs.filter((entry) => {
      if (settledJobs.current.has(entry.id)) return false;
      const job = knownSyncJobs.get(entry.id);
      return job !== undefined && isTerminalJobStatus(job.status);
    });
    if (finished.length === 0) return;
    for (const entry of finished) {
      settledJobs.current.add(entry.id);
      void client.invalidateQueries({ queryKey: knowledgeKeys.sourceRuns(entry.sourceId) });
    }
    void client.invalidateQueries({ queryKey: knowledgeKeys.sources(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    const failedJob = finished
      .map((entry) => knownSyncJobs.get(entry.id))
      .find((job) => job?.status === 'failed');
    if (failedJob) {
      toastError(
        new Error(
          knowledgeJobErrorText(failedJob.error) ?? '来源同步失败，已保留失败原因，可修正后重试',
        ),
      );
    }
  }, [baseId, client, knownSyncJobs, syncJobs]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageToolbar>
        <span role="status" className="text-xs text-muted-foreground">
          {sources.isPending
            ? '加载中…'
            : sources.isError
              ? '数量不可用'
              : // 分页已自动取完，这里的数量就是全部来源。
                `${sources.data?.length ?? 0} 个来源`}
        </span>
        {caps.sources ? (
          <Button className="ml-auto" onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" /> 新建来源
          </Button>
        ) : null}
      </PageToolbar>
      {sources.isPending ? <LoadingState rows={3} /> : null}
      {sources.isError ? (
        <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
      ) : null}
      {sources.isFetchNextPageError ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => void sources.fetchNextPage()}
        >
          重试加载其余来源
        </Button>
      ) : null}
      {sources.data && sources.data.length === 0 ? (
        <EmptyState
          title="还没有外部来源"
          action={
            caps.sources ? (
              <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                新建来源
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {sources.data && sources.data.length > 0 ? (
        <ul className="flex flex-col">
          {sources.data.map((source) => {
            const provider = sourceProvider(source.type);
            const ProviderIcon = provider.icon;
            const syncable = source.status === 'active';
            const lastSyncStatus = source.lastSyncStatus
              ? (jobStatusLabel[source.lastSyncStatus as keyof typeof jobStatusLabel] ??
                source.lastSyncStatus)
              : null;
            return (
              <li key={source.id} className="border-b py-3 last:border-b-0">
                <Collapsible open={selected === source.id} className="flex min-w-0 flex-col gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-3">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-item border border-line text-muted-foreground">
                      <ProviderIcon className="size-3.5" aria-hidden="true" />
                    </span>
                    <button
                      type="button"
                      className="min-w-0 truncate text-sm font-medium text-fg hover:underline"
                      onClick={() => setSelected(selected === source.id ? null : source.id)}
                      aria-expanded={selected === source.id}
                    >
                      {source.name}
                    </button>
                    <StatusBadge tone="outline">{provider.label}</StatusBadge>
                    <StatusBadge
                      tone={
                        source.status === 'active'
                          ? 'success'
                          : source.status === 'auth_error'
                            ? 'danger'
                            : 'outline'
                      }
                    >
                      {sourceStatusLabel[source.status]}
                    </StatusBadge>
                    <span className="text-2xs text-muted-foreground">
                      上次同步 {lastSyncStatus ? `${lastSyncStatus} · ` : ''}
                      {formatRelative(source.lastSyncAt)}
                    </span>
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      {caps.sources ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={test.isPending}
                          title="仅校验本地配置与已存凭证，不访问远端"
                          onClick={() =>
                            test.mutate(source.id, {
                              onSuccess: (result) =>
                                result.ok
                                  ? toastSuccess('本地配置与已存凭证检查通过')
                                  : toast.error(result.issues.join('；'), { duration: Infinity }),
                              onError: toastError,
                            })
                          }
                        >
                          检查配置
                        </Button>
                      ) : null}
                      {caps.execute ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={sync.isPending || !syncable}
                          title={
                            !syncable
                              ? '来源未启用，无法同步'
                              : sync.isPending
                                ? '正在提交同步任务'
                                : '立即提交一次同步任务'
                          }
                          onClick={() =>
                            sync.mutate(source.id, {
                              onSuccess: (result) => {
                                setSelected(source.id);
                                setSyncJobs((previous) => [
                                  ...previous,
                                  { id: result.jobId, sourceId: source.id },
                                ]);
                                toastSuccess('已提交同步任务');
                              },
                              onError: toastError,
                            })
                          }
                        >
                          立即同步
                        </Button>
                      ) : null}
                      {caps.sources ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`编辑来源 ${source.name}`}
                            onClick={() => setEditing(source)}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`删除来源 ${source.name}`}
                            onClick={() => {
                              setDeleteDocuments(false);
                              setDeleting(source);
                            }}
                          >
                            <Trash2 />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <span className="truncate text-2xs text-muted-foreground">
                    {sourceTargetSummary(source)}
                  </span>
                  {source.lastError ? (
                    <span className="text-2xs text-danger">{source.lastError}</span>
                  ) : null}
                  <CollapsibleContent animated>
                    <SourceRuns sourceId={source.id} />
                  </CollapsibleContent>
                </Collapsible>
              </li>
            );
          })}
        </ul>
      ) : null}
      {creating ? <SourceDialog baseId={baseId} onClose={() => setCreating(false)} /> : null}
      {editing ? (
        <SourceDialog baseId={baseId} source={editing} onClose={() => setEditing(null)} />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除来源"
          description={
            deleteDocuments
              ? `将删除「${deleting.name}」及其导入的全部文档与分块。此操作不可撤销。`
              : `将删除「${deleting.name}」，已导入的文档保留但停用、不再参与检索。`
          }
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync({
              sourceId: deleting.id,
              documents: deleteDocuments ? 'delete' : 'keep',
            });
            if (selected === deleting.id) setSelected(null);
            toastSuccess('来源已删除');
          }}
        >
          <div className="flex items-center gap-2 text-xs text-fg">
            <Checkbox
              id="knowledge-source-delete-documents"
              checked={deleteDocuments}
              onCheckedChange={(checked) => setDeleteDocuments(checked)}
            />
            <FieldLabel htmlFor="knowledge-source-delete-documents">
              同时删除已导入的文档
            </FieldLabel>
          </div>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** 凭证只写不读：留空提交不发 secrets，避免把已存密钥覆盖成空串。 */
function credentialField(type: SourceType): { key: 'token' | 'appSecret'; label: string } | null {
  if (type === 'github' || type === 'gitlab') return { key: 'token', label: 'Access Token' };
  if (type === 'feishu_wiki' || type === 'feishu_drive') {
    return { key: 'appSecret', label: 'App Secret' };
  }
  return null;
}

/** clientId 只用于列表 key；已有范围沿用服务端 id，保证 key 稳定、删行不串焦点。 */
type RangeKind = KnowledgeSourceInput['ranges'][number]['kind'];
type RangeDraft = Omit<KnowledgeSourceInput['ranges'][number], 'kind'> & {
  clientId: string;
  kind: RangeKind;
};

/** 提交前去掉 clientId，不把本地 key 混进来源 config。 */
function toRangeInput({ clientId: _clientId, ...range }: RangeDraft) {
  return { ...range, externalId: range.externalId.trim() };
}

const rangeKinds: Record<SourceType, RangeKind[]> = {
  github: ['github_repo'],
  feishu_wiki: ['wiki_space', 'wiki_node'],
  feishu_drive: ['drive_folder'],
  gitlab: ['gitlab_project'],
  feed: ['feed'],
};

const rangeKindLabel: Record<RangeKind, string> = {
  wiki_space: '知识空间',
  wiki_node: '知识节点',
  drive_folder: '云盘目录',
  gitlab_project: 'GitLab 项目',
  github_repo: '仓库',
  feed: 'Feed',
};

function rangeExternalLabel(kind: RangeKind): string {
  return {
    wiki_space: '空间 ID',
    wiki_node: '节点 Token',
    drive_folder: '目录 Token',
    gitlab_project: 'Project ID',
    github_repo: '仓库',
    feed: 'Feed 地址',
  }[kind];
}

/** 空范围行；clientId 在创建时生成一次，后续 render 不变。 */
function newRangeDraft(kind: RangeKind): RangeDraft {
  return {
    clientId: crypto.randomUUID(),
    kind,
    externalId: '',
    ref: null,
    paths: [],
    enabled: true,
  };
}

/** 至少一个范围，且至少一个启用；空行也算缺 ID。 */
function rangeIssue(type: SourceType, ranges: RangeDraft[]): string | null {
  if (ranges.length === 0) return '至少需要一个范围';
  if (ranges.some((range) => range.externalId.trim() === '')) return '每个范围都需要外部 ID';
  // GitLab 的来源级 config.ref 由范围回填；空 ref 会静默改到默认分支。
  if (type === 'gitlab' && ranges.some((range) => !range.ref?.trim())) {
    return '每个 GitLab 范围都需要 Ref';
  }
  if (!ranges.some((range) => range.enabled)) return '至少需要一个启用的范围';
  return null;
}

/** 来源弹层的草稿签名：关闭确认只比较真实字段，不依赖输入框注册顺序。 */
function sourceDraftSignature(input: {
  type: SourceType;
  name: string;
  secret: string;
  appId: string;
  baseUrl: string;
  cron: string;
  syncDeletions: boolean;
  status: KnowledgeSource['status'];
  ranges: RangeDraft[];
}): string {
  return JSON.stringify(input);
}

/** 列表行的目标摘要：仓库@ref / 飞书范围 / Feed，并带上 cron。 */
function sourceTargetSummary(source: KnowledgeSource): string {
  const summary = source.ranges
    .map((range) => {
      const kind = range.kind as RangeKind;
      if (kind === 'github_repo') return `${range.externalId}@${range.ref ?? '默认分支'}`;
      if (kind === 'gitlab_project') {
        return range.ref ? `${range.externalId}@${range.ref}` : range.externalId;
      }
      if (kind === 'feed') return range.externalId;
      return `${rangeKindLabel[kind]} ${range.externalId}`;
    })
    .join(' · ');
  return source.syncCron ? `${summary} · cron ${source.syncCron}` : summary;
}

/** 已有来源的 config 只读展示：缺省或非字符串一律按空值处理。 */
function configString(source: KnowledgeSource | undefined, key: string): string {
  const value = source?.config[key];
  return typeof value === 'string' ? value : '';
}

function RangeRows({
  type,
  ranges,
  disabled,
  errors,
  onChange,
}: {
  type: SourceType;
  ranges: RangeDraft[];
  disabled: boolean;
  /** 提交后按行显示缺外部 ID / Ref；未提交时不制造噪音。 */
  errors: Array<{ externalId: string | null; ref: string | null }>;
  onChange: (ranges: RangeDraft[]) => void;
}) {
  const kinds = rangeKinds[type];
  const patch = (index: number, next: Partial<RangeDraft>) =>
    onChange(ranges.map((range, i) => (i === index ? { ...range, ...next } : range)));

  return (
    <div className="flex flex-col gap-2">
      {ranges.map((range, index) => (
        <div
          key={range.clientId}
          className="flex flex-col gap-2 rounded-item border border-line p-2.5"
        >
          <div className="flex items-center gap-2">
            <span className="text-2xs text-muted-foreground">范围 {index + 1}</span>
            <Switch
              id={`source-range-${index}-enabled`}
              size="sm"
              checked={range.enabled}
              disabled={disabled}
              aria-label={`启用范围 ${index + 1}`}
              onCheckedChange={(checked) => patch(index, { enabled: checked })}
            />
            <span className="text-2xs text-muted-foreground">
              {range.enabled ? '启用' : '停用'}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label={`删除范围 ${index + 1}`}
              disabled={disabled}
              onClick={() => onChange(ranges.filter((_, i) => i !== index))}
            >
              <Trash2 />
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {kinds.length > 1 ? (
              <Field className="gap-1.5">
                <FieldLabel htmlFor={`source-range-${index}-kind`}>类型</FieldLabel>
                <Select
                  value={range.kind}
                  disabled={disabled}
                  onValueChange={(next) => {
                    if (next !== null) patch(index, { kind: next as RangeKind });
                  }}
                  items={kinds.map((kind) => ({ value: kind, label: rangeKindLabel[kind] }))}
                >
                  <SelectTrigger id={`source-range-${index}-kind`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {kinds.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {rangeKindLabel[kind]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <Field className="gap-1.5" data-invalid={errors[index]?.externalId !== null}>
              <FieldLabel htmlFor={`source-range-${index}-external`}>
                {rangeExternalLabel(range.kind)} <RequiredMark />
              </FieldLabel>
              <Input
                id={`source-range-${index}-external`}
                value={range.externalId}
                disabled={disabled}
                aria-invalid={errors[index]?.externalId !== null}
                aria-describedby={
                  errors[index]?.externalId !== null
                    ? `source-range-${index}-external-error`
                    : undefined
                }
                onChange={(event) => patch(index, { externalId: event.target.value })}
                placeholder={range.kind === 'github_repo' ? 'owner/repo' : undefined}
                className="font-mono"
              />
              <FieldError id={`source-range-${index}-external-error`}>
                {errors[index]?.externalId}
              </FieldError>
            </Field>
            {type === 'github' || type === 'gitlab' ? (
              <>
                <Field className="gap-1.5" data-invalid={errors[index]?.ref !== null}>
                  <FieldLabel htmlFor={`source-range-${index}-ref`}>
                    Ref {type === 'gitlab' ? <RequiredMark /> : null}
                  </FieldLabel>
                  <Input
                    id={`source-range-${index}-ref`}
                    value={range.ref ?? ''}
                    disabled={disabled}
                    aria-invalid={errors[index]?.ref !== null}
                    aria-describedby={
                      errors[index]?.ref !== null ? `source-range-${index}-ref-error` : undefined
                    }
                    onChange={(event) => patch(index, { ref: event.target.value.trim() || null })}
                    placeholder={type === 'github' ? '留空使用默认分支' : '例如 main'}
                    className="font-mono"
                  />
                  <FieldError id={`source-range-${index}-ref-error`}>
                    {errors[index]?.ref}
                  </FieldError>
                </Field>
                <Field className="gap-1.5 sm:col-span-2">
                  <FieldLabel htmlFor={`source-range-${index}-paths`}>Paths</FieldLabel>
                  <Input
                    id={`source-range-${index}-paths`}
                    value={range.paths.join(', ')}
                    disabled={disabled}
                    onChange={(event) =>
                      patch(index, {
                        paths: event.target.value
                          .split(',')
                          .map((path) => path.trim())
                          .filter((path) => path !== ''),
                      })
                    }
                    placeholder={
                      type === 'github'
                        ? '用逗号分隔，留空表示仓库全部路径'
                        : '用逗号分隔，留空表示项目全部路径'
                    }
                    className="font-mono"
                  />
                  <FieldDescription>
                    目录或文件前缀；留空读取{type === 'gitlab' ? '整个项目' : '整个仓库'}
                    ；仅同步文本文件。
                  </FieldDescription>
                </Field>
              </>
            ) : null}
          </div>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...ranges, newRangeDraft(kinds[0] as RangeKind)])}
        >
          <Plus data-icon="inline-start" aria-hidden="true" /> 添加范围
        </Button>
      </div>
    </div>
  );
}

function SourceDialog({
  baseId,
  source,
  onClose,
}: {
  baseId: string;
  source?: KnowledgeSource;
  onClose: () => void;
}) {
  const editing = source !== undefined;
  const create = useCreateKnowledgeSource(baseId);
  const update = useUpdateKnowledgeSource(baseId);
  const pending = create.isPending || update.isPending;
  const [step, setStep] = useState<'choose' | 'configure'>(editing ? 'configure' : 'choose');
  const [type, setType] = useState<SourceType>(source ? source.type : 'feishu_wiki');
  const [name, setName] = useState(source?.name ?? '');
  const [secret, setSecret] = useState('');
  const [appId, setAppId] = useState(() => configString(source, 'appId'));
  const [baseUrl, setBaseUrl] = useState(() => configString(source, 'baseUrl'));
  const [cron, setCron] = useState(source?.syncCron ?? '');
  const [syncDeletions, setSyncDeletions] = useState(source?.config.syncDeletions === true);
  // auth_error 不在可写枚举里：保持原值，只有用户主动改状态才提交。
  const [status, setStatus] = useState<KnowledgeSource['status']>(source?.status ?? 'active');
  const [ranges, setRanges] = useState<RangeDraft[]>(() =>
    source
      ? source.ranges.map(({ id, ...range }) => ({ ...range, clientId: id }))
      : [newRangeDraft(rangeKinds.feishu_wiki[0] as RangeKind)],
  );
  const [submitted, setSubmitted] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [baseline, setBaseline] = useState(() =>
    sourceDraftSignature({
      type: source ? source.type : 'feishu_wiki',
      name: source?.name ?? '',
      secret: '',
      appId: configString(source, 'appId'),
      baseUrl: configString(source, 'baseUrl'),
      cron: source?.syncCron ?? '',
      syncDeletions: source?.config.syncDeletions === true,
      status: source?.status ?? 'active',
      ranges,
    }),
  );
  const provider = sourceProvider(type);
  const ProviderIcon = provider.icon;
  const credential = credentialField(type);
  const secretRequired = credential !== null && !(editing && source.hasSecret);
  const issue = rangeIssue(type, ranges);
  const normalized = ranges.map(toRangeInput);
  const syncCron = cron.trim() === '' ? null : cron.trim();
  const dirty =
    step === 'configure' &&
    sourceDraftSignature({
      type,
      name,
      secret,
      appId,
      baseUrl,
      cron,
      syncDeletions,
      status,
      ranges,
    }) !== baseline;
  const guard = useDraftGuard(dirty, pending, onClose);
  const fieldIssues = {
    name: name.trim() === '' ? '请填写来源名称' : null,
    appId:
      type === 'feishu_wiki' || type === 'feishu_drive'
        ? appId.trim() === ''
          ? '请填写 App ID'
          : null
        : null,
    baseUrl: type === 'gitlab' && baseUrl.trim() === '' ? '请填写实例 URL' : null,
    secret: secretRequired && secret === '' ? `请填写 ${credential.label}` : null,
  };
  const rowIssues = ranges.map((range) => ({
    externalId: range.externalId.trim() === '' ? `请填写${rangeExternalLabel(range.kind)}` : null,
    ref: type === 'gitlab' && !range.ref?.trim() ? '请填写 Ref' : null,
  }));
  const hasSubmitIssue =
    Object.values(fieldIssues).some(Boolean) ||
    rowIssues.some((row) => row.externalId !== null || row.ref !== null) ||
    issue !== null;

  // 各类型的范围 kind 与外键含义不同，切换类型时整套重建，不能把旧行带过去；
  // 凭证与连接地址也只属于原类型，必须清空。
  const chooseType = (next: SourceType): void => {
    const nextRanges = [newRangeDraft(rangeKinds[next][0] as RangeKind)];
    setType(next);
    setSecret('');
    setBaseUrl('');
    setAppId('');
    setRanges(nextRanges);
    setStep('configure');
    setSubmitted(false);
    // 选类型本身不算草稿；只有真正改过字段才需要离开确认。
    setBaseline(
      sourceDraftSignature({
        type: next,
        name,
        secret: '',
        appId: '',
        baseUrl: '',
        cron,
        syncDeletions,
        status,
        ranges: nextRanges,
      }),
    );
  };

  const requestChooseType = (): void => {
    if (pending) return;
    if (dirty) setConfirmSwitch(true);
    else setStep('choose');
  };

  const buildConfig = (): Record<string, unknown> => {
    if (type === 'feishu_wiki' || type === 'feishu_drive') {
      return {
        appId: appId.trim(),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        syncDeletions,
      };
    }
    if (type === 'github') {
      // ref 属于每个 range，多仓库时不能把第一条写进公共 config。
      return {
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        projectId: normalized[0]?.externalId ?? '',
        syncDeletions,
      };
    }
    if (type === 'gitlab') {
      return {
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        projectId: normalized[0]?.externalId ?? '',
        ref: ranges.find((range) => range.ref)?.ref?.trim() ?? '',
        syncDeletions,
      };
    }
    return {};
  };

  const buildInput = (): KnowledgeSourceInput => {
    const common = { name: name.trim(), syncCron, ranges: normalized };
    if (type === 'feishu_wiki' || type === 'feishu_drive') {
      return {
        ...common,
        type,
        config: {
          appId: appId.trim(),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          syncDeletions,
        },
        secrets: { appSecret: secret },
      };
    }
    if (type === 'github') {
      return {
        ...common,
        type,
        config: {
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          projectId: normalized[0]?.externalId ?? '',
          syncDeletions,
        },
        secrets: { token: secret },
      };
    }
    if (type === 'gitlab') {
      return {
        ...common,
        type,
        config: {
          baseUrl: baseUrl.trim(),
          projectId: normalized[0]?.externalId ?? '',
          ref: ranges.find((range) => range.ref)?.ref?.trim() ?? '',
          syncDeletions,
        },
        secrets: { token: secret },
      };
    }
    return { ...common, type: 'feed', config: { syncDeletions: false }, secrets: {} };
  };

  const buildPatch = (target: KnowledgeSource) => {
    // 填了新凭证说明已修复 auth_error：自动恢复启用；留空则保留原状态。
    const patchStatus =
      status === 'auth_error'
        ? secret !== ''
          ? 'active'
          : undefined
        : status === target.status
          ? undefined
          : status;
    return {
      name: name.trim(),
      ...(patchStatus === undefined ? {} : { status: patchStatus }),
      syncCron,
      ranges: normalized,
      ...(type === 'feed' ? {} : { config: buildConfig() }),
      // 空值不提交，服务端保留原凭证；填了才是轮换。
      ...(credential && secret !== '' ? { secrets: { [credential.key]: secret } } : {}),
    };
  };

  const secretInput =
    credential === null ? null : (
      <Field className="gap-1.5" data-invalid={submitted && fieldIssues.secret !== null}>
        <FieldLabel htmlFor="knowledge-source-secret">
          {credential.label} {secretRequired ? <RequiredMark /> : null}
        </FieldLabel>
        <Input
          id="knowledge-source-secret"
          type="password"
          value={secret}
          autoComplete="off"
          disabled={pending}
          aria-invalid={submitted && fieldIssues.secret !== null}
          aria-describedby={
            submitted && fieldIssues.secret ? 'knowledge-source-secret-error' : undefined
          }
          onChange={(event) => setSecret(event.target.value)}
          placeholder={editing ? (source.hasSecret ? '留空保持原凭证' : '填写凭证') : '填写凭据'}
        />
        <FieldError id="knowledge-source-secret-error">
          {submitted ? fieldIssues.secret : null}
        </FieldError>
        {type === 'github' ? (
          <FieldDescription>需要 Contents 只读权限；私有仓库还需 Metadata 只读。</FieldDescription>
        ) : null}
      </Field>
    );

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) guard.close();
      }}
    >
      <DialogShell
        title={editing ? '编辑来源' : '新建来源'}
        closeDisabled={pending}
        className="max-w-[760px] sm:max-w-[760px]"
      >
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            setSubmitted(true);
            if (hasSubmitIssue) return;
            if (source) {
              update.mutate(
                { sourceId: source.id, patch: buildPatch(source) },
                {
                  onSuccess: () => {
                    toastSuccess('来源已更新');
                    guard.finish();
                  },
                  onError: toastError,
                },
              );
              return;
            }
            create.mutate(buildInput(), {
              onSuccess: () => {
                toastSuccess('来源已创建');
                guard.finish();
              },
              onError: toastError,
            });
          }}
        >
          {step === 'choose' ? (
            <div className="flex flex-col">
              {sourceProviders.map((option) => {
                const OptionIcon = option.icon;
                return (
                  <button
                    key={option.type}
                    type="button"
                    disabled={pending}
                    onClick={() => chooseType(option.type)}
                    className="flex items-center gap-3 border-b border-line px-2 py-3 text-left transition-colors last:border-b-0 hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-item border border-line text-muted-foreground">
                      <OptionIcon className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-fg">{option.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-item border border-line text-muted-foreground">
                  <ProviderIcon className="size-3.5" aria-hidden="true" />
                </span>
                <span className="text-xs font-medium text-fg">{provider.label}</span>
                {editing ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="ml-auto"
                    disabled={pending}
                    onClick={requestChooseType}
                  >
                    更换来源
                  </Button>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-fg">连接</span>
                <FieldGroup className="grid gap-3 sm:grid-cols-2">
                  <Field
                    className={cn('gap-1.5', !editing && 'sm:col-span-2')}
                    data-invalid={submitted && fieldIssues.name !== null}
                  >
                    <FieldLabel htmlFor="source-name">
                      名称 <RequiredMark />
                    </FieldLabel>
                    <Input
                      id="source-name"
                      value={name}
                      maxLength={120}
                      disabled={pending}
                      aria-invalid={submitted && fieldIssues.name !== null}
                      aria-describedby={
                        submitted && fieldIssues.name ? 'source-name-error' : undefined
                      }
                      onChange={(event) => setName(event.target.value)}
                    />
                    <FieldError id="source-name-error">
                      {submitted ? fieldIssues.name : null}
                    </FieldError>
                  </Field>
                  {editing ? (
                    <Field className="gap-1.5">
                      <FieldLabel htmlFor="knowledge-source-status">状态</FieldLabel>
                      <Select
                        value={status === 'auth_error' ? 'auth_error' : status}
                        disabled={pending}
                        onValueChange={(next) => {
                          if (next === 'active' || next === 'paused' || next === 'disabled') {
                            setStatus(next);
                          }
                        }}
                        items={[
                          ...(status === 'auth_error'
                            ? [{ value: 'auth_error', label: '凭证失效' }]
                            : []),
                          { value: 'active', label: '启用' },
                          { value: 'paused', label: '暂停' },
                          { value: 'disabled', label: '停用' },
                        ]}
                      >
                        <SelectTrigger id="knowledge-source-status" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {status === 'auth_error' ? (
                              <SelectItem value="auth_error">凭证失效</SelectItem>
                            ) : null}
                            <SelectItem value="active">启用</SelectItem>
                            <SelectItem value="paused">暂停</SelectItem>
                            <SelectItem value="disabled">停用</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  ) : null}
                  {type === 'feishu_wiki' || type === 'feishu_drive' ? (
                    <>
                      <Field
                        className="gap-1.5"
                        data-invalid={submitted && fieldIssues.appId !== null}
                      >
                        <FieldLabel htmlFor="source-app-id">
                          App ID <RequiredMark />
                        </FieldLabel>
                        <Input
                          id="source-app-id"
                          value={appId}
                          disabled={pending}
                          aria-invalid={submitted && fieldIssues.appId !== null}
                          aria-describedby={
                            submitted && fieldIssues.appId ? 'source-app-id-error' : undefined
                          }
                          onChange={(event) => setAppId(event.target.value)}
                          className="font-mono"
                        />
                        <FieldError id="source-app-id-error">
                          {submitted ? fieldIssues.appId : null}
                        </FieldError>
                      </Field>
                      {secretInput}
                      <Field className="gap-1.5 sm:col-span-2">
                        <FieldLabel htmlFor="source-base-url">Base URL</FieldLabel>
                        <Input
                          id="source-base-url"
                          value={baseUrl}
                          disabled={pending}
                          onChange={(event) => setBaseUrl(event.target.value)}
                          placeholder="留空使用官方地址"
                          className="font-mono"
                        />
                      </Field>
                    </>
                  ) : type === 'github' ? (
                    <>
                      <Field className="gap-1.5">
                        <FieldLabel htmlFor="source-github-api">API 地址</FieldLabel>
                        <Input
                          id="source-github-api"
                          value={baseUrl}
                          disabled={pending}
                          onChange={(event) => setBaseUrl(event.target.value)}
                          placeholder="https://api.github.com"
                          className="font-mono"
                        />
                      </Field>
                      {secretInput}
                    </>
                  ) : type === 'gitlab' ? (
                    <>
                      <Field
                        className="gap-1.5"
                        data-invalid={submitted && fieldIssues.baseUrl !== null}
                      >
                        <FieldLabel htmlFor="source-gitlab-url">
                          实例 URL <RequiredMark />
                        </FieldLabel>
                        <Input
                          id="source-gitlab-url"
                          value={baseUrl}
                          disabled={pending}
                          aria-invalid={submitted && fieldIssues.baseUrl !== null}
                          aria-describedby={
                            submitted && fieldIssues.baseUrl ? 'source-gitlab-url-error' : undefined
                          }
                          onChange={(event) => setBaseUrl(event.target.value)}
                          placeholder="https://gitlab.example.com"
                          className="font-mono"
                        />
                        <FieldError id="source-gitlab-url-error">
                          {submitted ? fieldIssues.baseUrl : null}
                        </FieldError>
                      </Field>
                      {secretInput}
                    </>
                  ) : null}
                </FieldGroup>
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-fg">同步范围</span>
                <RangeRows
                  type={type}
                  ranges={ranges}
                  disabled={pending}
                  errors={ranges.map((_, index) =>
                    submitted
                      ? (rowIssues[index] ?? { externalId: null, ref: null })
                      : { externalId: null, ref: null },
                  )}
                  onChange={setRanges}
                />
                {issue ? <FieldError id="knowledge-source-ranges-error">{issue}</FieldError> : null}
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="knowledge-source-cron">同步 cron（UTC）</FieldLabel>
                  <Input
                    id="knowledge-source-cron"
                    value={cron}
                    disabled={pending}
                    onChange={(event) => setCron(event.target.value)}
                    placeholder="留空不自动同步"
                    className="font-mono"
                  />
                </Field>
                {type === 'feed' ? (
                  <FieldDescription>
                    Feed 只暴露最近窗口，不会把条目滚出窗口当作删除；因此不提供删除传播开关。
                  </FieldDescription>
                ) : (
                  <Field orientation="horizontal" className="items-center gap-2">
                    <Switch
                      id="knowledge-source-sync-deletions"
                      checked={syncDeletions}
                      disabled={pending}
                      onCheckedChange={(checked) => setSyncDeletions(checked)}
                    />
                    <FieldLabel htmlFor="knowledge-source-sync-deletions">
                      远端删除时停用文档
                    </FieldLabel>
                  </Field>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={guard.close} disabled={pending}>
                  取消
                </Button>
                <Button type="submit" disabled={pending} aria-busy={pending}>
                  {pending ? (editing ? '保存中…' : '创建中…') : editing ? '保存' : '创建'}
                </Button>
              </div>
            </>
          )}
          {step === 'choose' ? (
            <div className="flex justify-end">
              <Button variant="outline" onClick={guard.close} disabled={pending}>
                取消
              </Button>
            </div>
          ) : null}
        </form>
        <DraftGuardDialogs guard={guard} draft="来源配置草稿会丢失。" pending={pending} />
        <ConfirmDialog
          open={confirmSwitch}
          title="放弃未保存的更改？"
          description="切换来源类型会清空当前连接与范围草稿。"
          confirmLabel="放弃并切换"
          confirmDisabled={pending}
          onClose={() => setConfirmSwitch(false)}
          onConfirm={async () => {
            setConfirmSwitch(false);
            setStep('choose');
          }}
        />
      </DialogShell>
    </Dialog>
  );
}

/** 每个展开的来源各自取同步记录；收起动画期间仍显示自己的数据。 */
function SourceRuns({ sourceId }: { sourceId: string }) {
  const runs = useKnowledgeSourceRuns(sourceId);
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-item bg-sunken/40 p-2">
      <span className="text-2xs text-muted-foreground">同步记录</span>
      {runs.isPending ? <span className="text-2xs text-muted-foreground">加载中…</span> : null}
      {runs.isError ? (
        <Button variant="link" size="xs" onClick={() => void runs.refetch()}>
          同步记录没有加载出来，重试
        </Button>
      ) : null}
      {runs.data && runs.data.length === 0 ? (
        <span className="text-2xs text-muted-foreground">还没有同步记录</span>
      ) : null}
      {runs.data && runs.data.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {runs.data.map((run) => (
            <li key={run.id} className="flex flex-wrap items-center gap-2 text-2xs">
              <StatusBadge tone={jobStatusTone[run.status]}>
                {jobStatusLabel[run.status]}
              </StatusBadge>
              <span className="text-muted-foreground">
                新增 {run.stats.created} · 更新 {run.stats.updated} · 失败 {run.stats.failed}
              </span>
              <span className="text-muted-foreground">
                {formatDateTime(run.startedAt ?? run.createdAt)}
              </span>
              {run.error ? <span className="text-danger">{run.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---- 处理记录 -------------------------------------------------------------

/** 文档名优先，其次来源名，再退到 ID；两列都为空的是整库任务。 */
function jobTargetLabel(job: KnowledgeJob): string {
  return job.documentTitle ?? job.sourceName ?? job.documentId ?? job.sourceId ?? '整库';
}

function JobsTab({
  baseId,
  canExecute,
  canUpload,
  documentId,
  onClearDocument,
  onGoDocuments,
}: {
  baseId: string;
  canExecute: boolean;
  canUpload: boolean;
  documentId: string | undefined;
  onClearDocument: () => void;
  onGoDocuments: () => void;
}) {
  const jobs = useKnowledgeJobs(baseId, documentId === undefined ? {} : { documentId });
  const retry = useRetryKnowledgeJob(baseId);
  const cancel = useCancelKnowledgeJob(baseId);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {documentId ? (
        <PageNote
          title="只显示该文档的处理记录"
          action={
            <Button variant="outline" size="sm" onClick={onClearDocument}>
              查看全部处理记录
            </Button>
          }
        />
      ) : null}
      <span role="status" className="text-xs text-muted-foreground">
        {jobs.isPending
          ? '加载中…'
          : jobs.isError && jobs.data === undefined
            ? '数量不可用'
            : `已加载 ${jobs.data?.length ?? 0} 条处理记录`}
      </span>
      {jobs.data?.some((job) => job.status === 'queued' || job.status === 'running') &&
      !knowledgeShouldPoll(jobs.data) ? (
        <PageNote
          title="已停止自动刷新"
          description="任务已超过其类型的最长执行时间仍未结束，可能已经卡住；刷新查看状态，或取消后重试。"
          action={
            <Button variant="outline" size="sm" onClick={() => void jobs.refetch()}>
              刷新
            </Button>
          }
        />
      ) : null}
      {jobs.isPending ? <LoadingState rows={4} /> : null}
      {jobs.isError && jobs.data === undefined ? (
        <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
      ) : null}
      {jobs.data && jobs.data.length === 0 ? (
        <EmptyState
          title={documentId ? '该文档还没有处理记录' : '还没有任务'}
          description={
            documentId
              ? '它可能尚未上传成功，或任务已被清理。重新上传文档后会生成新的处理记录。'
              : '上传文档或同步来源后，任务会出现在这里。'
          }
          action={
            documentId ? (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button variant="outline" size="sm" onClick={onClearDocument}>
                  清除筛选
                </Button>
                {canUpload ? (
                  <Button variant="outline" size="sm" onClick={onGoDocuments}>
                    重新上传文档
                  </Button>
                ) : null}
              </div>
            ) : undefined
          }
        />
      ) : null}
      {jobs.data && jobs.data.length > 0 ? (
        <Table aria-label="知识库任务" className="min-w-5xl">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-32">类型</TableHead>
              <TableHead className="min-w-56">对象</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="min-w-60">步骤</TableHead>
              <TableHead className="w-16 text-right">进度</TableHead>
              <TableHead className="w-32">创建</TableHead>
              <TableHead className="w-32">已运行</TableHead>
              <TableHead className="w-28">
                <span className="sr-only">操作</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.data.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                canExecute={canExecute}
                busy={retry.isPending || cancel.isPending}
                onRetry={() =>
                  retry.mutate(job.id, {
                    onSuccess: () => toastSuccess('已重新提交任务'),
                    onError: toastError,
                  })
                }
                onCancel={() =>
                  cancel.mutate(job.id, {
                    onSuccess: () => toastSuccess('已请求取消'),
                    onError: toastError,
                  })
                }
              />
            ))}
          </TableBody>
        </Table>
      ) : null}
      {jobs.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={jobs.isFetchingNextPage}
          aria-busy={jobs.isFetchingNextPage}
          onClick={() => void jobs.fetchNextPage()}
        >
          {jobs.isFetchingNextPage ? '加载中…' : '加载更多处理记录'}
        </Button>
      ) : null}
      {jobs.isFetchNextPageError ? (
        <ErrorState
          error={jobs.error}
          title="更多处理记录没有加载出来"
          onRetry={() => void jobs.fetchNextPage()}
        />
      ) : null}
    </div>
  );
}

function JobRow({
  job,
  canExecute,
  busy,
  onRetry,
  onCancel,
}: {
  job: KnowledgeJob;
  canExecute: boolean;
  busy: boolean;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const active = job.status === 'queued' || job.status === 'running';
  const runningMs = job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : null;
  const reason = knowledgeJobErrorText(job.error);
  return (
    <TableRow>
      <TableCell className="text-xs">{jobTypeLabel[job.type]}</TableCell>
      <TableCell className="whitespace-normal">
        <span
          className="block break-words text-xs text-fg"
          title={job.documentId ?? job.sourceId ?? undefined}
        >
          {jobTargetLabel(job)}
        </span>
      </TableCell>
      <TableCell>
        <StatusBadge tone={jobStatusTone[job.status]}>{jobStatusLabel[job.status]}</StatusBadge>
      </TableCell>
      <TableCell className="whitespace-normal">
        <span
          className="block break-words text-xs text-muted-foreground"
          title={job.error ?? job.step ?? ''}
        >
          {reason ?? job.step ?? '—'}
        </span>
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums">{job.progress}%</TableCell>
      <TableCell className="text-xs text-muted-foreground" title={formatDateTime(job.createdAt)}>
        {formatRelative(job.createdAt)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {active && runningMs !== null ? `已运行 ${formatDuration(runningMs)}` : '—'}
      </TableCell>
      <TableCell>
        {!canExecute ? null : active ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            取消
          </Button>
        ) : job.status === 'failed' || job.status === 'cancelled' ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRetry}>
            重试
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
