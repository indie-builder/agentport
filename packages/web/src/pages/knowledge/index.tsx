import type { KnowledgeBase } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  ChevronRight,
  CirclePause,
  CirclePlay,
  Copy,
  Download,
  EllipsisVertical,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { BusinessIllustration } from '../../components/business-illustration.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { FilterSelect } from '../../components/filter-select.js';
import { BaseInfoDialog } from '../../components/knowledge/knowledge-base-info.js';
import { DuplicateBaseDialog } from '../../components/knowledge/knowledge-duplicate-dialog.js';
import {
  KnowledgeProfilesDialog,
  KnowledgeSettingsDialog,
} from '../../components/knowledge/knowledge-settings.js';
import { DraftGuardDialogs, useDraftGuard } from '../../components/knowledge/knowledge-shared.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/motion-collapsible.js';
import { PageNote } from '../../components/page.js';
import { RecordRows } from '../../components/record-rows.js';
import { RequiredMark } from '../../components/required-mark.js';
import { ResourcePage } from '../../components/resource-page.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { Dialog } from '../../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Textarea } from '../../components/ui/textarea.js';
import { type ListView, ViewToggle } from '../../components/view-toggle.js';
import { can } from '../../lib/access.js';
import { errorMessage } from '../../lib/api.js';
import { downloadBlob } from '../../lib/browser-files.js';
import { cn } from '../../lib/cn.js';
import { guardedOpenChange, useDialogClose } from '../../lib/dialog-guard.js';
import { onFilePick } from '../../lib/file-pick.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import {
  meQuery,
  useAgents,
  useCreateKnowledgeBase,
  useCreateKnowledgeModelProfile,
  useDeleteKnowledgeBase,
  useDrainPages,
  useExportKnowledgeBase,
  useImportKnowledgeBase,
  useKnowledgeBasePins,
  useKnowledgeBases,
  useKnowledgeModelProfileSelections,
  useSetKnowledgeBasePin,
  useUpdateKnowledgeBase,
} from '../../lib/queries.js';
import { matchesQuery } from '../../lib/search.js';
import { slugFromName } from '../../lib/slug.js';
import { compareBySort } from '../../lib/sort.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';

const baseFormSchema = z.object({
  slug: z
    .string()
    .trim()
    .max(64, '最多 64 个字符，请精简后再保存')
    .refine(
      (value) => value === '' || /^[a-z0-9][a-z0-9-_]*$/.test(value),
      '仅允许小写字母、数字、- 和 _',
    ),
  name: z.string().trim().min(1, '不能为空，请填写后再保存').max(120, '最多 120 个字符'),
  description: z.string().max(500, '最多 500 个字符'),
  embeddingProfileId: z.string().min(1, '请选择 embedding profile'),
  rerankProfileId: z.string(),
  asrProfileId: z.string(),
  chunkTokens: z.string(),
  chunkOverlap: z.string(),
  wikiAutoUpdate: z.boolean(),
});

type BaseForm = z.infer<typeof baseFormSchema>;

const statusFilterOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '启用' },
  { value: 'disabled', label: '停用' },
];

