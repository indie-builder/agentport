import { gatewayServerSchema, type Server } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  CircleAlert,
  CircleCheck,
  KeyRound,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { toast } from 'sonner';
import { BusinessIllustration } from '../components/business-illustration.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { DialogShell } from '../components/dialog-shell.js';
import { FilterSelect } from '../components/filter-select.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageToolbar,
  PageTopbar,
} from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { SearchInput } from '../components/search-input.js';
import {
  ConnectionDialog,
  DeleteServerDialog,
  type LastTest,
  ToolCatalogDialog,
} from '../components/server/dialogs.js';
import { ErrorState } from '../components/states.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import { Checkbox } from '../components/ui/checkbox.js';
import { Dialog } from '../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Textarea } from '../components/ui/textarea.js';
import { can } from '../lib/access.js';
import { ApiError, api } from '../lib/api.js';
import { useFormBlocker } from '../lib/form.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { errorMessage } from '../lib/orpc.js';
import {
  meQuery,
  useAgents,
  useCreateServer,
  useServers,
  useTestServer,
  useUpdateServer,
} from '../lib/queries.js';
import { kindMeta } from '../lib/server-kinds.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

type GatewayServer = Extract<Server, { kind: 'gateway' }>;
type UpstreamServer = Extract<Server, { kind: 'http' } | { kind: 'generated' }>;

const sortOptions = [
  { value: 'newest', label: '最新创建' },
  { value: 'name', label: '名称排序' },
];

const gatewayFormSchema = gatewayServerSchema.omit({ kind: true });

function toolCountOf(gateway: GatewayServer, lastTest: LastTest | null): number | null {
  const result = lastTest?.result ?? null;
  return result ? (result.ok ? result.tools.length : null) : (gateway.lastToolCount ?? null);
}

