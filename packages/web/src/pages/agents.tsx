import type { Agent, AgentInput } from '@agentport/shared';
import { Plus, Trash2 } from 'lucide-react';
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
import { Skeleton } from '../components/ui/skeleton.js';
import { Textarea } from '../components/ui/textarea.js';
import { errorMessage } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import {
  useAgentFiles,
  useAgents,
  useCreateAgent,
  useDeleteAgent,
  useServers,
  useUpdateAgent,
} from '../lib/queries.js';

const models = ['claude-sonnet-5-5', 'claude-opus-5', 'claude-haiku-4-5'];

const emptyInput: AgentInput = {
  slug: '',
  name: '',
  model: 'claude-sonnet-5-5',
  systemPrompt: '',
  serverIds: [],
  maxTurns: 20,
  maxBudgetUsd: 2,
  timeoutMs: 600_000,
};

function toInput(agent: Agent): AgentInput {
  return {
    slug: agent.slug,
    name: agent.name,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    serverIds: agent.serverIds,
    maxTurns: agent.maxTurns,
    maxBudgetUsd: agent.maxBudgetUsd,
    timeoutMs: agent.timeoutMs,
  };
}

export function AgentsPage() {
  const agents = useAgents();
  const remove = useDeleteAgent();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const selected = agents.data?.find((a) => a.id === selectedId) ?? null;

  return (
    <div>
      <PageHeader
        title="Agents"
        description="每个 agent 会渲染成 .mcp.json / CLAUDE.md / agent md"
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" /> 新建
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div className="space-y-1">
          {agents.isPending ? <LoadingState rows={4} /> : null}
          {agents.isError ? (
            <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
          ) : null}
          {agents.data && agents.data.length === 0 ? (
            <EmptyState
              title="还没有 agent"
              description="先创建 MCP Server，再来绑定。"
              action={
                <Button size="sm" onClick={() => setCreating(true)}>
                  新建
                </Button>
              }
            />
          ) : null}
          {agents.data?.map((agent) => (
            <div
              key={agent.id}
              className={cn(
                'group flex items-center gap-1 rounded-md border px-2 py-1.5',
                agent.id === selectedId
                  ? 'border-zinc-700 bg-zinc-900'
                  : 'border-transparent hover:border-zinc-800 hover:bg-zinc-900/50',
              )}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => setSelectedId(agent.id)}
              >
                <div className="truncate text-sm text-zinc-200">{agent.name}</div>
                <div className="truncate text-xs text-zinc-500">{agent.slug}</div>
              </button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`删除 ${agent.name}`}
                className="opacity-0 group-hover:opacity-100"
                onClick={() => {
                  if (!window.confirm(`删除 agent「${agent.name}」？`)) return;
                  remove.mutate(agent.id, {
                    onError: (error) => toast.error(errorMessage(error)),
                    onSuccess: () => {
                      if (selectedId === agent.id) setSelectedId(null);
                    },
                  });
                }}
              >
                <Trash2 className="size-4 text-zinc-500" />
              </Button>
            </div>
          ))}
        </div>

        <div className="min-w-0">
          {selected ? (
            <AgentEditor key={selected.id} agent={selected} onDeleted={() => setSelectedId(null)} />
          ) : (
            <div className="rounded-lg border border-dashed border-zinc-800 px-6 py-16 text-center text-sm text-zinc-500">
              从左侧选择一个 agent 进行编辑，或新建一个。
            </div>
          )}
        </div>
      </div>

      <CreateAgentDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(agent) => setSelectedId(agent.id)}
      />
    </div>
  );
}