function KnowledgeRow({
  base,
  pinned,
  pinPending,
  onTogglePin,
  onEdit,
  onDuplicate,
  onSettings,
  onToggleStatus,
  onExport,
  onDelete,
  canUpdate,
  canCreate,
  canExport,
  canDelete,
  layout = 'row',
}: {
  base: KnowledgeBase;
  pinned: boolean;
  pinPending: boolean;
  canUpdate: boolean;
  canCreate: boolean;
  canExport: boolean;
  canDelete: boolean;
  onTogglePin: () => void;
  onEdit: (trigger: HTMLElement) => void;
  onDuplicate: (trigger: HTMLElement) => void;
  onSettings: (trigger: HTMLElement) => void;
  onToggleStatus: (trigger: HTMLElement) => void;
  onExport: (trigger: HTMLElement) => void;
  onDelete: (trigger: HTMLElement) => void;
  layout?: 'row' | 'card';
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button ref={triggerRef} variant="ghost" size="icon" aria-label={`操作 ${base.name}`}>
            <EllipsisVertical />
          </Button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={4} className="w-40">
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={pinPending} onSelect={onTogglePin}>
            {pinned ? <PinOff /> : <Pin />}
            {pinned ? '取消置顶' : '置顶'}
          </DropdownMenuItem>
          {canUpdate ? (
            <DropdownMenuItem onSelect={() => triggerRef.current && onEdit(triggerRef.current)}>
              <Pencil /> 编辑信息
            </DropdownMenuItem>
          ) : null}
          {canCreate ? (
            <DropdownMenuItem
              onSelect={() => triggerRef.current && onDuplicate(triggerRef.current)}
            >
              <Copy /> 复制知识库
            </DropdownMenuItem>
          ) : null}
          {canUpdate ? (
            <DropdownMenuItem onSelect={() => triggerRef.current && onSettings(triggerRef.current)}>
              <Settings /> 设置
            </DropdownMenuItem>
          ) : null}
          {canUpdate ? (
            <DropdownMenuItem
              onSelect={() => triggerRef.current && onToggleStatus(triggerRef.current)}
            >
              {base.status === 'active' ? <CirclePause /> : <CirclePlay />}
              {base.status === 'active' ? '停用' : '启用'}
            </DropdownMenuItem>
          ) : null}
          {canExport ? (
            <DropdownMenuItem onSelect={() => triggerRef.current && onExport(triggerRef.current)}>
              <Download /> 导出知识包
            </DropdownMenuItem>
          ) : null}
          {canDelete ? (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => triggerRef.current && onDelete(triggerRef.current)}
            >
              <Trash2 /> 删除
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  if (layout === 'card') {
    return (
      <li className="min-w-0">
        <Card size="sm" className="relative h-full">
          <Link
            to="/knowledge/$baseId"
            params={{ baseId: base.id }}
            aria-label={`查看知识库 ${base.name}`}
            className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
          <CardHeader>
            <CardTitle className="min-w-0">
              <span className="flex min-w-0 items-center gap-2">
                {pinned ? (
                  <span className="flex shrink-0 items-center" title="已置顶">
                    <Pin className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  </span>
                ) : null}
                <h2 className="min-w-0 truncate text-sm font-medium text-fg" title={base.name}>
                  {base.name}
                </h2>
              </span>
            </CardTitle>
            <CardAction className="relative z-10 flex items-center gap-1">
              <StatusBadge tone={base.status === 'active' ? 'success' : 'outline'}>
                {base.status === 'active' ? '启用' : '停用'}
              </StatusBadge>
              {menu}
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {base.description ? (
              <p className="line-clamp-2 break-words text-sm text-muted-foreground">
                {base.description}
              </p>
            ) : null}
            <RecordRows
              rows={[
                {
                  label: '更新时间',
                  value: formatRelative(base.updatedAt),
                  title: formatDateTime(base.updatedAt),
                },
              ]}
            />
          </CardContent>
        </Card>
      </li>
    );
  }
  return (
    <li className="relative min-w-0 transition-colors duration-150 ease-out-soft hover:bg-hover">
      <Link
        to="/knowledge/$baseId"
        params={{ baseId: base.id }}
        aria-label={`查看知识库 ${base.name}`}
        className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      />
      <div className="flex min-h-14 items-center gap-4 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            {pinned ? (
              <span className="flex shrink-0 items-center" title="已置顶">
                <Pin className="size-3.5 text-muted-foreground" aria-hidden="true" />
              </span>
            ) : null}
            <h2 className="min-w-0 truncate text-base font-medium text-fg" title={base.name}>
              {base.name}
            </h2>
            <StatusBadge
              className="shrink-0"
              tone={base.status === 'active' ? 'success' : 'outline'}
            >
              {base.status === 'active' ? '启用' : '停用'}
            </StatusBadge>
          </div>
          {base.description ? (
            <p className="truncate text-sm text-muted-foreground">{base.description}</p>
          ) : null}
        </div>
        <span
          className="shrink-0 text-xs tabular-nums text-muted-foreground"
          title={formatDateTime(base.updatedAt)}
        >
          {formatRelative(base.updatedAt)}
        </span>
        <div className="relative z-10 shrink-0">{menu}</div>
      </div>
    </li>
  );
}