export function GatewaysPage() {
  const me = useQuery(meQuery);
  const canCreate = can(me.data, 'servers.create');
  const canUpdate = can(me.data, 'servers.update');
  const canDelete = can(me.data, 'servers.delete');
  const canTest = can(me.data, 'servers.test');
  const canTokens = can(me.data, 'servers.tokens.read');
  const servers = useServers();
  const agents = useAgents();
  const test = useTestServer();
  const search = useSearch({ from: '/_shell/gateways' });
  const navigate = useNavigate();
  const query = search.q ?? '';
  const sort = search.sort ?? 'newest';
  const setFilter = (
    patch: { q?: string | undefined; sort?: 'newest' | 'name' | undefined },
    replace = false,
  ): void => {
    void navigate({ to: '/gateways', search: (previous) => ({ ...previous, ...patch }), replace });
  };
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<GatewayServer | null>(null);
  const [deleting, setDeleting] = useState<GatewayServer | null>(null);
  const [connection, setConnection] = useState<GatewayServer | null>(null);
  const [toolsServer, setToolsServer] = useState<GatewayServer | null>(null);
  const [tested, setTested] = useState<Map<string, LastTest>>(() => new Map());
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const focusTrigger = (): HTMLElement | null =>
    triggerRef.current?.isConnected ? triggerRef.current : createButtonRef.current;

  const all = servers.data ?? [];
  const serverNames = useMemo(() => new Map(all.map((server) => [server.id, server.name])), [all]);
  const gateways = useMemo(
    () => all.filter((server): server is GatewayServer => server.kind === 'gateway'),
    [all],
  );
  const upstreams = useMemo(
    () =>
      all.filter(
        (server): server is UpstreamServer => server.kind === 'http' || server.kind === 'generated',
      ),
    [all],
  );
  const agentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agents.data ?? []) {
      for (const serverId of agent.serverIds ?? []) {
        counts.set(serverId, (counts.get(serverId) ?? 0) + 1);
      }
    }
    return counts;
  }, [agents.data]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return gateways
      .filter((gateway) =>
        [
          gateway.name,
          gateway.description,
          ...gateway.serverIds.map((id) => serverNames.get(id) ?? id),
        ]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
      .sort((left, right) =>
        sort === 'name'
          ? left.name.localeCompare(right.name, 'zh-CN')
          : Date.parse(right.createdAt) - Date.parse(left.createdAt),
      );
  }, [gateways, query, serverNames, sort]);

  const openCreate = (trigger: HTMLElement | null): void => {
    triggerRef.current = trigger;
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (gateway: GatewayServer, trigger: HTMLElement | null): void => {
    triggerRef.current = trigger;
    setEditing(gateway);
    setFormOpen(true);
  };

  const runTest = (gateway: GatewayServer): void => {
    if (test.isPending) return;
    test.mutate(
      { id: gateway.id, runtimeEnvironmentId: null },
      {
        onSuccess: (result) => {
          setTested((previous) =>
            new Map(previous).set(gateway.id, { at: new Date().toISOString(), result }),
          );
          if (!result.ok) {
            toastError(
              new Error(
                `没有连上 ${gateway.name}：${result.error ?? '服务没有返回原因，请检查上游连接器后重试'}`,
              ),
            );
          } else if (result.error) {
            toast.warning(`已连接 ${gateway.name}，但部分上游失败：${result.error}`);
          }
        },
        onError: (error) => {
          setTested((previous) =>
            new Map(previous).set(gateway.id, {
              at: new Date().toISOString(),
              result: { ok: false, tools: [], error: errorMessage(error), durationMs: 0 },
            }),
          );
          toastError(error);
        },
      },
    );
  };

  const columns: DataColumn<GatewayServer>[] = [
    {
      id: 'name',
      header: '名称',
      locked: true,
      width: 'minmax(160px,1.4fr)',
      cell: (gateway) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <Button
            variant="ghost"
            className="h-auto w-full min-w-0 justify-start p-0 text-left text-base font-medium whitespace-normal text-fg"
            onClick={(event) => openEdit(gateway, event.currentTarget)}
          >
            <span className="break-words" title={gateway.name}>
              {gateway.name}
            </span>
          </Button>
          {gateway.description ? (
            <span className="break-words text-sm text-muted-foreground">{gateway.description}</span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'upstreams',
      header: '上游连接器',
      width: 'minmax(180px,1.8fr)',
      cell: (gateway) => {
        const names = gateway.serverIds.map((id) => serverNames.get(id) ?? id);
        return (
          <span
            className="block overflow-hidden text-ellipsis whitespace-nowrap text-sm text-muted-foreground"
            title={names.join('、')}
          >
            {names.join('、') || '—'}
          </span>
        );
      },
    },
    {
      id: 'tools',
      header: '工具',
      numeric: true,
      width: '72px',
      cell: (gateway) => toolCountOf(gateway, tested.get(gateway.id) ?? null) ?? '—',
    },
    {
      id: 'agents',
      header: '专家',
      numeric: true,
      width: '72px',
      cell: (gateway) =>
        agents.isError ? '未知' : agents.isPending ? '加载中…' : (agentCounts.get(gateway.id) ?? 0),
    },
    {
      id: 'status',
      header: '连通状态',
      width: '150px',
      cell: (gateway) => {
        const lastTest = tested.get(gateway.id) ?? null;
        const testing = test.isPending && test.variables?.id === gateway.id;
        if (testing) {
          return (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
              测试中…
            </span>
          );
        }
        const testedAt = lastTest?.at ?? gateway.lastTestedAt ?? null;
        if (!testedAt) return <span className="text-sm text-muted-foreground">未测试</span>;
        const ok = lastTest ? lastTest.result.ok : gateway.lastTestOk === true;
        return (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span
              className={
                ok
                  ? 'flex items-center gap-1.5 text-sm text-success'
                  : 'flex items-center gap-1.5 text-sm text-danger'
              }
            >
              {ok ? (
                <CircleCheck className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              {ok ? '试连成功' : '未能连接'}
            </span>
            <span
              className="font-mono text-xs tabular-nums text-muted-foreground"
              title={formatDateTime(testedAt)}
            >
              {formatRelative(testedAt)}
            </span>
          </div>
        );
      },
    },
    {
      id: 'actions',
      header: '操作',
      align: 'end',
      width: '32px',
      cell: (gateway) => (
        <GatewayActions
          displayName={gateway.name}
          testing={test.isPending && test.variables?.id === gateway.id}
          testPending={test.isPending}
          canUpdate={canUpdate}
          canTest={canTest}
          canTokens={canTokens}
          canDelete={canDelete}
          onEdit={(trigger) => openEdit(gateway, trigger)}
          onTest={() => runTest(gateway)}
          onTools={(trigger) => {
            triggerRef.current = trigger;
            setToolsServer(gateway);
          }}
          onConnection={(trigger) => {
            triggerRef.current = trigger;
            setConnection(gateway);
          }}
          onDelete={(trigger) => {
            triggerRef.current = trigger;
            setDeleting(gateway);
          }}
        />
      ),
    },
  ];

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          title="统一聚合"
          description="把多个连接器聚合为一个 MCP 端点，供智能体一次绑定。"
          actions={
            canCreate ? (
              <Button ref={createButtonRef} onClick={(event) => openCreate(event.currentTarget)}>
                <Plus data-icon="inline-start" /> 新建统一聚合
              </Button>
            ) : null
          }
        />
        <PageToolbar>
          <SearchInput
            label="搜索统一聚合"
            placeholder="搜索统一聚合…"
            value={query}
            onChange={(next) => setFilter({ q: next || undefined }, true)}
            className="w-56 min-w-0"
          />
          <FilterSelect
            label="统一聚合排序"
            value={sort}
            onValueChange={(next) => {
              if (next === 'newest' || next === 'name') {
                setFilter({ sort: next === 'newest' ? undefined : next });
              }
            }}
            options={sortOptions}
            className="w-32"
          />
          <span role="status" className="ml-auto text-xs text-muted-foreground">
            {servers.status === 'pending'
              ? '加载中…'
              : servers.status === 'error'
                ? '数量不可用'
                : `共 ${filtered.length} 个统一聚合`}
          </span>
        </PageToolbar>
      </PageTopbar>
      <PageBody>
        {servers.isError ? (
          <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />
        ) : null}
        {agents.isError ? (
          <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
        ) : null}

        {servers.data && gateways.length === 0 ? (
          <PageNote
            icon={<BusinessIllustration name="tools" size="compact" />}
            title="还没有统一聚合"
            description={canCreate ? undefined : '当前账户没有创建统一聚合的权限。'}
            action={
              canCreate ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(event) => openCreate(event.currentTarget)}
                >
                  <Plus data-icon="inline-start" /> 新建统一聚合
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {servers.data && gateways.length > 0 && filtered.length === 0 ? (
          <PageNote
            icon={<BusinessIllustration name="search" size="compact" />}
            title="没有匹配的统一聚合"
            action={
              <Button variant="outline" size="sm" onClick={() => setFilter({ q: undefined })}>
                清除筛选
              </Button>
            }
          />
        ) : null}

        {servers.isPending || (servers.data && gateways.length > 0 && filtered.length > 0) ? (
          <DataTable
            rows={filtered}
            columns={columns}
            rowKey={(gateway) => gateway.id}
            rowLabel={(gateway) => gateway.name}
            label="统一聚合列表"
            loading={servers.isPending}
            hideRowCount
            onRowClick={(gateway, trigger) => {
              triggerRef.current = trigger;
              setToolsServer(gateway);
            }}
          />
        ) : null}

        {formOpen ? (
          <GatewayFormDialog
            key={editing?.id ?? 'new'}
            gateway={editing}
            upstreams={upstreams}
            readOnly={editing !== null && !canUpdate}
            getReturnFocus={focusTrigger}
            onClose={() => {
              setFormOpen(false);
              setEditing(null);
            }}
            onSaved={(saved) => {
              setFormOpen(false);
              setEditing(null);
              setTested((previous) => {
                const next = new Map(previous);
                next.delete(saved.id);
                return next;
              });
            }}
          />
        ) : null}

        {toolsServer ? (
          <ToolCatalogDialog
            server={toolsServer}
            lastTest={tested.get(toolsServer.id) ?? null}
            pending={test.isPending}
            testing={test.isPending && test.variables?.id === toolsServer.id}
            onRetest={() => runTest(toolsServer)}
            getReturnFocus={focusTrigger}
            onClose={() => setToolsServer(null)}
          />
        ) : null}

        {connection ? (
          <ConnectionDialog
            server={connection}
            getReturnFocus={focusTrigger}
            onClose={() => setConnection(null)}
          />
        ) : null}

        {deleting ? (
          <DeleteServerDialog
            server={deleting}
            label="统一聚合"
            getReturnFocus={focusTrigger}
            onClose={() => setDeleting(null)}
          />
        ) : null}
      </PageBody>
    </Page>
  );
}

function GatewayActions({
  displayName,
  testing,
  testPending,
  canUpdate,
  canTest,
  canTokens,
  canDelete,
  onEdit,
  onTest,
  onTools,
  onConnection,
  onDelete,
}: {
  displayName: string;
  testing: boolean;
  testPending: boolean;
  canUpdate: boolean;
  canTest: boolean;
  canTokens: boolean;
  canDelete: boolean;
  onEdit: (trigger: HTMLElement) => void;
  onTest: () => void;
  onTools: (trigger: HTMLElement) => void;
  onConnection: (trigger: HTMLElement) => void;
  onDelete: (trigger: HTMLElement) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            ref={triggerRef}
            variant="ghost"
            size="icon-sm"
            aria-label={`操作 ${displayName}`}
          >
            <MoreHorizontal />
          </Button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={4} className="w-40">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => triggerRef.current && onEdit(triggerRef.current)}>
            <Pencil /> {canUpdate ? '编辑' : '查看'}
          </DropdownMenuItem>
          {canTest ? (
            <DropdownMenuItem disabled={testPending} onClick={onTest}>
              <Plug /> {testing ? '测试中…' : '测试连接'}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => triggerRef.current && onTools(triggerRef.current)}>
            <Wrench /> 聚合工具
          </DropdownMenuItem>
          {canTokens ? (
            <DropdownMenuItem
              onClick={() => triggerRef.current && onConnection(triggerRef.current)}
            >
              <KeyRound /> 连接信息
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        {canDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => triggerRef.current && onDelete(triggerRef.current)}
              >
                <Trash2 /> 删除
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GatewayFormDialog({
  gateway,
  upstreams,
  onClose,
  onSaved,
  getReturnFocus,
  readOnly = false,
}: {
  gateway: GatewayServer | null;
  upstreams: UpstreamServer[];
  onClose: () => void;
  onSaved: (gateway: Server) => void;
  getReturnFocus: () => HTMLElement | null;
  readOnly?: boolean | undefined;
}) {
  const creating = gateway === null;
  const viewOnly = readOnly && !creating;
  const create = useCreateServer();
  const update = useUpdateServer();
  const { register, control, handleSubmit, reset, watch, formState } = useZodForm(
    gatewayFormSchema,
    {
      defaultValues: {
        name: gateway?.name ?? '',
        description: gateway?.description ?? '',
        serverIds: gateway ? [...gateway.serverIds] : [],
      },
    },
  );
  const { errors, isDirty } = formState;
  const watched = watch();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [baseline, setBaseline] = useState(gateway);
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [reloading, setReloading] = useState(false);
  const pending = create.isPending || update.isPending || reloading;
  const blocker = useFormBlocker(isDirty, pending);
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);
  const settle = (): void => {
    blockerRef.current.reset?.();
  };
  const finish = (): void => {
    settle();
    onClose();
  };
  const reload = async (): Promise<void> => {
    if (!baseline || pending) return;
    setReloading(true);
    try {
      const latest = (await api.servers()).find(
        (server): server is GatewayServer => server.id === baseline.id && server.kind === 'gateway',
      );
      if (!latest) throw new Error('该统一聚合已不存在，请关闭配置并刷新列表');
      setBaseline(latest);
      reset({
        name: latest.name,
        description: latest.description,
        serverIds: [...latest.serverIds],
      });
      setConflict(false);
      setConfirmReload(false);
    } catch (error) {
      toastError(error);
    } finally {
      setReloading(false);
    }
  };
  const close = (): void => {
    if (pending) return;
    if (isDirty) {
      setConfirmDiscard(true);
      return;
    }
    finish();
  };

  const submit = handleSubmit((values) => {
    if (pending || viewOnly) return;
    if (baseline) {
      update.mutate(
        {
          id: baseline.id,
          input: values,
          expectedUpdatedAt: baseline.updatedAt,
        },
        {
          onSuccess: (saved) => {
            settle();
            toastSuccess('统一聚合已更新');
            onSaved(saved);
          },
          onError: (error) => {
            if (error instanceof ApiError && error.status === 409) {
              setConflict(true);
              toastError(new Error('配置已被修改；当前草稿已保留，请加载最新配置后重新编辑。'));
              return;
            }
            toastError(error);
          },
        },
      );
      return;
    }
    create.mutate(
      { ...values, kind: 'gateway' },
      {
        onSuccess: (saved) => {
          settle();
          toastSuccess('统一聚合已创建');
          onSaved(saved);
        },
        onError: (error) => toastError(error),
      },
    );
  });

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (next) return;
        if (pending || isDirty) details.cancel();
        close();
      }}
    >
      <DialogShell
        title={
          creating
            ? '新建统一聚合'
            : viewOnly
              ? `查看「${gateway.name}」`
              : `编辑「${gateway.name}」`
        }
        {...(!creating
          ? { description: viewOnly ? '只读查看，不能修改或保存。' : '聚合来源与名称可以修改。' }
          : {})}
        finalFocus={getReturnFocus}
        closeDisabled={pending}
      >
        {conflict ? (
          <div role="alert" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <p>配置已被修改，当前草稿已保留。加载最新配置会放弃此草稿。</p>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setConfirmReload(true)}
            >
              加载最新配置
            </Button>
          </div>
        ) : null}
        <ConfirmDialog
          open={confirmReload}
          onClose={() => {
            if (!pending) setConfirmReload(false);
          }}
          title="放弃草稿并加载最新配置？"
          description="当前未保存的更改会丢失。加载失败时会保留当前草稿。"
          confirmLabel="放弃并加载"
          confirmDisabled={pending}
          onConfirm={reload}
        />
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field data-disabled={pending} className="gap-1.5" data-invalid={Boolean(errors.name)}>
            <FieldLabel htmlFor="gateway-name">
              名称
              <RequiredMark />
            </FieldLabel>
            <Input
              {...register('name')}
              value={watched.name}
              disabled={pending}
              readOnly={viewOnly}
              id="gateway-name"
              placeholder="all-tools"
              aria-required
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? 'gateway-name-error' : 'gateway-name-hint'}
            />
            {errors.name ? (
              <FieldError id="gateway-name-error">{errors.name.message}</FieldError>
            ) : (
              <FieldDescription id="gateway-name-hint">小写字母、数字、- 和 _。</FieldDescription>
            )}
          </Field>

          <Field
            data-disabled={pending}
            className="gap-1.5"
            data-invalid={Boolean(errors.description)}
          >
            <FieldLabel htmlFor="gateway-desc">描述</FieldLabel>
            <Textarea
              {...register('description')}
              value={watched.description}
              disabled={pending}
              readOnly={viewOnly}
              id="gateway-desc"
              rows={2}
              aria-invalid={Boolean(errors.description)}
              aria-describedby={errors.description ? 'gateway-desc-error' : undefined}
              placeholder="一句话说明它聚合了哪些能力"
            />
            <FieldError id="gateway-desc-error">{errors.description?.message}</FieldError>
          </Field>

          <FieldSet className="gap-2" data-disabled={pending}>
            <FieldLegend variant="label">
              上游连接器
              <RequiredMark />
            </FieldLegend>
            {upstreams.length === 0 ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>还没有可聚合的连接器。</span>
                <Link to="/servers" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  去连接器创建
                </Link>
              </div>
            ) : (
              <Controller
                control={control}
                name="serverIds"
                render={({ field }) => (
                  <div
                    aria-invalid={Boolean(errors.serverIds) || undefined}
                    aria-describedby={errors.serverIds ? 'gateway-upstream-error' : undefined}
                    tabIndex={errors.serverIds ? -1 : undefined}
                    className="max-h-64 overflow-y-auto overscroll-contain rounded-item border"
                  >
                    {upstreams.map((server) => (
                      <Label
                        key={server.id}
                        htmlFor={`gateway-upstream-${server.id}`}
                        className="w-full gap-2.5 border-b px-3 py-2 font-normal last:border-b-0"
                      >
                        <Checkbox
                          id={`gateway-upstream-${server.id}`}
                          aria-label={`${server.name}（${kindMeta[server.kind].label}）`}
                          checked={field.value.includes(server.id)}
                          disabled={pending || viewOnly}
                          onCheckedChange={(next) =>
                            field.onChange(
                              next
                                ? [...field.value, server.id]
                                : field.value.filter((id) => id !== server.id),
                            )
                          }
                        />
                        <span className="min-w-0 flex-1 truncate text-fg" title={server.name}>
                          {server.name}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {kindMeta[server.kind].label}
                        </span>
                      </Label>
                    ))}
                  </div>
                )}
              />
            )}
            <FieldError id="gateway-upstream-error">{errors.serverIds?.message}</FieldError>
          </FieldSet>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close} disabled={pending}>
              {viewOnly ? '关闭' : '取消'}
            </Button>
            {viewOnly ? null : (
              <Button
                type="submit"
                disabled={pending || (!creating && !isDirty)}
                aria-busy={pending}
              >
                {pending ? '保存中…' : creating ? '创建' : '保存更改'}
              </Button>
            )}
          </div>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后这个统一聚合的修改会丢失。"
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
          description={pending ? '正在保存，请等待请求完成。' : '离开后统一聚合的修改会丢失。'}
          confirmLabel="放弃并离开"
          confirmDisabled={pending}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}
