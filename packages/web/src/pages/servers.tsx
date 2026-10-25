import {
  type ApiTool,
  type ApiToolInput,
  type ConnectorCatalogItem,
  SECRET_MASK,
  type Server,
  type ServerInput,
  type ServerTestResult,
  serverInputSchema,
} from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  CircleAlert,
  CircleCheck,
  KeyRound,
  LibraryBig,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Server as ServerIcon,
  Trash2,
  Upload,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { CodeBlock, JsonBlock } from '../components/code-block.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { FilterSelect } from '../components/filter-select.js';
import { PageNote } from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { ResourcePage } from '../components/resource-page.js';
import { SourceEditor } from '../components/source-editor.js';
import { ErrorState, InlineEmpty, LoadingState } from '../components/states.js';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { Textarea } from '../components/ui/textarea.js';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group.js';
import { ApiError, api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { fieldErrors, useFormBlocker } from '../lib/form.js';
import { formatDateTime, formatDuration } from '../lib/format.js';
import {
  connectorCatalogQuery,
  useAgents,
  useCreateServer,
  useCreateTool,
  useDeleteServer,
  useDeleteTool,
  useImportMcpFile,
  useRotateServerToken,
  useServers,
  useServerToken,
  useSetToolEnabled,
  useTestServer,
  useTools,
  useUpdateServer,
  useUpdateTool,
} from '../lib/queries.js';
import { parsePairs, validateToolInput } from '../lib/resource-form.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

type Kind = ServerInput['kind'];

const kindMeta: Record<Kind, { label: string; hint: string; newHint: string }> = {
  stdio: {
    label: '本地命令',
    hint: '由沙盒启动的 stdio 进程',
    newHint: '在沙盒里启动一个 MCP 进程，例如 npx 包或本地脚本。',
  },
  http: {
    label: '远程 MCP',
    hint: '已有的 MCP HTTP 端点',
    newHint: '直接连接一个已经实现了 MCP 协议的 HTTP 服务。',
  },
  generated: {
    label: 'HTTP API 转 MCP',
    hint: '平台把上游 HTTP API 包装成 MCP',
    newHint: '逐个声明上游 HTTP 端点，平台替你生成可调用的 MCP 工具。',
  },
};

/** 最近一次连接测试；只存在页面内存里，刷新或换设备后消失（后端没有持久化字段）。 */
interface LastTest {
  at: string;
  result: ServerTestResult;
}

function formatPairs(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function detailOf(server: Server): string {
  switch (server.kind) {
    case 'stdio':
      return [server.command, ...server.args].join(' ');
    case 'http':
      return server.url;
    case 'generated':
      return server.baseUrl;
  }
}

export function ServersPage() {
  const servers = useServers();
  const agents = useAgents();
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
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  // 弹层关闭后焦点回到真正打开它的控件，而不是统一回到「新建」。
  const triggerRef = useRef<HTMLElement | null>(null);
  const focusTrigger = (): HTMLElement | null =>
    triggerRef.current?.isConnected ? triggerRef.current : createButtonRef.current;

  const catalogTest = catalogServer ? tested.get(catalogServer.id) : undefined;
  const all = servers.data ?? [];

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all
      .filter((server) => {
        if (kind !== 'all' && server.kind !== kind) return false;
        return [server.name, server.description, detailOf(server)]
          .join(' ')
          .toLowerCase()
          .includes(needle);
      })
      .sort((left, right) =>
        sort === 'name'
          ? left.name.localeCompare(right.name, 'zh-CN')
          : Date.parse(right.createdAt) - Date.parse(left.createdAt),
      );
  }, [all, kind, query, sort]);

  const agentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agents.data ?? []) {
      for (const serverId of agent.serverIds) {
        counts.set(serverId, (counts.get(serverId) ?? 0) + 1);
      }
    }
    return counts;
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

  const runTest = (server: Server): void => {
    if (test.isPending) return;
    test.mutate(server.id, {
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
      onError: (error) => toastError(error),
    });
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
          <Button
            variant="outline"
            disabled={importMcp.isPending}
            aria-busy={importMcp.isPending}
            onClick={() => importInputRef.current?.click()}
          >
            <Upload data-icon="inline-start" aria-hidden="true" />{' '}
            {importMcp.isPending ? '导入中…' : '导入 .mcp.json'}
          </Button>
          <Button
            variant="outline"
            onClick={(event) => {
              triggerRef.current = event.currentTarget;
              setCatalogOpen(true);
            }}
          >
            <LibraryBig data-icon="inline-start" aria-hidden="true" /> 浏览目录
          </Button>
          <Button ref={createButtonRef} onClick={(event) => openCreate(event.currentTarget)}>
            <Plus data-icon="inline-start" /> 新建连接器
          </Button>
        </>
      }
    >
      {servers.isPending ? <LoadingState rows={4} layout="cards" /> : null}
      {servers.isError ? (
        <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />
      ) : null}
      {agents.isError ? (
        <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
      ) : null}

      {servers.data && all.length === 0 ? (
        <PageNote
          icon={<ServerIcon className="size-4" aria-hidden="true" />}
          title="把外部服务接成专家可用的工具"
          description="本地命令、远程 MCP 或 HTTP API 都可以。"
          action={
            <Button onClick={(event) => openCreate(event.currentTarget)}>
              <Plus data-icon="inline-start" /> 新建连接器
            </Button>
          }
        />
      ) : null}

      {servers.data && all.length > 0 && filtered.length === 0 ? (
        <PageNote
          title="没有匹配的连接器"
          description="换个关键词，或清除来源筛选。"
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

      {filtered.length > 0 ? (
        <ul
          aria-label="连接器列表"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
        >
          {filtered.map((server) => (
            <li key={server.id} className="min-w-0">
              <ServerCard
                server={server}
                agentCount={
                  agents.isError
                    ? '未知'
                    : agents.isPending
                      ? '加载中…'
                      : (agentCounts.get(server.id) ?? 0)
                }
                lastTest={tested.get(server.id) ?? null}
                testing={test.isPending && test.variables === server.id}
                testPending={test.isPending}
                onTest={() => runTest(server)}
                onTools={(trigger) => {
                  triggerRef.current = trigger;
                  setToolServer(server);
                }}
                onConnection={(trigger) => {
                  triggerRef.current = trigger;
                  setConnection(server);
                }}
                onCatalog={(trigger) => {
                  triggerRef.current = trigger;
                  setCatalogServer(server);
                }}
                onEdit={(trigger) => openEdit(server, trigger)}
                onDelete={(trigger) => {
                  triggerRef.current = trigger;
                  setDeleting(server);
                }}
              />
            </li>
          ))}
        </ul>
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

      {catalogServer && catalogTest ? (
        <ToolCatalogDialog
          server={catalogServer}
          lastTest={catalogTest}
          pending={test.isPending}
          testing={test.isPending && test.variables === catalogServer.id}
          onRetest={() => runTest(catalogServer)}
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

function ServerCard({
  server,
  agentCount,
  lastTest,
  testing,
  testPending,
  onTest,
  onTools,
  onConnection,
  onCatalog,
  onEdit,
  onDelete,
}: {
  server: Server;
  agentCount: number | '未知' | '加载中…';
  lastTest: LastTest | null;
  testing: boolean;
  testPending: boolean;
  onTest: () => void;
  onTools: (trigger: HTMLElement) => void;
  onConnection: (trigger: HTMLElement) => void;
  onCatalog: (trigger: HTMLElement) => void;
  onEdit: (trigger: HTMLElement) => void;
  onDelete: (trigger: HTMLElement) => void;
}) {
  const generated = server.kind === 'generated';
  const toolCount = lastTest?.result.ok
    ? lastTest.result.tools.length
    : (server.lastToolCount ?? '连接后确定');
  // 菜单项随菜单卸载，关闭后只能把焦点还给菜单触发器。
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <Card data-slot="server-card" className="h-full">
      <CardHeader className="grid-cols-[auto_minmax(0,1fr)_auto]!">
        <span className="row-span-2 flex size-10 shrink-0 items-center justify-center rounded-item bg-muted text-muted-foreground">
          <ServerIcon aria-hidden="true" />
        </span>
        <CardTitle className="col-start-2 min-w-0">
          <h2>
            <Button
              variant="ghost"
              className="h-auto w-full min-w-0 justify-start p-0 text-left text-base font-medium whitespace-normal"
              onClick={(event) => onEdit(event.currentTarget)}
            >
              <span className="line-clamp-2 break-words" title={server.name}>
                {server.name}
              </span>
            </Button>
          </h2>
        </CardTitle>
        <CardDescription className="col-start-2 row-start-2 line-clamp-2 min-h-10 break-words">
          {server.description || kindMeta[server.kind].hint}
        </CardDescription>
        <CardAction className="col-start-3">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  ref={menuTriggerRef}
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`操作 ${server.name}`}
                >
                  <MoreHorizontal />
                </Button>
              }
            />
            <DropdownMenuContent align="end" sideOffset={4} className="w-40">
              <DropdownMenuGroup>
                <DropdownMenuItem disabled={testPending} onClick={onTest}>
                  <Plug /> {testing ? '测试中…' : '测试连接'}
                </DropdownMenuItem>
                {generated ? (
                  <>
                    <DropdownMenuItem
                      onClick={() => menuTriggerRef.current && onTools(menuTriggerRef.current)}
                    >
                      <Wrench /> 工具定义
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => menuTriggerRef.current && onConnection(menuTriggerRef.current)}
                    >
                      <KeyRound /> 连接信息
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onClick={() => menuTriggerRef.current && onEdit(menuTriggerRef.current)}
                >
                  <Pencil /> 编辑
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => menuTriggerRef.current && onDelete(menuTriggerRef.current)}
                >
                  <Trash2 /> 删除
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge variant="secondary">{kindMeta[server.kind].label}</Badge>
          {server.lastTestOk === true ? (
            <span
              className="text-xs text-muted-foreground"
              title={
                server.lastTestedAt ? `测试于 ${formatDateTime(server.lastTestedAt)}` : undefined
              }
            >
              连接正常
            </span>
          ) : server.lastTestOk === false ? (
            <span className="text-xs text-danger">上次测试失败</span>
          ) : null}
        </div>
        <code className="truncate font-mono text-xs text-muted-foreground" title={detailOf(server)}>
          {detailOf(server) || '—'}
        </code>
        <TestSummary
          state={lastTest}
          testing={testing}
          serverName={server.name}
          onOpen={(trigger) => onCatalog(trigger)}
        />
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          工具 {toolCount} · 绑定专家 {agentCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          aria-label={`编辑 ${server.name}`}
          onClick={(event) => onEdit(event.currentTarget)}
        >
          <Pencil data-icon="inline-start" /> 编辑
        </Button>
      </CardFooter>
    </Card>
  );
}

function TestSummary({
  state,
  testing,
  serverName,
  onOpen,
}: {
  state: LastTest | null;
  testing: boolean;
  serverName: string;
  onOpen: (trigger: HTMLElement) => void;
}) {
  if (testing) return <span className="text-xs text-muted-foreground">测试中…</span>;
  if (!state) return <span className="text-xs text-muted-foreground">未测试</span>;
  const { result, at } = state;
  return (
    <div className="flex flex-col gap-2">
      <div className="max-w-[220px] flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          {result.ok ? (
            <CircleCheck className="size-3.5 shrink-0 text-success" />
          ) : (
            <CircleAlert className="size-3.5 shrink-0 text-danger" />
          )}
          <span className={cn('text-xs font-medium', result.ok ? 'text-success' : 'text-danger')}>
            {result.ok ? '连接成功' : '未能连接'}
          </span>
          <span className="font-mono text-2xs tabular-nums text-muted-foreground">
            {formatDateTime(at)}
          </span>
        </div>
        <div className="font-mono text-2xs tabular-nums text-muted-foreground">
          耗时 {formatDuration(result.durationMs)}
        </div>
        {/* 列出工具名：只给数量无法判断「连上了但工具没注册」这种情况。 */}
        {result.ok && result.tools.length > 0 ? (
          <p
            className="truncate font-mono text-2xs text-muted-foreground"
            title={result.tools.map((tool) => tool.name).join(', ')}
          >
            {result.tools.map((tool) => tool.name).join(' · ')}
          </p>
        ) : null}
        {result.error ? (
          <p className="truncate text-2xs text-danger" title={result.error}>
            {result.error}
          </p>
        ) : null}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        aria-label={`查看 ${serverName} 工具与测试详情`}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        查看工具与测试详情
      </Button>
    </div>
  );
}

/** 只读策划目录；选中只预填创建表单，不创建、不执行任何命令。 */
function ConnectorCatalogDialog({
  onClose,
  onPick,
  getReturnFocus,
}: {
  onClose: () => void;
  onPick: (item: ConnectorCatalogItem) => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const catalog = useQuery(connectorCatalogQuery);

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogShell
        title="连接器目录"
        description="策划清单，仅用于预填创建表单；不会自动执行任何命令。"
        finalFocus={getReturnFocus}
        className="max-w-2xl sm:max-w-2xl"
      >
        {catalog.isPending ? <LoadingState rows={3} /> : null}
        {catalog.isError ? (
          <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
        ) : null}
        {catalog.data ? (
          <ul aria-label="连接器目录" className="flex flex-col divide-y border-y">
            {catalog.data.map((item) => (
              <li key={item.slug} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium text-fg">{item.name}</span>
                  <Badge variant="secondary">{item.kind === 'http' ? 'HTTP' : 'stdio'}</Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto"
                    onClick={() => onPick(item)}
                  >
                    使用
                  </Button>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{item.description}</p>
                {item.kind === 'stdio' ? (
                  <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                    <code className="break-words font-mono text-fg">
                      {[item.command, ...(item.args ?? [])].filter(Boolean).join(' ')}
                    </code>
                    {item.envKeys?.length ? (
                      <p className="break-words font-mono">
                        需要环境变量：{item.envKeys.join('、')}
                      </p>
                    ) : null}
                    <p className="text-danger">保存并测试时会在宿主执行上述命令。</p>
                  </div>
                ) : null}
                <a
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="w-fit text-xs text-muted-foreground underline underline-offset-4 hover:text-fg"
                >
                  来源
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </DialogShell>
    </Dialog>
  );
}

/** 只读最近测试返回的目录与脱敏错误摘要；打开时不发请求。 */
function ToolCatalogDialog({
  server,
  lastTest,
  pending,
  testing,
  onRetest,
  onClose,
  getReturnFocus,
}: {
  server: Server;
  lastTest: LastTest;
  pending: boolean;
  testing: boolean;
  onRetest: () => void;
  onClose: () => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const result = lastTest.result;
  const tools = result.ok ? result.tools : [];

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogShell
        title={`工具与测试「${server.name}」`}
        description="最近一次测试结果"
        finalFocus={getReturnFocus}
        className="max-w-2xl sm:max-w-2xl"
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
            {result?.serverInfo ? (
              <span className="font-mono">
                {result.serverInfo.name} {result.serverInfo.version}
              </span>
            ) : null}
            {lastTest && result ? (
              <span className="font-mono tabular-nums">
                {formatDateTime(lastTest.at)} · {formatDuration(result.durationMs)}
              </span>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={pending}
              aria-busy={testing}
              onClick={onRetest}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              {testing ? '测试中…' : '重新测试'}
            </Button>
          </div>

          {!result.ok ? (
            <Field className="gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">失败原因</span>
              {/* 原文展示，不截断也不解析：这条文本是定位连不上问题的唯一线索。 */}
              <p className="break-words rounded-item bg-danger-soft p-3 font-mono text-xs leading-relaxed text-danger">
                {result.error ?? '服务没有返回原因。'}
              </p>
            </Field>
          ) : null}

          {tools.length === 0 && result?.ok ? (
            <InlineEmpty>连接成功，但没有返回任何工具。</InlineEmpty>
          ) : null}

          {tools.length > 0 ? (
            <ul aria-label="工具目录" className="flex flex-col divide-y border-y">
              {tools.map((tool, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 上游工具没有稳定唯一键，同名工具也可能重复
                <li key={`${tool.name}-${index}`} className="flex flex-col gap-2 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-xs text-fg">{tool.name}</span>
                    {tool.title && tool.title !== tool.name ? (
                      <span className="text-xs text-muted-foreground">{tool.title}</span>
                    ) : null}
                  </div>
                  {tool.description ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {tool.description}
                    </p>
                  ) : null}
                  {tool.inputSchema ? (
                    <JsonBlock value={tool.inputSchema} maxHeight="12rem" />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </DialogShell>
    </Dialog>
  );
}

function DeleteServerDialog({
  server,
  onClose,
  getReturnFocus,
}: {
  server: Server;
  onClose: () => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const remove = useDeleteServer();
  const agents = useAgents();
  const tools = useTools(server.kind === 'generated' ? server.id : null);
  const [typed, setTyped] = useState('');

  const bound = (agents.data ?? []).filter((agent) => agent.serverIds.includes(server.id));
  const toolCount = tools.data?.length ?? 0;
  const loading = agents.isPending || (server.kind === 'generated' && tools.isPending);
  const unknown = agents.isError || (server.kind === 'generated' && tools.isError);
  const risky = bound.length > 0 || toolCount > 0;
  const confirmed = !risky || typed.trim() === server.name;

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      finalFocus={getReturnFocus}
      title={`删除 server「${server.name}」`}
      description="删除后无法恢复；绑定它的智能体会立即失去这个工具来源。"
      confirmLabel="删除"
      confirmDisabled={loading || unknown || !confirmed}
      onConfirm={async () => {
        await remove.mutateAsync(server.id);
        toastSuccess('Server 已删除');
      }}
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-item bg-danger-soft p-3">
          <p className="text-xs text-danger">影响范围</p>
          {loading ? (
            <p className="mt-1 text-xs text-muted-foreground">正在读取绑定关系…</p>
          ) : unknown ? (
            <p className="mt-1 text-xs text-danger">
              读取不到完整的绑定关系，暂时无法安全删除。请刷新后重试，或先到智能体页确认。
            </p>
          ) : (
            <>
              <ul className="mt-1 flex flex-col gap-0.5 text-xs text-fg">
                <li>
                  工具 <span className="font-mono tabular-nums">{toolCount}</span> 个
                  {toolCount > 0 ? '，会一并删除' : ''}
                </li>
                <li>
                  智能体 <span className="font-mono tabular-nums">{bound.length}</span> 个
                  {bound.length > 0 ? '，会失去这些工具' : ''}
                </li>
              </ul>
              {bound.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-0.5 border-t border-line pt-2 text-xs text-fg">
                  {bound.map((agent) => (
                    <li key={agent.id}>· {agent.name}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>

        {bound.length > 0 ? (
          <Link
            to="/agents"
            className="inline-block self-start text-xs font-medium text-fg underline decoration-line-strong underline-offset-2"
          >
            先去解绑
          </Link>
        ) : null}

        {risky && !loading && !unknown ? (
          <Field className="gap-1.5">
            <FieldLabel htmlFor="delete-server-confirm">
              输入 <span className="font-mono">{server.name}</span> 以确认
              <RequiredMark />
            </FieldLabel>
            <Input
              id="delete-server-confirm"
              value={typed}
              autoComplete="off"
              aria-required
              aria-describedby="delete-server-confirm-hint"
              onChange={(event) => setTyped(event.target.value)}
            />
            <FieldDescription id="delete-server-confirm-hint">
              名称必须完全一致；误删后绑定的智能体不会自动恢复。
            </FieldDescription>
          </Field>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}

function ConnectionDialog({
  server,
  onClose,
  getReturnFocus,
}: {
  server: Server;
  onClose: () => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const token = useServerToken(server.id);
  const rotate = useRotateServerToken(server.id);
  // 轮换后只在这里保留明文；关闭对话框即丢弃。
  const [revealed, setRevealed] = useState<{ token: string; endpoint: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const data = revealed ?? token.data;
  const retry = (): void => {
    void token.refetch();
  };

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (next) return;
        // 轮换进行中关闭会丢掉新 token；请求完成前不允许关闭。
        if (rotate.isPending) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogShell
        title={`连接「${server.name}」`}
        description="外部 Host 用这个端点与 Bearer token 访问；token 只在这里轮换时才显示明文。"
        finalFocus={getReturnFocus}
        closeDisabled={rotate.isPending}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Endpoint</span>
            {token.isError && !revealed ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                Endpoint 读取失败。
                <Button variant="outline" size="sm" onClick={retry}>
                  <RefreshCw className="size-3.5" aria-hidden="true" /> 重试
                </Button>
              </p>
            ) : (
              <CodeBlock code={data?.endpoint ?? '加载中…'} copyLabel="复制 Endpoint" />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Token</span>
            {data ? (
              // 未轮换时接口只回掩码：那不是可用的 token，不能让用户复制。
              data.token === SECRET_MASK || !revealed ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {SECRET_MASK} 已配置。点「轮换 Token」生成新的明文，旧的立即失效。
                </p>
              ) : (
                <CodeBlock code={data.token} copyLabel="复制 Token" />
              )
            ) : token.isError ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                Token 读取失败。
                <Button variant="outline" size="sm" onClick={retry}>
                  <RefreshCw className="size-3.5" aria-hidden="true" /> 重试
                </Button>
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">加载中…</p>
            )}
            {revealed ? (
              <p role="status" className="text-2xs leading-relaxed text-warning">
                只显示这一次，请立即保存；旧 token 已失效。
              </p>
            ) : null}
          </div>
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              disabled={rotate.isPending}
              aria-busy={rotate.isPending}
              onClick={() => setConfirming(true)}
            >
              <KeyRound className="size-3.5" /> {rotate.isPending ? '轮换中' : '轮换'}
            </Button>
          </div>
        </div>
        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title="轮换 token？"
          description="旧 token 立即失效，正在使用的外部 Host 会中断。旧值不会再显示，只能把新 token 配置到每个 Host。"
          confirmLabel="轮换 token"
          onConfirm={async () => {
            const result = await rotate.mutateAsync(undefined);
            setRevealed(result);
          }}
        />
      </DialogShell>
    </Dialog>
  );
}

function ToolEditorDialog({
  server,
  onClose,
  getReturnFocus,
}: {
  server: Server;
  onClose: () => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const tools = useTools(server.id);
  const remove = useDeleteTool(server.id);
  const setEnabled = useSetToolEnabled(server.id);
  const [editing, setEditing] = useState<ApiTool | null>(null);
  const [deleting, setDeleting] = useState<ApiTool | null>(null);
  const switching = useRef(false);
  // 表单是弹层里唯一未保存的内容：关闭与「取消编辑」都走同一道确认。
  const [formDirty, setFormDirty] = useState(false);
  const [formPending, setFormPending] = useState(false);
  const [discard, setDiscard] = useState<{ run: () => void } | null>(null);

  const guarded = (run: () => void): void => {
    if (formPending || setEnabled.isPending || remove.isPending) return;
    if (formDirty) {
      setDiscard({ run });
      return;
    }
    run();
  };

  const setTool = async (vars: {
    toolId: string;
    enabled?: boolean;
    requiresApproval?: boolean;
  }): Promise<void> => {
    if (switching.current || formPending || remove.isPending) return;
    switching.current = true;
    try {
      await setEnabled.mutateAsync(vars);
    } catch (error) {
      toastError(error);
    } finally {
      switching.current = false;
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (next) return;
        // 未保存或请求中时由页面决定是否关闭，先撤销这次关闭请求。
        if (formPending || formDirty || setEnabled.isPending || remove.isPending) details.cancel();
        guarded(onClose);
      }}
    >
      <DialogShell
        title={`工具定义「${server.name}」`}
        description="每个上游 HTTP 端点对应一个 MCP 工具。路径里的 {param} 必须在 inputSchema.properties 中有同名属性。"
        finalFocus={getReturnFocus}
        closeDisabled={formPending || setEnabled.isPending || remove.isPending}
        className="max-w-3xl sm:max-w-3xl"
      >
        <div className="flex flex-col gap-5">
          {tools.isPending ? <LoadingState rows={2} /> : null}
          {tools.isError ? (
            <ErrorState error={tools.error} onRetry={() => void tools.refetch()} />
          ) : null}
          {tools.data && tools.data.length === 0 ? (
            <InlineEmpty>在下方声明第一个 HTTP 端点，供智能体调用。</InlineEmpty>
          ) : null}
          {tools.data && tools.data.length > 0 ? (
            <Table>
              <caption className="sr-only">生成的工具定义</caption>
              <TableHeader>
                {/* Keep table headings static when the pointer crosses the header. */}
                <TableRow className="hover:bg-transparent">
                  <TableHead>名称</TableHead>
                  <TableHead className="w-20">方法</TableHead>
                  <TableHead>路径</TableHead>
                  <TableHead className="w-20">参数</TableHead>
                  <TableHead className="w-16">启用</TableHead>
                  <TableHead className="w-16">审批</TableHead>
                  <TableHead className="w-20">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tools.data.map((tool) => (
                  // Keep tool rows on the same light chip hover surface as server rows.
                  <TableRow key={tool.id} className="h-14 hover:bg-chip">
                    <TableCell>
                      <span className="font-mono text-xs text-fg">{tool.name}</span>
                      {tool.description ? (
                        <div className="max-w-xs truncate text-2xs text-muted-foreground">
                          {tool.description}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <span className="rounded-tag bg-chip px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                        {tool.method}
                      </span>
                    </TableCell>
                    {/* Keep paths compact and monospaced beside tool metadata. */}
                    <TableCell className="font-mono text-2xs text-muted-foreground">
                      {tool.pathTemplate}
                    </TableCell>
                    {/* Keep parameter placement subordinate to the tool name. */}
                    <TableCell className="text-2xs text-muted-foreground">
                      {tool.paramsIn}
                    </TableCell>
                    <TableCell>
                      <Checkbox
                        className="size-3.5"
                        aria-label={`启用工具 ${tool.name}`}
                        checked={tool.enabled}
                        disabled={setEnabled.isPending || formPending || remove.isPending}
                        onCheckedChange={(enabled) => void setTool({ toolId: tool.id, enabled })}
                      />
                    </TableCell>
                    <TableCell>
                      <Checkbox
                        className="size-3.5"
                        aria-label={`批准工具 ${tool.name}`}
                        checked={tool.requiresApproval}
                        disabled={
                          editing?.id === tool.id ||
                          setEnabled.isPending ||
                          formPending ||
                          remove.isPending
                        }
                        onCheckedChange={(requiresApproval) =>
                          void setTool({ toolId: tool.id, requiresApproval })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`编辑工具 ${tool.name}`}
                          disabled={formPending || setEnabled.isPending || remove.isPending}
                          onClick={() => guarded(() => setEditing(tool))}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`删除工具 ${tool.name}`}
                          // Signal deletion on hover while keeping the neutral ghost button at rest.
                          className="hover:text-danger"
                          disabled={formPending || setEnabled.isPending || remove.isPending}
                          onClick={() => {
                            if (formPending || switching.current || remove.isPending) return;
                            setDeleting(tool);
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}

          <ToolForm
            key={editing?.id ?? 'new'}
            serverId={server.id}
            tool={editing}
            disabled={setEnabled.isPending || remove.isPending}
            onDirtyChange={setFormDirty}
            onPendingChange={setFormPending}
            onDone={() => setEditing(null)}
            onCancel={() => guarded(() => setEditing(null))}
          />

          <ConfirmDialog
            open={deleting !== null}
            onClose={() => setDeleting(null)}
            title={`删除工具「${deleting?.name ?? ''}」`}
            description="智能体将无法再调用该工具。此操作不可撤销。"
            onConfirm={async () => {
              if (!deleting || formPending || switching.current) return;
              await remove.mutateAsync(deleting.id);
              if (editing?.id === deleting.id) setEditing(null);
            }}
          />
          <ConfirmDialog
            open={discard !== null}
            onClose={() => setDiscard(null)}
            title="放弃未保存的更改？"
            description="关闭后这个工具的修改会丢失。"
            confirmLabel="放弃"
            onConfirm={async () => {
              discard?.run();
            }}
          />
        </div>
      </DialogShell>
    </Dialog>
  );
}

interface ToolFormValues {
  name: string;
  description: string;
  method: ApiToolInput['method'];
  pathTemplate: string;
  inputSchema: string;
  paramsIn: ApiToolInput['paramsIn'];
  requiresApproval: boolean;
}

const blankSchemaText = '{\n  "type": "object",\n  "properties": {}\n}';

const blankToolForm: ToolFormValues = {
  name: '',
  description: '',
  method: 'GET',
  pathTemplate: '/',
  inputSchema: blankSchemaText,
  paramsIn: 'query',
  requiresApproval: false,
};

/** validateToolInput 只读 form 的标量字段，schema 文本单独传入。 */
function toolPayload(values: ToolFormValues): ApiToolInput {
  return {
    name: values.name,
    description: values.description,
    method: values.method,
    pathTemplate: values.pathTemplate,
    inputSchema: {},
    paramsIn: values.paramsIn,
    requiresApproval: values.requiresApproval,
  };
}

const toolFormSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    pathTemplate: z.string(),
    inputSchema: z.string(),
    paramsIn: z.enum(['query', 'body']),
    requiresApproval: z.boolean(),
  })
  .superRefine((values, ctx) => {
    const result = validateToolInput(toolPayload(values), values.inputSchema);
    if (result.data) return;
    for (const [key, message] of Object.entries(result.errors)) {
      ctx.addIssue({ code: 'custom', path: [key], message });
    }
  });

function toolToForm(tool: ApiTool): ToolFormValues {
  return {
    name: tool.name,
    description: tool.description,
    method: tool.method,
    pathTemplate: tool.pathTemplate,
    inputSchema: JSON.stringify(tool.inputSchema, null, 2),
    paramsIn: tool.paramsIn,
    requiresApproval: tool.requiresApproval,
  };
}

/** 同一个表单用于新增与编辑；编辑时提交按钮换成「保存更改」。 */
export function ToolForm({
  serverId,
  tool,
  disabled,
  onDirtyChange,
  onPendingChange,
  onDone,
  onCancel,
}: {
  serverId: string;
  tool: ApiTool | null;
  disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const create = useCreateTool(serverId);
  const update = useUpdateTool(serverId);
  const { register, control, handleSubmit, reset, watch, formState } = useZodForm(toolFormSchema, {
    defaultValues: tool ? toolToForm(tool) : blankToolForm,
  });
  const { errors, isDirty } = formState;
  const watched = watch();

  // 只有这个表单自己的保存会改变可关闭状态；行内开关不算。
  const formPending = create.isPending || update.isPending;
  const pending = disabled || formPending;
  const dirty = isDirty;
  const blocker = useFormBlocker(dirty, pending);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onPendingChange(formPending);
  }, [formPending, onPendingChange]);
  // 提交成功后父级会卸载本表单；卸载时清掉父级的脏/请求中状态。
  useEffect(
    () => () => {
      onDirtyChange(false);
      onPendingChange(false);
    },
    [onDirtyChange, onPendingChange],
  );

  const submit = handleSubmit((values) => {
    if (pending) return;
    const result = validateToolInput(toolPayload(values), values.inputSchema);
    if (!result.data) return;
    const payload = result.data;

    if (!tool) {
      create.mutate(payload, {
        onSuccess: () => {
          reset(blankToolForm);
          toastSuccess('工具已添加');
        },
        onError: (error) => toastError(error),
      });
      return;
    }

    // 一次 PATCH 完成：工具 id 不变，运行中的审批与外键引用不会断。
    update.mutate(
      { toolId: tool.id, patch: payload },
      {
        onSuccess: () => {
          toastSuccess('工具已更新');
          onDone();
        },
        onError: (error) => toastError(error),
      },
    );
  });

  const methodOptions = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => ({
    value: method,
    label: method,
  }));
  const paramsOptions = [
    { value: 'query', label: 'query' },
    { value: 'body', label: 'body' },
  ];

  return (
    <form
      className="grid gap-3 border-t pt-5 sm:grid-cols-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      noValidate
    >
      <div className="flex items-baseline justify-between gap-2 sm:col-span-6">
        <h3 className="text-xs text-muted-foreground">
          {tool ? `编辑工具 ${tool.name}` : '添加工具'}
        </h3>
        {tool ? (
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={pending}>
            取消编辑
          </Button>
        ) : null}
      </div>
      <Field
        data-disabled={pending}
        className="gap-1.5 sm:col-span-2"
        data-invalid={Boolean(errors.name)}
      >
        <FieldLabel htmlFor={`tool-name-${serverId}`}>
          名称
          <RequiredMark />
        </FieldLabel>
        <Input
          {...register('name')}
          value={watched.name}
          disabled={pending}
          id={`tool-name-${serverId}`}
          placeholder="list-users"
          aria-required
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? `tool-name-error-${serverId}` : undefined}
        />
        <FieldError id={`tool-name-error-${serverId}`}>{errors.name?.message}</FieldError>
      </Field>
      <Field data-disabled={pending} className="gap-1.5">
        <FieldLabel htmlFor={`tool-method-${serverId}`}>方法</FieldLabel>
        <Controller
          control={control}
          name="method"
          render={({ field }) => (
            <Select
              disabled={pending}
              value={field.value}
              onValueChange={(next) => {
                if (next !== null) field.onChange(next);
              }}
              items={methodOptions}
            >
              <SelectTrigger id={`tool-method-${serverId}`} ref={field.ref} onBlur={field.onBlur}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {methodOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        />
      </Field>
      <Field
        data-disabled={pending}
        className="gap-1.5 sm:col-span-2"
        data-invalid={Boolean(errors.pathTemplate)}
      >
        <FieldLabel htmlFor={`tool-path-${serverId}`}>
          路径
          <RequiredMark />
        </FieldLabel>
        <Input
          {...register('pathTemplate')}
          value={watched.pathTemplate}
          disabled={pending}
          id={`tool-path-${serverId}`}
          placeholder="/users/{id}"
          aria-required
          aria-invalid={Boolean(errors.pathTemplate)}
          aria-describedby={errors.pathTemplate ? `tool-path-error-${serverId}` : undefined}
        />
        <FieldError id={`tool-path-error-${serverId}`}>{errors.pathTemplate?.message}</FieldError>
      </Field>
      <Field data-disabled={pending} className="gap-1.5">
        <FieldLabel htmlFor={`tool-params-${serverId}`}>参数位置</FieldLabel>
        <Controller
          control={control}
          name="paramsIn"
          render={({ field }) => (
            <Select
              disabled={pending}
              value={field.value}
              onValueChange={(next) => {
                if (next !== null) field.onChange(next);
              }}
              items={paramsOptions}
            >
              <SelectTrigger id={`tool-params-${serverId}`} ref={field.ref} onBlur={field.onBlur}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {paramsOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        />
      </Field>
      <Field
        data-disabled={pending}
        className="gap-1.5 sm:col-span-5"
        data-invalid={Boolean(errors.description)}
      >
        <FieldLabel htmlFor={`tool-desc-${serverId}`}>描述</FieldLabel>
        <Input
          {...register('description')}
          value={watched.description}
          disabled={pending}
          id={`tool-desc-${serverId}`}
          aria-invalid={Boolean(errors.description)}
          aria-describedby={errors.description ? `tool-desc-error-${serverId}` : undefined}
          placeholder="告诉智能体这个工具做什么、何时用"
        />
        <FieldError id={`tool-desc-error-${serverId}`}>{errors.description?.message}</FieldError>
      </Field>
      <Field
        data-disabled={pending}
        className="gap-1.5 sm:col-span-5"
        data-invalid={Boolean(errors.inputSchema)}
      >
        <FieldLabel htmlFor={`tool-schema-${serverId}`}>inputSchema (JSON)</FieldLabel>
        <Controller
          control={control}
          name="inputSchema"
          render={({ field }) => (
            <SourceEditor
              id={`tool-schema-${serverId}`}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              language="json"
              aria-label="inputSchema (JSON)"
              aria-invalid={Boolean(errors.inputSchema)}
              aria-describedby={errors.inputSchema ? `tool-schema-error-${serverId}` : undefined}
              disabled={pending}
              className="min-h-[10rem]"
            />
          )}
        />
        <FieldError id={`tool-schema-error-${serverId}`}>{errors.inputSchema?.message}</FieldError>
      </Field>
      <Field data-disabled={pending} orientation="horizontal" className="pt-1 sm:col-span-6">
        <Controller
          control={control}
          name="requiresApproval"
          render={({ field }) => (
            <Checkbox
              ref={field.ref}
              disabled={pending}
              id={`tool-approval-${serverId}`}
              className="size-3.5"
              checked={field.value}
              onCheckedChange={(requiresApproval) => field.onChange(requiresApproval)}
              onBlur={field.onBlur}
            />
          )}
        />
        <FieldLabel htmlFor={`tool-approval-${serverId}`}>调用前需要人工批准</FieldLabel>
      </Field>
      <div className="flex items-start pt-2">
        <Button type="submit" size="sm" disabled={pending || !watched.name}>
          {pending ? (
            '保存中…'
          ) : tool ? (
            '保存更改'
          ) : (
            <>
              <Plus className="size-4" /> 添加
            </>
          )}
        </Button>
      </div>
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="放弃未保存的更改？"
        description={pending ? '正在保存，请等待请求完成。' : '离开后工具配置的修改会丢失。'}
        confirmLabel="放弃并离开"
        confirmDisabled={pending}
        onConfirm={async () => blocker.proceed()}
      />
    </form>
  );
}

interface ServerFormValues {
  kind: Kind | null;
  name: string;
  description: string;
  command: string;
  args: string;
  url: string;
  baseUrl: string;
  pairs: string;
}

const emptyForm: ServerFormValues = {
  kind: null,
  name: '',
  description: '',
  command: '',
  args: '',
  url: '',
  baseUrl: '',
  pairs: '',
};

/** 校验与 payload 构造共用同一份扁平表单值，先解析 KEY=value 再交给共享 schema。 */
function buildServerInput(values: ServerFormValues, pairs: Record<string, string>): ServerInput {
  const common = { name: values.name, description: values.description };
  if (values.kind === 'stdio') {
    return {
      ...common,
      kind: 'stdio',
      command: values.command,
      args: values.args
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      env: pairs,
    };
  }
  // http 与 generated 的地址属于不同字段：PATCH 与表单都按 kind 取用，不能互相顶替。
  if (values.kind === 'http') {
    return { ...common, kind: 'http', url: values.url, headers: pairs };
  }
  return { ...common, kind: 'generated', baseUrl: values.baseUrl, headers: pairs };
}

const serverFormSchema = z
  .object({
    kind: z.enum(['stdio', 'http', 'generated']).nullable(),
    name: z.string(),
    description: z.string(),
    command: z.string(),
    args: z.string(),
    url: z.string(),
    baseUrl: z.string(),
    pairs: z.string(),
  })
  .superRefine((values, ctx) => {
    if (!values.kind) return;
    let pairs: Record<string, string>;
    try {
      pairs = parsePairs(values.pairs, values.kind === 'stdio' ? 'env' : 'headers');
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['pairs'],
        message: error instanceof Error ? error.message : '请检查 KEY=value 格式',
      });
      return;
    }
    const parsed = serverInputSchema.safeParse(buildServerInput(values, pairs));
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: 'custom',
        path: issue.path as (string | number)[],
        message: Object.values(fieldErrors([issue]))[0] ?? issue.message,
      });
    }
  });

function serverToForm(server: Server): ServerFormValues {
  const common = { kind: server.kind, name: server.name, description: server.description };
  switch (server.kind) {
    case 'stdio':
      return {
        ...common,
        command: server.command,
        args: server.args.join('\n'),
        url: '',
        baseUrl: '',
        pairs: formatPairs(server.env),
      };
    case 'http':
      return {
        ...common,
        command: '',
        args: '',
        url: server.url,
        baseUrl: '',
        pairs: formatPairs(server.headers),
      };
    case 'generated':
      return {
        ...common,
        command: '',
        args: '',
        url: '',
        baseUrl: server.baseUrl,
        pairs: formatPairs(server.headers),
      };
  }
}

function catalogToForm(item: ConnectorCatalogItem): ServerFormValues {
  // 名称用 slug：目录里的展示名可能含大写或括号，过不了 name 的 slug 校验。
  const common = { kind: item.kind, name: item.slug, description: item.description };
  if (item.kind === 'stdio') {
    return {
      ...emptyForm,
      ...common,
      command: item.command ?? '',
      args: (item.args ?? []).join('\n'),
    };
  }
  return { ...emptyForm, ...common, url: item.url ?? '' };
}

export function ServerFormDialog({
  server,
  initial = null,
  onClose,
  onSaved,
  getReturnFocus,
}: {
  server: Server | null;
  initial?: ConnectorCatalogItem | null;
  onClose: () => void;
  onSaved: (server: Server, created: boolean) => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const creating = server === null;
  const prefill = creating && initial ? catalogToForm(initial) : null;
  const create = useCreateServer();
  const update = useUpdateServer();
  const { register, handleSubmit, reset, setValue, clearErrors, watch, formState } = useZodForm(
    serverFormSchema,
    { defaultValues: server ? serverToForm(server) : (prefill ?? emptyForm) },
  );
  const { errors, isDirty } = formState;
  const kind = watch('kind');
  const watched = watch();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [baseline, setBaseline] = useState(server);
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [reloading, setReloading] = useState(false);
  const dirty = isDirty;

  const pending = create.isPending || update.isPending || reloading;
  const blocker = useFormBlocker(dirty, pending);
  const reload = async (): Promise<void> => {
    if (!baseline || pending) return;
    setReloading(true);
    try {
      const latest = (await api.servers()).find((item) => item.id === baseline.id);
      if (!latest) throw new Error('该连接器已不存在，请关闭配置并刷新列表');
      setBaseline(latest);
      reset(serverToForm(latest));
      setConflict(false);
      setConfirmReload(false);
    } catch (error) {
      toastError(error);
    } finally {
      setReloading(false);
    }
  };
  // 半填的配置不能因为 Esc / 点遮罩就消失：脏时先确认；请求中一律不能关闭。
  const close = (): void => {
    if (pending) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const submit = handleSubmit((values) => {
    if (!values.kind || pending) return;
    const pairs = parsePairs(values.pairs, values.kind === 'stdio' ? 'env' : 'headers');
    const parsed = serverInputSchema.safeParse(buildServerInput(values, pairs));
    if (!parsed.success) return;
    if (baseline) {
      update.mutate(
        { id: baseline.id, input: parsed.data, expectedUpdatedAt: baseline.updatedAt },
        {
          onSuccess: (saved) => {
            toastSuccess('Server 已更新');
            onSaved(saved, false);
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
    } else {
      create.mutate(parsed.data, {
        onSuccess: (saved) => {
          toastSuccess('Server 已创建');
          onSaved(saved, true);
        },
        onError: (error) => toastError(error),
      });
    }
  });

  const urlLabel = kind === 'http' ? 'URL' : 'Base URL';
  const urlError = errors.url?.message ?? errors.baseUrl?.message;

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (next) return;
        if (pending || dirty) details.cancel();
        close();
      }}
    >
      <DialogShell
        title={creating ? '新建连接器' : `编辑「${server.name}」`}
        {...(!creating ? { description: '来源类型不可修改。' } : {})}
        finalFocus={getReturnFocus}
        closeDisabled={pending}
      >
        {conflict ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
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
          {creating ? (
            <FieldSet className="gap-2.5" disabled={pending} data-disabled={pending}>
              <FieldLegend className="mb-2.5 text-xs font-normal text-muted-foreground">
                来源类型
              </FieldLegend>
              <ToggleGroup
                disabled={pending}
                aria-label="来源类型"
                variant="outline"
                value={kind ? [kind] : []}
                onValueChange={(values) => {
                  const next = values[0];
                  if (next === 'stdio' || next === 'http' || next === 'generated') {
                    setValue('kind', next, { shouldDirty: true });
                    clearErrors();
                  }
                }}
                className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3"
              >
                {(Object.keys(kindMeta) as Kind[]).map((value) => (
                  <ToggleGroupItem
                    key={value}
                    value={value}
                    className="h-auto min-w-0 flex-col items-start gap-1 whitespace-normal px-3 py-2.5 text-left"
                  >
                    <span>{kindMeta[value].label}</span>
                    <span className="text-2xs font-normal leading-snug text-muted-foreground">
                      {kindMeta[value].newHint}
                    </span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FieldSet>
          ) : null}

          {kind === null ? null : (
            <>
              <Field
                data-disabled={pending}
                className="gap-1.5"
                data-invalid={Boolean(errors.name)}
              >
                <FieldLabel htmlFor="server-name">
                  名称
                  <RequiredMark />
                </FieldLabel>
                <Input
                  {...register('name')}
                  value={watched.name}
                  disabled={pending}
                  id="server-name"
                  placeholder="filesystem"
                  aria-required
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? 'server-name-error' : 'server-name-hint'}
                />
                {errors.name ? (
                  <FieldError id="server-name-error">{errors.name.message}</FieldError>
                ) : (
                  <FieldDescription id="server-name-hint">
                    小写字母、数字、- 和 _。
                  </FieldDescription>
                )}
              </Field>

              <Field
                data-disabled={pending}
                className="gap-1.5"
                data-invalid={Boolean(errors.description)}
              >
                <FieldLabel htmlFor="server-desc">描述</FieldLabel>
                <Input
                  {...register('description')}
                  value={watched.description}
                  disabled={pending}
                  id="server-desc"
                  aria-invalid={Boolean(errors.description)}
                  aria-describedby={errors.description ? 'server-desc-error' : undefined}
                  placeholder="一句话说明它提供什么能力"
                />
                <FieldError id="server-desc-error">{errors.description?.message}</FieldError>
              </Field>

              {kind === 'stdio' ? (
                <>
                  <Field
                    data-disabled={pending}
                    className="gap-1.5"
                    data-invalid={Boolean(errors.command)}
                  >
                    <FieldLabel htmlFor="server-command">
                      命令
                      <RequiredMark />
                    </FieldLabel>
                    <Input
                      {...register('command')}
                      value={watched.command}
                      disabled={pending}
                      id="server-command"
                      placeholder="npx"
                      className="font-mono"
                      aria-required
                      aria-invalid={Boolean(errors.command)}
                      aria-describedby={errors.command ? 'server-command-error' : undefined}
                    />
                    <FieldError id="server-command-error">{errors.command?.message}</FieldError>
                  </Field>
                  <Field data-disabled={pending} className="gap-1.5">
                    <FieldLabel htmlFor="server-args">参数（每行一个）</FieldLabel>
                    <Textarea
                      {...register('args')}
                      value={watched.args}
                      disabled={pending}
                      id="server-args"
                      rows={2}
                      // Keep configuration values compact and monospaced for literal editing.
                      className="font-mono text-xs"
                      placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/tmp'}
                    />
                  </Field>
                  <Field
                    data-disabled={pending}
                    className="gap-1.5"
                    data-invalid={Boolean(errors.pairs)}
                  >
                    <FieldLabel htmlFor="server-env">环境变量（每行 KEY=value）</FieldLabel>
                    <Textarea
                      {...register('pairs')}
                      value={watched.pairs}
                      disabled={pending}
                      id="server-env"
                      aria-invalid={Boolean(errors.pairs)}
                      aria-describedby={errors.pairs ? 'server-env-error' : 'server-env-hint'}
                      rows={2}
                      // Keep configuration values compact and monospaced for literal editing.
                      className="font-mono text-xs"
                      placeholder="TOKEN=…"
                    />
                    <FieldError id="server-env-error">{errors.pairs?.message}</FieldError>
                    <FieldDescription id="server-env-hint">
                      保存后密钥只以 •••• 返回；保持 •••• 不动即沿用原值。
                    </FieldDescription>
                  </Field>
                </>
              ) : (
                <>
                  <Field
                    data-disabled={pending}
                    className="gap-1.5"
                    data-invalid={Boolean(urlError)}
                  >
                    <FieldLabel htmlFor="server-url">
                      {urlLabel}
                      <RequiredMark />
                    </FieldLabel>
                    <Input
                      {...register(kind === 'http' ? 'url' : 'baseUrl')}
                      value={kind === 'http' ? watched.url : watched.baseUrl}
                      disabled={pending}
                      id="server-url"
                      placeholder={
                        kind === 'http' ? 'https://example.com/mcp' : 'https://api.example.com/v1'
                      }
                      className="font-mono text-xs"
                      aria-required
                      aria-invalid={Boolean(urlError)}
                      aria-describedby={urlError ? 'server-url-error' : 'server-url-hint'}
                    />
                    {urlError ? (
                      <FieldError id="server-url-error">{urlError}</FieldError>
                    ) : (
                      <FieldDescription id="server-url-hint">
                        {kind === 'http'
                          ? 'MCP 端点地址，平台直接与它通信。'
                          : '上游 API 的根地址；工具路径会拼在它后面。'}
                      </FieldDescription>
                    )}
                  </Field>
                  <Field
                    data-disabled={pending}
                    className="gap-1.5"
                    data-invalid={Boolean(errors.pairs)}
                  >
                    <FieldLabel htmlFor="server-headers">Headers（每行 KEY=value）</FieldLabel>
                    <Textarea
                      {...register('pairs')}
                      value={watched.pairs}
                      disabled={pending}
                      id="server-headers"
                      aria-invalid={Boolean(errors.pairs)}
                      aria-describedby={
                        errors.pairs ? 'server-headers-error' : 'server-headers-hint'
                      }
                      rows={2}
                      // Keep configuration values compact and monospaced for literal editing.
                      className="font-mono text-xs"
                      placeholder="Authorization=Bearer …"
                    />
                    <FieldError id="server-headers-error">{errors.pairs?.message}</FieldError>
                    <FieldDescription id="server-headers-hint">
                      保存后密钥只以 •••• 返回；保持 •••• 不动即沿用原值。
                    </FieldDescription>
                  </Field>
                  {kind === 'generated' ? (
                    <p className="rounded-item bg-chip p-3 text-xs leading-relaxed text-muted-foreground">
                      保存后会直接打开工具编辑，把上游 HTTP API 的端点声明成 MCP 工具。
                    </p>
                  ) : null}
                </>
              )}
            </>
          )}

          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" size="sm" onClick={close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={pending || kind === null} aria-busy={pending}>
              {pending ? '保存中…' : creating ? '创建' : '保存更改'}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后这个 Server 的修改会丢失，密钥需要重新填写。"
          confirmLabel="放弃并关闭"
          confirmDisabled={pending}
          onConfirm={async () => {
            if (!pending) onClose();
          }}
        />
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title="放弃未保存的更改？"
          description={pending ? '正在保存，请等待请求完成。' : '离开后连接器配置的修改会丢失。'}
          confirmLabel="放弃并离开"
          confirmDisabled={pending}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}
