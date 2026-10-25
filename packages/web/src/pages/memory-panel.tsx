import type { OutputStyle } from '@agentport/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FilePlus2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { Checkbox } from '../components/ui/checkbox.js';
import { Field, FieldGroup, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { Textarea } from '../components/ui/textarea.js';
import { api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import {
  agentMemoryFileQuery,
  agentMemoryQuery,
  agentOutputStylesQuery,
  agentRulesQuery,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';

interface DraftCallbacks {
  onDirtyChange?: (dirty: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
}

/** 浏览/编辑 Claude Code 原生 auto-memory：MEMORY.md 索引 + 主题 Markdown。 */
export function MemoryPanel({
  agentId,
  onDirtyChange,
  onPendingChange,
}: { agentId: string } & DraftCallbacks) {
  const client = useQueryClient();
  const memory = useQuery(agentMemoryQuery(agentId));
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorPending, setEditorPending] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState(false);
  const files = memory.data?.files ?? [];
  // 选中项被删除或尚未确定时回落到 MEMORY.md。
  const active = files.some((file) => file.name === selected)
    ? selected
    : (files.find((file) => file.name === 'MEMORY.md')?.name ?? files[0]?.name ?? null);

  const create = useMutation({
    mutationFn: (fileName: string) => api.writeAgentMemoryFile(agentId, fileName, ''),
    onSuccess: (file) => {
      client.setQueryData(agentMemoryFileQuery(agentId, file.name).queryKey, file);
      void client.invalidateQueries({ queryKey: ['agent-memory', agentId] });
      toastSuccess(`已创建 ${file.name}`);
      setCreating(false);
      setName('');
      setSelected(file.name);
    },
    onError: toastError,
  });

  const remove = useMutation({
    mutationFn: (fileName: string) => api.deleteAgentMemoryFile(agentId, fileName),
    onSuccess: (_data, fileName) => {
      toastSuccess(`已删除 ${fileName}`);
      if (selected === fileName) setSelected(null);
      client.removeQueries({ queryKey: ['agent-memory-file', agentId, fileName] });
      void client.invalidateQueries({ queryKey: ['agent-memory', agentId] });
    },
  });

  // 创建中的文件名也属于离开会丢失的输入；创建请求同样要锁住切换与离开。
  const dirty = editorDirty || (creating && name.trim() !== '');
  const pending = editorPending || remove.isPending || create.isPending;
  // 路由离开与任务切换由父级用合并后的状态统一保护。
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => onPendingChange?.(pending), [pending, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);

  const submitNewFile = (event: React.FormEvent): void => {
    event.preventDefault();
    if (pending) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const fileName = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
    if (files.some((file) => file.name === fileName)) {
      toastError(new Error('同名记忆文件已存在，请换一个名字。'));
      return;
    }
    create.mutate(fileName);
  };

  if (memory.isPending) return <LoadingState rows={4} />;
  if (memory.isError) {
    return <ErrorState error={memory.error} onRetry={() => void memory.refetch()} />;
  }
  if (!memory.data.initialized) {
    return (
      <EmptyState
        icon={<FilePlus2 className="size-5" />}
        title="初始化记忆"
        description="MEMORY.md 作为索引，跨会话保留这位专家的长期记忆。"
        action={
          <Button
            disabled={create.isPending}
            aria-busy={create.isPending}
            onClick={() => create.mutate('MEMORY.md')}
          >
            <Plus data-icon="inline-start" aria-hidden="true" /> 初始化 MEMORY.md
          </Button>
        }
      />
    );
  }

  return (
    <div className="grid min-w-0 items-start gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
      <div className="min-w-0">
        <ul className="hidden flex-col gap-0.5 md:flex">
          {files.map((file) => (
            <li key={file.name} className="min-w-0 max-w-full">
              <button
                type="button"
                aria-current={file.name === active ? 'true' : undefined}
                disabled={pending}
                onClick={() => {
                  if (file.name === active) return;
                  if (dirty) setPendingSwitch(file.name);
                  else setSelected(file.name);
                }}
                className={cn(
                  'flex w-full max-w-full min-w-0 items-center rounded-icon px-2 py-1.5 text-left font-mono text-xs transition-colors',
                  file.name === active
                    ? 'bg-selected font-medium text-fg'
                    : 'text-muted-foreground hover:bg-hover',
                )}
              >
                <span className="truncate" title={file.name}>
                  {file.name}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <Select
          value={active}
          disabled={pending}
          items={files.map((file) => ({ value: file.name, label: file.name }))}
          onValueChange={(next) => {
            if (next === null || next === active) return;
            if (dirty) setPendingSwitch(next);
            else setSelected(next);
          }}
        >
          <SelectTrigger className="w-full min-w-0 md:hidden" aria-label="记忆文件">
            <SelectValue className="truncate" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {files.map((file) => (
                <SelectItem key={file.name} value={file.name}>
                  {file.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        {creating ? (
          <form onSubmit={submitNewFile} className="mt-2 flex flex-col gap-2">
            <Input
              autoFocus
              value={name}
              aria-label="记忆文件名"
              placeholder="主题.md"
              disabled={create.isPending}
              onChange={(event) => setName(event.target.value)}
              className="font-mono"
              onKeyDown={(event) => {
                if (event.key === 'Escape') setCreating(false);
              }}
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={create.isPending || !name.trim()}>
                {create.isPending ? '创建中…' : '创建'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={create.isPending}
                onClick={() => setCreating(false)}
              >
                取消
              </Button>
            </div>
          </form>
        ) : (
          <Button
            variant="outline"
            className="mt-2 justify-start"
            disabled={pending}
            onClick={() => {
              if (dirty) setPendingCreate(true);
              else setCreating(true);
            }}
          >
            <Plus data-icon="inline-start" aria-hidden="true" /> 新建记忆文件
          </Button>
        )}
      </div>

      {active ? (
        <MemoryFileEditor
          key={active}
          agentId={agentId}
          name={active}
          onDelete={() => setDeleting(active)}
          onDirtyChange={setEditorDirty}
          onPendingChange={setEditorPending}
        />
      ) : null}

      <ConfirmDialog
        open={pendingSwitch !== null || pendingCreate}
        onClose={() => {
          if (pending) return;
          setPendingSwitch(null);
          setPendingCreate(false);
        }}
        title="放弃未保存的修改？"
        description={`「${active ?? ''}」还有未保存的内容，继续后会丢失。`}
        confirmLabel="放弃并继续"
        confirmDisabled={pending}
        onConfirm={async () => {
          if (pendingSwitch) setSelected(pendingSwitch);
          else setCreating(true);
          setPendingSwitch(null);
          setPendingCreate(false);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => {
          if (pending) return;
          setDeleting(null);
        }}
        title="删除记忆文件"
        description={`将删除「${deleting ?? ''}」，此操作不可撤销。`}
        confirmDisabled={pending}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting);
        }}
      />
    </div>
  );
}

function MemoryFileEditor({
  agentId,
  name,
  onDelete,
  onDirtyChange,
  onPendingChange,
}: {
  agentId: string;
  name: string;
  onDelete: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const client = useQueryClient();
  const file = useQuery(agentMemoryFileQuery(agentId, name));
  const [draft, setDraft] = useState<string | null>(null);
  const content = draft ?? file.data?.content ?? '';
  const dirty = draft !== null && draft !== file.data?.content;

  const save = useMutation({
    mutationFn: () => api.writeAgentMemoryFile(agentId, name, content),
    onSuccess: (next) => {
      client.setQueryData(agentMemoryFileQuery(agentId, name).queryKey, next);
      void client.invalidateQueries({ queryKey: ['agent-memory', agentId] });
      toastSuccess('记忆已保存');
    },
    onError: toastError,
  });

  // 父级需要用脏状态拦截切换文件与路由离开。
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => onPendingChange(save.isPending), [save.isPending, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);

  if (file.isPending) return <LoadingState rows={4} />;
  if (file.isError) {
    return <ErrorState error={file.error} onRetry={() => void file.refetch()} />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 truncate font-mono text-md font-semibold text-fg">{name}</h2>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            variant="destructive"
            size="icon"
            aria-label={`删除 ${name}`}
            title={`删除 ${name}`}
            disabled={save.isPending}
            onClick={onDelete}
          >
            <Trash2 aria-hidden="true" />
          </Button>
          <Button
            disabled={!dirty || save.isPending}
            aria-busy={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? '保存中…' : '记忆保存'}
          </Button>
        </div>
      </div>
      <Field data-disabled={save.isPending} className="gap-1.5">
        <FieldLabel htmlFor="memory-content">{name} 内容</FieldLabel>
        <Textarea
          id="memory-content"
          value={content}
          rows={18}
          disabled={save.isPending}
          onChange={(event) => setDraft(event.target.value)}
          // Markdown 需要等宽与可读的行距。
          className="min-h-[18rem] font-mono leading-relaxed"
        />
      </Field>
    </div>
  );
}

type RuleAction =
  | { type: 'open'; rule: { slug: string; content: string; globs: string } }
  | { type: 'create' }
  | { type: 'delete'; slug: string };

/** 项目规则：编辑 `.claude/rules/<slug>.md`，可选路径作用域（globs）。 */
export function RulesPanel({
  agentId,
  onDirtyChange,
  onPendingChange,
}: { agentId: string } & DraftCallbacks) {
  const client = useQueryClient();
  const rules = useQuery(agentRulesQuery(agentId));
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [slug, setSlug] = useState('');
  const [draft, setDraft] = useState('');
  const [globs, setGlobs] = useState('');
  const [baseline, setBaseline] = useState<{ content: string; globs: string } | null>(null);
  const [confirming, setConfirming] = useState<RuleAction | null>(null);

  const invalidate = (): void =>
    void client.invalidateQueries({ queryKey: ['agent-rules', agentId] });
  const current = rules.data?.find((r) => r.slug === selected) ?? null;
  const dirty = creating
    ? slug.trim() !== '' || draft !== '' || globs !== ''
    : baseline !== null && (draft !== baseline.content || globs !== baseline.globs);

  const open = (rule: { slug: string; content: string; globs: string }): void => {
    setSelected(rule.slug);
    setDraft(rule.content);
    setGlobs(rule.globs);
    setBaseline({ content: rule.content, globs: rule.globs });
    setCreating(false);
  };

  const startCreate = (): void => {
    setCreating(true);
    setSelected(null);
    setSlug('');
    setDraft('');
    setGlobs('');
    setBaseline(null);
  };

  const save = useMutation({
    mutationFn: (vars: { slug: string; content: string; globs: string }) =>
      api.writeAgentRule(agentId, vars.slug, { content: vars.content, globs: vars.globs }),
    onSuccess: (rule) => {
      toastSuccess('规则已保存');
      setSelected(rule.slug);
      setDraft(rule.content);
      setGlobs(rule.globs);
      setBaseline({ content: rule.content, globs: rule.globs });
      setCreating(false);
      invalidate();
    },
    onError: (error) => toastError(error),
  });

  const remove = useMutation({
    mutationFn: (s: string) => api.deleteAgentRule(agentId, s),
    onSuccess: () => {
      toastSuccess('规则已删除');
      setSelected(null);
      setBaseline(null);
      invalidate();
    },
  });

  const pending = save.isPending || remove.isPending;

  const apply = (action: RuleAction): void => {
    if (pending) return;
    if (action.type === 'open') open(action.rule);
    else if (action.type === 'create') startCreate();
    else remove.mutate(action.slug);
  };

  const guard = (action: RuleAction): void => {
    if (pending) return;
    // 删除始终二次确认；其余动作只有当前草稿会丢时才确认。
    if (dirty || action.type === 'delete') setConfirming(action);
    else apply(action);
  };

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => onPendingChange?.(pending), [pending, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);

  const submit = (): void => {
    if (pending) return;
    const target = creating ? slug.trim() : selected;
    if (!target) return;
    save.mutate({ slug: target, content: draft, globs });
  };

  if (rules.isPending) return <LoadingState rows={2} />;
  if (rules.isError) return <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />;

  return (
    <div className="grid min-w-0 items-start gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-2">
        <Button variant="outline" disabled={pending} onClick={() => guard({ type: 'create' })}>
          <Plus data-icon="inline-start" /> 新建规则
        </Button>
        <ul className="hidden flex-col gap-0.5 md:flex">
          {rules.data.map((rule) => (
            <li key={rule.id} className="min-w-0 max-w-full">
              <button
                type="button"
                disabled={pending}
                onClick={() => guard({ type: 'open', rule })}
                className={cn(
                  'w-full max-w-full truncate rounded-item px-2 py-1.5 text-left text-sm hover:bg-hover',
                  selected === rule.slug && 'bg-selected text-fg',
                )}
              >
                {rule.slug}
              </button>
            </li>
          ))}
        </ul>
        <Select
          value={selected}
          disabled={pending}
          items={rules.data.map((rule) => ({ value: rule.slug, label: rule.slug }))}
          onValueChange={(next) => {
            const rule = rules.data.find((item) => item.slug === next);
            if (rule) guard({ type: 'open', rule });
          }}
        >
          <SelectTrigger className="w-full min-w-0 md:hidden" aria-label="项目规则">
            <SelectValue className="truncate" placeholder="选择规则" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {rules.data.map((rule) => (
                <SelectItem key={rule.id} value={rule.slug}>
                  {rule.slug}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        {creating || current ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate font-mono text-md font-semibold text-fg">
                {creating ? '新建规则' : current?.slug}
              </h2>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {current ? (
                  <Button
                    variant="destructive"
                    size="icon"
                    aria-label={`删除规则 ${current.slug}`}
                    title={`删除规则 ${current.slug}`}
                    disabled={pending}
                    onClick={() => guard({ type: 'delete', slug: current.slug })}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                ) : null}
                <Button
                  onClick={submit}
                  disabled={save.isPending || !dirty || (creating && !slug.trim())}
                  aria-busy={save.isPending}
                >
                  {save.isPending ? '保存中…' : '保存规则'}
                </Button>
              </div>
            </div>
            <FieldGroup>
              {creating ? (
                <Field className="gap-1.5" data-disabled={pending}>
                  <FieldLabel htmlFor="rule-slug">规则 slug</FieldLabel>
                  <Input
                    id="rule-slug"
                    value={slug}
                    placeholder="no-console"
                    className="font-mono"
                    disabled={pending}
                    onChange={(e) => setSlug(e.target.value)}
                  />
                </Field>
              ) : null}
              <Field className="gap-1.5" data-disabled={pending}>
                <FieldLabel htmlFor="rule-globs">路径作用域（可选）</FieldLabel>
                <Input
                  id="rule-globs"
                  value={globs}
                  placeholder="src/**/*.ts, docs/**"
                  className="font-mono"
                  disabled={pending}
                  onChange={(e) => setGlobs(e.target.value)}
                />
              </Field>
              <Field className="gap-1.5" data-disabled={pending}>
                <FieldLabel htmlFor="rule-content">规则内容（Markdown）</FieldLabel>
                <Textarea
                  id="rule-content"
                  value={draft}
                  rows={12}
                  className="min-h-[16rem] font-mono leading-relaxed"
                  disabled={pending}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </Field>
            </FieldGroup>
          </>
        ) : (
          <EmptyState title="选择或新建规则" />
        )}
      </div>

      <ConfirmDialog
        open={confirming !== null}
        onClose={() => {
          if (pending) return;
          setConfirming(null);
        }}
        title={
          confirming?.type === 'delete'
            ? dirty
              ? '放弃修改并删除？'
              : '删除规则？'
            : '放弃未保存的修改？'
        }
        description={
          confirming?.type === 'delete'
            ? dirty
              ? `「${current?.slug ?? ''}」还有未保存的内容，继续会放弃这些修改并删除该规则，此操作不可撤销。`
              : `将删除「${current?.slug ?? ''}」，此操作不可撤销。`
            : `「${current?.slug ?? '新建规则'}」还有未保存的内容，继续后会丢失。`
        }
        confirmLabel={
          confirming?.type === 'delete' && !dirty
            ? '删除'
            : confirming?.type === 'delete'
              ? '放弃并删除'
              : '放弃并继续'
        }
        confirmDisabled={pending}
        onConfirm={async () => {
          const action = confirming;
          if (action?.type === 'delete') {
            // 删除成功后再关确认框；失败保留草稿，错误由 ConfirmDialog 统一提示。
            await remove.mutateAsync(action.slug);
            setConfirming(null);
          } else {
            setConfirming(null);
            if (action) apply(action);
          }
        }}
      />
    </div>
  );
}

type StyleAction =
  | { type: 'open'; style: OutputStyle }
  | { type: 'create' }
  | { type: 'delete'; slug: string };

/** 自定义输出风格：选中项经 settings.outputStyle 生效。 */
export function OutputStylesPanel({
  agentId,
  onDirtyChange,
  onPendingChange,
}: { agentId: string } & DraftCallbacks) {
  const client = useQueryClient();
  const styles = useQuery(agentOutputStylesQuery(agentId));
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [keepCodingInstructions, setKeepCodingInstructions] = useState(false);
  const [body, setBody] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<{
    description: string;
    keepCodingInstructions: boolean;
    body: string;
  } | null>(null);
  const [confirming, setConfirming] = useState<StyleAction | null>(null);

  const invalidate = (): void =>
    void client.invalidateQueries({ queryKey: ['agent-output-styles', agentId] });
  const current = styles.data?.find((style) => style.slug === selected) ?? null;
  const dirty = creating
    ? slug.trim() !== '' || description !== '' || keepCodingInstructions || body !== ''
    : baseline !== null &&
      (description !== baseline.description ||
        keepCodingInstructions !== baseline.keepCodingInstructions ||
        body !== baseline.body);

  const open = (style: OutputStyle): void => {
    setSelected(style.slug);
    setDescription(style.description);
    setKeepCodingInstructions(style.keepCodingInstructions);
    setBody(style.body);
    setBaseline({
      description: style.description,
      keepCodingInstructions: style.keepCodingInstructions,
      body: style.body,
    });
    setCreating(false);
  };

  const startCreate = (): void => {
    setCreating(true);
    setSelected(null);
    setSlug('');
    setDescription('');
    setKeepCodingInstructions(false);
    setBody('');
    setBaseline(null);
  };

  const save = useMutation({
    mutationFn: (vars: {
      slug: string;
      description: string;
      keepCodingInstructions: boolean;
      body: string;
    }) =>
      api.writeAgentOutputStyle(agentId, vars.slug, {
        description: vars.description,
        keepCodingInstructions: vars.keepCodingInstructions,
        body: vars.body,
      }),
    onSuccess: (style) => {
      toastSuccess('输出风格已保存');
      setSelected(style.slug);
      setDescription(style.description);
      setKeepCodingInstructions(style.keepCodingInstructions);
      setBody(style.body);
      setBaseline({
        description: style.description,
        keepCodingInstructions: style.keepCodingInstructions,
        body: style.body,
      });
      setCreating(false);
      invalidate();
    },
    onError: (error) => toastError(error),
  });

  const unselect = useMutation({
    mutationFn: (s: string) => api.unselectAgentOutputStyle(agentId, s),
    onSuccess: () => {
      toastSuccess('已取消启用');
      invalidate();
    },
    onError: (error) => toastError(error),
  });

  const remove = useMutation({
    mutationFn: (s: string) => api.deleteAgentOutputStyle(agentId, s),
    onSuccess: () => {
      toastSuccess('输出风格已删除');
      setSelected(null);
      setBaseline(null);
      invalidate();
    },
  });

  const pending = save.isPending || unselect.isPending || remove.isPending;

  const apply = (action: StyleAction): void => {
    if (pending) return;
    if (action.type === 'open') open(action.style);
    else if (action.type === 'create') startCreate();
    else setDeleting(action.slug);
  };

  const guard = (action: StyleAction): void => {
    if (pending) return;
    if (dirty) setConfirming(action);
    else apply(action);
  };

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => onPendingChange?.(pending), [pending, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);

  const submit = (): void => {
    if (pending) return;
    const target = creating ? slug.trim() : selected;
    if (!target) return;
    save.mutate({ slug: target, description, keepCodingInstructions, body });
  };

  if (styles.isPending) return <LoadingState rows={2} />;
  if (styles.isError)
    return <ErrorState error={styles.error} onRetry={() => void styles.refetch()} />;

  return (
    <div className="grid min-w-0 items-start gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-2">
        <Button variant="outline" disabled={pending} onClick={() => guard({ type: 'create' })}>
          <Plus data-icon="inline-start" /> 新建风格
        </Button>
        <ul className="hidden flex-col gap-0.5 md:flex">
          {styles.data.map((style) => (
            <li key={style.id} className="min-w-0 max-w-full">
              <button
                type="button"
                disabled={pending}
                onClick={() => guard({ type: 'open', style })}
                className={cn(
                  'flex w-full max-w-full items-center gap-1.5 truncate rounded-item px-2 py-1.5 text-left text-sm hover:bg-hover',
                  selected === style.slug && 'bg-selected text-fg',
                )}
              >
                <span className="truncate">{style.slug}</span>
                {style.isSelected ? (
                  <span className="ml-auto shrink-0 text-2xs text-muted-foreground">已启用</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        <Select
          value={selected}
          disabled={pending}
          items={styles.data.map((style) => ({ value: style.slug, label: style.slug }))}
          onValueChange={(next) => {
            const style = styles.data.find((item) => item.slug === next);
            if (style) guard({ type: 'open', style });
          }}
        >
          <SelectTrigger className="w-full min-w-0 md:hidden" aria-label="输出风格">
            <SelectValue className="truncate" placeholder="选择输出风格" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {styles.data.map((style) => (
                <SelectItem key={style.id} value={style.slug}>
                  {style.slug}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        {creating || current ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate font-mono text-md font-semibold text-fg">
                {creating ? '新建风格' : current?.slug}
              </h2>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {current?.isSelected ? (
                  <Button
                    variant="outline"
                    onClick={() => unselect.mutate(current.slug)}
                    disabled={pending}
                  >
                    取消启用
                  </Button>
                ) : null}
                {current ? (
                  <Button
                    variant="destructive"
                    size="icon"
                    aria-label={`删除风格 ${current.slug}`}
                    title={`删除风格 ${current.slug}`}
                    disabled={pending}
                    onClick={() => guard({ type: 'delete', slug: current.slug })}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                ) : null}
                <Button
                  onClick={submit}
                  disabled={save.isPending || !dirty || (creating && !slug.trim())}
                  aria-busy={save.isPending}
                >
                  {save.isPending ? '保存中…' : '风格保存'}
                </Button>
              </div>
            </div>
            <FieldGroup>
              <Field className="gap-1.5" data-disabled={pending}>
                <FieldLabel htmlFor="output-style-slug">风格 slug</FieldLabel>
                <Input
                  id="output-style-slug"
                  value={creating ? slug : (current?.slug ?? '')}
                  placeholder="风格 slug，如 concise"
                  className="font-mono"
                  disabled={!creating || pending}
                  onChange={(e) => setSlug(e.target.value)}
                />
              </Field>
              <Field className="gap-1.5" data-disabled={pending}>
                <FieldLabel htmlFor="output-style-description">风格描述</FieldLabel>
                <Input
                  id="output-style-description"
                  value={description}
                  placeholder="描述"
                  disabled={pending}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
              <Field orientation="horizontal" data-disabled={pending}>
                <Checkbox
                  id="output-style-keep-coding"
                  checked={keepCodingInstructions}
                  disabled={pending}
                  onCheckedChange={setKeepCodingInstructions}
                />
                <FieldLabel htmlFor="output-style-keep-coding">保留编码指令</FieldLabel>
              </Field>
              <Field className="gap-1.5" data-disabled={pending}>
                <FieldLabel htmlFor="output-style-body">风格内容</FieldLabel>
                <Textarea
                  id="output-style-body"
                  value={body}
                  placeholder="风格说明（Markdown）"
                  rows={12}
                  className="min-h-[16rem] font-mono leading-relaxed"
                  disabled={pending}
                  onChange={(e) => setBody(e.target.value)}
                />
              </Field>
            </FieldGroup>
          </>
        ) : (
          <EmptyState title="选择或新建输出风格" description="启用后会替换专家默认的输出风格。" />
        )}
      </div>

      <ConfirmDialog
        open={confirming !== null}
        onClose={() => {
          if (pending) return;
          setConfirming(null);
        }}
        title={confirming?.type === 'delete' ? '放弃修改并删除？' : '放弃未保存的修改？'}
        description={
          confirming?.type === 'delete'
            ? `「${current?.slug ?? ''}」还有未保存的内容，继续会放弃这些修改，并进入删除确认。`
            : `「${current?.slug ?? '新建风格'}」还有未保存的内容，继续后会丢失。`
        }
        confirmLabel="放弃并继续"
        confirmDisabled={pending}
        onConfirm={async () => {
          const action = confirming;
          setConfirming(null);
          if (action) apply(action);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => {
          if (pending) return;
          setDeleting(null);
        }}
        title="删除输出风格"
        description={`将删除「${deleting ?? ''}」，此操作不可撤销。`}
        confirmDisabled={pending}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting);
        }}
      />
    </div>
  );
}
