import {
  type ApiTool,
  type ApiToolInput,
  type Server,
  type ServerInput,
  type ServerTestResult,
  serverInputSchema,
} from '@agentport/shared';
import { Link } from '@tanstack/react-router';
import {
  CircleAlert,
  CircleCheck,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  Server as ServerIcon,
  Trash2,
  Wrench,
} from 'lucide-react';
import * as DropdownMenuPrimitive from 'radix-ui/dropdown-menu';
import { type ComponentProps, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CodeBlock } from '../components/code-block.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Page, PageHeader, PageNote } from '../components/page.js';
import { ErrorState, InlineEmpty, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { Dialog } from '../components/ui/dialog.js';
import { FieldError, FieldHint, Input } from '../components/ui/input.js';
import { Label, RequiredMark } from '../components/ui/label.js';
import { Select } from '../components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from '../components/ui/table.js';
import { SearchInput } from '../components/ui/tabs.js';
import { Textarea } from '../components/ui/textarea.js';
import { ApiError } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { fieldErrors } from '../lib/form.js';
import { formatDateTime, formatDuration } from '../lib/format.js';
import {
  useAgents,
  useCreateServer,
  useCreateTool,
  useDeleteServer,
  useDeleteTool,
  useRotateServerToken,
  useServers,
  useServerToken,
  useSetToolEnabled,
  useTestServer,
  useTools,
  useUpdateServer,
  useUpdateTool,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';

type Kind = ServerInput['kind'];
type KindFilter = Kind | 'all';

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

const menuItemClass =
  'flex cursor-pointer select-none items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-sm text-fg outline-none data-[disabled]:pointer-events-none data-[disabled]:text-subtle data-[highlighted]:bg-hover';

/** 表单控件 36px / radius 9，跟随设计基准；表格行里的控件不受影响。 */
function LineInput({ className, ...props }: ComponentProps<'input'>) {
  return <Input className={cn('h-9 rounded-[9px] px-3', className)} {...props} />;
}

function CodeArea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <Textarea className={cn('rounded-[9px] px-3 py-2 leading-relaxed', className)} {...props} />
  );
}

/** 最近一次连接测试；只存在页面内存里，刷新或换设备后消失（后端没有持久化字段）。 */
interface LastTest {
  at: string;
  result: ServerTestResult;
}

