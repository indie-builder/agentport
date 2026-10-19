import {
  type ApiToolInput,
  type Server,
  type ServerInput,
  type ServerTestResult,
  serverInputSchema,
} from '@agentport/shared';
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Pencil,
  Plug,
  Plus,
  Server as ServerIcon,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { PageHeader } from '../components/page.js';
import { EmptyState, ErrorState, InlineEmpty, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
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
} from '../components/ui/table.js';
import { Tabs } from '../components/ui/tabs.js';
import { Textarea } from '../components/ui/textarea.js';
import { cn } from '../lib/cn.js';
import { formatDateTime, formatDuration } from '../lib/format.js';
import {
  useCreateServer,
  useCreateTool,
  useDeleteServer,
  useDeleteTool,
  useServers,
  useTestServer,
  useTools,
  useUpdateServer,
} from '../lib/queries.js';
import { toastError, toastPending, toastSuccess } from '../lib/toast.js';

type Kind = ServerInput['kind'];
type KindFilter = Kind | 'all';

const kindMeta: Record<Kind, { label: string; badge: 'default' | 'accent'; hint: string }> = {
  stdio: { label: 'stdio', badge: 'default', hint: '本地命令，由沙盒启动' },
  http: { label: 'HTTP', badge: 'default', hint: '远程 MCP 端点' },
  generated: { label: 'generated', badge: 'accent', hint: '平台把上游 HTTP API 包装成 MCP' },
};

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

function fieldErrors(issues: z.ZodIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || 'form';
    out[key] ??= issue.message;
  }
  return out;
}