export function KnowledgePage() {
  const me = useQuery(meQuery);
  const canCreate = can(me.data, 'knowledge.create');
  const canUpdate = can(me.data, 'knowledge.update');
  const canDelete = can(me.data, 'knowledge.delete');
  const canImport = can(me.data, 'knowledge.import');
  const canExport = can(me.data, 'knowledge.export');
  const canManageModels = can(me.data, 'knowledge.models.manage');
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/knowledge/' });
  const query = search.q ?? '';
  const sort = search.sort ?? 'newest';
  const status = search.status;
  const view: ListView = search.view ?? 'cards';
  const setView = (next: ListView): void => {
    void navigate({
      to: '/knowledge',
      search: { ...search, view: next === 'cards' ? undefined : next },
    });
  };
  const bases = useKnowledgeBases();
  const baseItems = bases.data ?? [];
  const pins = useKnowledgeBasePins();
  const pinnedIds = new Set(pins.data?.baseIds ?? []);
  const setPin = useSetKnowledgeBasePin();
  const { hasNextPage, isFetchNextPageError, fetchNextPage } = bases;
  useDrainPages(bases);
  const agents = useAgents();
  const update = useUpdateKnowledgeBase();
  const remove = useDeleteKnowledgeBase();
  const exporter = useExportKnowledgeBase();
  const importer = useImportKnowledgeBase();
  const importInput = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<KnowledgeBase | null>(null);
  const [duplicating, setDuplicating] = useState<KnowledgeBase | null>(null);
  const [configuring, setConfiguring] = useState<KnowledgeBase | null>(null);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [deleting, setDeleting] = useState<KnowledgeBase | null>(null);
  const [actionFocus, setActionFocus] = useState<HTMLElement | null>(null);
  const [failedImport, setFailedImport] = useState<{ file: File; message: string } | null>(null);
  const [imported, setImported] = useState<{
    baseId: string;
    documents: number;
    wikiPages: number;
  } | null>(null);
  const [createdBaseId, setCreatedBaseId] = useState<string | null>(null);
  const [duplicatedBaseId, setDuplicatedBaseId] = useState<string | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (creating || createdBaseId === null) return;
    setCreatedBaseId(null);
    void navigate({ to: '/knowledge/$baseId', params: { baseId: createdBaseId } });
  }, [creating, createdBaseId, navigate]);

  useEffect(() => {
    if (duplicating || duplicatedBaseId === null) return;
    setDuplicatedBaseId(null);
    void navigate({ to: '/knowledge/$baseId', params: { baseId: duplicatedBaseId } });
  }, [duplicating, duplicatedBaseId, navigate]);

  const boundAgents = deleting
    ? (agents.data?.filter((agent) => (agent.serverIds ?? []).includes(deleting.serverId)) ?? [])
    : [];

  const download = (base: KnowledgeBase): void => {
    exporter.mutate(base.id, {
      onSuccess: async (blob) => {
        downloadBlob(blob, `${base.slug}.zip`);
        toastSuccess(`已导出「${base.name}」`);
      },
      onError: toastError,
    });
  };

  const onImportFile = (file: File): void => {
    setFailedImport(null);
    setImported(null);
    importer.mutate(file, {
      onSuccess: (result) => {
        setImported({
          baseId: result.baseId,
          documents: result.counts.documents,
          wikiPages: result.counts.wikiPages,
        });
        toastSuccess(
          `知识库已导入：${result.counts.documents} 个文档、${result.counts.wikiPages} 个 Wiki 页面`,
        );
      },
      onError: (error) => setFailedImport({ file, message: errorMessage(error) }),
    });
  };

  const compareBases = (a: KnowledgeBase, b: KnowledgeBase): number => compareBySort(a, b, sort);
  const visible = baseItems
    .filter((base) => status === undefined || base.status === status)
    .filter((base) => {
      const term = query.trim().toLocaleLowerCase();
      return term === '' || matchesQuery([base.name, base.slug, base.description], term);
    })
    .sort((a, b) => {
      const pinnedA = pinnedIds.has(a.id);
      if (pinnedA !== pinnedIds.has(b.id)) return pinnedA ? -1 : 1;
      return compareBases(a, b);
    });
  const renderRows = (layout: 'row' | 'card') =>
    visible.map((base) => (
      <KnowledgeRow
        key={base.id}
        base={base}
        layout={layout}
        pinned={pinnedIds.has(base.id)}
        pinPending={setPin.isPending && setPin.variables?.baseId === base.id}
        onTogglePin={() =>
          setPin.mutate(
            { baseId: base.id, pinned: !pinnedIds.has(base.id) },
            { onError: toastError },
          )
        }
        onEdit={(trigger) => {
          setActionFocus(trigger);
          setEditing(base);
        }}
        onDuplicate={(trigger) => {
          setActionFocus(trigger);
          setDuplicating(base);
        }}
        onSettings={(trigger) => {
          setActionFocus(trigger);
          setConfiguring(base);
        }}
        onToggleStatus={(trigger) => {
          setActionFocus(trigger);
          update.mutate(
            {
              baseId: base.id,
              patch: { status: base.status === 'active' ? 'disabled' : 'active' },
            },
            {
              onSuccess: () =>
                toastSuccess(base.status === 'active' ? '知识库已停用' : '知识库已启用'),
              onError: toastError,
            },
          );
        }}
        onExport={(trigger) => {
          setActionFocus(trigger);
          download(base);
        }}
        canUpdate={canUpdate}
        canCreate={canCreate}
        canExport={canExport}
        canDelete={canDelete}
        onDelete={(trigger) => {
          setActionFocus(trigger);
          setDeleting(base);
        }}
      />
    ));

  const setSearch = (
    patch: {
      q?: string | undefined;
      sort?: 'newest' | 'name' | undefined;
      status?: 'active' | 'disabled' | undefined;
    },
    replace = false,
  ): void => {
    const next = { ...search, ...patch };
    void navigate({
      to: '/knowledge',
      search: {
        ...(next.q ? { q: next.q } : {}),
        ...(next.sort === undefined || next.sort === 'newest' ? {} : { sort: next.sort }),
        ...(next.status === undefined ? {} : { status: next.status }),
        ...(search.view === undefined || search.view === 'cards' ? {} : { view: search.view }),
      },
      replace,
    });
  };

  const initialPending = bases.isPending && baseItems.length === 0;
  const initialError = bases.isError && baseItems.length === 0;
  const emptyNoFilter = !bases.isPending && !bases.isError && baseItems.length === 0;
  const refreshError = (bases.isError || isFetchNextPageError) && baseItems.length > 0;
  const filtering = query.trim() !== '' || status !== undefined;
  const filteredEmpty = baseItems.length > 0 && visible.length === 0 && filtering;

  return (
    <ResourcePage
      section="knowledge"
      hideToolbar={emptyNoFilter}
      query={query}
      onQueryChange={(next) => setSearch({ q: next }, true)}
      sort={sort}
      onSortChange={(next) => setSearch({ sort: next })}
      count={visible.length}
      status={
        bases.isPending
          ? 'pending'
          : bases.isError || isFetchNextPageError
            ? 'error'
            : hasNextPage
              ? 'pending'
              : 'success'
      }
      menuFilters={
        <FilterSelect
          value={status ?? 'all'}
          onValueChange={(next) =>
            setSearch({ status: next === 'active' || next === 'disabled' ? next : undefined })
          }
          options={statusFilterOptions}
          label="按启用状态筛选"
          className="w-full"
        />
      }
      activeFilterCount={status === undefined ? 0 : 1}
      leadingFilters={
        query.trim() !== '' && hasNextPage ? (
          <span className="text-xs text-muted-foreground">
            仅搜索已加载的 {baseItems.length} 个
          </span>
        ) : null
      }
      actions={
        <>
          <input
            ref={importInput}
            type="file"
            accept="application/zip,.zip"
            className="hidden"
            aria-label="选择知识包 ZIP"
            onChange={onFilePick((files) => {
              const file = files[0];
              if (file) onImportFile(file);
            })}
          />
          {canCreate && (bases.isPending || bases.isError || baseItems.length > 0) ? (
            <Button ref={createButtonRef} onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" aria-hidden="true" /> 新建知识库
            </Button>
          ) : null}
          {canImport || canManageModels ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button ref={moreTriggerRef} variant="ghost" size="icon" aria-label="更多操作">
                    <EllipsisVertical aria-hidden="true" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" sideOffset={4} className="w-44">
                <DropdownMenuGroup>
                  {canImport ? (
                    <DropdownMenuItem
                      disabled={importer.isPending}
                      aria-busy={importer.isPending}
                      onSelect={() => importInput.current?.click()}
                    >
                      <Upload aria-hidden="true" />
                      {importer.isPending ? '导入中…' : '导入知识包'}
                    </DropdownMenuItem>
                  ) : null}
                  {canManageModels ? (
                    <DropdownMenuItem
                      onSelect={() => {
                        setActionFocus(moreTriggerRef.current);
                        setProfilesOpen(true);
                      }}
                    >
                      <Settings aria-hidden="true" /> 模型配置
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </>
      }
      {...(visible.length > 0
        ? { toolbarActions: <ViewToggle value={view} onChange={setView} /> }
        : {})}
    >
      {failedImport ? (
        <PageNote
          tone="danger"
          title="知识包没有导入"
          description={failedImport.message}
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={importer.isPending}
              aria-busy={importer.isPending}
              onClick={() => onImportFile(failedImport.file)}
            >
              重试
            </Button>
          }
        />
      ) : null}
      {imported ? (
        <PageNote
          title="知识包已导入"
          description={`${imported.documents} 个文档、${imported.wikiPages} 个 Wiki 页面`}
          action={
            <div className="flex gap-2">
              <Link
                to="/knowledge/$baseId"
                params={{ baseId: imported.baseId }}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                打开知识库
              </Link>
              <Button variant="ghost" size="sm" onClick={() => setImported(null)}>
                关闭
              </Button>
            </div>
          }
        />
      ) : null}
      {initialPending ? <LoadingState rows={4} /> : null}
      {initialError ? (
        <ErrorState error={bases.error} onRetry={() => void bases.refetch()} />
      ) : null}
      {refreshError ? (
        <PageNote
          title="列表没有刷新成功"
          description={errorMessage(bases.error ?? new Error('还有更多知识库没有加载出来'))}
          tone="danger"
          action={
            <Button variant="outline" size="sm" onClick={() => void bases.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}
      {emptyNoFilter ? (
        <PageNote
          icon={<BusinessIllustration name="knowledge" size="compact" />}
          title="未创建知识库"
          action={
            canCreate ? (
              <Button ref={createButtonRef} variant="default" onClick={() => setCreating(true)}>
                <Plus data-icon="inline-start" aria-hidden="true" /> 新建知识库
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {visible.length > 0 && view !== 'cards' ? (
        <ul className="divide-y divide-line border-y">{renderRows('row')}</ul>
      ) : null}
      {visible.length > 0 && view === 'cards' ? (
        <ul
          aria-label="知识库列表"
          className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,288px),1fr))] gap-4 pt-2"
        >
          {renderRows('card')}
        </ul>
      ) : null}
      {hasNextPage ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted-foreground">
            还有更多知识库未加载（已加载 {baseItems.length} 个）
          </span>
          {isFetchNextPageError ? (
            <Button variant="outline" size="sm" onClick={() => void fetchNextPage()}>
              重试
            </Button>
          ) : null}
        </div>
      ) : null}
      {filteredEmpty ? (
        <PageNote
          title="没有匹配的知识库"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSearch({ q: undefined, status: undefined })}
            >
              清除筛选
            </Button>
          }
        />
      ) : null}
      {creating ? (
        <CreateBaseDialog
          canManageModels={canManageModels}
          finalFocus={() => (createButtonRef.current?.isConnected ? createButtonRef.current : null)}
          onClose={() => setCreating(false)}
          onCreated={(base) => {
            setImported(null);
            setCreating(false);
            setCreatedBaseId(base.id);
          }}
        />
      ) : null}
      {editing ? (
        <BaseInfoDialog
          base={editing}
          finalFocus={() => (actionFocus?.isConnected ? actionFocus : null)}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {duplicating ? (
        <DuplicateBaseDialog
          base={duplicating}
          finalFocus={() => (actionFocus?.isConnected ? actionFocus : null)}
          onClose={() => setDuplicating(null)}
          onDuplicated={(baseId) => {
            setDuplicating(null);
            setDuplicatedBaseId(baseId);
          }}
        />
      ) : null}
      {configuring ? (
        <KnowledgeSettingsDialog
          base={configuring}
          finalFocus={() => (actionFocus?.isConnected ? actionFocus : null)}
          onClose={() => setConfiguring(null)}
        />
      ) : null}
      {profilesOpen ? (
        <KnowledgeProfilesDialog
          finalFocus={() =>
            actionFocus?.isConnected
              ? actionFocus
              : createButtonRef.current?.isConnected
                ? createButtonRef.current
                : null
          }
          onClose={() => setProfilesOpen(false)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除知识库"
          description={
            boundAgents.length > 0
              ? `将删除「${deleting.name}」的全部文档、Wiki 与索引，并解除与 ${boundAgents
                  .map((agent) => agent.name)
                  .join('、')} 的绑定。此操作不可撤销。`
              : `将删除「${deleting.name}」的全部文档、Wiki 与索引。此操作不可撤销。`
          }
          confirmLabel="删除"
          confirmDisabled={remove.isPending}
          finalFocus={() => (actionFocus?.isConnected ? actionFocus : null)}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toastSuccess('知识库已删除');
          }}
        />
      ) : null}
    </ResourcePage>
  );
}

function CreateBaseDialog({
  canManageModels,
  onClose: onClosed,
  finalFocus,
  onCreated,
}: {
  canManageModels: boolean;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
  onCreated: (base: { id: string; name: string }) => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const create = useCreateKnowledgeBase();
  const profiles = useKnowledgeModelProfileSelections();
  const embedding = (profiles.data ?? []).filter(
    (profile) => profile.kind === 'embedding' && profile.enabled,
  );
  const rerank = (profiles.data ?? []).filter(
    (profile) => profile.kind === 'rerank' && profile.enabled,
  );
  const asr = (profiles.data ?? []).filter((profile) => profile.kind === 'asr' && profile.enabled);
  const form = useZodForm(baseFormSchema, {
    defaultValues: {
      slug: '',
      name: '',
      description: '',
      embeddingProfileId: '',
      rerankProfileId: 'none',
      asrProfileId: 'none',
      chunkTokens: '800',
      chunkOverlap: '120',
      wikiAutoUpdate: false,
    } satisfies BaseForm,
  });
  const errors = form.formState.errors;
  const [profileDirty, setProfileDirty] = useState(false);
  const [profilePending, setProfilePending] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const pending = create.isPending || profilePending;
  const dirty = form.formState.isDirty || profileDirty;
  const guard = useDraftGuard(dirty, pending, onClose);
  const missingProfiles = profiles.isSuccess && embedding.length === 0;
  const onlyEmbedding = embedding.length === 1 ? embedding[0] : undefined;

  useEffect(() => {
    if (!onlyEmbedding || form.getValues('embeddingProfileId') !== '') return;
    form.setValue('embeddingProfileId', onlyEmbedding.id, { shouldValidate: true });
  }, [onlyEmbedding, form]);

  useEffect(() => {
    if (!errors.slug && !errors.embeddingProfileId && !errors.chunkTokens && !errors.chunkOverlap)
      return;
    setAdvancedOpen(true);
  }, [errors.slug, errors.embeddingProfileId, errors.chunkTokens, errors.chunkOverlap]);

  useEffect(() => {
    if (missingProfiles || profiles.isError) setAdvancedOpen(true);
  }, [missingProfiles, profiles.isError]);

  useEffect(() => {
    if (!advancedOpen) return;
    const first = errors.slug
      ? 'knowledge-slug'
      : errors.embeddingProfileId
        ? 'knowledge-embedding'
        : errors.chunkTokens
          ? 'knowledge-chunk-tokens'
          : errors.chunkOverlap
            ? 'knowledge-chunk-overlap'
            : null;
    if (first) document.getElementById(first)?.focus();
  }, [
    advancedOpen,
    errors.slug,
    errors.embeddingProfileId,
    errors.chunkTokens,
    errors.chunkOverlap,
  ]);

  const submit = form.handleSubmit((values) => {
    const chunkTokens = Number(values.chunkTokens);
    const chunkOverlap = Number(values.chunkOverlap);
    if (!Number.isInteger(chunkTokens) || chunkTokens < 200 || chunkTokens > 4000) {
      form.setError('chunkTokens', { message: '需为 200–4000 的整数' });
      return;
    }
    if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap > 1000) {
      form.setError('chunkOverlap', { message: '需为 0–1000 的整数' });
      return;
    }
    const generatedSlug = slugFromName(values.name);
    const slug = values.slug || generatedSlug || `kb-${crypto.randomUUID().slice(0, 8)}`;
    create.mutate(
      {
        slug,
        name: values.name,
        description: values.description,
        embeddingProfileId: values.embeddingProfileId,
        rerankProfileId: values.rerankProfileId === 'none' ? null : values.rerankProfileId,
        asrProfileId: values.asrProfileId === 'none' ? null : values.asrProfileId,
        settings: { chunkTokens, chunkOverlap, wikiAutoUpdate: values.wikiAutoUpdate },
      },
      {
        onSuccess: (base) => {
          toastSuccess(`已创建「${base.name}」`);
          guard.finish();
          dialog.finish(() => onCreated({ id: base.id, name: base.name }));
        },
        onError: toastError,
      },
    );
  });

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell
        title="新建知识库"
        closeDisabled={pending}
        finalFocus={finalFocus}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button
              type="submit"
              form="knowledge-create-form"
              disabled={pending || missingProfiles}
              aria-busy={pending}
            >
              {pending ? '创建中…' : '创建'}
            </Button>
          </div>
        }
      >
        <form
          id="knowledge-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            return submit();
          }}
          className="flex flex-col gap-4"
          noValidate
        >
          <FieldGroup className="gap-3">
            <Field className="gap-1.5" data-invalid={Boolean(errors.name)}>
              <FieldLabel htmlFor="knowledge-name">
                名称 <RequiredMark />
              </FieldLabel>
              <Input
                {...form.register('name')}
                id="knowledge-name"
                disabled={pending}
                aria-required="true"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'knowledge-name-error' : undefined}
              />
              <FieldError id="knowledge-name-error">{errors.name?.message}</FieldError>
            </Field>
            <Field className="gap-1.5" data-invalid={Boolean(errors.description)}>
              <FieldLabel htmlFor="knowledge-description">描述</FieldLabel>
              <Textarea
                {...form.register('description')}
                id="knowledge-description"
                disabled={pending}
                rows={2}
                aria-invalid={Boolean(errors.description)}
                aria-describedby={errors.description ? 'knowledge-description-error' : undefined}
              />
              <FieldError id="knowledge-description-error">
                {errors.description?.message}
              </FieldError>
            </Field>
          </FieldGroup>
          <Collapsible
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            className="rounded-item border border-line"
          >
            <CollapsibleTrigger
              type="button"
              className="flex w-full cursor-pointer items-center gap-1.5 rounded-item px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight
                className={cn(
                  'size-3.5 shrink-0 transition-transform duration-150 ease-out-soft',
                  advancedOpen && 'rotate-90',
                )}
                aria-hidden="true"
              />
              高级设置
            </CollapsibleTrigger>
            <CollapsibleContent keepMounted animated>
              <div className="flex flex-col gap-3 border-t border-line p-3">
                <Field className="gap-1.5" data-invalid={Boolean(errors.slug)}>
                  <FieldLabel htmlFor="knowledge-slug">Slug</FieldLabel>
                  <Input
                    {...form.register('slug')}
                    id="knowledge-slug"
                    disabled={pending}
                    aria-invalid={Boolean(errors.slug)}
                    aria-describedby={
                      errors.slug
                        ? 'knowledge-slug-hint knowledge-slug-error'
                        : 'knowledge-slug-hint'
                    }
                    className="font-mono"
                  />
                  <FieldDescription id="knowledge-slug-hint">留空时按名称生成</FieldDescription>
                  <FieldError id="knowledge-slug-error">{errors.slug?.message}</FieldError>
                </Field>
                {profiles.isError ? (
                  <div className="flex items-center gap-2">
                    <FieldError>模型 profile 没有加载出来</FieldError>
                    <Button variant="link" size="xs" onClick={() => void profiles.refetch()}>
                      重试
                    </Button>
                  </div>
                ) : null}
                {missingProfiles ? (
                  canManageModels ? (
                    <FieldDescription>
                      当前无启用的 embedding profile；先创建一个再回填到上方。
                    </FieldDescription>
                  ) : (
                    <FieldDescription>
                      当前无可用的 embedding
                      模型。创建知识库前，需要由有「管理模型端点」权限的成员先添加一个。
                    </FieldDescription>
                  )
                ) : null}
                {missingProfiles && canManageModels ? (
                  <NewEmbeddingProfile
                    onCreated={(profile) => {
                      setProfilePending(false);
                      setProfileDirty(false);
                      form.setValue('embeddingProfileId', profile.id, { shouldValidate: true });
                    }}
                    onDirtyChange={setProfileDirty}
                    onPendingChange={setProfilePending}
                  />
                ) : null}
                {embedding.length > 1 ? (
                  <Field className="gap-1.5" data-invalid={Boolean(errors.embeddingProfileId)}>
                    <FieldLabel htmlFor="knowledge-embedding">
                      Embedding <RequiredMark />
                    </FieldLabel>
                    <Select
                      value={form.watch('embeddingProfileId')}
                      disabled={pending}
                      onValueChange={(next) => {
                        if (next !== null)
                          form.setValue('embeddingProfileId', next, {
                            shouldDirty: true,
                            shouldValidate: true,
                          });
                      }}
                      items={embedding.map((profile) => ({
                        value: profile.id,
                        label: profile.name,
                      }))}
                    >
                      <SelectTrigger
                        id="knowledge-embedding"
                        className="w-full"
                        aria-invalid={Boolean(errors.embeddingProfileId)}
                        aria-describedby={
                          errors.embeddingProfileId ? 'knowledge-embedding-error' : undefined
                        }
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {embedding.map((profile) => (
                            <SelectItem key={profile.id} value={profile.id}>
                              {profile.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldError id="knowledge-embedding-error">
                      {errors.embeddingProfileId?.message}
                    </FieldError>
                  </Field>
                ) : onlyEmbedding ? (
                  <Field className="gap-1.5">
                    <span className="text-sm font-medium">Embedding</span>
                    <div className="flex h-8 items-center rounded-lg border border-line bg-muted px-2.5 text-sm text-muted-foreground">
                      {onlyEmbedding.name}
                    </div>
                  </Field>
                ) : null}
                <FieldGroup className="grid gap-3 sm:grid-cols-2">
                  <Field className="gap-1.5">
                    <FieldLabel htmlFor="knowledge-rerank">重排</FieldLabel>
                    <Select
                      value={form.watch('rerankProfileId')}
                      disabled={pending}
                      onValueChange={(next) => {
                        if (next !== null)
                          form.setValue('rerankProfileId', next, { shouldDirty: true });
                      }}
                      items={[
                        { value: 'none', label: '不启用' },
                        ...rerank.map((profile) => ({ value: profile.id, label: profile.name })),
                      ]}
                    >
                      <SelectTrigger id="knowledge-rerank" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="none">不启用</SelectItem>
                          {rerank.map((profile) => (
                            <SelectItem key={profile.id} value={profile.id}>
                              {profile.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field className="gap-1.5">
                    <FieldLabel htmlFor="knowledge-asr">音频转录</FieldLabel>
                    <Select
                      value={form.watch('asrProfileId')}
                      disabled={pending}
                      onValueChange={(next) => {
                        if (next !== null)
                          form.setValue('asrProfileId', next, { shouldDirty: true });
                      }}
                      items={[
                        { value: 'none', label: '不启用' },
                        ...asr.map((profile) => ({ value: profile.id, label: profile.name })),
                      ]}
                    >
                      <SelectTrigger id="knowledge-asr" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="none">不启用</SelectItem>
                          {asr.map((profile) => (
                            <SelectItem key={profile.id} value={profile.id}>
                              {profile.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field className="gap-1.5" data-invalid={Boolean(errors.chunkTokens)}>
                    <FieldLabel htmlFor="knowledge-chunk-tokens">分块长度（字符）</FieldLabel>
                    <Input
                      {...form.register('chunkTokens')}
                      id="knowledge-chunk-tokens"
                      inputMode="numeric"
                      disabled={pending}
                      aria-invalid={Boolean(errors.chunkTokens)}
                      aria-describedby={
                        errors.chunkTokens ? 'knowledge-chunk-tokens-error' : undefined
                      }
                    />
                    <FieldError id="knowledge-chunk-tokens-error">
                      {errors.chunkTokens?.message}
                    </FieldError>
                  </Field>
                  <Field className="gap-1.5" data-invalid={Boolean(errors.chunkOverlap)}>
                    <FieldLabel htmlFor="knowledge-chunk-overlap">分块重叠（字符）</FieldLabel>
                    <Input
                      {...form.register('chunkOverlap')}
                      id="knowledge-chunk-overlap"
                      inputMode="numeric"
                      disabled={pending}
                      aria-invalid={Boolean(errors.chunkOverlap)}
                      aria-describedby={
                        errors.chunkOverlap ? 'knowledge-chunk-overlap-error' : undefined
                      }
                    />
                    <FieldError id="knowledge-chunk-overlap-error">
                      {errors.chunkOverlap?.message}
                    </FieldError>
                  </Field>
                  <Field orientation="horizontal" className="items-center gap-2 sm:col-span-2">
                    <Checkbox
                      id="knowledge-wiki-auto"
                      checked={form.watch('wikiAutoUpdate')}
                      disabled={pending}
                      onCheckedChange={(checked) =>
                        form.setValue('wikiAutoUpdate', checked, { shouldDirty: true })
                      }
                    />
                    <FieldLabel htmlFor="knowledge-wiki-auto">文档更新后自动刷新 Wiki</FieldLabel>
                  </Field>
                </FieldGroup>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </form>
        <DraftGuardDialogs guard={guard} draft="新建知识库草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

function NewEmbeddingProfile({
  onCreated,
  onDirtyChange,
  onPendingChange,
}: {
  onCreated: (profile: { id: string }) => void;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const create = useCreateKnowledgeModelProfile();
  const [name, setName] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const pending = create.isPending;
  const invalid = [name, endpointUrl, model].some((value) => value.trim() === '');
  const dirty = [name, endpointUrl, model, apiKey].some((value) => value.trim() !== '');
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onPendingChange(pending), [pending, onPendingChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const save = async (): Promise<void> => {
    try {
      const profile = await create.mutateAsync({
        kind: 'embedding',
        name: name.trim(),
        endpointUrl: endpointUrl.trim(),
        model: model.trim(),
        ...(apiKey === '' ? {} : { apiKey }),
      });
      toastSuccess('Embedding profile 已创建');
      onCreated(profile);
    } catch (error) {
      toastError(error);
    } finally {
      onPendingChange(false);
    }
  };

  return (
    <FieldGroup className="grid gap-3 rounded-item border border-line p-3 sm:grid-cols-2">
      <Field className="gap-1.5">
        <FieldLabel htmlFor="profile-name">Embedding 名称</FieldLabel>
        <Input
          id="profile-name"
          value={name}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field className="gap-1.5">
        <FieldLabel htmlFor="profile-endpoint">Endpoint URL</FieldLabel>
        <Input
          id="profile-endpoint"
          value={endpointUrl}
          disabled={pending}
          onChange={(event) => setEndpointUrl(event.target.value)}
          placeholder="https://…"
        />
      </Field>
      <Field className="gap-1.5">
        <FieldLabel htmlFor="profile-model">模型</FieldLabel>
        <Input
          id="profile-model"
          value={model}
          disabled={pending}
          onChange={(event) => setModel(event.target.value)}
          className="font-mono"
        />
      </Field>
      <Field className="gap-1.5">
        <FieldLabel htmlFor="profile-api-key">API Key</FieldLabel>
        <Input
          id="profile-api-key"
          type="password"
          value={apiKey}
          disabled={pending}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </Field>
      <div className="flex justify-end sm:col-span-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending || invalid}
          aria-busy={pending}
          onClick={() => void save()}
        >
          {pending ? '创建中…' : '创建 embedding profile'}
        </Button>
      </div>
    </FieldGroup>
  );
}
