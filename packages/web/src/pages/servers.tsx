import type { ApiToolInput, Server, ServerInput, ServerTestResult } from '@agentport/shared';
import { ChevronDown, ChevronRight, Plug, Plus, Trash2, Wrench } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '../components/page.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Dialog } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Select } from '../components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { Textarea } from '../components/ui/textarea.js';
import { errorMessage } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import {
  useCreateServer,
  useCreateTool,
  useDeleteServer,
  useDeleteTool,
  useServers,
  useTestServer,
  useTools,
} from '../lib/queries.js';

type Kind = ServerInput['kind'];

const kinds: Array<{ value: Kind; label: string }> = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'HTTP' },
  { value: 'generated', label: 'generated' },
];

/** 一行一个 `KEY=value`，值里允许出现 `=`。 */
function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
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
  const remove = useDeleteServer();
  const test = useTestServer();
  const [createOpen, setCreateOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tested, setTested] = useState<{ id: string; result: ServerTestResult } | null>(null);

  const runTest = (id: string) => {
    test.mutate(id, {
      onSuccess: (result) => setTested({ id, result }),
      onError: (error) => toast.error(errorMessage(error)),
    });
  };

  return (
    <div>
      <PageHeader
        title="MCP Servers"
        description="stdio 命令、远程 HTTP，或由平台把上游 HTTP API 包装成 MCP"
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" /> 新建
          </Button>
        }
      />

      {servers.isPending ? <LoadingState rows={4} /> : null}
      {servers.isError ? (
        <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />
      ) : null}
      {servers.data && servers.data.length === 0 ? (
        <EmptyState
          title="还没有 MCP Server"
          description="新建一个 stdio、HTTP 或 generated server，然后在 agent 中绑定。"
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              新建
            </Button>
          }
        />
      ) : null}

      {servers.data && servers.data.length > 0 ? (
        <div className="rounded-lg border border-zinc-800">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-6" />
                <TableHead>名称</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>配置</TableHead>
                <TableHead className="w-40 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {servers.data.map((server) => (
                <ServerRow
                  key={server.id}
                  server={server}
                  expanded={expanded === server.id}
                  onToggle={() => setExpanded(expanded === server.id ? null : server.id)}
                  testing={test.isPending && test.variables === server.id}
                  onTest={() => runTest(server.id)}
                  result={tested?.id === server.id ? tested.result : null}
                  onDelete={() => {
                    if (!window.confirm(`删除 server「${server.name}」？`)) return;
                    remove.mutate(server.id, {
                      onError: (error) => toast.error(errorMessage(error)),
                      onSuccess: () => setExpanded(null),
                    });
                  }}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <CreateServerDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function ServerRow({
  server,
  expanded,
  onToggle,
  onTest,
  testing,
  result,
  onDelete,
}: {
  server: Server;
  expanded: boolean;
  onToggle: () => void;
  onTest: () => void;
  testing: boolean;
  result: ServerTestResult | null;
  onDelete: () => void;
}) {
  const generated = server.kind === 'generated';
  return (
    <>
      <TableRow>
        <TableCell className="pr-0">
          <button
            type="button"
            aria-label={expanded ? '收起' : '展开'}
            className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
            disabled={!generated}
            onClick={onToggle}
          >
            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        </TableCell>
        <TableCell>
          <div className="font-medium text-zinc-200">{server.name}</div>
          {server.description ? (
            <div className="max-w-md truncate text-xs text-zinc-500">{server.description}</div>
          ) : null}
        </TableCell>
        <TableCell>
          <Badge variant={generated ? 'accent' : 'default'}>{server.kind}</Badge>
        </TableCell>
        <TableCell>
          <code className="block max-w-md truncate text-xs text-zinc-400">{detailOf(server)}</code>
        </TableCell>
        <TableCell className="text-right">
          <div className="flex justify-end gap-1">
            <Button variant="outline" size="sm" disabled={testing} onClick={onTest}>
              <Plug className="size-3.5" /> {testing ? '测试中…' : '测试'}
            </Button>
            <Button variant="ghost" size="icon" aria-label="删除" onClick={onDelete}>
              <Trash2 className="size-4 text-zinc-500" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {result ? (
        <tr className="bg-zinc-950/40">
          <td />
          <td colSpan={4} className="px-3 pb-3">
            <TestResultView result={result} />
          </td>
        </tr>
      ) : null}
      {generated && expanded ? (
        <tr>
          <td />
          <td colSpan={4} className="px-3 pb-3">
            <ToolsPanel serverId={server.id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function TestResultView({ result }: { result: ServerTestResult }) {
  return (
    <div
      className={cn(
        'rounded-md border p-2 text-xs',
        result.ok ? 'border-emerald-900 bg-emerald-950/20' : 'border-red-900 bg-red-950/20',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={result.ok ? 'text-emerald-300' : 'text-red-300'}>
          {result.ok ? '连接成功' : '连接失败'}
        </span>
        <span className="text-zinc-500">{result.durationMs}ms</span>
        {result.serverInfo ? (
          <span className="text-zinc-400">
            {result.serverInfo.name} {result.serverInfo.version}
          </span>
        ) : null}
      </div>
      {result.error ? <div className="mt-1 text-red-400/90">{result.error}</div> : null}
      {result.tools.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {result.tools.map((tool) => (
            <li key={tool.name} className="text-zinc-400">
              <code className="text-zinc-300">{tool.name}</code>
              {tool.description ? (
                <span className="ml-2 text-zinc-500">{tool.description}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : result.ok ? (
        <div className="mt-1 text-zinc-500">该 server 没有暴露工具。</div>
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

  const submit = () => {
    let schema: unknown;
    try {
      schema = JSON.parse(schemaText);
    } catch {
      toast.error('inputSchema 不是合法 JSON');
      return;
    }
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
      toast.error('inputSchema 必须是 JSON 对象');
      return;
    }
    create.mutate(
      { ...form, inputSchema: schema as Record<string, unknown> },
      {
        onSuccess: () => {
          setForm({ ...form, name: '', description: '', pathTemplate: '/' });
          toast.success('工具已添加');
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  };

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-zinc-300">
        <Wrench className="size-3.5" /> 工具
      </div>
      {tools.isPending ? <LoadingState rows={2} /> : null}
      {tools.isError ? (
        <ErrorState error={tools.error} onRetry={() => void tools.refetch()} />
      ) : null}
      {tools.data && tools.data.length === 0 ? (
        <div className="mb-3 text-xs text-zinc-500">
          还没有工具，生成的 MCP Server 暂时不提供任何能力。
        </div>
      ) : null}
      {tools.data && tools.data.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>方法</TableHead>
              <TableHead>路径</TableHead>
              <TableHead>参数位置</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tools.data.map((tool) => (
              <TableRow key={tool.id}>
                <TableCell>
                  <div className="text-zinc-200">{tool.name}</div>
                  <div className="max-w-sm truncate text-xs text-zinc-500">{tool.description}</div>
                </TableCell>
                <TableCell>
                  <Badge>{tool.method}</Badge>
                </TableCell>
                <TableCell>
                  <code className="text-xs text-zinc-400">{tool.pathTemplate}</code>
                </TableCell>
                <TableCell className="text-xs text-zinc-400">{tool.paramsIn}</TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`删除工具 ${tool.name}`}
                    onClick={() =>
                      remove.mutate(tool.id, {
                        onError: (error) => toast.error(errorMessage(error)),
                      })
                    }
                  >
                    <Trash2 className="size-4 text-zinc-500" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      <form
        className="mt-3 grid grid-cols-2 gap-2 border-t border-zinc-800 pt-3 md:grid-cols-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="space-y-1">
          <Label htmlFor={`tool-name-${serverId}`}>名称</Label>
          <Input
            id={`tool-name-${serverId}`}
            value={form.name}
            placeholder="list-users"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`tool-method-${serverId}`}>方法</Label>
          <Select
            id={`tool-method-${serverId}`}
            value={form.method}
            onChange={(e) => setForm({ ...form, method: e.target.value as ApiToolInput['method'] })}
          >
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`tool-path-${serverId}`}>路径</Label>
          <Input
            id={`tool-path-${serverId}`}
            value={form.pathTemplate}
            placeholder="/users/{id}"
            onChange={(e) => setForm({ ...form, pathTemplate: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`tool-params-${serverId}`}>参数位置</Label>
          <Select
            id={`tool-params-${serverId}`}
            value={form.paramsIn}
            onChange={(e) =>
              setForm({ ...form, paramsIn: e.target.value as ApiToolInput['paramsIn'] })
            }
          >
            <option value="query">query</option>
            <option value="body">body</option>
          </Select>
        </div>
        <div className="col-span-2 space-y-1">
          <Label htmlFor={`tool-desc-${serverId}`}>描述</Label>
          <Input
            id={`tool-desc-${serverId}`}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <div className="col-span-2 space-y-1 md:col-span-5">
          <Label htmlFor={`tool-schema-${serverId}`}>inputSchema (JSON)</Label>
          <Textarea
            id={`tool-schema-${serverId}`}
            rows={4}
            value={schemaText}
            className="font-mono text-xs"
            onChange={(e) => setSchemaText(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <Button type="submit" size="sm" disabled={create.isPending || !form.name}>
            <Plus className="size-3.5" /> 添加
          </Button>
        </div>
      </form>
    </div>
  );
}

function CreateServerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateServer();
  const [kind, setKind] = useState<Kind>('stdio');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [pairs, setPairs] = useState('');

  const submit = () => {
    const common = { name, description };
    const extras = parsePairs(pairs);
    const input: ServerInput =
      kind === 'stdio'
        ? {
            ...common,
            kind,
            command,
            args: args
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
            env: extras,
          }
        : kind === 'http'
          ? { ...common, kind, url, headers: extras }
          : { ...common, kind, baseUrl: url, headers: extras };
    create.mutate(input, {
      onSuccess: () => {
        toast.success('Server 已创建');
        setName('');
        setDescription('');
        setCommand('');
        setArgs('');
        setUrl('');
        setPairs('');
        onClose();
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  };

  return (
    <Dialog open={open} onClose={onClose} title="新建 MCP Server">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex gap-1 rounded-md border border-zinc-800 p-0.5">
          {kinds.map((k) => (
            <button
              key={k.value}
              type="button"
              className={cn(
                'flex-1 rounded px-2 py-1 text-xs',
                kind === k.value
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200',
              )}
              onClick={() => setKind(k.value)}
            >
              {k.label}
            </button>
          ))}
        </div>

        <div className="space-y-1">
          <Label htmlFor="server-name">名称</Label>
          <Input
            id="server-name"
            value={name}
            placeholder="filesystem"
            onChange={(e) => setName(e.target.value)}
          />
          <p className="text-[11px] text-zinc-500">
            小写字母、数字、- 和 _；会作为 .mcp.json 的 key。
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="server-desc">描述</Label>
          <Input
            id="server-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {kind === 'stdio' ? (
          <>
            <div className="space-y-1">
              <Label htmlFor="server-command">命令</Label>
              <Input
                id="server-command"
                value={command}
                placeholder="npx"
                onChange={(e) => setCommand(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="server-args">参数（每行一个）</Label>
              <Textarea
                id="server-args"
                rows={2}
                value={args}
                className="font-mono text-xs"
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/tmp'}
                onChange={(e) => setArgs(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="server-env">环境变量（每行 KEY=value）</Label>
              <Textarea
                id="server-env"
                rows={2}
                value={pairs}
                className="font-mono text-xs"
                onChange={(e) => setPairs(e.target.value)}
              />
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1">
              <Label htmlFor="server-url">{kind === 'http' ? 'URL' : 'Base URL'}</Label>
              <Input
                id="server-url"
                value={url}
                placeholder="https://example.com/mcp"
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="server-headers">Headers（每行 KEY=value）</Label>
              <Textarea
                id="server-headers"
                rows={2}
                value={pairs}
                className="font-mono text-xs"
                placeholder="Authorization=Bearer …"
                onChange={(e) => setPairs(e.target.value)}
              />
            </div>
            {kind === 'generated' ? (
              <p className="text-[11px] text-zinc-500">
                创建后在列表中展开该 server，添加把上游 HTTP API 暴露成 MCP 工具的定义。
              </p>
            ) : null}
          </>
        )}

        <div className="flex justify-end gap-2 border-t border-zinc-800 pt-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={create.isPending || !name}>
            {create.isPending ? '创建中…' : '创建'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
