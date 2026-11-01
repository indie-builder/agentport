import {
  type KnowledgeBase,
  type KnowledgeDocument,
  type KnowledgeJob,
  type KnowledgeSourceInput,
  knowledgeAudioMetadataSchema,
} from '@agentport/shared';
import { type Query, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  ArrowLeft,
  BookMarked,
  BookOpen,
  ChevronDown,
  CircleHelp,
  Cloud,
  Code,
  Feather,
  FileText,
  Folder,
  FolderArchive,
  FolderOpen,
  GitFork,
  LibraryBig,
  MessageSquare,
  MoreHorizontal,
  NotebookText,
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
import type { z } from 'zod';
import { BusinessIllustration } from '../components/business-illustration.js';
import { CodeBlock } from '../components/code-block.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { FilterSelect } from '../components/filter-select.js';
import { KnowledgeImage, stripImageReferences } from '../components/knowledge-citations.js';
import {
  BatchActionDialog,
  DocumentVersionPicker,
  ManualDraftDialog,
} from '../components/knowledge-documents.js';
import { KnowledgeEvaluations } from '../components/knowledge-evaluations.js';
import { FaqTab } from '../components/knowledge-faq.js';
import { SearchTab } from '../components/knowledge-search.js';
import { KnowledgeSettingsDialog } from '../components/knowledge-settings.js';
import {
  AUDIO_MAX_BYTES,
  DraftGuardDialogs,
  documentStatusLabel,
  documentStatusTone,
  isAudioMimeType,
  isAudioUpload,
  isMissingJob,
  isTerminalJobStatus,
  jobStatusLabel,
  jobStatusTone,
  jobTypeLabel,
  locatorLabel,
  sourceStatusLabel,
  treeFolders,
  useDraftGuard,
  versionLabel,
} from '../components/knowledge-shared.js';
import { WikiTab } from '../components/knowledge-wiki.js';
import { Markdown } from '../components/markdown.js';
import { Collapsible, CollapsibleContent } from '../components/motion-collapsible.js';
import { Page, PageHeader, PageNote, PageSection, PageToolbar } from '../components/page.js';
import { ReaderToolbar } from '../components/reader-toolbar.js';
import { RequiredMark } from '../components/required-mark.js';
import { SearchInput } from '../components/search-input.js';
import { SourceEditor } from '../components/source-editor.js';
import { EmptyState, ErrorState, InlineEmpty, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button, buttonVariants } from '../components/ui/button.js';
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
  api,
  errorMessage,
  type KnowledgeChunk,
  type KnowledgeFolder,
  type KnowledgeSource,
  type KnowledgeTag,
  type KnowledgeVersionImage,
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
  useCreateKnowledgeChunk,
  useCreateKnowledgeFolder,
  useCreateKnowledgeManualDocument,
  useCreateKnowledgeSource,
  useCreateKnowledgeTag,
  useDeleteKnowledgeChunk,
  useDeleteKnowledgeDocument,
  useDeleteKnowledgeFolder,
  useDeleteKnowledgeSource,
  useDeleteKnowledgeTag,
  useDrainPages,
  useImportKnowledgeUrl,
  useKnowledgeBase,
  useKnowledgeDocument,
  useKnowledgeDocumentChunks,
  useKnowledgeDocuments,
  useKnowledgeDocumentVersions,
  useKnowledgeFolders,
  useKnowledgeJobDetail,
  useKnowledgeJobs,
  useKnowledgeMarkdown,
  useKnowledgeSourceRuns,
  useKnowledgeSources,
  useKnowledgeSyncItems,
  useKnowledgeTags,
  useKnowledgeVersionDetails,
  usePublishKnowledgeDocumentVersion,
  useReprocessKnowledgeDocument,
  useRetryKnowledgeJob,
  useRollbackKnowledgeDocument,
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
import type { knowledgeDetailSearchSchema } from '../routes/-search.js';

const tabs = [
  { id: 'documents', label: '文档' },
  { id: 'sources', label: '来源' },
  { id: 'search', label: '检索测试' },
  { id: 'evaluations', label: '离线评估' },
  { id: 'faqs', label: 'FAQ' },
  { id: 'wiki', label: 'Wiki' },
  { id: 'jobs', label: '处理记录' },
] as const;

type TabId = (typeof tabs)[number]['id'];
type DetailSearch = z.infer<typeof knowledgeDetailSearchSchema>;

/** 按叶权限控制每个主操作、行菜单与子编辑器；展示与否只由这里决定。 */
type KnowledgeCaps = {
  content: boolean;
  sources: boolean;
  execute: boolean;
  publish: boolean;
  update: boolean;
  import: boolean;
  export: boolean;
};

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
  {
    type: 'lark_wiki',
    label: 'Lark 知识库',
    description: '使用 Lark 应用同步知识空间或知识节点',
    icon: BookOpen,
  },
  {
    type: 'lark_drive',
    label: 'Lark 云盘',
    description: '使用 Lark 应用同步云盘目录中的文件',
    icon: Cloud,
  },
  { type: 'notion', label: 'Notion', description: '同步页面、数据库与数据源', icon: NotebookText },
  {
    type: 'confluence',
    label: 'Confluence',
    description: '同步空间或页面及附件',
    icon: BookMarked,
  },
  { type: 'yuque', label: '语雀', description: '同步知识库文档', icon: Feather },
  {
    type: 'dingtalk',
    label: '钉钉',
    description: '同步知识空间或节点文档',
    icon: MessageSquare,
  },
  { type: 'ima', label: 'IMA', description: '同步指定知识库的媒体与笔记', icon: LibraryBig },
  {
    type: 'seafile',
    label: 'Seafile',
    description: '同步 Seafile 11+ 库内目录文件',
    icon: FolderArchive,
  },
  { type: 'nextcloud', label: 'Nextcloud', description: '同步账号目录文件', icon: Cloud },
  { type: 'feed', label: 'RSS', description: '抓取 Feed 最近窗口内的条目', icon: Rss },
];

