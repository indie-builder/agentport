import type { KnowledgeBase } from '@agentport/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  CirclePause,
  CirclePlay,
  Download,
  LibraryBig,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import {
  KnowledgeProfilesDialog,
  KnowledgeSettingsDialog,
} from '../components/knowledge-settings.js';
import { PageNote } from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { ResourcePage } from '../components/resource-page.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card.js';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { Textarea } from '../components/ui/textarea.js';
import { errorMessage } from '../lib/api.js';
import { useFormBlocker } from '../lib/form.js';
import { formatRelative } from '../lib/format.js';
import {
  useAgents,
  useCreateKnowledgeBase,
  useCreateKnowledgeModelProfile,
  useDeleteKnowledgeBase,
  useExportKnowledgeBase,
  useImportKnowledgeBase,
  useKnowledgeBases,
  useKnowledgeModelProfiles,
  useUpdateKnowledgeBase,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

const baseFormSchema = z.object({
  slug: z
    .string()
    .min(1, '不能为空，请填写后再保存')
    .max(64, '最多 64 个字符，请精简后再保存')
    .regex(/^[a-z0-9][a-z0-9-_]*$/, '仅允许小写字母、数字、- 和 _'),
  name: z.string().trim().min(1, '不能为空，请填写后再保存').max(120, '最多 120 个字符'),
  description: z.string().max(500, '最多 500 个字符'),
  embeddingProfileId: z.string().min(1, '请选择 embedding profile'),
  rerankProfileId: z.string(),
  chunkTokens: z.string(),
  chunkOverlap: z.string(),
  wikiAutoUpdate: z.boolean(),
});

type BaseForm = z.infer<typeof baseFormSchema>;

/** 列表只返回 base 本身；文档数在详情页看，不在卡片上为每个库多拉一页文档。 */
function KnowledgeCard({
  base,
  onRename,
  onSettings,
  onToggleStatus,
  onExport,
  onDelete,
}: {
  base: KnowledgeBase;
  onRename: (trigger: HTMLElement) => void;
  onSettings: (trigger: HTMLElement) => void;
  onToggleStatus: (trigger: HTMLElement) => void;
  onExport: (trigger: HTMLElement) => void;
  onDelete: (trigger: HTMLElement) => void;
}) {
  return (
    <li className="min-w-0">
      <Card className="relative h-full transition-shadow hover:ring-foreground/25">
        {/* 覆盖整卡的可点击入口；操作菜单用 z-10 保持在它之上。 */}
        <Link
          to="/knowledge/$baseId"
          params={{ baseId: base.id }}
          aria-label={`查看知识库 ${base.name}`}
          className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        />
        <CardHeader className="grid-cols-[auto_minmax(0,1fr)_auto]!">
          <span className="row-span-2 flex size-10 shrink-0 items-center justify-center self-center rounded-item bg-muted text-muted-foreground">
            <LibraryBig aria-hidden="true" />
          </span>
          <CardTitle className="col-start-2 min-w-0">
            <h2 className="truncate text-base leading-snug font-medium" title={base.name}>
              {base.name}
            </h2>
          </CardTitle>
          <CardAction className="relative z-10 col-start-3 row-span-2 row-start-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label={`操作 ${base.name}`}>
                    <MoreHorizontal />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" sideOffset={4} className="w-40">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={(event) => onRename(event.currentTarget)}>
                    <Pencil /> 重命名
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={(event) => onSettings(event.currentTarget)}>
                    <Settings /> 设置
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={(event) => onToggleStatus(event.currentTarget)}>
                    {base.status === 'active' ? <CirclePause /> : <CirclePlay />}
                    {base.status === 'active' ? '停用' : '启用'}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={(event) => onExport(event.currentTarget)}>
                    <Download /> 导出知识包
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={(event) => onDelete(event.currentTarget)}
                  >
                    <Trash2 /> 删除
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </CardAction>
          <CardDescription className="col-start-2 row-start-2 line-clamp-2 min-h-10">
            {base.description || '—'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 flex-wrap items-center gap-2">
          <StatusBadge tone={base.status === 'active' ? 'success' : 'outline'}>
            {base.status === 'active' ? '启用' : '停用'}
          </StatusBadge>
        </CardContent>
        <CardFooter className="mt-auto justify-between gap-2">
          <span className="truncate font-mono text-2xs text-muted-foreground">{base.slug}</span>
          <span className="text-xs text-muted-foreground">{formatRelative(base.updatedAt)}</span>
        </CardFooter>
      </Card>
    </li>
  );
}

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

export function KnowledgePage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/knowledge/' });
  const query = search.q ?? '';
  const sort = search.sort ?? 'newest';
  const bases = useKnowledgeBases();
  const baseItems = bases.data ?? [];
  // 知识库是小型集合：一次取完剩余分页（每页 50，仅取元数据），
  // 这样「共 N 个」是真实总数，本地搜索也覆盖整库，而不是假装首屏就是全部。
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = bases;
  useEffect(() => {
    // 失败后不自动重试，交给下方显式「重试」，避免请求循环。
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const agents = useAgents();
  const update = useUpdateKnowledgeBase();
  const remove = useDeleteKnowledgeBase();
  const exporter = useExportKnowledgeBase();
  const importer = useImportKnowledgeBase();
  const importInput = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<KnowledgeBase | null>(null);
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
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);

  const boundAgents = deleting
    ? (agents.data?.filter((agent) => agent.serverIds.includes(deleting.serverId)) ?? [])
    : [];

  const download = (base: KnowledgeBase): void => {
    exporter.mutate(base.id, {
      onSuccess: async (blob) => {
        // 导出就是整库 ZIP；扩展名由浏览器按名称落盘。
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${base.slug}.zip`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        toastSuccess(`已导出「${base.name}」`);
      },
      onError: toastError,
    });
  };

  const onImportFile = (file: File): void => {
    setFailedImport(null);
    setImported(null);
    setCreated(null);
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
      // 缺同名 profile 是 409，可恢复：留住文件并提供重试，不要求用户重新选。
      onError: (error) => setFailedImport({ file, message: errorMessage(error) }),
    });
  };

  const visible = baseItems
    .filter((base) => {
      const term = query.trim().toLocaleLowerCase();
      return (
        term === '' ||
        [base.name, base.slug, base.description].some((value) =>
          value.toLocaleLowerCase().includes(term),
        )
      );
    })
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name, 'zh-CN')
        : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

  const setQuery = (next: string): void => {
    void navigate({
      to: '/knowledge',
      search: { ...(search.sort ? { sort: search.sort } : {}), ...(next ? { q: next } : {}) },
      replace: true,
    });
  };

  // 四种状态互斥：首屏加载、首屏失败、真空库、筛选无结果；刷新失败只加提示，不替换已有数据。
  const initialPending = bases.isPending && baseItems.length === 0;
  const initialError = bases.isError && baseItems.length === 0;
  const refreshError = (bases.isError || isFetchNextPageError) && baseItems.length > 0;
  const filteredEmpty = baseItems.length > 0 && visible.length === 0 && query.trim() !== '';

  return (
    <ResourcePage
      section="knowledge"
      query={query}
      onQueryChange={setQuery}
      sort={sort}
      onSortChange={(next) =>
        void navigate({
          to: '/knowledge',
          search: { ...(query ? { q: query } : {}), ...(next === 'newest' ? {} : { sort: next }) },
        })
      }
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
      leadingFilters={
        // 搜索在已加载的库里本地过滤；还有更多时直接显示加载入口，避免被当成全库搜索。
        query.trim() !== '' && hasNextPage ? (
          <span className="text-xs text-muted-foreground">
            仅搜索已加载的 {baseItems.length} 个
          </span>
        ) : null
      }
      actions={
        <>
          <Button variant="outline" onClick={() => setProfilesOpen(true)}>
            <Settings data-icon="inline-start" aria-hidden="true" /> 模型配置
          </Button>
          <Button
            variant="outline"
            disabled={importer.isPending}
            aria-busy={importer.isPending}
            onClick={() => importInput.current?.click()}
          >
            <Upload data-icon="inline-start" aria-hidden="true" />
            {importer.isPending ? '导入中…' : '导入知识包'}
          </Button>
          <input
            ref={importInput}
            type="file"
            accept="application/zip,.zip"
            className="hidden"
            aria-label="选择知识包 ZIP"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // 清空后允许再次选同一个文件；失败时文件仍在用户手里，可修正后重选。
              event.target.value = '';
              if (file) onImportFile(file);
            }}
          />
          <Button ref={createButtonRef} onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" /> 新建知识库
          </Button>
        </>
      }
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
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link to="/knowledge/$baseId" params={{ baseId: imported.baseId }} />}
              >
                打开知识库
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setImported(null)}>
                关闭
              </Button>
            </div>
          }
        />
      ) : null}
      {created ? (
        <PageNote
          title={`已创建「${created.name}」`}
          action={
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link to="/knowledge/$baseId" params={{ baseId: created.id }} />}
              >
                打开知识库
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCreated(null)}>
                关闭
              </Button>
            </div>
          }
        />
      ) : null}
      {initialPending ? <LoadingState rows={4} layout="cards" /> : null}
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
      {!bases.isPending && !bases.isError && baseItems.length === 0 ? (
        <EmptyState
          icon={<LibraryBig className="size-5" />}
          title="还没有知识库"
          action={
            <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" aria-hidden="true" /> 新建知识库
            </Button>
          }
        />
      ) : null}
      {visible.length > 0 ? (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visible.map((base) => (
            <KnowledgeCard
              key={base.id}
              base={base}
              onRename={(trigger) => {
                setActionFocus(trigger);
                setRenaming(base);
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
              onDelete={(trigger) => {
                setActionFocus(trigger);
                setDeleting(base);
              }}
            />
          ))}
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
        <EmptyState
          title="没有匹配的知识库"
          action={
            <Button variant="outline" size="sm" onClick={() => setQuery('')}>
              清除搜索
            </Button>
          }
        />
      ) : null}
      {creating ? (
        <CreateBaseDialog
          finalFocus={() => (createButtonRef.current?.isConnected ? createButtonRef.current : null)}
          onClose={() => setCreating(false)}
          onCreated={(base) => {
            setImported(null);
            setCreated({ id: base.id, name: base.name });
          }}
        />
      ) : null}
      {renaming ? (
        <RenameBaseDialog
          base={renaming}
          finalFocus={() => (actionFocus?.isConnected ? actionFocus : null)}
          onClose={() => setRenaming(null)}
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
          finalFocus={() => (createButtonRef.current?.isConnected ? createButtonRef.current : null)}
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

function RenameBaseDialog({
  base,
  onClose,
  finalFocus,
}: {
  base: KnowledgeBase;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const update = useUpdateKnowledgeBase();
  const [name, setName] = useState(base.name);
  const trimmed = name.trim();
  const pending = update.isPending;
  const dirty = name !== base.name;
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
      <DialogShell title="重命名知识库" closeDisabled={pending} finalFocus={finalFocus}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate(
              { baseId: base.id, patch: { name: trimmed } },
              {
                onSuccess: () => {
                  toastSuccess('已重命名');
                  guard.finish();
                },
                onError: toastError,
              },
            );
          }}
        >
          <FieldGroup>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="knowledge-base-name">
                名称 <RequiredMark />
              </FieldLabel>
              <Input
                id="knowledge-base-name"
                value={name}
                disabled={pending}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button
              type="submit"
              disabled={pending || trimmed === '' || trimmed === base.name}
              aria-busy={pending}
            >
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="重命名草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

function CreateBaseDialog({
  onClose,
  finalFocus,
  onCreated,
}: {
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
  onCreated: (base: { id: string; name: string }) => void;
}) {
  const create = useCreateKnowledgeBase();
  const profiles = useKnowledgeModelProfiles();
  const embedding = (profiles.data ?? []).filter(
    (profile) => profile.kind === 'embedding' && profile.enabled,
  );
  const rerank = (profiles.data ?? []).filter(
    (profile) => profile.kind === 'rerank' && profile.enabled,
  );
  const form = useZodForm(baseFormSchema, {
    defaultValues: {
      slug: '',
      name: '',
      description: '',
      embeddingProfileId: '',
      rerankProfileId: 'none',
      chunkTokens: '800',
      chunkOverlap: '120',
      wikiAutoUpdate: false,
    } satisfies BaseForm,
  });
  const errors = form.formState.errors;
  const [profileDirty, setProfileDirty] = useState(false);
  const [profilePending, setProfilePending] = useState(false);
  const pending = create.isPending || profilePending;
  const dirty = form.formState.isDirty || profileDirty;
  const guard = useDraftGuard(dirty, pending, onClose);
  // 加载失败时不能把「没拿到」当成「没有 profile」。
  const missingProfiles = profiles.isSuccess && embedding.length === 0;

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
    create.mutate(
      {
        slug: values.slug,
        name: values.name,
        description: values.description,
        embeddingProfileId: values.embeddingProfileId,
        rerankProfileId: values.rerankProfileId === 'none' ? null : values.rerankProfileId,
        settings: { chunkTokens, chunkOverlap, wikiAutoUpdate: values.wikiAutoUpdate },
      },
      {
        onSuccess: (base) => {
          toastSuccess(`已创建「${base.name}」`);
          guard.finish();
          onCreated({ id: base.id, name: base.name });
        },
        onError: toastError,
      },
    );
  });

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
      <DialogShell title="新建知识库" closeDisabled={pending} finalFocus={finalFocus}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            return submit();
          }}
          className="flex flex-col gap-4"
          noValidate
        >
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
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
            <Field className="gap-1.5" data-invalid={Boolean(errors.slug)}>
              <FieldLabel htmlFor="knowledge-slug">
                Slug <RequiredMark />
              </FieldLabel>
              <Input
                {...form.register('slug')}
                id="knowledge-slug"
                disabled={pending}
                aria-required="true"
                aria-invalid={Boolean(errors.slug)}
                aria-describedby={errors.slug ? 'knowledge-slug-error' : undefined}
                className="font-mono"
              />
              <FieldError id="knowledge-slug-error">{errors.slug?.message}</FieldError>
            </Field>
          </FieldGroup>
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
            <FieldError id="knowledge-description-error">{errors.description?.message}</FieldError>
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
            <FieldDescription>
              还没有启用的 embedding profile；先创建一个再回填到上方。
            </FieldDescription>
          ) : null}
          {missingProfiles ? (
            <NewEmbeddingProfile
              onCreated={(profile) => {
                // 列表刷新会先卸载子表单，它再也回报不了 pending/dirty，外层在这里结算。
                setProfilePending(false);
                setProfileDirty(false);
                form.setValue('embeddingProfileId', profile.id, { shouldValidate: true });
              }}
              onDirtyChange={setProfileDirty}
              onPendingChange={setProfilePending}
            />
          ) : null}
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field className="gap-1.5" data-invalid={Boolean(errors.embeddingProfileId)}>
              <FieldLabel htmlFor="knowledge-embedding">
                Embedding <RequiredMark />
              </FieldLabel>
              <Select
                value={form.watch('embeddingProfileId')}
                disabled={pending || embedding.length === 0}
                onValueChange={(next) => {
                  if (next !== null)
                    form.setValue('embeddingProfileId', next, {
                      shouldDirty: true,
                      shouldValidate: true,
                    });
                }}
                items={embedding.map((profile) => ({ value: profile.id, label: profile.name }))}
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
            <Field className="gap-1.5">
              <FieldLabel htmlFor="knowledge-rerank">重排</FieldLabel>
              <Select
                value={form.watch('rerankProfileId')}
                disabled={pending}
                onValueChange={(next) => {
                  if (next !== null) form.setValue('rerankProfileId', next, { shouldDirty: true });
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
            <Field className="gap-1.5" data-invalid={Boolean(errors.chunkTokens)}>
              <FieldLabel htmlFor="knowledge-chunk-tokens">分块长度（字符）</FieldLabel>
              <Input
                {...form.register('chunkTokens')}
                id="knowledge-chunk-tokens"
                inputMode="numeric"
                disabled={pending}
                aria-invalid={Boolean(errors.chunkTokens)}
                aria-describedby={errors.chunkTokens ? 'knowledge-chunk-tokens-error' : undefined}
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
                aria-describedby={errors.chunkOverlap ? 'knowledge-chunk-overlap-error' : undefined}
              />
              <FieldError id="knowledge-chunk-overlap-error">
                {errors.chunkOverlap?.message}
              </FieldError>
            </Field>
          </FieldGroup>
          <Field orientation="horizontal" className="items-center gap-2">
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
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending || missingProfiles} aria-busy={pending}>
              {pending ? '创建中…' : '创建'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="新建知识库草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

/** 首次使用没有可用 profile 时，建库表单里直接补一个 embedding profile。 */
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
      // 列表刷新可能先卸载子表单，pending 只能由仍存活的异步延续结算。
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