export function ServersPage() {
  const servers = useServers();
  const test = useTestServer();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Server | null>(null);
  const [deleting, setDeleting] = useState<Server | null>(null);
  const [tested, setTested] = useState<Record<string, ServerTestResult>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const remove = useDeleteServer();

  const all = servers.data ?? [];
  const counts = useMemo(
    () => ({
      all: all.length,
      stdio: all.filter((server) => server.kind === 'stdio').length,
      http: all.filter((server) => server.kind === 'http').length,
      generated: all.filter((server) => server.kind === 'generated').length,
    }),
    [all],
  );

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

  const groups = useMemo(
    () =>
      (['stdio', 'http', 'generated'] as const)
        .map((item) => ({ kind: item, servers: filtered.filter((s) => s.kind === item) }))
        .filter((group) => group.servers.length > 0),
    [filtered],
  );

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
        setTested((previous) => ({ ...previous, [server.id]: result }));
        if (!result.ok) toast.error(`连接失败：${result.error ?? '未知错误'}`);
      },
      onError: (error) => toastError(error),
    });
  };

  return (
    <div>
      <PageHeader
        title="MCP Servers"
        description="接入 stdio 命令或远程 HTTP 端点；generated server 把上游 HTTP API 直接暴露成 MCP 工具。"
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-3.5" /> 新建 Server
          </Button>
        }
      />

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          label="按类型筛选"
          value={kind}
          onChange={(next) => setKind(next)}
          items={[
            { value: 'all', label: '全部', count: counts.all },
            { value: 'stdio', label: 'stdio', count: counts.stdio },
            { value: 'http', label: 'HTTP', count: counts.http },
            { value: 'generated', label: 'generated', count: counts.generated },
          ]}
        />
        <div className="relative sm:w-64">
          <Input
            type="search"
            aria-label="搜索 server"
            placeholder="搜索名称、描述或地址…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-2.5"
          />
        </div>
      </div>

      {servers.isPending ? <LoadingState rows={4} /> : null}
      {servers.isError ? (
        <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />
      ) : null}

      {servers.data && all.length === 0 ? (
        <EmptyState
          icon={<ServerIcon className="size-5" />}
          title="还没有 MCP Server"
          description="stdio 适合本地工具，HTTP 适合已有远程服务，generated 适合把内部 API 直接交给智能体调用。"
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-3.5" /> 新建 Server
            </Button>
          }
        />
      ) : null}

      {servers.data && all.length > 0 && filtered.length === 0 ? (
        <EmptyState
          title="没有匹配的 server"
          description="换个关键词，或清除类型筛选。"
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

      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.kind} aria-label={`${kindMeta[group.kind].label} servers`}>
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="text-[13px] font-semibold text-fg">{kindMeta[group.kind].label}</h2>
              <span className="text-[11px] tabular-nums text-subtle">{group.servers.length}</span>
              <span className="text-[11px] text-subtle">{kindMeta[group.kind].hint}</span>
            </div>
            <div className="grid gap-2.5 xl:grid-cols-2">
              {group.servers.map((server) => (
                <ServerCard
                  key={server.id}
                  server={server}
                  testing={test.isPending && test.variables === server.id}
                  result={tested[server.id] ?? null}
                  toolsOpen={expanded === server.id}
                  onToggleTools={() => setExpanded(expanded === server.id ? null : server.id)}
                  onTest={() => runTest(server)}
                  onEdit={() => openEdit(server)}
                  onDelete={() => setDeleting(server)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {formOpen ? (
        <ServerFormDialog
          key={editing?.id ?? 'new'}
          server={editing}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onSaved={(saved) => {
            setFormOpen(false);
            setEditing(null);
            setTested((previous) => {
              const next = { ...previous };
              delete next[saved.id];
              return next;
            });
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`删除 server「${deleting?.name ?? ''}」`}
        description="绑定了该 server 的智能体会立即失去它的工具，generated server 的工具定义也会一并删除。此操作不可撤销。"
        onConfirm={async () => {
          if (!deleting) return;
          const toastId = toastPending('正在删除…');
          try {
            await remove.mutateAsync(deleting.id);
            toastSuccess('Server 已删除');
          } finally {
            toast.dismiss(toastId);
          }
        }}
      />
    </div>
  );
}

function ServerCard({
  server,
  testing,
  result,
  toolsOpen,
  onToggleTools,
  onTest,
  onEdit,
  onDelete,
}: {
  server: Server;
  testing: boolean;
  result: ServerTestResult | null;
  toolsOpen: boolean;
  onToggleTools: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const generated = server.kind === 'generated';
  return (
    <div className="rounded-[10px] border border-line bg-surface">
      <div className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-fg">{server.name}</span>
            <Badge variant={kindMeta[server.kind].badge}>{kindMeta[server.kind].label}</Badge>
            {result ? (
              <Badge variant={result.ok ? 'success' : 'danger'}>
                {result.ok ? '连接正常' : '连接失败'}
              </Badge>
            ) : null}
          </div>
          {server.description ? (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">
              {server.description}
            </p>
          ) : null}
          <code
            className="mt-2 block truncate font-mono text-[11px] text-subtle"
            title={detailOf(server)}
          >
            {detailOf(server) || '—'}
          </code>
          <div className="mt-1.5 text-[11px] text-subtle/80">
            更新于 {formatDateTime(server.updatedAt)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={testing}
            aria-busy={testing}
            onClick={onTest}
          >
            {testing ? (
              <span className="size-3 animate-spin rounded-full border border-current border-t-transparent" />
            ) : (
              <Plug className="size-3.5" />
            )}
            {testing ? '测试中' : '测试'}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`编辑 ${server.name}`}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`删除 ${server.name}`}
            onClick={onDelete}
            className="hover:text-danger"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      {result ? <TestResultPanel result={result} /> : null}

      {generated ? (
        <div className="border-t border-line">
          <button
            type="button"
            aria-expanded={toolsOpen}
            onClick={onToggleTools}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-muted transition-colors hover:bg-surface-2/40 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
          >
            <Wrench className="size-3.5" />
            工具定义
            <ChevronDown
              className={cn('ml-auto size-3.5 transition-transform', toolsOpen && 'rotate-180')}
            />
          </button>
          {toolsOpen ? <ToolsPanel serverId={server.id} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function TestResultPanel({ result }: { result: ServerTestResult }) {
  return (
    <div
      className={cn(
        'border-t px-4 py-3 text-xs',
        result.ok ? 'border-success/20 bg-success/5' : 'border-danger/20 bg-danger/5',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {result.ok ? (
          <span className="inline-flex items-center gap-1 font-medium text-success">
            <CircleCheck className="size-3.5" /> 连接成功
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 font-medium text-danger">
            <CircleAlert className="size-3.5" /> 连接失败
          </span>
        )}
        <span className="tabular-nums text-muted">耗时 {formatDuration(result.durationMs)}</span>
        {result.serverInfo ? (
          <span className="font-mono text-subtle">
            {result.serverInfo.name} v{result.serverInfo.version}
          </span>
        ) : null}
        <span className="text-subtle">工具 {result.tools.length}</span>
      </div>
      {result.error ? (
        <p className="mt-2 whitespace-pre-wrap break-words rounded-md border border-danger/20 bg-danger/5 p-2 font-mono text-[11px] leading-relaxed text-danger">
          {result.error}
        </p>
      ) : null}
      {result.tools.length > 0 ? (
        <div className="mt-2 overflow-hidden rounded-md border border-line">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/3">工具</TableHead>
                <TableHead>描述</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.tools.map((tool) => (
                <TableRow key={tool.name}>
                  <TableCell className="font-mono text-[11px] text-fg">{tool.name}</TableCell>
                  <TableCell className="text-[11px] text-muted">
                    {tool.description || '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : result.ok ? (
        <p className="mt-2 text-subtle">该 server 没有暴露工具。</p>
      ) : null}
    </div>
  );
}

function ToolsPanel({ serverId }: { serverId: string }) {
  const tools = useTools(serverId);
  const create = useCreateTool(serverId);
  const remove = useDeleteTool(serverId);
  const [form, setForm] = useState<ApiToolInput>({
    name: '',
    description: '',
    method: 'GET',
    pathTemplate: '/',
    inputSchema: { type: 'object', properties: {} },
    paramsIn: 'query',
  });
  const [schemaText, setSchemaText] = useState('{\n  "type": "object",\n  "properties": {}\n}');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deletingTool, setDeletingTool] = useState<{ id: string; name: string } | null>(null);

  const submit = (): void => {
    const next: Record<string, string> = {};
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(form.name)) {
      next.name = '仅允许小写字母、数字、- 和 _';
    }
    if (!form.pathTemplate.trim()) next.pathTemplate = '路径不能为空';
    let schema: unknown;
    try {
      schema = JSON.parse(schemaText);
    } catch {
      next.inputSchema = '不是合法 JSON';
      schema = null;
    }
    if (
      schema !== null &&
      (typeof schema !== 'object' || schema === null || Array.isArray(schema))
    ) {
      next.inputSchema = '必须是 JSON 对象';
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    create.mutate(
      { ...form, inputSchema: schema as Record<string, unknown> },
      {
        onSuccess: () => {
          setForm({ ...form, name: '', description: '', pathTemplate: '/' });
          toastSuccess('工具已添加');
        },
        onError: (error) => toastError(error),
      },
    );
  };

  return (
    <div className="space-y-3 border-t border-line bg-canvas/30 p-4">
      {tools.isPending ? <LoadingState rows={2} /> : null}
      {tools.isError ? (
        <ErrorState error={tools.error} onRetry={() => void tools.refetch()} />
      ) : null}
      {tools.data && tools.data.length === 0 ? (
        <InlineEmpty>还没有工具，生成的 MCP Server 暂时不提供任何能力。</InlineEmpty>
      ) : null}
      {tools.data && tools.data.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-line">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead className="w-20">方法</TableHead>
                <TableHead>路径</TableHead>
                <TableHead className="w-20">参数</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.data.map((tool) => (
                <TableRow key={tool.id}>
                  <TableCell>
                    <div className="font-mono text-[11px] text-fg">{tool.name}</div>
                    {tool.description ? (
                      <div className="max-w-xs truncate text-[11px] text-subtle">
                        {tool.description}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant="mono">{tool.method}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-muted">
                    {tool.pathTemplate}
                  </TableCell>
                  <TableCell className="text-[11px] text-muted">{tool.paramsIn}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`删除工具 ${tool.name}`}
                      className="hover:text-danger"
                      onClick={() => setDeletingTool({ id: tool.id, name: tool.name })}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <form
        className="grid gap-2 border-t border-line pt-3 sm:grid-cols-6"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        noValidate
      >
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={`tool-name-${serverId}`}>
            名称
            <RequiredMark />
          </Label>
          <Input
            id={`tool-name-${serverId}`}
            value={form.name}
            placeholder="list-users"
            aria-invalid={Boolean(errors.name)}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <FieldError>{errors.name}</FieldError>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`tool-method-${serverId}`}>方法</Label>
          <Select
            id={`tool-method-${serverId}`}
            value={form.method}
            onChange={(event) =>
              setForm({ ...form, method: event.target.value as ApiToolInput['method'] })
            }
          >
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={`tool-path-${serverId}`}>
            路径
            <RequiredMark />
          </Label>
          <Input
            id={`tool-path-${serverId}`}
            value={form.pathTemplate}
            placeholder="/users/{id}"
            aria-invalid={Boolean(errors.pathTemplate)}
            onChange={(event) => setForm({ ...form, pathTemplate: event.target.value })}
          />
          <FieldError>{errors.pathTemplate}</FieldError>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`tool-params-${serverId}`}>参数位置</Label>
          <Select
            id={`tool-params-${serverId}`}
            value={form.paramsIn}
            onChange={(event) =>
              setForm({ ...form, paramsIn: event.target.value as ApiToolInput['paramsIn'] })
            }
          >
            <option value="query">query</option>
            <option value="body">body</option>
          </Select>
        </div>
        <div className="space-y-1 sm:col-span-5">
          <Label htmlFor={`tool-desc-${serverId}`}>描述</Label>
          <Input
            id={`tool-desc-${serverId}`}
            value={form.description}
            placeholder="告诉智能体这个工具做什么、何时用"
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </div>
        <div className="space-y-1 sm:col-span-5">
          <Label htmlFor={`tool-schema-${serverId}`}>inputSchema (JSON)</Label>
          <Textarea
            id={`tool-schema-${serverId}`}
            rows={4}
            value={schemaText}
            className="font-mono text-xs"
            aria-invalid={Boolean(errors.inputSchema)}
            onChange={(event) => setSchemaText(event.target.value)}
          />
          <FieldError>{errors.inputSchema}</FieldError>
        </div>
        <div className="flex items-start pt-5">
          <Button type="submit" size="sm" disabled={create.isPending || !form.name}>
            {create.isPending ? (
              '添加中…'
            ) : (
              <>
                <Plus className="size-3.5" /> 添加
              </>
            )}
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={deletingTool !== null}
        onClose={() => setDeletingTool(null)}
        title={`删除工具「${deletingTool?.name ?? ''}」`}
        description="智能体将无法再调用该工具。此操作不可撤销。"
        onConfirm={async () => {
          if (!deletingTool) return;
          await remove.mutateAsync(deletingTool.id);
        }}
      />
    </div>
  );
}

interface FormState {
  name: string;
  description: string;
  command: string;
  args: string;
  url: string;
  pairs: string;
}

const emptyForm: FormState = {
  name: '',
  description: '',
  command: '',
  args: '',
  url: '',
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
        pairs: formatPairs(server.env),
      };
    case 'http':
      return {
        ...common,
        command: '',
        args: '',
        url: server.url,
        pairs: formatPairs(server.headers),
      };
    case 'generated':
      return {
        ...common,
        command: '',
        args: '',
        url: server.baseUrl,
        pairs: formatPairs(server.headers),
      };
  }
}

function ServerFormDialog({
  server,
  onClose,
  onSaved,
}: {
  server: Server | null;
  onClose: () => void;
  onSaved: (server: Server) => void;
}) {
  const creating = server === null;
  const create = useCreateServer();
  const update = useUpdateServer();
  const [kind, setKind] = useState<Kind>(server?.kind ?? 'stdio');
  const [form, setForm] = useState<FormState>(() => (server ? serverToForm(server) : emptyForm));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const pending = create.isPending || update.isPending;

  const buildInput = (): ServerInput => {
    const common = { name: form.name, description: form.description };
    const pairs = parsePairs(form.pairs);
    if (kind === 'stdio') {
      return {
        ...common,
        kind,
        command: form.command,
        args: form.args
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        env: pairs,
      };
    }
    if (kind === 'http') return { ...common, kind, url: form.url, headers: pairs };
    return { ...common, kind, baseUrl: form.url, headers: pairs };
  };

  const submit = (): void => {
    const candidate = buildInput();
    const parsed = serverInputSchema.safeParse(candidate);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    if (server) {
      update.mutate(
        { id: server.id, input: parsed.data },
        {
          onSuccess: (saved) => {
            toastSuccess('Server 已更新');
            onSaved(saved);
          },
          onError: (error) => toastError(error),
        },
      );
    } else {
      create.mutate(parsed.data, {
        onSuccess: (saved) => {
          toastSuccess('Server 已创建');
          setForm(emptyForm);
          onSaved(saved);
        },
        onError: (error) => toastError(error),
      });
    }
  };

  const urlLabel = kind === 'http' ? 'URL' : 'Base URL';

  return (
    <Dialog
      open
      onClose={onClose}
      title={creating ? '新建 MCP Server' : `编辑「${server.name}」`}
      description={
        creating
          ? '配置保存后即可测试连接，并在智能体中绑定。'
          : '类型不可修改；密钥保持 •••• 不变即沿用原值。'
      }
    >
      <form
        className="space-y-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {creating ? (
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(kindMeta) as Kind[]).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
                className={cn(
                  'rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                  kind === value
                    ? 'border-accent/60 bg-accent-soft'
                    : 'border-line hover:border-line-strong hover:bg-surface-2/50',
                )}
              >
                <span className="block text-xs font-medium text-fg">{kindMeta[value].label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-subtle">
                  {kindMeta[value].hint}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="space-y-1">
          <Label htmlFor="server-name">
            名称
            <RequiredMark />
          </Label>
          <Input
            id="server-name"
            value={form.name}
            placeholder="filesystem"
            aria-invalid={Boolean(errors.name)}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          {errors.name ? (
            <FieldError>{errors.name}</FieldError>
          ) : (
            <FieldHint>小写字母、数字、- 和 _；会作为 .mcp.json 的 key。</FieldHint>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor="server-desc">描述</Label>
          <Input
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
              <Input
                id="server-command"
                value={form.command}
                placeholder="npx"
                className="font-mono"
                aria-invalid={Boolean(errors.command)}
                onChange={(event) => setForm({ ...form, command: event.target.value })}
              />
              <FieldError>{errors.command}</FieldError>
            </div>
            <div className="space-y-1">
              <Label htmlFor="server-args">参数（每行一个）</Label>
              <Textarea
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
              <Textarea
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
              <Input
                id="server-url"
                value={form.url}
                placeholder="https://example.com/mcp"
                className="font-mono text-xs"
                aria-invalid={Boolean(errors.url ?? errors.baseUrl)}
                onChange={(event) => setForm({ ...form, url: event.target.value })}
              />
              <FieldError>{errors.url ?? errors.baseUrl}</FieldError>
            </div>
            <div className="space-y-1">
              <Label htmlFor="server-headers">Headers（每行 KEY=value）</Label>
              <Textarea
                id="server-headers"
                rows={2}
                value={form.pairs}
                className="font-mono text-xs"
                placeholder="Authorization=Bearer …"
                onChange={(event) => setForm({ ...form, pairs: event.target.value })}
              />
            </div>
            {kind === 'generated' ? (
              <p className="rounded-md border border-line bg-surface-2/40 p-2.5 text-[11px] leading-relaxed text-muted">
                创建后在列表中展开「工具定义」，把上游 HTTP API 的每个端点声明成一个 MCP 工具。
              </p>
            ) : null}
          </>
        )}

        {errors.form ? <FieldError>{errors.form}</FieldError> : null}

        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={pending} aria-busy={pending}>
            {pending ? '保存中…' : creating ? '创建' : '保存更改'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export { formatPairs, parsePairs };