/** 未知类型显式标注，不回落到某个具体 provider 误导用户。 */
function sourceProvider(type: SourceType): (typeof sourceProviders)[number] {
  return (
    sourceProviders.find((provider) => provider.type === type) ?? {
      type,
      label: '未知来源',
      description: '当前界面不支持这个来源类型',
      icon: CircleHelp,
    }
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
    import: can(me.data, 'knowledge.import'),
    export: can(me.data, 'knowledge.export'),
  };
  const canReadAgents = can(me.data, 'agents.read');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTrigger, setSettingsTrigger] = useState<HTMLElement | null>(null);
  const [expertsOpen, setExpertsOpen] = useState(false);

  const go = (patch: Partial<DetailSearch>, replace = false): void => {
    const next = Object.fromEntries(
      Object.entries({ ...search, ...patch }).filter(([, value]) => value !== undefined),
    ) as DetailSearch;
    void navigate({
      to: '/knowledge/$baseId',
      params: { baseId },
      search: next,
      replace,
    });
  };

  return (
    <Page>
      <PageHeader
        title={base.data?.name ?? '知识库'}
        leading={
          <Link
            to="/knowledge"
            aria-label="返回知识库列表"
            className={buttonVariants({ variant: 'outline', size: 'icon' })}
          >
            <ArrowLeft />
          </Link>
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
                asrEnabled={base.data?.asrProfileId != null}
                folderId={search.folder}
                onFolderChange={(folderId) => go({ folder: folderId }, true)}
                documentId={search.document}
                onDocumentChange={(document) => go({ document }, true)}
                onViewJobs={(documentId) => go({ panel: 'jobs', document: documentId })}
              />
            </TabsContent>
            <TabsContent value="sources">
              <SourcesTab
                baseId={baseId}
                caps={caps}
                sourceId={search.source}
                onSelectSource={(source) => go({ source })}
                onOpenDocument={(document) =>
                  go({ panel: 'documents', source: undefined, folder: undefined, document })
                }
              />
            </TabsContent>
            <TabsContent value="search">
              <SearchTab
                baseId={baseId}
                canExecute={caps.execute}
                state={search}
                onChange={(patch, replace) => go(patch, replace)}
              />
            </TabsContent>
            <TabsContent value="evaluations">
              <KnowledgeEvaluations baseId={baseId} canExecute={caps.execute} />
            </TabsContent>
            <TabsContent value="faqs">
              <FaqTab baseId={baseId} caps={caps} />
            </TabsContent>
            <TabsContent value="wiki">
              <WikiTab
                baseId={baseId}
                caps={caps}
                pageId={search.page}
                onSelect={(page) => go({ page })}
              />
            </TabsContent>
            <TabsContent value="jobs">
              <JobsTab
                baseId={baseId}
                canExecute={caps.execute}
                canUpload={caps.content}
                documentId={search.document}
                onClearDocument={() => go({ document: undefined }, true)}
                onGoDocuments={() => go({ panel: undefined, document: undefined })}
                onOpenDocument={(document) =>
                  go({ panel: 'documents', source: undefined, folder: undefined, document })
                }
                onOpenSource={(source) => go({ panel: 'sources', source, document: undefined })}
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
        const dataBase64 = await readBase64(file);
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

        <p className="text-xs text-muted-foreground">
          音频支持 mp3、wav、m4a、flac、ogg，单个不超过 25 MB。
          {asrEnabled
            ? '上传后会调用已配置的转录模型，可能计费；失败重试可能再次计费。'
            : '先在知识库设置里绑定音频转录模型。'}
        </p>

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
              <TableRow className="hover:bg-transparent">
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

function DocumentViewer({
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
                {versionId && !isCurrent ? (
                  <p className="text-xs text-muted-foreground">
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
                                variant="ghost"
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
  const [initial] = useState(chunk?.content ?? '');
  const [initialHeading] = useState(chunk?.heading ?? '');
  const [content, setContent] = useState(initial);
  const [heading, setHeading] = useState(initialHeading);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const pending = update.isPending || create.isPending;
  const trimmed = content.trim();
  const dirty = content !== initial || heading !== initialHeading;
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
      <DialogShell title={creating ? '新增分块' : '编辑分块'} closeDisabled={pending}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            const patch = {
              content: trimmed,
              heading: heading.trim() === '' ? null : heading.trim(),
            };
            const handlers = {
              onSuccess: () => {
                toastSuccess(creating ? '分块已新增，正在补建向量' : '分块已保存，正在补建向量');
                finish();
              },
              onError: (reason: unknown) => {
                // 保留草稿；服务端拒绝时给出明确的重载入口，不静默丢弃修改。
                setError(errorMessage(reason));
              },
            };
            if (chunk) update.mutate({ chunkId: chunk.id, patch }, handlers);
            else create.mutate(patch, handlers);
          }}
        >
          <Field className="gap-1.5">
            <FieldLabel htmlFor="knowledge-chunk-heading">标题</FieldLabel>
            <Input
              id="knowledge-chunk-heading"
              value={heading}
              disabled={pending}
              onChange={(event) => setHeading(event.target.value)}
            />
          </Field>
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
                    if (creating) create.reset();
                    else update.reset();
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
            if (creating) create.reset();
            else await update.reset();
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

// ---- 来源 -----------------------------------------------------------------

function SourcesTab({
  baseId,
  caps,
  sourceId,
  onSelectSource,
  onOpenDocument,
}: {
  baseId: string;
  caps: KnowledgeCaps;
  sourceId: string | undefined;
  onSelectSource: (sourceId: string | undefined) => void;
  onOpenDocument: (documentId: string) => void;
}) {
  const sources = useKnowledgeSources(baseId);
  useDrainPages(sources);
  const remove = useDeleteKnowledgeSource(baseId);
  const test = useTestKnowledgeSource();
  const sync = useSyncKnowledgeSource(baseId);
  const jobs = useKnowledgeJobs(baseId);
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(sourceId ?? null);
  useEffect(() => setSelected(sourceId ?? null), [sourceId]);
  const selectSource = (id: string | null): void => {
    setSelected(id);
    onSelectSource(id ?? undefined);
  };
  const [deleting, setDeleting] = useState<KnowledgeSource | null>(null);
  const [deleteDocuments, setDeleteDocuments] = useState(false);
  const [editing, setEditing] = useState<KnowledgeSource | null>(null);
  const [syncJobs, setSyncJobs] = useState<Array<{ id: string; sourceId: string }>>([]);
  const [probeJobs, setProbeJobs] = useState<Record<string, string>>({});
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
          illustration={<BusinessIllustration name="knowledge" />}
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
                      onClick={() => selectSource(selected === source.id ? null : source.id)}
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
                          title="提交一次只读远程连接测试，结果写入任务"
                          onClick={() =>
                            test.mutate(source.id, {
                              onSuccess: (result) => {
                                setProbeJobs((previous) => ({
                                  ...previous,
                                  [source.id]: result.jobId,
                                }));
                                toastSuccess('已提交连接测试，结果见下方');
                              },
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
                                selectSource(source.id);
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
                  {probeJobs[source.id] ? (
                    <SourceProbeStatus jobId={probeJobs[source.id] ?? ''} />
                  ) : null}
                  <CollapsibleContent animated>
                    <SourceRuns sourceId={source.id} onOpenDocument={onOpenDocument} />
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
            if (selected === deleting.id) selectSource(null);
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

type AuthMode = 'cloud_basic' | 'cloud_scoped' | 'dc_pat';

const authModeOptions: Array<{ value: AuthMode; label: string }> = [
  { value: 'cloud_basic', label: 'Cloud Basic' },
  { value: 'cloud_scoped', label: 'Cloud Scoped' },
  { value: 'dc_pat', label: 'Data Center PAT' },
];

function isAuthMode(value: unknown): value is AuthMode {
  return value === 'cloud_basic' || value === 'cloud_scoped' || value === 'dc_pat';
}

type CredentialKey =
  | 'token'
  | 'appSecret'
  | 'apiKey'
  | 'apiToken'
  | 'pat'
  | 'clientSecret'
  | 'appPassword';

/** 凭证只写不读：留空提交不发 secrets，避免把已存密钥覆盖成空串。 */
function credentialField(
  type: SourceType,
  authMode: AuthMode,
): { key: CredentialKey; label: string; description?: string } | null {
  switch (type) {
    case 'github':
    case 'gitlab':
      return { key: 'token', label: 'Access Token' };
    case 'feishu_wiki':
    case 'feishu_drive':
    case 'lark_wiki':
    case 'lark_drive':
      return { key: 'appSecret', label: 'App Secret' };
    case 'notion':
      return { key: 'apiKey', label: 'Integration Token' };
    case 'confluence':
      return authMode === 'dc_pat'
        ? { key: 'pat', label: 'Personal Access Token' }
        : { key: 'apiToken', label: 'API Token' };
    case 'yuque':
      return { key: 'apiToken', label: 'Token', description: 'Token 权益以语雀账号为准。' };
    case 'dingtalk':
      return { key: 'clientSecret', label: 'Client Secret' };
    case 'ima':
      return { key: 'apiKey', label: 'API Key' };
    case 'seafile':
      return { key: 'apiToken', label: 'API Token' };
    case 'nextcloud':
      return { key: 'appPassword', label: 'App 密码' };
    default:
      return null;
  }
}

type SourceFieldKey =
  | 'appId'
  | 'baseUrl'
  | 'email'
  | 'cloudId'
  | 'username'
  | 'operatorUnionId'
  | 'clientId';
type SourceFieldState = Record<SourceFieldKey, string>;

const emptySourceFields: SourceFieldState = {
  appId: '',
  baseUrl: '',
  email: '',
  cloudId: '',
  username: '',
  operatorUnionId: '',
  clientId: '',
};

type SourceFieldSpec = {
  key: SourceFieldKey;
  label: string;
  /** 连接身份字段：创建后不可改，编辑时只读，避免旧凭证被带到新站点。 */
  identity?: boolean;
  required?: boolean | ((authMode: AuthMode) => boolean);
  /** 仅在该认证模式显示（Confluence 条件字段）。 */
  visible?: (authMode: AuthMode) => boolean;
  placeholder?: string;
};

/** 新增来源的连接字段集中在这里，按类型渲染，不为每个 provider 复制一套表单。 */
const sourceFieldSpecs: Partial<Record<SourceType, SourceFieldSpec[]>> = {
  lark_wiki: [{ key: 'appId', label: 'App ID', identity: true }],
  lark_drive: [{ key: 'appId', label: 'App ID', identity: true }],
  confluence: [
    {
      key: 'baseUrl',
      label: '站点 URL',
      identity: true,
      placeholder: 'https://example.atlassian.net',
    },
    {
      key: 'email',
      label: 'Email',
      identity: true,
      required: (mode) => mode !== 'dc_pat',
      visible: (mode) => mode !== 'dc_pat',
    },
    {
      key: 'cloudId',
      label: 'Cloud ID',
      identity: true,
      required: (mode) => mode === 'cloud_scoped',
      visible: (mode) => mode === 'cloud_scoped',
    },
  ],
  dingtalk: [
    { key: 'clientId', label: 'Client ID', identity: true },
    { key: 'operatorUnionId', label: '操作者 Union ID', identity: true },
  ],
  ima: [{ key: 'clientId', label: 'Client ID', identity: true }],
  seafile: [
    {
      key: 'baseUrl',
      label: '实例 URL',
      identity: true,
      placeholder: 'https://seafile.example.com',
    },
  ],
  nextcloud: [
    {
      key: 'baseUrl',
      label: '实例 URL',
      identity: true,
      placeholder: 'https://cloud.example.com',
    },
    { key: 'username', label: '用户名', identity: true },
  ],
};

function sourceFieldRequired(spec: SourceFieldSpec, authMode: AuthMode): boolean {
  return typeof spec.required === 'function' ? spec.required(authMode) : (spec.required ?? true);
}

function sourceFieldId(key: SourceFieldKey): string {
  return `source-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** Seafile 只有精确的 / 表示全库；其余输入按库内相对目录保存。 */
function normalizeSeafilePaths(paths: string[]): string[] {
  if (paths.some((path) => path.trim() === '/')) return [];
  return paths.map((path) => path.trim().replace(/^\/+|\/+$/g, ''));
}

function seafilePathInvalid(paths: string[]): boolean {
  return paths.some(
    (path) => /[\\\0]/.test(path) || path.split('/').some((segment) => segment === '..'),
  );
}

/**
 * //、/// 或空串 normalize 后为空；它们不是全库，必须按字段错误拦下，
 * 否则过滤成空数组会被后端当成全库而静默放大同步范围。
 */
function seafilePathIssue(paths: string[]): string | null {
  if (paths.some((path) => path.trim() === '/')) return null;
  if (paths.length === 0 || paths.some((path) => path.trim().replace(/^\/+|\/+$/g, '') === '')) {
    return '每个 Seafile 范围都需要目录根；全库请填 /';
  }
  if (paths.some((path) => seafilePathInvalid([path]))) {
    return 'Seafile 路径不能包含反斜杠或 ..';
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
  return {
    ...range,
    externalId: range.externalId.trim(),
    paths: range.kind === 'seafile_repo' ? normalizeSeafilePaths(range.paths) : range.paths,
  };
}

const rangeKinds: Record<SourceType, RangeKind[]> = {
  github: ['github_repo'],
  feishu_wiki: ['wiki_space', 'wiki_node'],
  feishu_drive: ['drive_folder'],
  lark_wiki: ['wiki_space', 'wiki_node'],
  lark_drive: ['drive_folder'],
  notion: ['notion_page', 'notion_database', 'notion_data_source'],
  confluence: ['confluence_space', 'confluence_page'],
  yuque: ['yuque_repo'],
  dingtalk: ['dingtalk_workspace', 'dingtalk_node'],
  ima: ['ima_kb'],
  seafile: ['seafile_repo'],
  nextcloud: ['nextcloud_path'],
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
  notion_page: '页面',
  notion_database: '数据库',
  notion_data_source: '数据源',
  confluence_space: '空间',
  confluence_page: '页面',
  yuque_repo: '知识库',
  dingtalk_workspace: '知识空间',
  dingtalk_node: '节点',
  ima_kb: '知识库',
  seafile_repo: '知识库',
  nextcloud_path: '目录',
};

function rangeExternalLabel(kind: RangeKind): string {
  return {
    wiki_space: '空间 ID',
    wiki_node: '节点 Token',
    drive_folder: '目录 Token',
    gitlab_project: 'Project ID',
    github_repo: '仓库',
    feed: 'Feed 地址',
    notion_page: '页面 UUID',
    notion_database: '数据库 UUID',
    notion_data_source: '数据源 UUID',
    confluence_space: '空间 ID',
    confluence_page: '页面 ID',
    yuque_repo: '知识库 ID',
    dingtalk_workspace: '知识空间 ID',
    dingtalk_node: '节点 ID',
    ima_kb: '知识库 ID',
    seafile_repo: '库 ID',
    nextcloud_path: '目录路径',
  }[kind];
}

/** 空范围行；clientId 在创建时生成一次，后续 render 不变。 */
function newRangeDraft(kind: RangeKind): RangeDraft {
  return {
    clientId: crypto.randomUUID(),
    kind,
    externalId: '',
    ref: null,
    // Seafile 新行显式以 / 表示全库；清空输入不被当成全库。
    paths: kind === 'seafile_repo' ? ['/'] : [],
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
  if (type === 'yuque' && ranges.some((range) => !/^[1-9]\d*$/.test(range.externalId.trim()))) {
    return '语雀知识库 ID 需为正整数';
  }
  if (type === 'nextcloud' && ranges.some((range) => !range.externalId.trim().startsWith('/'))) {
    return 'Nextcloud 目录路径需以 / 开头';
  }
  if (type === 'seafile') {
    const pathIssue = ranges
      .map((range) => seafilePathIssue(range.paths))
      .find((value) => value !== null);
    if (pathIssue) return pathIssue;
  }
  if (!ranges.some((range) => range.enabled)) return '至少需要一个启用的范围';
  return null;
}

/** 来源弹层的草稿签名：关闭确认只比较真实字段，不依赖输入框注册顺序。 */
function sourceDraftSignature(input: {
  type: SourceType;
  name: string;
  secret: string;
  fields: SourceFieldState;
  authMode: AuthMode;
  cron: string;
  syncDeletions: boolean;
  status: KnowledgeSource['status'];
  ranges: RangeDraft[];
}): string {
  return JSON.stringify(input);
}

/** 列表行的目标摘要：仓库@ref / 来源范围 / Feed，并带上 cron。 */
function sourceTargetSummary(source: KnowledgeSource): string {
  const summary = source.ranges
    .map((range) => {
      const kind = range.kind as RangeKind;
      if (kind === 'github_repo') return `${range.externalId}@${range.ref ?? '默认分支'}`;
      if (kind === 'gitlab_project') {
        return range.ref ? `${range.externalId}@${range.ref}` : range.externalId;
      }
      if (kind === 'seafile_repo') {
        return `${range.externalId}:${range.paths.join(', ') || '/'}`;
      }
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
  /** 提交后按行显示缺外部 ID / Ref / Seafile 目录根；未提交时不制造噪音。 */
  errors: Array<{ externalId: string | null; ref: string | null; paths: string | null }>;
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
                placeholder={
                  range.kind === 'github_repo'
                    ? 'owner/repo'
                    : range.kind === 'nextcloud_path'
                      ? '/培训资料'
                      : undefined
                }
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
            {type === 'seafile' ? (
              <Field className="gap-1.5 sm:col-span-2" data-invalid={errors[index]?.paths !== null}>
                <FieldLabel htmlFor={`source-range-${index}-paths`}>目录根</FieldLabel>
                <Input
                  id={`source-range-${index}-paths`}
                  value={range.paths.join(', ')}
                  disabled={disabled}
                  aria-invalid={errors[index]?.paths !== null}
                  aria-describedby={
                    errors[index]?.paths !== null ? `source-range-${index}-paths-error` : undefined
                  }
                  onChange={(event) =>
                    patch(index, {
                      paths: event.target.value.split(',').map((path) => path.trim()),
                    })
                  }
                  placeholder="/ 表示整个库，或用逗号分隔多个库内相对目录"
                  className="font-mono"
                />
                <FieldDescription>
                  / 表示整个库；子目录按库内相对路径填写，例如 /Documents。
                </FieldDescription>
                <FieldError id={`source-range-${index}-paths-error`}>
                  {errors[index]?.paths}
                </FieldError>
              </Field>
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
  const [fields, setFields] = useState<SourceFieldState>(() => ({
    ...emptySourceFields,
    appId: configString(source, 'appId'),
    baseUrl: configString(source, 'baseUrl'),
    email: configString(source, 'email'),
    cloudId: configString(source, 'cloudId'),
    username: configString(source, 'username'),
    operatorUnionId: configString(source, 'operatorUnionId'),
    clientId: configString(source, 'clientId'),
  }));
  const [authMode, setAuthMode] = useState<AuthMode>(() =>
    isAuthMode(source?.config.authMode) ? source.config.authMode : 'cloud_basic',
  );
  const [cron, setCron] = useState(source?.syncCron ?? '');
  const [syncDeletions, setSyncDeletions] = useState(source?.config.syncDeletions === true);
  // auth_error 不在可写枚举里：保持原值，只有用户主动改状态才提交。
  const [status, setStatus] = useState<KnowledgeSource['status']>(source?.status ?? 'active');
  const [ranges, setRanges] = useState<RangeDraft[]>(() =>
    source
      ? source.ranges.map(({ id, ...range }) => ({
          ...range,
          clientId: id,
          // 后端空 paths 表示全库；草稿显式写 /，清空后才是真正的空。
          paths: range.kind === 'seafile_repo' && range.paths.length === 0 ? ['/'] : range.paths,
        }))
      : [newRangeDraft(rangeKinds.feishu_wiki[0] as RangeKind)],
  );
  const [submitted, setSubmitted] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [baseline, setBaseline] = useState(() =>
    sourceDraftSignature({
      type: source ? source.type : 'feishu_wiki',
      name: source?.name ?? '',
      secret: '',
      fields,
      authMode,
      cron: source?.syncCron ?? '',
      syncDeletions: source?.config.syncDeletions === true,
      status: source?.status ?? 'active',
      ranges,
    }),
  );
  const provider = sourceProvider(type);
  const ProviderIcon = provider.icon;
  const credential = credentialField(type, authMode);
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
      fields,
      authMode,
      cron,
      syncDeletions,
      status,
      ranges,
    }) !== baseline;
  const guard = useDraftGuard(dirty, pending, onClose);
  const specs = (sourceFieldSpecs[type] ?? []).filter(
    (spec) => spec.visible === undefined || spec.visible(authMode),
  );
  const fieldIssues = Object.fromEntries(
    specs.map((spec) => [
      spec.key,
      sourceFieldRequired(spec, authMode) && fields[spec.key].trim() === ''
        ? `请填写 ${spec.label}`
        : null,
    ]),
  ) as Partial<Record<SourceFieldKey, string | null>>;
  const nameIssue = name.trim() === '' ? '请填写来源名称' : null;
  const secretIssue = secretRequired && secret === '' ? `请填写 ${credential.label}` : null;
  const legacyIssues = {
    appId:
      (type === 'feishu_wiki' || type === 'feishu_drive') && fields.appId.trim() === ''
        ? '请填写 App ID'
        : null,
    baseUrl: type === 'gitlab' && fields.baseUrl.trim() === '' ? '请填写实例 URL' : null,
  };
  const rowIssues = ranges.map((range) => ({
    externalId: range.externalId.trim() === '' ? `请填写${rangeExternalLabel(range.kind)}` : null,
    ref: type === 'gitlab' && !range.ref?.trim() ? '请填写 Ref' : null,
    paths: type === 'seafile' ? seafilePathIssue(range.paths) : null,
  }));
  const hasSubmitIssue =
    nameIssue !== null ||
    secretIssue !== null ||
    Object.values(fieldIssues).some(Boolean) ||
    Object.values(legacyIssues).some(Boolean) ||
    rowIssues.some((row) => row.externalId !== null || row.ref !== null || row.paths !== null) ||
    issue !== null;

  // 各类型的范围 kind 与外键含义不同，切换类型时整套重建，不能把旧行带过去；
  // 凭证与连接地址也只属于原类型，必须清空。
  const chooseType = (next: SourceType): void => {
    const nextRanges = [newRangeDraft(rangeKinds[next][0] as RangeKind)];
    setType(next);
    setSecret('');
    setFields({ ...emptySourceFields });
    setAuthMode('cloud_basic');
    setRanges(nextRanges);
    setStep('configure');
    setSubmitted(false);
    // 选类型本身不算草稿；只有真正改过字段才需要离开确认。
    setBaseline(
      sourceDraftSignature({
        type: next,
        name,
        secret: '',
        fields: { ...emptySourceFields },
        authMode: 'cloud_basic',
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
    switch (type) {
      case 'feishu_wiki':
      case 'feishu_drive':
        return {
          appId: fields.appId.trim(),
          ...(fields.baseUrl.trim() ? { baseUrl: fields.baseUrl.trim() } : {}),
          syncDeletions,
        };
      case 'lark_wiki':
      case 'lark_drive':
        return { appId: fields.appId.trim(), syncDeletions };
      case 'github':
        // ref 属于每个 range，多仓库时不能把第一条写进公共 config。
        return {
          ...(fields.baseUrl.trim() ? { baseUrl: fields.baseUrl.trim() } : {}),
          projectId: normalized[0]?.externalId ?? '',
          syncDeletions,
        };
      case 'gitlab':
        return {
          ...(fields.baseUrl.trim() ? { baseUrl: fields.baseUrl.trim() } : {}),
          projectId: normalized[0]?.externalId ?? '',
          ref: ranges.find((range) => range.ref)?.ref?.trim() ?? '',
          syncDeletions,
        };
      case 'notion':
      case 'yuque':
        return { syncDeletions };
      case 'confluence':
        return {
          authMode,
          baseUrl: fields.baseUrl.trim(),
          ...(authMode === 'dc_pat' ? {} : { email: fields.email.trim() }),
          ...(authMode === 'cloud_scoped' ? { cloudId: fields.cloudId.trim() } : {}),
          syncDeletions,
        };
      case 'dingtalk':
        return {
          clientId: fields.clientId.trim(),
          operatorUnionId: fields.operatorUnionId.trim(),
          syncDeletions,
        };
      case 'ima':
        return { clientId: fields.clientId.trim(), syncDeletions };
      case 'seafile':
        return { baseUrl: fields.baseUrl.trim(), syncDeletions };
      case 'nextcloud':
        return { baseUrl: fields.baseUrl.trim(), username: fields.username.trim(), syncDeletions };
      default:
        return {};
    }
  };

  const buildInput = (): KnowledgeSourceInput => {
    const common = { name: name.trim(), syncCron, ranges: normalized };
    const secrets = credential ? { [credential.key]: secret } : {};
    // 服务端 Zod 才是信任边界；这里只按所选 type 组装对应 wire 形状。
    return { ...common, type, config: buildConfig(), secrets } as KnowledgeSourceInput;
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
      <Field className="gap-1.5" data-invalid={submitted && secretIssue !== null}>
        <FieldLabel htmlFor="knowledge-source-secret">
          {credential.label} {secretRequired ? <RequiredMark /> : null}
        </FieldLabel>
        <Input
          id="knowledge-source-secret"
          type="password"
          value={secret}
          autoComplete="off"
          disabled={pending}
          aria-invalid={submitted && secretIssue !== null}
          aria-describedby={submitted && secretIssue ? 'knowledge-source-secret-error' : undefined}
          onChange={(event) => setSecret(event.target.value)}
          placeholder={editing ? (source.hasSecret ? '留空保持原凭证' : '填写凭证') : '填写凭据'}
        />
        <FieldError id="knowledge-source-secret-error">{submitted ? secretIssue : null}</FieldError>
        {type === 'github' ? (
          <FieldDescription>需要 Contents 只读权限；私有仓库还需 Metadata 只读。</FieldDescription>
        ) : credential.description ? (
          <FieldDescription>{credential.description}</FieldDescription>
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
                  onSuccess: (result) => {
                    const revoked = result.disabledDocumentIds?.length ?? 0;
                    toastSuccess(
                      revoked > 0 ? `来源已更新，${revoked} 个文档立即撤权` : '来源已更新',
                    );
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
                    data-invalid={submitted && nameIssue !== null}
                  >
                    <FieldLabel htmlFor="source-name">
                      名称 <RequiredMark />
                    </FieldLabel>
                    <Input
                      id="source-name"
                      value={name}
                      maxLength={120}
                      disabled={pending}
                      aria-invalid={submitted && nameIssue !== null}
                      aria-describedby={submitted && nameIssue ? 'source-name-error' : undefined}
                      onChange={(event) => setName(event.target.value)}
                    />
                    <FieldError id="source-name-error">{submitted ? nameIssue : null}</FieldError>
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
                        data-invalid={submitted && legacyIssues.appId !== null}
                      >
                        <FieldLabel htmlFor="source-app-id">
                          App ID <RequiredMark />
                        </FieldLabel>
                        <Input
                          id="source-app-id"
                          value={fields.appId}
                          disabled={pending}
                          aria-invalid={submitted && legacyIssues.appId !== null}
                          aria-describedby={
                            submitted && legacyIssues.appId ? 'source-app-id-error' : undefined
                          }
                          onChange={(event) =>
                            setFields((previous) => ({ ...previous, appId: event.target.value }))
                          }
                          className="font-mono"
                        />
                        <FieldError id="source-app-id-error">
                          {submitted ? legacyIssues.appId : null}
                        </FieldError>
                      </Field>
                      {secretInput}
                      <Field className="gap-1.5 sm:col-span-2">
                        <FieldLabel htmlFor="source-base-url">Base URL</FieldLabel>
                        <Input
                          id="source-base-url"
                          value={fields.baseUrl}
                          disabled={pending}
                          onChange={(event) =>
                            setFields((previous) => ({ ...previous, baseUrl: event.target.value }))
                          }
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
                          value={fields.baseUrl}
                          disabled={pending}
                          onChange={(event) =>
                            setFields((previous) => ({ ...previous, baseUrl: event.target.value }))
                          }
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
                        data-invalid={submitted && legacyIssues.baseUrl !== null}
                      >
                        <FieldLabel htmlFor="source-gitlab-url">
                          实例 URL <RequiredMark />
                        </FieldLabel>
                        <Input
                          id="source-gitlab-url"
                          value={fields.baseUrl}
                          disabled={pending}
                          aria-invalid={submitted && legacyIssues.baseUrl !== null}
                          aria-describedby={
                            submitted && legacyIssues.baseUrl
                              ? 'source-gitlab-url-error'
                              : undefined
                          }
                          onChange={(event) =>
                            setFields((previous) => ({ ...previous, baseUrl: event.target.value }))
                          }
                          placeholder="https://gitlab.example.com"
                          className="font-mono"
                        />
                        <FieldError id="source-gitlab-url-error">
                          {submitted ? legacyIssues.baseUrl : null}
                        </FieldError>
                      </Field>
                      {secretInput}
                    </>
                  ) : (
                    <>
                      {type === 'confluence' ? (
                        <Field className="gap-1.5 sm:col-span-2">
                          <FieldLabel htmlFor="source-confluence-auth">认证模式</FieldLabel>
                          <Select
                            value={authMode}
                            disabled={pending || editing}
                            onValueChange={(next) => {
                              if (!next || !isAuthMode(next)) return;
                              setAuthMode(next);
                              // 模式切换会换凭证类型，旧值不能带到新模式。
                              setSecret('');
                            }}
                            items={authModeOptions}
                          >
                            <SelectTrigger id="source-confluence-auth" className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {authModeOptions.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                      ) : null}
                      {specs.map((spec) => {
                        const error = fieldIssues[spec.key] ?? null;
                        const id = sourceFieldId(spec.key);
                        return (
                          <Field
                            key={spec.key}
                            className="gap-1.5"
                            data-invalid={submitted && error !== null}
                          >
                            <FieldLabel htmlFor={id}>
                              {spec.label}{' '}
                              {sourceFieldRequired(spec, authMode) ? <RequiredMark /> : null}
                            </FieldLabel>
                            <Input
                              id={id}
                              value={fields[spec.key]}
                              disabled={pending || (editing && spec.identity === true)}
                              aria-invalid={submitted && error !== null}
                              aria-describedby={submitted && error ? `${id}-error` : undefined}
                              onChange={(event) =>
                                setFields((previous) => ({
                                  ...previous,
                                  [spec.key]: event.target.value,
                                }))
                              }
                              placeholder={spec.placeholder}
                              className="font-mono"
                            />
                            <FieldError id={`${id}-error`}>{submitted ? error : null}</FieldError>
                          </Field>
                        );
                      })}
                      {secretInput}
                      {type === 'lark_wiki' || type === 'lark_drive' ? (
                        <FieldDescription className="sm:col-span-2">
                          使用 Lark 应用（open.larksuite.com），与飞书应用不互通。
                        </FieldDescription>
                      ) : type === 'notion' ? (
                        <FieldDescription className="sm:col-span-2">
                          连接需有读取权限，目标页面或数据库已共享给该连接。
                        </FieldDescription>
                      ) : type === 'confluence' ? (
                        <FieldDescription className="sm:col-span-2">
                          Cloud 使用 Email + API Token；Data Center 使用
                          PAT。认证模式与站点在创建后不可修改。
                        </FieldDescription>
                      ) : type === 'yuque' ? (
                        <FieldDescription className="sm:col-span-2">
                          知识库 ID 为语雀的数字 ID，不是 namespace 或 slug。
                        </FieldDescription>
                      ) : type === 'ima' ? (
                        <FieldDescription className="sm:col-span-2">
                          笔记仅作者可读；部分媒体不提供原文下载。
                        </FieldDescription>
                      ) : type === 'seafile' ? (
                        <FieldDescription className="sm:col-span-2">
                          适用于 Seafile 11+，使用 Bearer API Token。
                        </FieldDescription>
                      ) : type === 'nextcloud' ? (
                        <FieldDescription className="sm:col-span-2">
                          使用账号的应用密码，不读取网页登录 Cookie。
                        </FieldDescription>
                      ) : null}
                    </>
                  )}
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
                      ? (rowIssues[index] ?? { externalId: null, ref: null, paths: null })
                      : { externalId: null, ref: null, paths: null },
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
function SourceProbeStatus({ jobId }: { jobId: string }) {
  const job = useKnowledgeJobDetail(jobId);
  if (job.isPending) {
    return <span className="text-2xs text-muted-foreground">连接测试进行中…</span>;
  }
  if (job.isError) {
    return <span className="text-2xs text-danger">连接测试结果没有加载出来。</span>;
  }
  const result = job.data?.result;
  if (!result) {
    return (
      <span className="text-2xs text-muted-foreground">
        连接测试{job.data?.status === 'failed' ? '失败' : '进行中'}
        {job.data?.error ? ` · ${knowledgeJobErrorText(job.data.error)}` : ''}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 rounded-item border border-line px-2 py-1">
      <span className={`text-2xs ${result.ok ? 'text-success' : 'text-danger'}`}>
        连接测试{result.ok ? '通过' : '失败'}
      </span>
      {result.checks.map((check) => (
        <span key={check.rangeId} className="text-2xs text-muted-foreground">
          {check.rangeId} · {check.ok ? '可读' : (check.code ?? '不可读')}
          {check.message ? ` · ${check.message}` : ''}
        </span>
      ))}
    </div>
  );
}

function SyncRunItems({
  sourceId,
  syncRunId,
  onOpenDocument,
}: {
  sourceId: string;
  syncRunId: string;
  onOpenDocument: (documentId: string) => void;
}) {
  const items = useKnowledgeSyncItems(sourceId, syncRunId);
  if (items.isPending) return <span className="text-2xs text-muted-foreground">加载中…</span>;
  if (items.isError && items.data === undefined) {
    return (
      <Button variant="link" size="xs" onClick={() => void items.refetch()}>
        逐项结果没有加载出来，重试
      </Button>
    );
  }
  const itemRows = items.data?.pages.flatMap((page) => page.items) ?? [];
  if (itemRows.length === 0) {
    return <span className="text-2xs text-muted-foreground">没有失败或跳过项</span>;
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {itemRows.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-2 text-2xs">
            <StatusBadge tone={item.status === 'failed' ? 'danger' : 'outline'}>
              {item.status === 'failed' ? '失败' : '跳过'}
            </StatusBadge>
            <span className="font-mono text-muted-foreground">{item.externalId}</span>
            <span className="text-danger">
              {item.code}
              {item.message ? `: ${item.message}` : ''}
            </span>
            {item.documentId ? (
              <Button
                variant="link"
                size="xs"
                onClick={() => onOpenDocument(item.documentId ?? '')}
              >
                打开文档
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {items.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          disabled={items.isFetchingNextPage}
          onClick={() => void items.fetchNextPage()}
        >
          {items.isFetchingNextPage ? '加载中…' : '加载更多逐项结果'}
        </Button>
      ) : null}
      {items.isFetchNextPageError ? (
        <ErrorState error={items.error} onRetry={() => void items.fetchNextPage()} />
      ) : null}
    </div>
  );
}

function SourceRuns({
  sourceId,
  onOpenDocument,
}: {
  sourceId: string;
  onOpenDocument: (documentId: string) => void;
}) {
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
            <li key={run.id} className="flex flex-col gap-1 text-2xs">
              <div className="flex flex-wrap items-center gap-2">
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
              </div>
              {/* 统计没有 skipped 字段，也始终给出逐项入口：仅有跳过项时同样能展开。 */}
              <details className="pl-2">
                <summary className="cursor-pointer text-muted-foreground">
                  逐项结果
                  {run.stats.failed > 0 ? ` · 失败 ${run.stats.failed}` : ''}
                </summary>
                <div className="mt-1">
                  <SyncRunItems
                    sourceId={sourceId}
                    syncRunId={run.id}
                    onOpenDocument={onOpenDocument}
                  />
                </div>
              </details>
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
  onOpenDocument,
  onOpenSource,
}: {
  baseId: string;
  canExecute: boolean;
  canUpload: boolean;
  documentId: string | undefined;
  onClearDocument: () => void;
  onGoDocuments: () => void;
  onOpenDocument: (documentId: string) => void;
  onOpenSource: (sourceId: string) => void;
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
          illustration={<BusinessIllustration name={documentId ? 'search' : 'runs'} />}
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
                onOpenDocument={onOpenDocument}
                onOpenSource={onOpenSource}
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
  onOpenDocument,
  onOpenSource,
}: {
  job: KnowledgeJob;
  canExecute: boolean;
  busy: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onOpenDocument: (documentId: string) => void;
  onOpenSource: (sourceId: string) => void;
}) {
  const active = job.status === 'queued' || job.status === 'running';
  const runningMs = job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : null;
  const reason = knowledgeJobErrorText(job.error);
  const targetTitle = job.documentId ?? job.sourceId ?? undefined;
  const openTarget = (): void => {
    if (job.documentId) onOpenDocument(job.documentId);
    else if (job.sourceId) onOpenSource(job.sourceId);
  };
  return (
    <TableRow>
      <TableCell className="text-xs">{jobTypeLabel[job.type]}</TableCell>
      <TableCell className="whitespace-normal">
        {targetTitle ? (
          <Button
            variant="link"
            size="xs"
            className="h-auto whitespace-normal px-0 text-left break-words"
            title={targetTitle}
            onClick={openTarget}
          >
            {jobTargetLabel(job)}
          </Button>
        ) : (
          <span className="block break-words text-xs text-fg" title={targetTitle}>
            {jobTargetLabel(job)}
          </span>
        )}
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
