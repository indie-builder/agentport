import type { ConnectorCatalogItem, Server } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { CircleAlert, CircleCheck, LibraryBig, LoaderCircle, Plus, Upload } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { BusinessIllustration } from '../../components/business-illustration.js';
import { type DataColumn, DataTable } from '../../components/data-table.js';
import { FilterSelect } from '../../components/filter-select.js';
import { PageNote } from '../../components/page.js';
import { ResourcePage } from '../../components/resource-page.js';
import { ErrorState } from '../../components/states.js';
import { Button } from '../../components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.js';
import { can } from '../../lib/access.js';
import { cn } from '../../lib/cn.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import { errorMessage } from '../../lib/orpc.js';
import {
  connectorCatalogQuery,
  meQuery,
  useAgents,
  useImportMcpFile,
  useRuntimeEnvironments,
  useServers,
  useTestServer,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { ConnectionDialog } from './connection-dialog.js';
import { ConnectorCatalogDialog } from './connector-catalog-dialog.js';
import { DeleteServerDialog } from './delete-server-dialog.js';
import { ServerActions } from './server-actions.js';
import { ServerFormDialog } from './server-form-dialog.js';
import { type Kind, kindMeta, type LastTest } from './shared.js';
import { TestEnvironmentDialog } from './test-environment-dialog.js';
import { ToolCatalogDialog } from './tool-catalog-dialog.js';
import { ToolEditorDialog } from './tool-editor-dialog.js';

function detailOf(server: Server): string {
  switch (server.kind) {
    case 'stdio':
      return [server.command, ...server.args].join(' ');
    case 'http':
      return server.url;
    case 'generated':
      return server.baseUrl;
    case 'knowledge':
      return server.config.knowledgeBaseId;
  }
}

function toolCountOf(server: Server, lastTest: LastTest | null): number | null {
  const result = lastTest?.result ?? null;
  return result ? (result.ok ? result.tools.length : null) : (server.lastToolCount ?? null);
}

export function ServersPage() {
  const me = useQuery(meQuery);
  const canCreate = can(me.data, 'servers.create');
  const canImport = can(me.data, 'servers.import');
  const canUpdate = can(me.data, 'servers.update');
  const canDelete = can(me.data, 'servers.delete');
  const canTest = can(me.data, 'servers.test');
  const canTools = can(me.data, 'servers.tools.manage');
  const canTokens = can(me.data, 'servers.tokens.read');
  const servers = useServers();
  const catalog = useQuery(connectorCatalogQuery);
  const agents = useAgents();
  const environments = useRuntimeEnvironments();
  const test = useTestServer();
  const importMcp = useImportMcpFile();
  const search = useSearch({ from: '/_shell/servers' });
  const navigate = useNavigate();
  const query = search.q ?? '';
  const kind = search.kind ?? 'all';
  const sort = search.sort ?? 'newest';
  const setFilter = (
    patch: {
      q?: string | undefined;
      kind?: Kind | undefined;
      sort?: 'newest' | 'name' | undefined;
    },
    replace = false,
  ): void => {
    void navigate({ to: '/servers', search: (previous) => ({ ...previous, ...patch }), replace });
  };
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Server | null>(null);
  const [deleting, setDeleting] = useState<Server | null>(null);
  const [connection, setConnection] = useState<Server | null>(null);
  const [toolServer, setToolServer] = useState<Server | null>(null);
  const [catalogServer, setCatalogServer] = useState<Server | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogInitial, setCatalogInitial] = useState<ConnectorCatalogItem | null>(null);
  const [tested, setTested] = useState<Map<string, LastTest>>(() => new Map());
  const [testingServer, setTestingServer] = useState<Server | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  // 弹层关闭后焦点回到真正打开它的控件，而不是统一回到「新建」。
  const triggerRef = useRef<HTMLElement | null>(null);
  const focusTrigger = (): HTMLElement | null =>
    triggerRef.current?.isConnected ? triggerRef.current : createButtonRef.current;

  const catalogTest = catalogServer ? tested.get(catalogServer.id) : undefined;
  const all = servers.data ?? [];
  // 环境列表不可用时不允许确认：默认项只是占位，无法核对上次实际环境。
  // 有缓存时刷新失败同样算不可用：缓存可能已经过时，先重试再测。
  const environmentList = environments.data ?? [];
  const environmentsLoading = environments.isFetching && environments.data === undefined;
  const environmentsError = environments.isError ? environments.error : null;

  // 目录条目的 name 是人类可读名；已登记的 server 只有 slug 作为 name。
  const catalogNames = useMemo(
    () => new Map((catalog.data ?? []).map((item) => [item.slug, item.name])),
    [catalog.data],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all
      .filter((server) => {
        if (kind !== 'all' && server.kind !== kind) return false;
        return [server.name, catalogNames.get(server.name), server.description, detailOf(server)]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle);
      })
      .sort((left, right) =>
        sort === 'name'
          ? (catalogNames.get(left.name) ?? left.name).localeCompare(
              catalogNames.get(right.name) ?? right.name,
              'zh-CN',
            )
          : Date.parse(right.createdAt) - Date.parse(left.createdAt),
      );
  }, [all, catalogNames, kind, query, sort]);

  const agentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agents.data ?? []) {
      for (const serverId of agent.serverIds ?? []) {
        counts.set(serverId, (counts.get(serverId) ?? 0) + 1);
      }
    }
    return counts;
  }, [agents.data]);

  const agentNames = useMemo(() => {
    const names = new Map<string, string[]>();
    for (const agent of agents.data ?? []) {
      for (const serverId of agent.serverIds ?? []) {
        const list = names.get(serverId);
        if (list) list.push(agent.name);
        else names.set(serverId, [agent.name]);
      }
    }
    return names;
  }, [agents.data]);

  const openCreate = (trigger: HTMLElement | null): void => {
    triggerRef.current = trigger;
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (server: Server, trigger: HTMLElement | null): void => {
    triggerRef.current = trigger;
    setEditing(server);
    setFormOpen(true);
  };

  const runTest = (server: Server, environmentId: string | null = null): void => {
    if (test.isPending) return;
    // 只有 stdio 在沙盒里执行；HTTP/generated 由平台直连，不能带运行环境。
    const runtimeEnvironmentId = server.kind === 'stdio' ? environmentId : null;
    test.mutate(
      {
        id: server.id,
        runtimeEnvironmentId,
      },
      {
        onSuccess: (result) => {
          setTested((previous) =>
            new Map(previous).set(server.id, { at: new Date().toISOString(), result }),
          );
          if (!result.ok) {
            toastError(
              new Error(
                `没有连上 ${server.name}：${result.error ?? '服务没有返回原因，请检查地址与网络后重试'}`,
              ),
            );
          }
        },
        onError: (error) => {
          setTested((previous) =>
            new Map(previous).set(server.id, {
              at: new Date().toISOString(),
              result: { ok: false, tools: [], error: errorMessage(error), durationMs: 0 },
            }),
          );
          toastError(error);
        },
      },
    );
  };

  // stdio 的每个入口都先经过环境确认；HTTP/generated 直接测试。
  const startTest = (server: Server, trigger: HTMLElement): void => {
    triggerRef.current = trigger;
    if (server.kind === 'stdio') setTestingServer(server);
    else runTest(server);
  };

  const importFile = async (file: File): Promise<void> => {
    if (file.size > 1_048_576) {
      toastError(new Error('导入文件不能超过 1 MB，请精简后重试。'));
      return;
    }
    try {
      const result = await importMcp.mutateAsync(await file.text());
      toastSuccess(`已导入 ${result.servers.length} 个连接器`);
      for (const warning of result.warnings) toast.info(warning);
    } catch (error) {
      toastError(error);
    }
  };

  const kindOptions = [
    { value: 'all', label: '全部来源' },
    { value: 'stdio', label: kindMeta.stdio.label },
    { value: 'http', label: kindMeta.http.label },
    { value: 'generated', label: kindMeta.generated.label },
  ];

  const columns: DataColumn<Server>[] = [
    {
      id: 'name',
      header: '名称',
      locked: true,
      width: 'minmax(160px,1.4fr)',
      cell: (server) => {
        const displayName = catalogNames.get(server.name) ?? server.name;
        return (
          <div className="flex min-w-0 flex-col gap-0.5">
            <Button
              variant="ghost"
              className="h-auto w-full min-w-0 justify-start p-0 text-left text-base font-medium whitespace-normal text-fg"
              onClick={(event) => openEdit(server, event.currentTarget)}
            >
              <span className="break-words" title={displayName}>
                {displayName}
              </span>
            </Button>
            {displayName === server.name ? null : (
              <code className="break-all font-mono text-xs text-muted-foreground">
                {server.name}
              </code>
            )}
          </div>
        );
      },
    },
    {
      id: 'kind',
      header: '来源',
      width: '140px',
      cell: (server) => (
        <span className="text-sm text-muted-foreground">{kindMeta[server.kind].label}</span>
      ),
    },
    {
      id: 'address',
      header: '地址',
      width: 'minmax(180px,1.8fr)',
      cell: (server) => {
        const detail = detailOf(server);
        return (
          <code
            className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm text-muted-foreground"
            title={detail}
          >
            {detail || '—'}
          </code>
        );
      },
    },
    {
      id: 'status',
      header: '连通状态',
      width: '150px',
      cell: (server) => {
        const lastTest = tested.get(server.id) ?? null;
        const testing = test.isPending && test.variables?.id === server.id;
        if (testing) {
          return (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
              测试中…
            </span>
          );
        }
        const result = lastTest?.result ?? null;
        const testedAt = lastTest?.at ?? server.lastTestedAt ?? null;
        if (!testedAt) return <span className="text-sm text-muted-foreground">未测试</span>;
        const ok = result ? result.ok : server.lastTestOk === true;
        const environment = result
          ? (result.runtimeEnvironment ?? null)
          : (server.lastTestRuntimeEnvironment ?? null);
        return (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span
              className={cn(
                'flex items-center gap-1.5 text-sm',
                ok ? 'text-success' : 'text-danger',
              )}
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
            {environment ? (
              <span
                className="truncate font-mono text-xs text-muted-foreground"
                title={`${environment.environmentName} · ${environment.versionId} · ${environment.imageId}`}
              >
                环境 {environment.environmentName} · {shortId(environment.versionId)}
              </span>
            ) : null}
          </div>
        );
      },
    },
    {
      id: 'tools',
      header: '工具',
      numeric: true,
      width: '72px',
      cell: (server) => toolCountOf(server, tested.get(server.id) ?? null) ?? '—',
    },
    {
      id: 'agents',
      header: '专家',
      numeric: true,
      width: '72px',
      cell: (server) => {
        if (agents.isError) return '未知';
        if (agents.isPending) return '加载中…';
        const count = agentCounts.get(server.id) ?? 0;
        if (count === 0) return 0;
        const names = agentNames.get(server.id) ?? [];
        return (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto px-1.5 font-normal tabular-nums"
                  aria-label={`查看使用该连接器的 ${count} 个专家`}
                >
                  {count}
                </Button>
              }
            />
            <PopoverContent align="end" className="w-64">
              <p className="text-xs text-muted-foreground">使用该连接器的专家</p>
              <ul className="flex flex-col gap-1">
                {names.map((name) => (
                  <li key={name} className="text-sm break-words text-fg">
                    {name}
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        );
      },
    },
    {
      id: 'actions',
      header: '操作',
      align: 'end',
      width: '32px',
      cell: (server) => (
        <ServerActions
          displayName={catalogNames.get(server.name) ?? server.name}
          generated={server.kind === 'generated'}
          testing={test.isPending && test.variables?.id === server.id}
          testPending={test.isPending}
          canTest={canTest}
          canTools={canTools}
          canTokens={canTokens}
          canDelete={canDelete}
          onTest={(trigger) => startTest(server, trigger)}
          onCatalog={(trigger) => {
            triggerRef.current = trigger;
            setCatalogServer(server);
          }}
          onTools={(trigger) => {
            triggerRef.current = trigger;
            setToolServer(server);
          }}
          onConnection={(trigger) => {
            triggerRef.current = trigger;
            setConnection(server);
          }}
          onDelete={(trigger) => {
            triggerRef.current = trigger;
            setDeleting(server);
          }}
        />
      ),
    },
  ];

  return (
    <ResourcePage
      section="servers"
      query={query}
      onQueryChange={(q) => setFilter({ q: q || undefined }, true)}
      sort={sort}
      onSortChange={(next) => setFilter({ sort: next === 'newest' ? undefined : next })}
      count={filtered.length}
      status={servers.status}
      filters={
        <FilterSelect
          value={kind}
          onValueChange={(next) => setFilter({ kind: next === 'all' ? undefined : (next as Kind) })}
          options={kindOptions}
          label="按来源筛选"
          className="w-36"
        />
      }
      actions={
        <>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // 先清空 value，同一个文件重试时才会再次触发 change。
              event.target.value = '';
              if (file) void importFile(file);
            }}
          />
          {canImport ? (
            <Button
              variant="outline"
              disabled={importMcp.isPending}
              aria-busy={importMcp.isPending}
              onClick={() => importInputRef.current?.click()}
            >
              <Upload data-icon="inline-start" aria-hidden="true" />{' '}
              {importMcp.isPending ? '导入中…' : '导入 .mcp.json'}
            </Button>
          ) : null}
          {canCreate ? (
            <Button
              variant="outline"
              onClick={(event) => {
                triggerRef.current = event.currentTarget;
                setCatalogOpen(true);
              }}
            >
              <LibraryBig data-icon="inline-start" aria-hidden="true" /> 浏览目录
            </Button>
          ) : null}
          {canCreate && !(servers.data && all.length === 0) ? (
            <Button ref={createButtonRef} onClick={(event) => openCreate(event.currentTarget)}>
              <Plus data-icon="inline-start" /> 新建连接器
            </Button>
          ) : null}
        </>
      }
    >
      {servers.isError ? (
        <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />
      ) : null}
      {agents.isError ? (
        <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
      ) : null}

      {servers.data && all.length === 0 ? (
        <PageNote
          icon={<BusinessIllustration name="tools" size="compact" />}
          title="未添加连接器"
          description={canCreate ? undefined : '当前账户没有创建连接器的权限。'}
          action={
            canCreate ? (
              <Button onClick={(event) => openCreate(event.currentTarget)}>
                <Plus data-icon="inline-start" /> 新建连接器
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {servers.data && all.length > 0 && filtered.length === 0 ? (
        <PageNote
          icon={<BusinessIllustration name="search" size="compact" />}
          title="没有匹配的连接器"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFilter({ q: undefined, kind: undefined });
              }}
            >
              清除筛选
            </Button>
          }
        />
      ) : null}

      {servers.isPending || (servers.data && all.length > 0 && filtered.length > 0) ? (
        <DataTable
          rows={filtered}
          columns={columns}
          rowKey={(server) => server.id}
          rowLabel={(server) => catalogNames.get(server.name) ?? server.name}
          label="连接器列表"
          loading={servers.isPending}
          hideRowCount
          onRowClick={(server, trigger) => {
            triggerRef.current = trigger;
            setCatalogServer(server);
          }}
        />
      ) : null}

      {catalogOpen ? (
        <ConnectorCatalogDialog
          getReturnFocus={focusTrigger}
          onClose={() => setCatalogOpen(false)}
          onPick={(item) => {
            setCatalogOpen(false);
            setEditing(null);
            setCatalogInitial(item);
            setFormOpen(true);
          }}
        />
      ) : null}

      {formOpen ? (
        <ServerFormDialog
          key={editing?.id ?? (catalogInitial ? `catalog-${catalogInitial.slug}` : 'new')}
          getReturnFocus={focusTrigger}
          server={editing}
          initial={catalogInitial}
          readOnly={editing !== null && !canUpdate}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
            setCatalogInitial(null);
          }}
          onSaved={(saved, created) => {
            setFormOpen(false);
            setEditing(null);
            setCatalogInitial(null);
            setTested((previous) => {
              const next = new Map(previous);
              next.delete(saved.id);
              return next;
            });
            // 新建的 generated server 还没有工具；直接进入工具编辑，避免回到列表后无从下手。
            if (created && saved.kind === 'generated') setToolServer(saved);
          }}
        />
      ) : null}

      {catalogServer ? (
        <ToolCatalogDialog
          server={catalogServer}
          lastTest={catalogTest ?? null}
          pending={test.isPending}
          testing={test.isPending && test.variables?.id === catalogServer.id}
          onRetest={(trigger) => startTest(catalogServer, trigger)}
          getReturnFocus={focusTrigger}
          onClose={() => setCatalogServer(null)}
        />
      ) : null}

      {toolServer ? (
        <ToolEditorDialog
          server={toolServer}
          getReturnFocus={focusTrigger}
          onClose={() => {
            setTested((previous) => {
              const next = new Map(previous);
              next.delete(toolServer.id);
              return next;
            });
            setToolServer(null);
          }}
        />
      ) : null}

      {testingServer ? (
        <TestEnvironmentDialog
          server={testingServer}
          lastTest={tested.get(testingServer.id) ?? null}
          environments={environmentList}
          environmentsLoading={environmentsLoading}
          environmentsError={environmentsError}
          onRetryEnvironments={() => void environments.refetch()}
          getReturnFocus={focusTrigger}
          onClose={() => setTestingServer(null)}
          onConfirm={(environmentId) => {
            setTestingServer(null);
            runTest(testingServer, environmentId === 'default' ? null : environmentId);
          }}
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
          getReturnFocus={focusTrigger}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </ResourcePage>
  );
}

export { ToolForm } from './tool-form.js';
export { ServerFormDialog };
