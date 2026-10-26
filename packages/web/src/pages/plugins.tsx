import {
  nativePluginInstallInputSchema,
  type PluginWithAgentCount,
  pluginInputSchema,
  slugSchema,
} from '@agentport/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Download,
  MoreHorizontal,
  PackagePlus,
  Pencil,
  Puzzle,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { PageNote } from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { ResourcePage } from '../components/resource-page.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
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
import { Dialog } from '../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import {
  useDeletePlugin,
  useImportNativePlugin,
  useImportPlugin,
  useInstallNativePlugin,
  useNativePlugins,
  usePlugins,
  useUpdatePlugin,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

const maxPluginBytes = 4_194_304;

const pluginFormSchema = pluginInputSchema.pick({ slug: true, name: true, description: true });

const installFormSchema = nativePluginInstallInputSchema.extend({
  // 表单里空字符串代表「不指定」，提交前再省略。
  slug: slugSchema.or(z.literal('')),
});

export function PluginsPage() {
  const plugins = usePlugins();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/plugins/' });
  const query = search.q ?? '';
  const sort = search.sort ?? 'newest';
  const [editing, setEditing] = useState<PluginWithAgentCount | null>(null);
  const [deleting, setDeleting] = useState<PluginWithAgentCount | null>(null);
  const [installing, setInstalling] = useState(false);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const importPlugin = useImportPlugin();
  const actionTriggerRef = useRef<HTMLElement | null>(null);
  const panelFocus = (): HTMLElement | null =>
    actionTriggerRef.current?.isConnected ? actionTriggerRef.current : importButtonRef.current;

  const visiblePlugins = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return (plugins.data ?? [])
      .filter((plugin) =>
        [plugin.name, plugin.slug, plugin.runtimeName, plugin.description].some((value) =>
          value.toLocaleLowerCase().includes(term),
        ),
      )
      .sort((a, b) =>
        sort === 'name'
          ? a.name.localeCompare(b.name, 'zh-CN')
          : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
  }, [plugins.data, query, sort]);

  const importZip = async (file: File): Promise<void> => {
    if (file.size > maxPluginBytes) {
      toastError(new Error('插件包不能超过 4 MB，请精简后重试。'));
      return;
    }
    // slug 取压缩包文件名，与官方插件目录命名一致。
    const slug = file.name
      .replace(/\.zip$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
    if (slug.length === 0) {
      toastError(new Error('无法从文件名得到插件标识，请把 ZIP 重命名为合法的插件名。'));
      return;
    }
    try {
      const result = await importPlugin.mutateAsync({ file, slug });
      toastSuccess(`已导入「${result.plugin.name}」`);
      for (const warning of result.warnings) toast.warning(warning);
    } catch (error) {
      toastError(error);
    }
  };

  return (
    <ResourcePage
      section="plugins"
      query={query}
      onQueryChange={(next) =>
        void navigate({
          to: '/plugins',
          search: (previous) => ({ ...previous, q: next || undefined }),
          replace: true,
        })
      }
      sort={sort}
      onSortChange={(next) =>
        void navigate({
          to: '/plugins',
          search: { ...search, sort: next === 'newest' ? undefined : next },
        })
      }
      count={visiblePlugins.length}
      status={plugins.status}
      actions={
        <>
          <input
            ref={importInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importZip(file);
            }}
          />
          <Button
            ref={importButtonRef}
            variant="outline"
            disabled={importPlugin.isPending}
            aria-busy={importPlugin.isPending}
            onClick={() => importInputRef.current?.click()}
          >
            <Upload data-icon="inline-start" aria-hidden="true" />{' '}
            {importPlugin.isPending ? '导入中…' : '导入插件 ZIP'}
          </Button>
          <Button
            aria-haspopup="dialog"
            onClick={(event) => {
              actionTriggerRef.current = event.currentTarget;
              setInstalling(true);
            }}
          >
            <PackagePlus data-icon="inline-start" aria-hidden="true" /> 安装插件
          </Button>
        </>
      }
    >
      {plugins.isPending ? <LoadingState rows={4} layout="cards" /> : null}
      {plugins.isError ? (
        <ErrorState error={plugins.error} onRetry={() => void plugins.refetch()} />
      ) : null}
      {plugins.data && plugins.data.length > 0 && visiblePlugins.length === 0 ? (
        <PageNote
          icon={<Puzzle aria-hidden="true" />}
          title="没有匹配的插件"
          description="试试其他关键词。"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigate({
                  to: '/plugins',
                  search: (previous) => ({ ...previous, q: undefined }),
                })
              }
            >
              清除筛选
            </Button>
          }
        />
      ) : null}
      {plugins.data && plugins.data.length === 0 ? (
        <PageNote
          icon={<Puzzle aria-hidden="true" />}
          title="还没有插件"
          description="导入一个符合 Claude Code 官方目录结构的插件 ZIP。"
          action={
            <Button variant="outline" size="sm" onClick={() => importInputRef.current?.click()}>
              导入插件 ZIP
            </Button>
          }
        />
      ) : null}

      {visiblePlugins.length > 0 ? (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visiblePlugins.map((plugin) => (
            <li key={plugin.id} className="min-w-0">
              <Card className="h-full">
                <CardHeader className="grid-cols-[auto_minmax(0,1fr)_auto]!">
                  <span className="row-span-2 flex size-10 shrink-0 items-center justify-center self-center rounded-item bg-muted text-muted-foreground">
                    <Puzzle aria-hidden="true" />
                  </span>
                  <CardTitle className="col-start-2 min-w-0">
                    <h2 className="min-w-0">
                      <Button
                        variant="ghost"
                        nativeButton={false}
                        render={<Link to="/plugins/$pluginId" params={{ pluginId: plugin.id }} />}
                        className="h-auto w-full min-w-0 justify-start p-0 text-base leading-snug font-medium"
                      >
                        <span className="truncate" title={plugin.name}>
                          {plugin.name}
                        </span>
                      </Button>
                    </h2>
                  </CardTitle>
                  <CardAction className="col-start-3">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`操作 ${plugin.name}`}
                            onClick={(event) => {
                              actionTriggerRef.current = event.currentTarget;
                            }}
                          >
                            <MoreHorizontal />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end" sideOffset={4} className="w-44">
                        <DropdownMenuGroup>
                          <DropdownMenuItem onClick={() => setEditing(plugin)}>
                            <Pencil /> 编辑
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            nativeButton={false}
                            render={<a href={`/api/plugins/${plugin.id}/export`} />}
                          >
                            <Download /> 导出 ZIP
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setDeleting(plugin)}
                          >
                            <Trash2 /> 删除
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </CardAction>
                  <CardDescription className="col-start-2 row-start-2 line-clamp-2 min-h-10">
                    {plugin.description || '暂无描述'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-3">
                  <Badge variant="secondary" className="max-w-full font-mono">
                    <span className="truncate">{plugin.runtimeName}</span>
                  </Badge>
                  {plugin.sourceId ? (
                    <Badge variant="outline" className="max-w-full font-mono">
                      <span className="truncate" title={plugin.sourceId}>
                        来自 {plugin.sourceId.slice(plugin.sourceId.indexOf('@') + 1)}
                      </span>
                    </Badge>
                  ) : null}
                  <div className="flex flex-wrap gap-1.5">
                    {plugin.capabilities.skills.length > 0 ? (
                      <Badge variant="outline">{plugin.capabilities.skills.length} 个技能</Badge>
                    ) : null}
                    {plugin.capabilities.agents.length > 0 ? (
                      <Badge variant="outline">
                        {plugin.capabilities.agents.length} 个子智能体
                      </Badge>
                    ) : null}
                    {plugin.capabilities.mcpServers.length > 0 ? (
                      <Badge variant="outline">
                        {plugin.capabilities.mcpServers.length} 个 MCP
                      </Badge>
                    ) : null}
                    {plugin.capabilities.hasHooks ? (
                      <Badge variant="outline">含 hooks</Badge>
                    ) : null}
                  </div>
                </CardContent>
                <CardFooter className="mt-auto justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    被 {plugin.agentCount} 个专家使用
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      nativeButton={false}
                      render={<Link to="/plugins/$pluginId" params={{ pluginId: plugin.id }} />}
                    >
                      查看详情
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`编辑 ${plugin.name}`}
                      aria-haspopup="dialog"
                      onClick={(event) => {
                        actionTriggerRef.current = event.currentTarget;
                        setEditing(plugin);
                      }}
                    >
                      编辑
                    </Button>
                  </div>
                </CardFooter>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}

      {editing ? (
        <PluginDialog plugin={editing} finalFocus={panelFocus} onClose={() => setEditing(null)} />
      ) : null}
      {installing ? (
        <InstallPluginDialog finalFocus={panelFocus} onClose={() => setInstalling(false)} />
      ) : null}
      {deleting ? (
        <DeletePluginDialog
          plugin={deleting}
          finalFocus={panelFocus}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </ResourcePage>
  );
}

function InstallPluginDialog({
  onClose,
  finalFocus,
}: {
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const install = useInstallNativePlugin();
  const importNative = useImportNativePlugin();
  const [tab, setTab] = useState<'market' | 'installed'>('market');
  const native = useNativePlugins(tab === 'installed');
  const pending = install.isPending || importNative.isPending;
  const form = useZodForm(installFormSchema, {
    defaultValues: { marketplace: '', plugin: '', slug: '' },
  });
  const errors = form.formState.errors;

  const submit = form.handleSubmit((values) => {
    if (pending) return;
    install.mutate(
      {
        marketplace: values.marketplace,
        plugin: values.plugin,
        ...(values.slug === '' ? {} : { slug: values.slug }),
      },
      {
        onSuccess: ({ warnings, reused }) => {
          toastSuccess(reused ? '已在插件库' : '已安装');
          for (const warning of warnings) toast.warning(warning);
        },
        onError: toastError,
      },
    );
  });

  // 已下载但还没入库的插件只需纳入，不重新走市场安装。
  const addToLibrary = (pluginId: string): void => {
    if (pending) return;
    importNative.mutate(
      { pluginId },
      {
        onSuccess: ({ warnings, reused }) => {
          toastSuccess(reused ? '已在插件库' : '已加入插件库');
          for (const warning of warnings) toast.warning(warning);
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
        if (!next) onClose();
      }}
    >
      <DialogShell title="安装插件" closeDisabled={pending} finalFocus={finalFocus}>
        <Tabs value={tab} onValueChange={(next) => setTab(next as 'market' | 'installed')}>
          <TabsList aria-label="安装方式">
            <TabsTrigger value="market" disabled={pending}>
              从市场安装
            </TabsTrigger>
            <TabsTrigger value="installed" disabled={pending}>
              已安装
            </TabsTrigger>
          </TabsList>
          <TabsContent value="market">
            <form
              noValidate
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <FieldGroup>
                <Field data-invalid={errors.marketplace ? true : undefined} data-disabled={pending}>
                  <FieldLabel htmlFor="plugin-marketplace">
                    市场来源 <RequiredMark />
                  </FieldLabel>
                  <Input
                    id="plugin-marketplace"
                    {...form.register('marketplace')}
                    disabled={pending}
                    required
                    aria-required="true"
                    aria-invalid={errors.marketplace ? true : undefined}
                    aria-describedby={errors.marketplace ? 'plugin-marketplace-error' : undefined}
                    placeholder="owner/repo 或 https://…"
                  />
                  <FieldError id="plugin-marketplace-error">
                    {errors.marketplace?.message}
                  </FieldError>
                </Field>
                <Field data-invalid={errors.plugin ? true : undefined} data-disabled={pending}>
                  <FieldLabel htmlFor="plugin-name-input">
                    插件名 <RequiredMark />
                  </FieldLabel>
                  <Input
                    id="plugin-name-input"
                    {...form.register('plugin')}
                    disabled={pending}
                    required
                    aria-required="true"
                    aria-invalid={errors.plugin ? true : undefined}
                    aria-describedby={errors.plugin ? 'plugin-name-input-error' : undefined}
                    placeholder="plugin-name"
                  />
                  <FieldError id="plugin-name-input-error">{errors.plugin?.message}</FieldError>
                </Field>
                <Field data-invalid={errors.slug ? true : undefined} data-disabled={pending}>
                  <FieldLabel htmlFor="plugin-slug-input">标识</FieldLabel>
                  <Input
                    id="plugin-slug-input"
                    {...form.register('slug')}
                    disabled={pending}
                    aria-invalid={errors.slug ? true : undefined}
                    aria-describedby={errors.slug ? 'plugin-slug-input-error' : undefined}
                    placeholder="可选，默认用插件清单里的名字"
                  />
                  <FieldError id="plugin-slug-input-error">{errors.slug?.message}</FieldError>
                </Field>
              </FieldGroup>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
                  取消
                </Button>
                <Button
                  type="submit"
                  disabled={pending}
                  aria-busy={pending}
                  className="transition-[color,background-color,border-color,opacity] duration-150 ease-out-soft"
                >
                  {pending ? '安装中…' : '安装'}
                </Button>
              </div>
            </form>
          </TabsContent>
          <TabsContent value="installed">
            <div className="flex flex-col gap-3">
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void native.refetch()}
                  disabled={native.isFetching || pending}
                >
                  <RefreshCw
                    data-icon="inline-start"
                    className={native.isFetching ? 'animate-spin' : undefined}
                    aria-hidden="true"
                  />
                  {native.isFetching ? '刷新中…' : '刷新'}
                </Button>
              </div>
              {native.isPending ? <LoadingState rows={2} /> : null}
              {native.isError ? (
                <ErrorState error={native.error} onRetry={() => void native.refetch()} />
              ) : null}
              {native.data?.installed.length === 0 ? (
                <EmptyState
                  icon={<PackagePlus aria-hidden="true" />}
                  title="没有已安装的插件"
                  action={
                    <Button variant="outline" size="sm" onClick={() => setTab('market')}>
                      从市场安装
                    </Button>
                  }
                />
              ) : null}
              {native.data && native.data.installed.length > 0 ? (
                <ul aria-label="已安装的插件" className="divide-y divide-line border-y">
                  {native.data.installed.map((item) => {
                    const importing =
                      importNative.isPending && importNative.variables?.pluginId === item.pluginId;
                    return (
                      <li
                        key={item.pluginId}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm"
                      >
                        <span className="min-w-0 truncate font-mono" title={item.pluginId}>
                          {item.pluginId}
                        </span>
                        {item.version ? (
                          <span className="text-xs text-muted-foreground">{item.version}</span>
                        ) : null}
                        <div className="ml-auto">
                          {item.imported ? (
                            <Badge variant="secondary">已加入</Badge>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={pending}
                              aria-busy={importing}
                              className="transition-[color,background-color,border-color,opacity] duration-150 ease-out-soft"
                              onClick={() => addToLibrary(item.pluginId)}
                            >
                              {importing ? '加入中…' : '加入插件库'}
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          </TabsContent>
        </Tabs>
      </DialogShell>
    </Dialog>
  );
}

export function PluginDialog({
  plugin,
  onClose,
  finalFocus,
}: {
  plugin: PluginWithAgentCount;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const update = useUpdatePlugin();
  const pending = update.isPending;
  const form = useZodForm(pluginFormSchema, {
    defaultValues: {
      slug: plugin.slug,
      name: plugin.name,
      description: plugin.description,
    },
  });
  const errors = form.formState.errors;
  const dirty = form.formState.isDirty;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // 半填的配置不能因为 Esc / 点遮罩就消失：脏时先确认；请求中一律不能关闭。
  const close = (): void => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const submit = form.handleSubmit((values) => {
    if (pending) return;
    // slug 由导入时的文件名决定，不可改；PATCH 只接受可编辑的两项。
    update.mutate(
      {
        id: plugin.id,
        input: { name: values.name, description: values.description },
        expectedUpdatedAt: plugin.updatedAt,
      },
      {
        onSuccess: () => {
          toastSuccess('插件已保存');
          onClose();
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
        if (!next) close();
      }}
    >
      <DialogShell title="编辑插件" closeDisabled={pending} finalFocus={finalFocus}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup>
            <Field data-disabled={pending}>
              <FieldLabel htmlFor="plugin-slug">标识</FieldLabel>
              <Input id="plugin-slug" value={plugin.slug} disabled className="font-mono" />
            </Field>
            <Field data-invalid={errors.name ? true : undefined}>
              <FieldLabel htmlFor="plugin-name">名称</FieldLabel>
              <Input
                id="plugin-name"
                {...form.register('name')}
                disabled={pending}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? 'plugin-name-error' : undefined}
              />
              <FieldError id="plugin-name-error">{errors.name?.message}</FieldError>
            </Field>
            <Field data-invalid={errors.description ? true : undefined}>
              <FieldLabel htmlFor="plugin-description">描述</FieldLabel>
              <Input
                id="plugin-description"
                {...form.register('description')}
                disabled={pending}
                aria-invalid={errors.description ? true : undefined}
              />
              <FieldError>{errors.description?.message}</FieldError>
            </Field>
          </FieldGroup>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" aria-busy={pending} disabled={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后插件名称与描述的修改会丢失。"
          confirmLabel="放弃并关闭"
          confirmDisabled={pending}
          onConfirm={async () => {
            if (!pending) onClose();
          }}
        />
      </DialogShell>
    </Dialog>
  );
}

function DeletePluginDialog({
  plugin,
  onClose,
  finalFocus,
}: {
  plugin: PluginWithAgentCount;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const remove = useDeletePlugin();
  return (
    <ConfirmDialog
      open
      title="删除插件"
      description={`「${plugin.name}」及其所有文件将被删除，绑定的 ${plugin.agentCount} 个专家会失去它。`}
      confirmLabel="删除"
      finalFocus={finalFocus}
      onClose={onClose}
      onConfirm={() =>
        remove.mutateAsync(plugin.id).then(() => {
          toastSuccess('插件已删除');
        })
      }
    />
  );
}