function AgentEditor({ agent, onDeleted }: { agent: Agent; onDeleted: () => void }) {
  const update = useUpdateAgent();
  const remove = useDeleteAgent();
  const servers = useServers();
  const [form, setForm] = useState<AgentInput>(() => toInput(agent));
  const [tab, setTab] = useState<'edit' | 'files'>('edit');

  const dirty =
    form.slug !== agent.slug ||
    form.name !== agent.name ||
    form.model !== agent.model ||
    form.systemPrompt !== agent.systemPrompt ||
    form.serverIds.join() !== agent.serverIds.join() ||
    form.maxTurns !== agent.maxTurns ||
    form.maxBudgetUsd !== agent.maxBudgetUsd;

  const save = () => {
    update.mutate(
      { id: agent.id, input: form },
      {
        onSuccess: () => toast.success('已保存'),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  };

  const toggleServer = (id: string) => {
    setForm((f) => ({
      ...f,
      serverIds: f.serverIds.includes(id)
        ? f.serverIds.filter((s) => s !== id)
        : [...f.serverIds, id],
    }));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1 rounded-md border border-zinc-800 p-0.5">
          {(
            [
              ['edit', '编辑'],
              ['files', '文件预览'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={cn(
                'rounded px-2.5 py-1 text-xs',
                tab === value ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200',
              )}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!window.confirm(`删除 agent「${agent.name}」？`)) return;
              remove.mutate(agent.id, {
                onSuccess: onDeleted,
                onError: (error) => toast.error(errorMessage(error)),
              });
            }}
          >
            <Trash2 className="size-3.5" /> 删除
          </Button>
          {tab === 'edit' ? (
            <Button size="sm" disabled={!dirty || update.isPending} onClick={save}>
              {update.isPending ? '保存中…' : '保存'}
            </Button>
          ) : null}
        </div>
      </div>

      {tab === 'edit' ? (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) save();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="agent-slug">Slug</Label>
              <Input
                id="agent-slug"
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-name">名称</Label>
              <Input
                id="agent-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-model">模型</Label>
              <Input
                id="agent-model"
                list="agent-models"
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              />
              <datalist id="agent-models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="agent-turns">maxTurns</Label>
                <Input
                  id="agent-turns"
                  type="number"
                  min={1}
                  value={form.maxTurns}
                  onChange={(e) => setForm({ ...form, maxTurns: Number(e.target.value) })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="agent-budget">maxBudgetUsd</Label>
                <Input
                  id="agent-budget"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={form.maxBudgetUsd}
                  onChange={(e) => setForm({ ...form, maxBudgetUsd: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="agent-prompt">System prompt</Label>
            <Textarea
              id="agent-prompt"
              rows={8}
              value={form.systemPrompt}
              className="font-mono text-xs"
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            />
          </div>

          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-xs font-medium text-zinc-400">绑定的 MCP Servers</legend>
            {servers.isPending ? <Skeleton className="h-16 w-full" /> : null}
            {servers.isError ? (
              <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />
            ) : null}
            {servers.data && servers.data.length === 0 ? (
              <p className="text-xs text-zinc-500">
                还没有可绑定的 server，先去 MCP Servers 页面创建。
              </p>
            ) : null}
            <div className="grid gap-1 sm:grid-cols-2">
              {servers.data?.map((server) => (
                <label
                  key={server.id}
                  className="flex cursor-pointer items-center gap-2 rounded border border-zinc-800 px-2 py-1.5 text-sm hover:bg-zinc-900"
                >
                  <input
                    type="checkbox"
                    className="accent-emerald-500"
                    checked={form.serverIds.includes(server.id)}
                    onChange={() => toggleServer(server.id)}
                  />
                  <span className="min-w-0 flex-1 truncate text-zinc-200">{server.name}</span>
                  <Badge variant={server.kind === 'generated' ? 'accent' : 'default'}>
                    {server.kind}
                  </Badge>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!dirty || update.isPending}>
              保存
            </Button>
          </div>
        </form>
      ) : (
        <FilesPreview agentId={agent.id} />
      )}
    </div>
  );
}

const fileTabs = [
  ['mcpJson', '.mcp.json'],
  ['claudeMd', 'CLAUDE.md'],
  ['agentMd', 'agent md'],
] as const;

function FilesPreview({ agentId }: { agentId: string }) {
  const files = useAgentFiles(agentId);
  const [which, setWhich] = useState<(typeof fileTabs)[number][0]>('mcpJson');

  if (files.isPending) return <LoadingState rows={6} />;
  if (files.isError) return <ErrorState error={files.error} onRetry={() => void files.refetch()} />;
  if (!files.data) return null;

  const content = files.data[which];

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {fileTabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={cn(
              'rounded px-2 py-1 text-xs',
              which === key
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
            )}
            onClick={() => setWhich(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {content ? (
        <pre className="max-h-[65vh] overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300">
          {content}
        </pre>
      ) : (
        <p className="text-xs text-zinc-500">该文件为空。</p>
      )}
    </div>
  );
}

function CreateAgentDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (agent: Agent) => void;
}) {
  const create = useCreateAgent();
  const [form, setForm] = useState<AgentInput>(emptyInput);

  return (
    <Dialog open={open} onClose={onClose} title="新建 Agent">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(form, {
            onSuccess: (agent) => {
              setForm(emptyInput);
              onCreated(agent);
              onClose();
            },
            onError: (error) => toast.error(errorMessage(error)),
          });
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="new-agent-slug">Slug</Label>
            <Input
              id="new-agent-slug"
              value={form.slug}
              placeholder="support-bot"
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-agent-name">名称</Label>
            <Input
              id="new-agent-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="new-agent-model">模型</Label>
          <Select
            id="new-agent-model"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="new-agent-prompt">System prompt</Label>
          <Textarea
            id="new-agent-prompt"
            rows={4}
            className="font-mono text-xs"
            value={form.systemPrompt}
            onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-800 pt-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={create.isPending || !form.slug || !form.name}>
            {create.isPending ? '创建中…' : '创建'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
