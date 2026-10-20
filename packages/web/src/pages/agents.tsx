import { type Agent, type AgentInput, agentInputSchema, BUILTIN_TOOLS } from '@agentport/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileCode,
  FileText,
  History,
  Plus,
  RotateCcw,
  Search,
  Shield,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CodeBlock } from '../components/code-block.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Page, PageHeader } from '../components/page.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { Dialog } from '../components/ui/dialog.js';
import { FieldError, FieldHint, Input } from '../components/ui/input.js';
import { Label, RequiredMark } from '../components/ui/label.js';
import { MultiSelect } from '../components/ui/multi-select.js';
import { Select } from '../components/ui/select.js';
import { Tabs } from '../components/ui/tabs.js';
import { Textarea } from '../components/ui/textarea.js';
import type { AgentVersionSummary } from '../lib/api.js';
import { ApiError, api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { fieldErrors } from '../lib/form.js';
import { formatDateTime } from '../lib/format.js';
import {
  useAgentFiles,
  useAgents,
  useAgentVersion,
  useAgentVersions,
  useCreateAgent,
  useDeleteAgent,
  useRollbackAgent,
  useServers,
  useSkills,
  useUpdateAgent,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';

/**
 * 模型名由部署的网关决定，不是平台常量：直连 Anthropic 时是 claude-*，
 * 用自建网关时是网关 /v1/models 里的 id。这里给的是当前部署的默认值，
 * 创建后仍可手改，所以不要把它当成白名单。
 */
const models = ['group/flash', 'auto/deepseek-v4.1-flash', 'workbuddy/kimi-k3-2'];

const emptyInput: AgentInput = {
  slug: '',
  name: '',
  description: '',
  model: 'claude-sonnet-5-5',
  systemPrompt: '',
  serverIds: [],
  skillIds: [],
  subAgentIds: [],
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'dontAsk',
  maxTurns: 20,
  maxBudgetUsd: 2,
  timeoutMs: 600_000,
  enabled: true,
};

function toInput(agent: Agent): AgentInput {
  return {
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    serverIds: agent.serverIds,
    skillIds: agent.skillIds,
    subAgentIds: agent.subAgentIds,
    allowedTools: agent.allowedTools,
    disallowedTools: agent.disallowedTools,
    permissionMode: agent.permissionMode,
    maxTurns: agent.maxTurns,
    maxBudgetUsd: agent.maxBudgetUsd,
    timeoutMs: agent.timeoutMs,
    enabled: agent.enabled,
    ...(agent.effort === undefined ? {} : { effort: agent.effort }),
    ...(agent.maxThinkingTokens === undefined
      ? {}
      : { maxThinkingTokens: agent.maxThinkingTokens }),
  };
}

export function AgentsPage() {
  const agents = useAgents();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const remove = useDeleteAgent();

  // 导入返回的 agent 直接选中；列表与 server/skill 缓存随后失效刷新。
  const importFile = async (file: File): Promise<void> => {
    setImporting(true);
    try {
      const data: unknown = JSON.parse(await file.text());
      const result = await api.importAgent(data);
      setSelectedId(result.agent.id);
      await Promise.all(
        ['agents', 'servers', 'skills', 'overview'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
      const suffix = result.warnings.length > 0 ? `，${result.warnings.length} 条提示` : '';
      toastSuccess(`已导入「${result.agent.name}」${suffix}`);
    } catch (error) {
      toastError(error);
    } finally {
      setImporting(false);
    }
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = agents.data ?? [];
    if (!needle) return list;
    return list.filter((agent) =>
      [agent.name, agent.slug, agent.description].join(' ').toLowerCase().includes(needle),
    );
  }, [agents.data, query]);

  // 选中项被删除或首次进入时，落到第一个 agent，避免右侧空白。
  const selected = filtered.find((agent) => agent.id === selectedId) ?? filtered[0] ?? null;

  return (
    <Page>
      <PageHeader
        title="智能体"
        description="文件式定义：每个智能体渲染为 .mcp.json、CLAUDE.md 与 agent md，由沙盒在运行时装配。"
        actions={
          <div className="flex items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importFile(file);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={importing}
              aria-busy={importing}
              onClick={() => fileInput.current?.click()}
            >
              <Upload className="size-3.5" /> {importing ? '导入中…' : '导入'}
            </Button>
            <Button ref={createButtonRef} size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" /> 新建智能体
            </Button>
          </div>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
            <Input
              type="search"
              aria-label="搜索智能体"
              placeholder="搜索名称或 slug…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-8"
            />
          </div>

          {agents.isPending ? <LoadingState rows={4} /> : null}
          {agents.isError ? (
            <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
          ) : null}
          {agents.data && agents.data.length === 0 ? (
            <EmptyState
              icon={<Bot className="size-5" />}
              title="还没有智能体"
              description="创建后绑定 MCP Server，即可在对话中使用它的工具。"
              action={
                <Button size="sm" onClick={() => setCreating(true)}>
                  新建智能体
                </Button>
              }
            />
          ) : null}
          {agents.data && agents.data.length > 0 && filtered.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-subtle">没有匹配的智能体。</p>
          ) : null}

          <ul className="space-y-0.5" aria-label="智能体列表">
            {filtered.map((agent) => {
              const active = selected?.id === agent.id;
              return (
                <li key={agent.id}>
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => setSelectedId(agent.id)}
                    className={cn(
                      'group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      active
                        ? 'bg-accent-soft text-fg'
                        : 'text-muted hover:bg-sunken hover:text-fg',
                    )}
                  >
                    <span
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        agent.enabled ? 'bg-success' : 'bg-subtle',
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{agent.name}</span>
                      <span className="block truncate font-mono text-[10px] text-subtle">
                        {agent.slug}
                      </span>
                    </span>
                    <span className="text-[10px] tabular-nums text-subtle">
                      {agent.serverIds.length}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="min-w-0">
          {selected ? (
            <AgentEditor
              key={selected.id}
              agent={selected}
              onDelete={() => setDeleting(selected)}
            />
          ) : agents.data && agents.data.length > 0 ? (
            <EmptyState title="选择一个智能体" description="从左侧列表选择以查看和编辑配置。" />
          ) : (
            <div className="rounded-lg border border-dashed border-line-strong/70 px-6 py-16 text-center text-sm text-muted">
              新建智能体后在这里编辑。
            </div>
          )}
        </div>
      </div>

      {creating ? (
        <CreateAgentDialog
          returnFocusRef={createButtonRef}
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setSelectedId(agent.id);
            setCreating(false);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`删除智能体「${deleting?.name ?? ''}」`}
        description="它的会话、消息与绑定关系会一并删除，正在运行的任务不会被自动停止。此操作不可撤销。"
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          if (selectedId === deleting.id) setSelectedId(null);
        }}
      />
    </Page>
  );
}

function AgentEditor({ agent, onDelete }: { agent: Agent; onDelete: () => void }) {
  const update = useUpdateAgent();
  const servers = useServers();
  const skills = useSkills();
  const agents = useAgents();
  const [form, setForm] = useState<AgentInput>(() => toInput(agent));
  const [tab, setTab] = useState<'config' | 'files' | 'versions'>('config');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState(false);
  // 多行文本按行解析为数组；草稿单独保留，输入换行时不会被 join 规范化掉。
  const [allowedText, setAllowedText] = useState(() => agent.allowedTools.join('\n'));
  const allowedInvalid = allowedText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => /\s/.test(line));
  // 空值表示「不设置」，不能落成 0（schema 是可选正整数）。
  const [thinkingText, setThinkingText] = useState(() =>
    agent.maxThinkingTokens === undefined ? '' : String(agent.maxThinkingTokens),
  );
  const thinkingNumber = thinkingText.trim() === '' ? undefined : Number(thinkingText);
  const thinkingInvalid =
    thinkingNumber !== undefined && (!Number.isInteger(thinkingNumber) || thinkingNumber <= 0);

  const setAllowedToolsText = (value: string): void => {
    setAllowedText(value);
    set(
      'allowedTools',
      value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
  };

  const setThinkingTextSafely = (value: string): void => {
    setThinkingText(value);
    const number = value.trim() === '' ? undefined : Number(value);
    set(
      'maxThinkingTokens',
      number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined,
    );
  };

  const download = async (): Promise<void> => {
    setExporting(true);
    try {
      const data = await api.exportAgent(agent.id);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `${agent.slug}.agent.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      toastError(error);
    } finally {
      setExporting(false);
    }
  };

  const initial = useMemo(() => toInput(agent), [agent]);
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);

  const set = <K extends keyof AgentInput>(key: K, value: AgentInput[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key as string];
      return next;
    });
  };

  const save = (): void => {
    if (allowedInvalid || thinkingInvalid) return;
    const parsed = agentInputSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    update.mutate(
      { id: agent.id, input: parsed.data, expectedUpdatedAt: agent.updatedAt },
      {
        onSuccess: () => {
          setErrors({});
          toastSuccess('智能体已保存');
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409) {
            toast.error('配置已被修改，请刷新');
            return;
          }
          toastError(error);
        },
      },
    );
  };

  const serverOptions = (servers.data ?? []).map((server) => ({
    id: server.id,
    label: server.name,
    hint: server.kind,
    tag: server.kind,
  }));

  // 候选只能是还没有 parent 的顶层 agent，排除自己；已是子智能体时不能再委派。
  const subAgentOptions = (agents.data ?? [])
    .filter((item) => item.id !== agent.id && item.parentId === null)
    .map((item) => ({ id: item.id, label: item.name, hint: item.slug }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          label="智能体编辑视图"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'config', label: '配置' },
            { value: 'files', label: '文件预览' },
            { value: 'versions', label: '版本历史', icon: <History className="size-3.5" /> },
          ]}
        />
        <div className="flex items-center gap-2">
          {dirty ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-warning">
              <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
              有未保存的更改
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={exporting}
            aria-busy={exporting}
            onClick={() => void download()}
          >
            <Download className="size-3.5" /> 导出
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete} className="hover:text-danger">
            <Trash2 className="size-3.5" /> 删除
          </Button>
          <Button
            size="sm"
            disabled={!dirty || update.isPending || allowedInvalid || thinkingInvalid}
            aria-busy={update.isPending}
            onClick={save}
          >
            {update.isPending ? (
              '保存中…'
            ) : dirty ? (
              '保存更改'
            ) : (
              <>
                <Check className="size-3.5" /> 已保存
              </>
            )}
          </Button>
        </div>
      </div>

      {tab === 'config' ? (
        <form
          className="space-y-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (dirty && !update.isPending) save();
          }}
        >
          <section className="rounded-lg border border-line bg-surface p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="agent-name">
                  名称
                  <RequiredMark />
                </Label>
                <Input
                  id="agent-name"
                  value={form.name}
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? 'agent-name-error' : undefined}
                  onChange={(event) => set('name', event.target.value)}
                />
                <FieldError id="agent-name-error">{errors.name}</FieldError>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-slug">Slug</Label>
                <Input
                  id="agent-slug"
                  value={form.slug}
                  className="font-mono"
                  readOnly
                  aria-describedby="agent-slug-hint"
                />
                <FieldHint id="agent-slug-hint">创建后不可修改；它是工作区目录名。</FieldHint>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="agent-desc">描述</Label>
                <Input
                  id="agent-desc"
                  value={form.description}
                  placeholder="一句话说明它擅长什么"
                  onChange={(event) => set('description', event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-model">模型</Label>
                <Input
                  id="agent-model"
                  list="agent-models"
                  value={form.model}
                  className="font-mono"
                  onChange={(event) => set('model', event.target.value)}
                />
                <datalist id="agent-models">
                  {models.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-enabled">状态</Label>
                <Select
                  id="agent-enabled"
                  value={form.enabled ? 'on' : 'off'}
                  onValueChange={(next) => set('enabled', next === 'on')}
                  options={[
                    { value: 'on', label: '启用' },
                    { value: 'off', label: '停用' },
                  ]}
                />
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-line bg-surface p-5">
            <h2 className="mb-3 text-[13px] font-semibold text-fg">系统提示词</h2>
            <Textarea
              aria-label="系统提示词"
              rows={10}
              value={form.systemPrompt}
              className="font-mono text-xs leading-relaxed"
              placeholder="描述角色、边界与工作方式；会写入 CLAUDE.md。"
              onChange={(event) => set('systemPrompt', event.target.value)}
            />
          </section>

          <section className="rounded-lg border border-line bg-surface p-5">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="text-[13px] font-semibold text-fg">MCP Servers</h2>
              <span className="text-[11px] text-subtle">
                已绑定 {form.serverIds.length} / {(servers.data ?? []).length}
              </span>
            </div>
            {servers.isPending ? <LoadingState rows={1} /> : null}
            {servers.isError ? (
              <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />
            ) : null}
            {servers.data && servers.data.length === 0 ? (
              <p className="text-xs text-muted">
                还没有可绑定的 server，先去 MCP Servers 页面创建。
              </p>
            ) : null}
            {servers.data && servers.data.length > 0 ? (
              <MultiSelect
                label="MCP Server"
                options={serverOptions}
                value={form.serverIds}
                onChange={(next) => set('serverIds', next)}
                placeholder="搜索并选择 server…"
                emptyText="没有匹配的 server"
              />
            ) : null}
            <p className="mt-2 text-[11px] text-subtle">
              绑定后，工作区的 .mcp.json 会包含这些 server，智能体可使用
              <code className="mx-1 font-mono text-muted">mcp__&lt;server&gt;__*</code>
              工具。
            </p>
          </section>

          <section className="rounded-lg border border-line bg-surface p-5">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
                <Sparkles className="size-3.5 text-subtle" /> 技能
              </h2>
              <span className="text-[11px] text-subtle">
                已绑定 {form.skillIds.length} / {(skills.data ?? []).length}
              </span>
            </div>
            {skills.isPending ? <LoadingState rows={1} /> : null}
            {skills.data && skills.data.length === 0 ? (
              <p className="text-xs text-muted">
                还没有技能。技能是可复用的操作流程，会渲染为
                <code className="mx-1 font-mono text-muted">
                  .claude/skills/&lt;slug&gt;/SKILL.md
                </code>
                供智能体按需读取。
              </p>
            ) : null}
            {skills.data && skills.data.length > 0 ? (
              <MultiSelect
                label="技能"
                options={(skills.data ?? []).map((skill) => ({
                  id: skill.id,
                  label: skill.name,
                  hint: skill.description,
                }))}
                value={form.skillIds}
                onChange={(next) => set('skillIds', next)}
                placeholder="搜索并选择技能…"
                emptyText="没有匹配的技能"
              />
            ) : null}
          </section>

          <section className="rounded-lg border border-line bg-surface p-5">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
                <Bot className="size-3.5 text-subtle" /> 子智能体
              </h2>
              <span className="text-[11px] text-subtle">
                已选择 {form.subAgentIds.length} / {subAgentOptions.length}
              </span>
            </div>
            {agent.parentId !== null ? (
              <p className="text-xs text-muted">
                它本身已经是子智能体，不能再委派。子智能体只支持一层。
              </p>
            ) : subAgentOptions.length === 0 ? (
              <p className="text-xs text-muted">
                没有可选的主智能体。只有「没有父级」的智能体才能被委派。
              </p>
            ) : (
              <MultiSelect
                label="子智能体"
                options={subAgentOptions}
                value={form.subAgentIds}
                onChange={(next) => set('subAgentIds', next)}
                placeholder="搜索并选择子智能体…"
                emptyText="没有匹配的智能体"
              />
            )}
            <p className="mt-2 text-[11px] text-subtle">
              选中后，主智能体获得 <code className="font-mono text-muted">Agent</code>{' '}
              工具，子智能体定义会渲染到{' '}
              <code className="font-mono text-muted">.claude/agents/&lt;slug&gt;.md</code>。
            </p>
          </section>

          <section className="rounded-lg border border-line bg-surface p-5">
            <h2 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-fg">
              <Shield className="size-3.5 text-subtle" /> 权限与工具
            </h2>
            <p className="mb-3 text-[11px] text-subtle">
              内置工具默认禁用；MCP 工具由绑定的 server 自动放行。
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="agent-perm">权限模式</Label>
                <Select
                  id="agent-perm"
                  value={form.permissionMode}
                  onValueChange={(next) =>
                    set('permissionMode', next as AgentInput['permissionMode'])
                  }
                  options={[
                    { value: 'dontAsk', label: 'dontAsk — 拒绝未预批准' },
                    { value: 'plan', label: 'plan — 只规划不执行' },
                    { value: 'default', label: 'default — 标准权限' },
                    { value: 'acceptEdits', label: 'acceptEdits — 自动接受编辑' },
                  ]}
                />
                <p className="text-[11px] text-subtle">
                  auto 依赖模型分类器，平台无法审计，因此不开放。
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-effort">推理强度</Label>
                <Select
                  id="agent-effort"
                  value={form.effort ?? ''}
                  onValueChange={(value) =>
                    set('effort', value === '' ? undefined : (value as AgentInput['effort']))
                  }
                  options={[
                    { value: '', label: '默认' },
                    { value: 'low', label: 'low' },
                    { value: 'medium', label: 'medium' },
                    { value: 'high', label: 'high' },
                    { value: 'xhigh', label: 'xhigh' },
                    { value: 'max', label: 'max' },
                  ]}
                />
              </div>
            </div>
            <div className="mt-4">
              <Label htmlFor="agent-allowed-tools" className="mb-1.5 block">
                自定义允许的 MCP 工具
              </Label>
              <Textarea
                id="agent-allowed-tools"
                rows={3}
                value={allowedText}
                className="font-mono text-xs leading-relaxed"
                placeholder={'mcp__jsonplaceholder__get_user\nmcp__crm__*'}
                aria-invalid={allowedInvalid}
                aria-describedby={
                  allowedInvalid ? 'agent-allowed-tools-error' : 'agent-allowed-tools-hint'
                }
                onChange={(event) => setAllowedToolsText(event.target.value)}
              />
              {allowedInvalid ? (
                <FieldError id="agent-allowed-tools-error">
                  每行只能有一个工具名或模式，不能包含空格。
                </FieldError>
              ) : (
                <FieldHint id="agent-allowed-tools-hint">
                  每行一个模式，例如
                  mcp__jsonplaceholder__get_user、mcp__crm__*。留空表示「所有已绑定 server
                  的全部工具」。
                </FieldHint>
              )}
            </div>
            <div className="mt-4">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-subtle">
                内置工具
              </div>
              <div className="flex flex-wrap gap-1.5">
                {BUILTIN_TOOLS.map((tool) => {
                  const allowed = !form.disallowedTools.includes(tool);
                  return (
                    <button
                      key={tool}
                      type="button"
                      aria-pressed={allowed}
                      onClick={() =>
                        set(
                          'disallowedTools',
                          allowed
                            ? [...form.disallowedTools, tool]
                            : form.disallowedTools.filter((t) => t !== tool),
                        )
                      }
                      className={cn(
                        'rounded-md border px-2 py-1 font-mono text-[11px] transition-colors',
                        allowed
                          ? 'border-warning-line bg-warning-soft text-warning'
                          : 'border-line bg-sunken text-subtle hover:text-muted',
                      )}
                      title={allowed ? '已允许（不推荐）' : '已禁用'}
                    >
                      {tool}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-line bg-surface p-5">
            <h2 className="mb-3 text-[13px] font-semibold text-fg">运行时限制</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="agent-turns">最大轮次</Label>
                <Input
                  id="agent-turns"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={form.maxTurns}
                  aria-invalid={Boolean(errors.maxTurns)}
                  aria-describedby={errors.maxTurns ? 'agent-turns-error' : undefined}
                  onChange={(event) => set('maxTurns', Number(event.target.value))}
                />
                <FieldError id="agent-turns-error">{errors.maxTurns}</FieldError>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-budget">预算上限 (USD)</Label>
                <Input
                  id="agent-budget"
                  type="number"
                  min={0.01}
                  step={0.01}
                  inputMode="decimal"
                  value={form.maxBudgetUsd}
                  aria-invalid={Boolean(errors.maxBudgetUsd)}
                  aria-describedby={errors.maxBudgetUsd ? 'agent-budget-error' : undefined}
                  onChange={(event) => set('maxBudgetUsd', Number(event.target.value))}
                />
                <FieldError id="agent-budget-error">{errors.maxBudgetUsd}</FieldError>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-timeout">超时 (毫秒)</Label>
                <Input
                  id="agent-timeout"
                  type="number"
                  min={1000}
                  step={1000}
                  inputMode="numeric"
                  value={form.timeoutMs}
                  aria-invalid={Boolean(errors.timeoutMs)}
                  aria-describedby={errors.timeoutMs ? 'agent-timeout-error' : undefined}
                  onChange={(event) => set('timeoutMs', Number(event.target.value))}
                />
                <FieldError id="agent-timeout-error">{errors.timeoutMs}</FieldError>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-thinking">最大思考 tokens</Label>
                <Input
                  id="agent-thinking"
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={thinkingText}
                  placeholder="不设置"
                  aria-invalid={thinkingInvalid}
                  aria-describedby={
                    thinkingInvalid ? 'agent-thinking-error' : 'agent-thinking-hint'
                  }
                  onChange={(event) => setThinkingTextSafely(event.target.value)}
                />
                {thinkingInvalid ? (
                  <FieldError id="agent-thinking-error">
                    请输入大于 0 的整数，或留空表示不设置。
                  </FieldError>
                ) : (
                  <FieldHint id="agent-thinking-hint">留空表示不设置。</FieldHint>
                )}
              </div>
            </div>
          </section>

          <div className="flex justify-end gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={!dirty || update.isPending || allowedInvalid || thinkingInvalid}
            >
              {update.isPending ? '保存中…' : '保存更改'}
            </Button>
          </div>
        </form>
      ) : tab === 'files' ? (
        <FilesPreview agentId={agent.id} dirty={dirty} />
      ) : (
        <VersionHistory
          agentId={agent.id}
          onRolledBack={(next) => {
            setForm(toInput(next));
            setAllowedText(next.allowedTools.join('\n'));
            setThinkingText(
              next.maxThinkingTokens === undefined ? '' : String(next.maxThinkingTokens),
            );
            setErrors({});
          }}
        />
      )}
    </div>
  );
}

const fileTabs = [
  ['mcpJson', '.mcp.json', FileCode],
  ['claudeMd', 'CLAUDE.md', FileText],
  ['agentMd', 'agent md', FileText],
] as const;

function FilesPreview({ agentId, dirty }: { agentId: string; dirty: boolean }) {
  const files = useAgentFiles(agentId);
  const [which, setWhich] = useState<(typeof fileTabs)[number][0]>('mcpJson');

  const disabled = files.isPending || files.isError || !files.data;
  const active = fileTabs.find(([key]) => key === which) ?? fileTabs[0];
  const content = files.data?.[active[0]] ?? '';

  return (
    <div className="space-y-3">
      <p className="rounded-md border border-line bg-sunken/50 px-3 py-2 text-[11px] leading-relaxed text-muted">
        密钥在运行时注入，此处显示为占位符。
      </p>
      {dirty ? (
        <p className="rounded-md border border-warning-line bg-warning-soft px-3 py-2 text-[11px] leading-relaxed text-warning">
          预览显示的是上次保存后的内容。保存更改后重新加载即可看到最新结果。
        </p>
      ) : null}
      <Tabs
        label="工作区文件"
        value={which}
        onChange={setWhich}
        items={fileTabs.map(([value, label, Icon]) => ({
          value,
          label,
          icon: <Icon className="size-3.5" />,
        }))}
      />
      {files.isPending ? <LoadingState rows={6} /> : null}
      {files.isError ? (
        <ErrorState error={files.error} onRetry={() => void files.refetch()} />
      ) : null}
      {!disabled && content ? (
        <CodeBlock key={active[0]} code={content} lineNumbers maxHeight="calc(100vh - 22rem)" />
      ) : null}
      {!disabled && !content ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-xs text-subtle">
          该文件当前为空。保存配置后会自动生成内容。
        </p>
      ) : null}
      {!disabled ? (
        <p className="text-[11px] text-subtle">
          内容由当前保存的配置渲染；路径{' '}
          <code className="font-mono">data/workspaces/{'{slug}'}/</code>
        </p>
      ) : null}
    </div>
  );
}

function VersionHistory({
  agentId,
  onRolledBack,
}: {
  agentId: string;
  onRolledBack: (agent: Agent) => void;
}) {
  const versions = useAgentVersions(agentId);
  const rollback = useRollbackAgent();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [pending, setPending] = useState<AgentVersionSummary | null>(null);

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-subtle">
        每次保存都会生成一个版本快照（含 server
        与技能绑定）。回滚会把快照应用为当前配置，并生成一个新版本。
      </p>
      {versions.isPending ? <LoadingState rows={4} /> : null}
      {versions.isError ? (
        <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
      ) : null}
      {versions.data && versions.data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-xs text-subtle">
          还没有版本记录。修改配置并保存后，这里会留下第一份快照。
        </p>
      ) : null}
      {versions.data && versions.data.length > 0 ? (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {versions.data.map((item) => {
            const open = expanded === item.version;
            return (
              <li key={item.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[12.5px] font-medium text-fg">
                        v{item.version}
                      </span>
                      {item.note ? (
                        <span className="truncate rounded bg-sunken px-1.5 py-0.5 text-[10px] text-muted">
                          {item.note}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-[11px] text-subtle">
                      {formatDateTime(item.createdAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : item.version)}
                    >
                      {open ? (
                        <ChevronDown className="size-3.5" />
                      ) : (
                        <ChevronRight className="size-3.5" />
                      )}
                      {open ? '收起' : '查看'}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setPending(item)}>
                      <RotateCcw className="size-3.5" /> 回滚到此版本
                    </Button>
                  </div>
                </div>
                {open ? (
                  <div className="mt-3">
                    <VersionSnapshot agentId={agentId} version={item.version} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={`回滚到 v${pending?.version ?? ''}`}
        description="当前配置会被该版本的快照覆盖，并生成一个新版本。正在运行的会话不受影响。"
        confirmLabel="回滚"
        onConfirm={async () => {
          if (!pending) return;
          const agent = await rollback.mutateAsync({ id: agentId, version: pending.version });
          onRolledBack(agent);
          toastSuccess(`已回滚到 v${pending.version}`);
        }}
      />
    </div>
  );
}

function VersionSnapshot({ agentId, version }: { agentId: string; version: number }) {
  const detail = useAgentVersion(agentId, version, true);
  if (detail.isPending) return <LoadingState rows={3} />;
  if (detail.isError) {
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  }
  return (
    <CodeBlock
      code={JSON.stringify(detail.data.snapshot, null, 2)}
      json
      lineNumbers
      maxHeight="22rem"
    />
  );
}

function CreateAgentDialog({
  onClose,
  onCreated,
  returnFocusRef,
}: {
  onClose: () => void;
  onCreated: (agent: Agent) => void;
  returnFocusRef: { current: HTMLElement | null };
}) {
  const create = useCreateAgent();
  const [form, setForm] = useState<AgentInput>(emptyInput);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (): void => {
    const parsed = agentInputSchema.safeParse({
      ...form,
      name: form.name.trim() || form.slug,
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: (agent) => {
        toastSuccess('智能体已创建');
        onCreated(agent);
      },
      onError: (error) => toastError(error),
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="新建智能体"
      description="创建后可继续配置提示词、绑定 server 与运行时限制。"
      returnFocusRef={returnFocusRef}
    >
      <form
        className="space-y-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-agent-slug">
              Slug
              <RequiredMark />
            </Label>
            <Input
              id="new-agent-slug"
              value={form.slug}
              placeholder="support-bot"
              className="font-mono"
              aria-invalid={Boolean(errors.slug)}
              aria-describedby={errors.slug ? 'new-agent-slug-error' : 'new-agent-slug-hint'}
              onChange={(event) => setForm({ ...form, slug: event.target.value })}
            />
            {errors.slug ? (
              <FieldError id="new-agent-slug-error">{errors.slug}</FieldError>
            ) : (
              <FieldHint id="new-agent-slug-hint">
                小写字母、数字、- 和 _；创建后不可修改。
              </FieldHint>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-agent-name">名称</Label>
            <Input
              id="new-agent-name"
              value={form.name}
              placeholder="客服助手"
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-agent-model">模型</Label>
          <Select
            id="new-agent-model"
            value={form.model}
            onValueChange={(model) => setForm({ ...form, model })}
            options={models.map((model) => ({ value: model, label: model }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-agent-prompt">系统提示词</Label>
          <Textarea
            id="new-agent-prompt"
            rows={5}
            className="font-mono text-xs"
            value={form.systemPrompt}
            onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={create.isPending} aria-busy={create.isPending}>
            {create.isPending ? '创建中…' : '创建'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