/** 一行一个 `KEY=value`，值里允许出现 `=`。 */
function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    if (index > 0) out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return out;
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
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Server | null>(null);
  const [deleting, setDeleting] = useState<Server | null>(null);
  const [connection, setConnection] = useState<Server | null>(null);
  const [toolServer, setToolServer] = useState<Server | null>(null);
  const [tested, setTested] = useState<Map<string, LastTest>>(() => new Map());
  const createButtonRef = useRef<HTMLButtonElement>(null);

  const all = servers.data ?? [];

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter((server) => {
      if (kind !== 'all' && server.kind !== kind) return false;
      if (!needle) return true;
      return [server.name, server.description, detailOf(server)]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [all, kind, query]);

  const agentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agents.data ?? []) {
      for (const serverId of agent.serverIds) {
        counts.set(serverId, (counts.get(serverId) ?? 0) + 1);
      }
    }
    return counts;
  }, [agents.data]);

  const openCreate = (): void => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (server: Server): void => {
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
          toast.error(
            `没有连上 ${server.name}：${result.error ?? '服务没有返回原因，请检查地址与网络后重试'}`,
          );
        }
      },
      onError: (error) => toastError(error),
    });
  };

  return (
    <Page>
      <PageHeader
        title="MCP Servers"
        meta={<span className="font-mono text-xs tabular-nums text-subtle">{all.length}</span>}
        actions={
          <>
            <Select
              aria-label="按来源筛选"
              value={kind}
              onValueChange={(next) => setKind(next as KindFilter)}
              options={[
                { value: 'all', label: '全部来源' },
                { value: 'stdio', label: kindMeta.stdio.label },
                { value: 'http', label: kindMeta.http.label },
                { value: 'generated', label: kindMeta.generated.label },
              ]}
              className="w-36 rounded-[9px] border-transparent bg-chip hover:bg-hover"
            />
            <SearchInput
              label="搜索 server"
              value={query}
              onChange={setQuery}
              placeholder="搜索名称、描述或地址…"
              className="w-56 [&_input]:rounded-[9px] [&_input]:border-transparent [&_input]:bg-chip"
            />
            <Button
              ref={createButtonRef}
              size="sm"
              className="h-8 rounded-full px-3.5"
              onClick={openCreate}
            >
              <Plus className="size-4" strokeWidth={1.75} /> 新建 Server
            </Button>
          </>
        }
      />

      {servers.isPending ? <LoadingState rows={4} /> : null}
      {servers.isError ? (
        <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />
      ) : null}

      {servers.data && all.length === 0 ? (
        <PageNote
          icon={<ServerIcon className="size-4" strokeWidth={1.75} aria-hidden="true" />}
          title="还没有 MCP Server"
          description="本地命令适合自建工具，远程 MCP 适合已有服务，HTTP API 转 MCP 适合把内部接口直接交给智能体。"
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-3.5" /> 新建 Server
            </Button>
          }
        />
      ) : null}

      {servers.data && all.length > 0 && filtered.length === 0 ? (
        <PageNote
          title="没有匹配的 server"
          description="换个关键词，或清除来源筛选。"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery('');
                setKind('all');
              }}
            >
              清除筛选
            </Button>
          }
        />
      ) : null}

      {filtered.length > 0 ? (
        <TableWrap label="MCP Server 列表">
          <Table>
            <caption className="sr-only">MCP Server 列表</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-2">名称</TableHead>
                <TableHead className="w-36">来源</TableHead>
                <TableHead>地址摘要</TableHead>
                <TableHead className="w-20 text-right">工具数</TableHead>
                <TableHead className="w-56">最近测试</TableHead>
                <TableHead className="w-28 text-right">绑定智能体数</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((server) => (
                <ServerRow
                  key={server.id}
                  server={server}
                  agentCount={agentCounts.get(server.id) ?? 0}
                  lastTest={tested.get(server.id) ?? null}
                  testing={test.isPending && test.variables === server.id}
                  onTest={() => runTest(server)}
                  onTools={() => setToolServer(server)}
                  onConnection={() => setConnection(server)}
                  onEdit={() => openEdit(server)}
                  onDelete={() => setDeleting(server)}
                />
              ))}
            </TableBody>
          </Table>
        </TableWrap>
      ) : null}

      {formOpen ? (
        <ServerFormDialog
          key={editing?.id ?? 'new'}
          returnFocusRef={createButtonRef}
          server={editing}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onSaved={(saved, created) => {
            setFormOpen(false);
            setEditing(null);
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

      {toolServer ? (
        <ToolEditorDialog
          server={toolServer}
          returnFocusRef={createButtonRef}
          onClose={() => setToolServer(null)}
        />
      ) : null}

      {connection ? (
        <ConnectionDialog server={connection} onClose={() => setConnection(null)} />
      ) : null}

      {deleting ? <DeleteServerDialog server={deleting} onClose={() => setDeleting(null)} /> : null}
    </Page>
  );
}

function ServerRow({
  server,
  agentCount,
  lastTest,
  testing,
  onTest,
  onTools,
  onConnection,
  onEdit,
  onDelete,
}: {
  server: Server;
  agentCount: number;
  lastTest: LastTest | null;
  testing: boolean;
  onTest: () => void;
  onTools: () => void;
  onConnection: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const generated = server.kind === 'generated';
  // 工具数是这个列表的一等信息：server 有配置但零工具时，它其实还不能用。
  const tools = useTools(generated ? server.id : null);

  return (
    <TableRow data-slot="server-row" className="h-14 hover:bg-chip">
      <TableCell className="pl-2">
        <div className="min-w-0">
          <div className="truncate text-base text-fg">{server.name}</div>
          {server.description ? (
            <div className="max-w-[280px] truncate text-2xs text-subtle">{server.description}</div>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <span className="rounded-[6px] bg-chip px-1.5 py-0.5 text-2xs text-muted">
          {kindMeta[server.kind].label}
        </span>
      </TableCell>
      <TableCell>
        <code
          className="block max-w-[300px] truncate font-mono text-2xs text-muted"
          title={detailOf(server)}
        >
          {detailOf(server) || '—'}
        </code>
      </TableCell>
      <TableCell className="text-right">
        <span className="font-mono text-xs tabular-nums text-fg">
          {generated ? (tools.data ? tools.data.length : tools.isError ? '—' : '…') : 0}
        </span>
      </TableCell>
      <TableCell>
        <TestSummary state={lastTest} testing={testing} />
      </TableCell>
      <TableCell className="text-right">
        <span className="font-mono text-xs tabular-nums text-fg">{agentCount}</span>
      </TableCell>
      <TableCell>
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`操作 ${server.name}`}>
              <MoreHorizontal className="size-4" strokeWidth={1.75} />
            </Button>
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="end"
              sideOffset={4}
              className="z-50 min-w-40 rounded-[12px] border border-line bg-surface p-1 shadow-overlay"
            >
              <DropdownMenuPrimitive.Item
                disabled={testing}
                onSelect={onTest}
                className={menuItemClass}
              >
                <Plug className="size-4" strokeWidth={1.75} /> {testing ? '测试中…' : '测试连接'}
              </DropdownMenuPrimitive.Item>
              {generated ? (
                <>
                  <DropdownMenuPrimitive.Item onSelect={onTools} className={menuItemClass}>
                    <Wrench className="size-4" strokeWidth={1.75} /> 工具定义
                  </DropdownMenuPrimitive.Item>
                  <DropdownMenuPrimitive.Item onSelect={onConnection} className={menuItemClass}>
                    <KeyRound className="size-4" strokeWidth={1.75} /> 连接信息
                  </DropdownMenuPrimitive.Item>
                </>
              ) : null}
              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-line" />
              <DropdownMenuPrimitive.Item onSelect={onEdit} className={menuItemClass}>
                <Pencil className="size-4" strokeWidth={1.75} /> 编辑
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item
                onSelect={onDelete}
                className={cn(menuItemClass, 'text-danger data-[highlighted]:bg-danger-soft')}
              >
                <Trash2 className="size-4" strokeWidth={1.75} /> 删除
              </DropdownMenuPrimitive.Item>
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
      </TableCell>
    </TableRow>
  );
}

function TestSummary({ state, testing }: { state: LastTest | null; testing: boolean }) {
  if (testing) return <span className="text-xs text-muted">测试中…</span>;
  if (!state) return <span className="text-xs text-subtle">未测试</span>;
  const { result, at } = state;
  return (
    <div className="max-w-[220px] space-y-0.5">
      <div className="flex items-center gap-1.5">
        {result.ok ? (
          <CircleCheck className="size-3.5 shrink-0 text-success" />
        ) : (
          <CircleAlert className="size-3.5 shrink-0 text-danger" />
        )}
        <span className={cn('text-xs font-medium', result.ok ? 'text-success' : 'text-danger')}>
          {result.ok ? '连接成功' : '未能连接'}
        </span>
        <span className="font-mono text-2xs tabular-nums text-subtle">{formatDateTime(at)}</span>
      </div>
      <div className="font-mono text-2xs tabular-nums text-subtle">
        耗时 {formatDuration(result.durationMs)} · 工具 {result.tools.length}
      </div>
      {/* 列出工具名：只给数量无法判断「连上了但工具没注册」这种情况。 */}
      {result.ok && result.tools.length > 0 ? (
        <p
          className="truncate font-mono text-2xs text-muted"
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
  );
}

function DeleteServerDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const remove = useDeleteServer();
  const agents = useAgents();
  const tools = useTools(server.kind === 'generated' ? server.id : null);
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);

  const bound = (agents.data ?? []).filter((agent) => agent.serverIds.includes(server.id));
  const generated = server.kind === 'generated';
  const toolCount = tools.data?.length ?? 0;
  const loading = agents.isPending || (generated && tools.isPending);
  const unknown = agents.isError || (generated && tools.isError);
  const risky = bound.length > 0 || toolCount > 0;
  const confirmed = !risky || typed.trim() === server.name;

  const confirm = async (): Promise<void> => {
    setPending(true);
    try {
      await remove.mutateAsync(server.id);
      toastSuccess('Server 已删除');
      onClose();
    } catch (error) {
      toastError(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`删除 server「${server.name}」`}
      description="删除后无法恢复；绑定它的智能体会立即失去这个工具来源。"
    >
      <div className="space-y-4">
        <div className="rounded-[9px] bg-danger-soft p-3">
          <p className="text-xs text-danger">影响范围</p>
          {loading ? (
            <p className="mt-1 text-xs text-muted">正在读取绑定关系…</p>
          ) : unknown ? (
            <p className="mt-1 text-xs text-danger">
              读取不到完整的绑定关系，暂时无法安全删除。请刷新后重试，或先到智能体页确认。
            </p>
          ) : (
            <>
              <ul className="mt-1 space-y-0.5 text-xs text-fg">
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
                <ul className="mt-2 space-y-0.5 border-t border-danger-line pt-2 text-xs text-fg">
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
            className="inline-block text-xs font-medium text-fg underline decoration-line-strong underline-offset-2"
          >
            先去解绑
          </Link>
        ) : null}

        {risky && !loading && !unknown ? (
          <div className="space-y-1.5">
            <Label htmlFor="delete-server-confirm">
              输入 <span className="font-mono">{server.name}</span> 以确认
              <RequiredMark />
            </Label>
            <LineInput
              id="delete-server-confirm"
              value={typed}
              autoComplete="off"
              aria-describedby="delete-server-confirm-hint"
              onChange={(event) => setTyped(event.target.value)}
            />
            <FieldHint id="delete-server-confirm-hint">
              名称必须完全一致；误删后绑定的智能体不会自动恢复。
            </FieldHint>
          </div>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            aria-busy={pending}
            disabled={pending || loading || unknown || !confirmed}
            onClick={() => void confirm()}
          >
            {pending ? '删除中…' : '删除'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ConnectionDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const token = useServerToken(server.id);
  const rotate = useRotateServerToken(server.id);
  // 轮换后只在这里保留明文；关闭对话框即丢弃。
  const [revealed, setRevealed] = useState<{ token: string; endpoint: string } | null>(null);
  const data = revealed ?? token.data;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`连接「${server.name}」`}
      description="外部 Host 用这个端点与 Bearer token 访问；token 只在这里轮换时才显示明文。"
    >
      <div className="space-y-3">
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted">Endpoint</span>
          <CodeBlock code={data?.endpoint ?? '加载中…'} copyLabel="复制 Endpoint" />
        </div>
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted">Token</span>
          {data ? (
            <CodeBlock code={data.token} copyLabel="复制 Token" />
          ) : (
            <p className="text-xs text-subtle">{token.isError ? '读取失败' : '加载中…'}</p>
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
            onClick={() =>
              rotate.mutate(undefined, {
                onSuccess: (result) => setRevealed(result),
                onError: (error) => toastError(error),
              })
            }
          >
            <KeyRound className="size-3.5" /> {rotate.isPending ? '轮换中' : '轮换'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ToolEditorDialog({
  server,
  onClose,
  returnFocusRef,
}: {
  server: Server;
  onClose: () => void;
  returnFocusRef: { current: HTMLElement | null };
}) {
  const tools = useTools(server.id);
  const remove = useDeleteTool(server.id);
  const setEnabled = useSetToolEnabled(server.id);
  const [editing, setEditing] = useState<ApiTool | null>(null);
  const [deleting, setDeleting] = useState<ApiTool | null>(null);

  return (
    <Dialog
      open
      onClose={onClose}
      title={`工具定义「${server.name}」`}
      description="每个上游 HTTP 端点对应一个 MCP 工具。路径里的 {param} 必须在 inputSchema.properties 中有同名属性。"
      returnFocusRef={returnFocusRef}
      className="max-w-3xl rounded-[12px] [&>div:last-child]:px-6 [&>div:last-child]:py-6"
    >
      <div className="space-y-5">
        {tools.isPending ? <LoadingState rows={2} /> : null}
        {tools.isError ? (
          <ErrorState error={tools.error} onRetry={() => void tools.refetch()} />
        ) : null}
        {tools.data && tools.data.length === 0 ? (
          <InlineEmpty>还没有工具。在下方声明第一个端点，智能体才能调用它。</InlineEmpty>
        ) : null}
        {tools.data && tools.data.length > 0 ? (
          <TableWrap label="生成的工具定义">
            <Table>
              <caption className="sr-only">生成的工具定义</caption>
              <TableHeader>
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
                  <TableRow key={tool.id} className="h-14 hover:bg-chip">
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs text-fg">{tool.name}</span>
                        {tool.requiresApproval ? (
                          <span className="rounded-[6px] bg-warning-soft px-1.5 py-0.5 text-2xs text-warning">
                            需审批
                          </span>
                        ) : null}
                      </div>
                      {tool.description ? (
                        <div className="max-w-xs truncate text-2xs text-subtle">
                          {tool.description}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <span className="rounded-[6px] bg-chip px-1.5 py-0.5 font-mono text-2xs text-muted">
                        {tool.method}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-2xs text-muted">
                      {tool.pathTemplate}
                    </TableCell>
                    <TableCell className="text-2xs text-muted">{tool.paramsIn}</TableCell>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="size-3.5 accent-ink"
                        aria-label={`启用工具 ${tool.name}`}
                        checked={tool.enabled}
                        disabled={setEnabled.isPending}
                        onChange={(event) =>
                          setEnabled.mutate(
                            { toolId: tool.id, enabled: event.target.checked },
                            { onError: (error) => toastError(error) },
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="size-3.5 accent-ink"
                        aria-label={`批准工具 ${tool.name}`}
                        checked={tool.requiresApproval}
                        disabled={setEnabled.isPending}
                        onChange={(event) =>
                          setEnabled.mutate(
                            { toolId: tool.id, requiresApproval: event.target.checked },
                            { onError: (error) => toastError(error) },
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`编辑工具 ${tool.name}`}
                          onClick={() => setEditing(tool)}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`删除工具 ${tool.name}`}
                          className="hover:text-danger"
                          onClick={() => setDeleting(tool)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableWrap>
        ) : null}

        <ToolForm
          key={editing?.id ?? 'new'}
          serverId={server.id}
          tool={editing}
          onDone={() => setEditing(null)}
        />

        <ConfirmDialog
          open={deleting !== null}
          onClose={() => setDeleting(null)}
          title={`删除工具「${deleting?.name ?? ''}」`}
          description="智能体将无法再调用该工具。此操作不可撤销。"
          onConfirm={async () => {
            if (!deleting) return;
            await remove.mutateAsync(deleting.id);
            if (editing?.id === deleting.id) setEditing(null);
          }}
        />
      </div>
    </Dialog>
  );
}

const blankTool: ApiToolInput = {
  name: '',
  description: '',
  method: 'GET',
  pathTemplate: '/',
  inputSchema: { type: 'object', properties: {} },
  paramsIn: 'query',
  requiresApproval: false,
};

const blankSchemaText = '{\n  "type": "object",\n  "properties": {}\n}';

function toolToInput(tool: ApiTool): ApiToolInput {
  return {
    name: tool.name,
    description: tool.description,
    method: tool.method,
    pathTemplate: tool.pathTemplate,
    inputSchema: tool.inputSchema,
    paramsIn: tool.paramsIn,
    requiresApproval: tool.requiresApproval,
  };
}

/** 同一个表单用于新增与编辑；编辑时提交按钮换成「保存更改」。 */
function ToolForm({
  serverId,
  tool,
  onDone,
}: {
  serverId: string;
  tool: ApiTool | null;
  onDone: () => void;
}) {
  const create = useCreateTool(serverId);
  const remove = useDeleteTool(serverId);
  const update = useUpdateTool(serverId);
  const setEnabled = useSetToolEnabled(serverId);
  const [form, setForm] = useState<ApiToolInput>(() => (tool ? toolToInput(tool) : blankTool));
  const [schemaText, setSchemaText] = useState(() =>
    tool ? JSON.stringify(tool.inputSchema, null, 2) : blankSchemaText,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const pending = create.isPending || update.isPending || remove.isPending || setEnabled.isPending;

  const submit = (): void => {
    const next: Record<string, string> = {};
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(form.name)) {
      next.name = '名称只能用小写字母、数字、- 和 _，例如 list-users';
    }
    if (!form.pathTemplate.trim()) next.pathTemplate = '路径不能为空，请填写例如 /users/{id}';

    let schema: unknown = null;
    try {
      schema = JSON.parse(schemaText);
    } catch {
      next.inputSchema = '这里不是合法 JSON，请先修正语法再保存';
    }
    if (
      schema !== null &&
      (typeof schema !== 'object' || schema === null || Array.isArray(schema))
    ) {
      next.inputSchema = 'schema 必须是 JSON 对象，例如 {"type":"object"}';
      schema = null;
    }
    if (schema !== null && typeof schema === 'object' && !next.pathTemplate) {
      const properties = (schema as { properties?: unknown }).properties;
      const keys =
        properties && typeof properties === 'object' && !Array.isArray(properties)
          ? Object.keys(properties)
          : [];
      const placeholders = [...form.pathTemplate.matchAll(/\{([^{}/]+)\}/g)].map(
        (match) => match[1] ?? '',
      );
      const missing = placeholders.filter((name) => name && !keys.includes(name));
      if (missing.length > 0) {
        next.pathTemplate = `路径里的 ${missing.map((name) => `{${name}}`).join('、')} 在 inputSchema.properties 中没有同名属性，请补上后再保存`;
      }
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});

    const payload: ApiToolInput = { ...form, inputSchema: schema as Record<string, unknown> };

    if (!tool) {
      create.mutate(payload, {
        onSuccess: () => {
          setForm(blankTool);
          setSchemaText(blankSchemaText);
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
  };

  return (
    <form
      className="grid gap-3 border-t border-line pt-5 sm:grid-cols-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      noValidate
    >
      <div className="flex items-baseline justify-between gap-2 sm:col-span-6">
        <h3 className="text-xs text-subtle">{tool ? `编辑工具 ${tool.name}` : '添加工具'}</h3>
        {tool ? (
          <Button variant="ghost" size="xs" onClick={onDone}>
            取消编辑
          </Button>
        ) : null}
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`tool-name-${serverId}`}>
          名称
          <RequiredMark />
        </Label>
        <LineInput
          id={`tool-name-${serverId}`}
          value={form.name}
          placeholder="list-users"
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? `tool-name-error-${serverId}` : undefined}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
        <FieldError id={`tool-name-error-${serverId}`}>{errors.name}</FieldError>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`tool-method-${serverId}`}>方法</Label>
        <Select
          id={`tool-method-${serverId}`}
          value={form.method}
          onValueChange={(next) => setForm({ ...form, method: next as ApiToolInput['method'] })}
          options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => ({
            value: method,
            label: method,
          }))}
        />
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`tool-path-${serverId}`}>
          路径
          <RequiredMark />
        </Label>
        <LineInput
          id={`tool-path-${serverId}`}
          value={form.pathTemplate}
          placeholder="/users/{id}"
          aria-invalid={Boolean(errors.pathTemplate)}
          aria-describedby={errors.pathTemplate ? `tool-path-error-${serverId}` : undefined}
          onChange={(event) => setForm({ ...form, pathTemplate: event.target.value })}
        />
        <FieldError id={`tool-path-error-${serverId}`}>{errors.pathTemplate}</FieldError>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`tool-params-${serverId}`}>参数位置</Label>
        <Select
          id={`tool-params-${serverId}`}
          value={form.paramsIn}
          onValueChange={(next) => setForm({ ...form, paramsIn: next as ApiToolInput['paramsIn'] })}
          options={[
            { value: 'query', label: 'query' },
            { value: 'body', label: 'body' },
          ]}
        />
      </div>
      <div className="space-y-1.5 sm:col-span-5">
        <Label htmlFor={`tool-desc-${serverId}`}>描述</Label>
        <LineInput
          id={`tool-desc-${serverId}`}
          value={form.description}
          placeholder="告诉智能体这个工具做什么、何时用"
          onChange={(event) => setForm({ ...form, description: event.target.value })}
        />
      </div>
      <div className="space-y-1.5 sm:col-span-5">
        <Label htmlFor={`tool-schema-${serverId}`}>inputSchema (JSON)</Label>
        <CodeArea
          id={`tool-schema-${serverId}`}
          rows={4}
          value={schemaText}
          className="font-mono text-xs"
          aria-invalid={Boolean(errors.inputSchema)}
          aria-describedby={errors.inputSchema ? `tool-schema-error-${serverId}` : undefined}
          onChange={(event) => setSchemaText(event.target.value)}
        />
        <FieldError id={`tool-schema-error-${serverId}`}>{errors.inputSchema}</FieldError>
      </div>
      <div className="flex items-center gap-2 pt-1 sm:col-span-6">
        <input
          id={`tool-approval-${serverId}`}
          type="checkbox"
          className="size-3.5 accent-ink"
          checked={form.requiresApproval}
          onChange={(event) => setForm({ ...form, requiresApproval: event.target.checked })}
        />
        <Label htmlFor={`tool-approval-${serverId}`}>调用前需要人工批准</Label>
      </div>
      <div className="flex items-start pt-2">
        <Button
          type="submit"
          size="sm"
          className="rounded-full px-3.5"
          disabled={pending || !form.name}
        >
          {pending ? (
            '保存中…'
          ) : tool ? (
            '保存更改'
          ) : (
            <>
              <Plus className="size-4" strokeWidth={1.75} /> 添加
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

interface FormState {
  name: string;
  description: string;
  command: string;
  args: string;
  url: string;
  baseUrl: string;
  pairs: string;
}

const emptyForm: FormState = {
  name: '',
  description: '',
  command: '',
  args: '',
  url: '',
  baseUrl: '',
  pairs: '',
};

function serverToForm(server: Server): FormState {
  const common = { name: server.name, description: server.description };
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

function ServerFormDialog({
  server,
  onClose,
  onSaved,
  returnFocusRef,
}: {
  server: Server | null;
  onClose: () => void;
  onSaved: (server: Server, created: boolean) => void;
  returnFocusRef: { current: HTMLElement | null };
}) {
  const creating = server === null;
  const create = useCreateServer();
  const update = useUpdateServer();
  const [kind, setKind] = useState<Kind | null>(server?.kind ?? null);
  const [form, setForm] = useState<FormState>(() => (server ? serverToForm(server) : emptyForm));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const pending = create.isPending || update.isPending;

  const buildInput = (selected: Kind): ServerInput => {
    const common = { name: form.name, description: form.description };
    const pairs = parsePairs(form.pairs);
    if (selected === 'stdio') {
      return {
        ...common,
        kind: 'stdio',
        command: form.command,
        args: form.args
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        env: pairs,
      };
    }
    // http 与 generated 的地址属于不同字段：PATCH 与表单都按 kind 取用，不能互相顶替。
    if (selected === 'http') {
      return { ...common, kind: 'http', url: form.url, headers: pairs };
    }
    return { ...common, kind: 'generated', baseUrl: form.baseUrl, headers: pairs };
  };

  const submit = (): void => {
    if (!kind) return;
    const parsed = serverInputSchema.safeParse(buildInput(kind));
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    if (server) {
      update.mutate(
        { id: server.id, input: parsed.data, expectedUpdatedAt: server.updatedAt },
        {
          onSuccess: (saved) => {
            toastSuccess('Server 已更新');
            onSaved(saved, false);
          },
          onError: (error) => {
            if (error instanceof ApiError && error.status === 409) {
              toast.error('配置已被修改，请刷新');
              onClose();
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
  };

  const urlLabel = kind === 'http' ? 'URL' : 'Base URL';
  const urlValue = kind === 'http' ? form.url : form.baseUrl;
  const urlError = errors.url ?? errors.baseUrl;

  return (
    <Dialog
      open
      onClose={onClose}
      title={creating ? '新建 MCP Server' : `编辑「${server.name}」`}
      description={
        creating
          ? '第一步选来源类型，然后只填写这种接入方式需要的字段。'
          : '来源类型不可修改；密钥保持 •••• 不变即沿用原值。'
      }
      returnFocusRef={returnFocusRef}
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {creating ? (
          <fieldset className="space-y-2.5">
            <legend className="mb-1.5 text-xs text-subtle">来源类型</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {(Object.keys(kindMeta) as Kind[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={kind === value}
                  onClick={() => {
                    setKind(value);
                    setErrors({});
                  }}
                  className={cn(
                    'rounded-[9px] border px-3 py-2.5 text-left transition-colors focus-visible:outline-none',
                    kind === value ? 'border-fg bg-chip' : 'border-line hover:bg-hover',
                  )}
                >
                  <span className="block text-sm text-fg">{kindMeta[value].label}</span>
                  <span className="mt-0.5 block text-2xs leading-snug text-subtle">
                    {kindMeta[value].newHint}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}

        {kind === null ? (
          <p className="text-2xs text-subtle">先选一种来源类型，下面的字段会随类型变化。</p>
        ) : (
          <>
            <div className="space-y-1">
              <Label htmlFor="server-name">
                名称
                <RequiredMark />
              </Label>
              <LineInput
                id="server-name"
                value={form.name}
                placeholder="filesystem"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'server-name-error' : 'server-name-hint'}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
              {errors.name ? (
                <FieldError id="server-name-error">{errors.name}</FieldError>
              ) : (
                <FieldHint id="server-name-hint">
                  小写字母、数字、- 和 _；会作为 .mcp.json 的 key。
                </FieldHint>
              )}
            </div>

            <div className="space-y-1">
              <Label htmlFor="server-desc">描述</Label>
              <LineInput
                id="server-desc"
                value={form.description}
                placeholder="一句话说明它提供什么能力"
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </div>

            {kind === 'stdio' ? (
              <>
                <div className="space-y-1">
                  <Label htmlFor="server-command">
                    命令
                    <RequiredMark />
                  </Label>
                  <LineInput
                    id="server-command"
                    value={form.command}
                    placeholder="npx"
                    className="font-mono"
                    aria-invalid={Boolean(errors.command)}
                    aria-describedby={errors.command ? 'server-command-error' : undefined}
                    onChange={(event) => setForm({ ...form, command: event.target.value })}
                  />
                  <FieldError id="server-command-error">{errors.command}</FieldError>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="server-args">参数（每行一个）</Label>
                  <CodeArea
                    id="server-args"
                    rows={2}
                    value={form.args}
                    className="font-mono text-xs"
                    placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/tmp'}
                    onChange={(event) => setForm({ ...form, args: event.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="server-env">环境变量（每行 KEY=value）</Label>
                  <CodeArea
                    id="server-env"
                    rows={2}
                    value={form.pairs}
                    className="font-mono text-xs"
                    placeholder="TOKEN=…"
                    onChange={(event) => setForm({ ...form, pairs: event.target.value })}
                  />
                  <FieldHint>保存后密钥只以 •••• 返回；保持 •••• 不动即沿用原值。</FieldHint>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1">
                  <Label htmlFor="server-url">
                    {urlLabel}
                    <RequiredMark />
                  </Label>
                  <LineInput
                    id="server-url"
                    value={urlValue}
                    placeholder={
                      kind === 'http' ? 'https://example.com/mcp' : 'https://api.example.com/v1'
                    }
                    className="font-mono text-xs"
                    aria-invalid={Boolean(urlError)}
                    aria-describedby={urlError ? 'server-url-error' : 'server-url-hint'}
                    onChange={(event) =>
                      setForm(
                        kind === 'http'
                          ? { ...form, url: event.target.value }
                          : { ...form, baseUrl: event.target.value },
                      )
                    }
                  />
                  {urlError ? (
                    <FieldError id="server-url-error">{urlError}</FieldError>
                  ) : (
                    <FieldHint id="server-url-hint">
                      {kind === 'http'
                        ? 'MCP 端点地址，平台直接与它通信。'
                        : '上游 API 的根地址；工具路径会拼在它后面。'}
                    </FieldHint>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="server-headers">Headers（每行 KEY=value）</Label>
                  <CodeArea
                    id="server-headers"
                    rows={2}
                    value={form.pairs}
                    className="font-mono text-xs"
                    placeholder="Authorization=Bearer …"
                    onChange={(event) => setForm({ ...form, pairs: event.target.value })}
                  />
                </div>
                {kind === 'generated' ? (
                  <p className="rounded-[9px] bg-chip p-3 text-xs leading-relaxed text-muted">
                    保存后会直接打开工具编辑，把上游 HTTP API 的端点声明成 MCP 工具。
                  </p>
                ) : null}
              </>
            )}
          </>
        )}

        {errors.form ? <FieldError>{errors.form}</FieldError> : null}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            size="sm"
            className="rounded-full px-3.5"
            disabled={pending || kind === null}
            aria-busy={pending}
          >
            {pending ? '保存中…' : creating ? '创建' : '保存更改'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
