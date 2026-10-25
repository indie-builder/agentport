import { type PluginWithAgentCount, pluginInputSchema } from '@agentport/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Download, MoreHorizontal, Pencil, Puzzle, Trash2, Upload } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { PageNote } from '../components/page.js';
import { ResourcePage } from '../components/resource-page.js';
import { ErrorState, LoadingState } from '../components/states.js';
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
import { useDeletePlugin, useImportPlugin, usePlugins, useUpdatePlugin } from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

const maxPluginBytes = 4_194_304;

const pluginFormSchema = pluginInputSchema.pick({ slug: true, name: true, description: true });

export function PluginsPage() {
  const plugins = usePlugins();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/plugins' });
  const query = search.q ?? '';
  const sort = search.sort ?? 'newest';
  const [editing, setEditing] = useState<PluginWithAgentCount | null>(null);
  const [deleting, setDeleting] = useState<PluginWithAgentCount | null>(null);
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
            disabled={importPlugin.isPending}
            aria-busy={importPlugin.isPending}
            onClick={() => importInputRef.current?.click()}
          >
            <Upload data-icon="inline-start" aria-hidden="true" />{' '}
            {importPlugin.isPending ? '导入中…' : '导入插件 ZIP'}
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
                        className="h-auto w-full min-w-0 justify-start p-0 text-base leading-snug font-medium"
                        onClick={(event) => {
                          actionTriggerRef.current = event.currentTarget;
                          setEditing(plugin);
                        }}
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
                </CardFooter>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}

      {editing ? (
        <PluginDialog plugin={editing} finalFocus={panelFocus} onClose={() => setEditing(null)} />
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
