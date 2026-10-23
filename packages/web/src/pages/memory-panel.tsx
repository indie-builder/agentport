import type { OutputStyle } from '@agentport/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FilePlus2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { Checkbox } from '../components/ui/checkbox.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
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

/** 浏览/编辑 Claude Code 原生 auto-memory：MEMORY.md 索引 + 主题 Markdown。 */
export function MemoryPanel({ agentId }: { agentId: string }) {
  const client = useQueryClient();
  const memory = useQuery(agentMemoryQuery(agentId));
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
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

  const submitNewFile = (event: React.FormEvent): void => {
    event.preventDefault();
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
    <div className="grid min-w-0 items-start gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
      <div className="min-w-0">
        <ul className="flex flex-wrap gap-1 md:flex-col md:flex-nowrap md:gap-0.5">
          {files.map((file) => (
            <li key={file.name} className="min-w-0">
              <button
                type="button"
                aria-current={file.name === active ? 'true' : undefined}
                onClick={() => setSelected(file.name)}
                className={cn(
                  'flex w-full min-w-0 items-center rounded-icon px-2 py-1.5 font-mono text-xs transition-colors md:text-left',
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

        {creating ? (
          <form onSubmit={submitNewFile} className="mt-2 flex flex-col gap-2">
            <Input
              autoFocus
              value={name}
              aria-label="记忆文件名"
              placeholder="主题.md"
              disabled={create.isPending}
              onChange={(event) => setName(event.target.value)}
              className="font-mono text-xs"
              onKeyDown={(event) => {
                if (event.key === 'Escape') setCreating(false);
              }}
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={create.isPending || !name.trim()}>
                {create.isPending ? '创建中…' : '创建'}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={create.isPending}
                onClick={() => setCreating(false)}
              >
                取消
              </Button>
            </div>
          </form>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 justify-start text-muted-foreground"
            onClick={() => setCreating(true)}
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
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="删除记忆文件"
        description={`将删除「${deleting ?? ''}」，此操作不可撤销。`}
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
}: {
  agentId: string;
  name: string;
  onDelete: () => void;
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

  if (file.isPending) return <LoadingState rows={4} />;
  if (file.isError) {
    return <ErrorState error={file.error} onRetry={() => void file.refetch()} />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{name}</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            disabled={!dirty || save.isPending}
            aria-busy={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? '保存中…' : '保存'}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`删除 ${name}`}
            title={`删除 ${name}`}
            onClick={onDelete}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      </div>
      <Textarea
        value={content}
        rows={18}
        aria-label={`${name} 内容`}
        onChange={(event) => setDraft(event.target.value)}
        // Markdown 需要等宽与可读的行距。
        className="min-h-[18rem] font-mono text-xs leading-relaxed"
      />
    </div>
  );
}

/** 项目规则：编辑 `.claude/rules/<slug>.md`，可选路径作用域（globs）。 */
export function RulesPanel({ agentId }: { agentId: string }) {
  const client = useQueryClient();
  const rules = useQuery(agentRulesQuery(agentId));
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [slug, setSlug] = useState('');
  const [draft, setDraft] = useState('');
  const [globs, setGlobs] = useState('');

  const invalidate = (): void =>
    void client.invalidateQueries({ queryKey: ['agent-rules', agentId] });
  const current = rules.data?.find((r) => r.slug === selected) ?? null;

  const open = (rule: { slug: string; content: string; globs: string }): void => {
    setSelected(rule.slug);
    setDraft(rule.content);
    setGlobs(rule.globs);
    setCreating(false);
  };

  const startCreate = (): void => {
    setCreating(true);
    setSelected(null);
    setSlug('');
    setDraft('');
    setGlobs('');
  };

  const save = useMutation({
    mutationFn: (vars: { slug: string; content: string; globs: string }) =>
      api.writeAgentRule(agentId, vars.slug, { content: vars.content, globs: vars.globs }),
    onSuccess: (rule) => {
      toastSuccess('规则已保存');
      setSelected(rule.slug);
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
      invalidate();
    },
    onError: (error) => toastError(error),
  });

  const submit = (): void => {
    const target = creating ? slug.trim() : selected;
    if (!target) return;
    save.mutate({ slug: target, content: draft, globs });
  };

  if (rules.isPending) return <LoadingState rows={2} />;
  if (rules.isError) return <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />;

  return (
    <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
      <div className="flex flex-col gap-2">
        <Button variant="outline" size="sm" onClick={startCreate}>
          <Plus data-icon="inline-start" /> 新建规则
        </Button>
        {rules.data.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            规则会随工作区加载，用来约束专家的行为。
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {rules.data.map((rule) => (
              <li key={rule.id}>
                <button
                  type="button"
                  onClick={() => open(rule)}
                  className={cn(
                    'w-full truncate rounded-item px-2 py-1.5 text-left text-sm hover:bg-hover',
                    selected === rule.slug && 'bg-selected text-fg',
                  )}
                >
                  {rule.slug}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {creating || current ? (
          <>
            {creating ? (
              <Input
                value={slug}
                placeholder="规则 slug，如 no-console"
                aria-label="规则 slug"
                className="font-mono text-xs"
                onChange={(e) => setSlug(e.target.value)}
              />
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm text-fg">{current?.slug}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`删除规则 ${current?.slug}`}
                  onClick={() => current && remove.mutate(current.slug)}
                >
                  <Trash2 />
                </Button>
              </div>
            )}
            <Input
              value={globs}
              placeholder="路径作用域（可选），如 src/**/*.ts, docs/**"
              aria-label="路径作用域"
              className="font-mono text-xs"
              onChange={(e) => setGlobs(e.target.value)}
            />
            <Textarea
              value={draft}
              placeholder="规则内容（Markdown）"
              aria-label="规则内容"
              rows={12}
              className="min-h-[16rem] font-mono text-xs leading-relaxed"
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="flex justify-end">
              <Button onClick={submit} disabled={save.isPending} aria-busy={save.isPending}>
                {save.isPending ? '保存中…' : '保存规则'}
              </Button>
            </div>
          </>
        ) : (
          <EmptyState
            title="选择或新建规则"
            description="规则按官方 .claude/rules 约定随会话加载。"
          />
        )}
      </div>
    </div>
  );
}

/** 自定义输出风格：选中项经 settings.outputStyle 生效。 */
export function OutputStylesPanel({ agentId }: { agentId: string }) {
  const client = useQueryClient();
  const styles = useQuery(agentOutputStylesQuery(agentId));
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [keepCodingInstructions, setKeepCodingInstructions] = useState(false);
  const [body, setBody] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  const invalidate = (): void =>
    void client.invalidateQueries({ queryKey: ['agent-output-styles', agentId] });
  const current = styles.data?.find((style) => style.slug === selected) ?? null;

  const open = (style: OutputStyle): void => {
    setSelected(style.slug);
    setDescription(style.description);
    setKeepCodingInstructions(style.keepCodingInstructions);
    setBody(style.body);
    setCreating(false);
  };

  const startCreate = (): void => {
    setCreating(true);
    setSelected(null);
    setSlug('');
    setDescription('');
    setKeepCodingInstructions(false);
    setBody('');
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
      invalidate();
    },
    onError: (error) => toastError(error),
  });

  const submit = (): void => {
    const target = creating ? slug.trim() : selected;
    if (!target) return;
    save.mutate({ slug: target, description, keepCodingInstructions, body });
  };

  if (styles.isPending) return <LoadingState rows={2} />;
  if (styles.isError)
    return <ErrorState error={styles.error} onRetry={() => void styles.refetch()} />;

  return (
    <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
      <div className="flex flex-col gap-2">
        <Button variant="outline" size="sm" onClick={startCreate}>
          <Plus data-icon="inline-start" /> 新建风格
        </Button>
        {styles.data.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">新建风格后会随会话加载。</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {styles.data.map((style) => (
              <li key={style.id}>
                <button
                  type="button"
                  onClick={() => open(style)}
                  className={cn(
                    'flex w-full items-center gap-1.5 truncate rounded-item px-2 py-1.5 text-left text-sm hover:bg-hover',
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
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {creating || current ? (
          <>
            <Input
              value={creating ? slug : (current?.slug ?? '')}
              placeholder="风格 slug，如 concise"
              aria-label="风格 slug"
              className="font-mono text-xs"
              disabled={!creating}
              onChange={(e) => setSlug(e.target.value)}
            />
            <Input
              value={description}
              placeholder="描述"
              aria-label="风格描述"
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <Checkbox
                id="output-style-keep-coding"
                className="size-3.5"
                checked={keepCodingInstructions}
                onCheckedChange={setKeepCodingInstructions}
              />
              <Label htmlFor="output-style-keep-coding" className="text-xs font-normal">
                保留编码指令
              </Label>
            </div>
            <Textarea
              value={body}
              placeholder="风格说明（Markdown）"
              aria-label="风格内容"
              rows={12}
              className="min-h-[16rem] font-mono text-xs leading-relaxed"
              onChange={(e) => setBody(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              {current?.isSelected ? (
                <Button
                  variant="ghost"
                  onClick={() => unselect.mutate(current.slug)}
                  disabled={unselect.isPending}
                >
                  取消启用
                </Button>
              ) : null}
              {current ? (
                <Button variant="destructive" onClick={() => setDeleting(current.slug)}>
                  <Trash2 /> 删除
                </Button>
              ) : null}
              <Button onClick={submit} disabled={save.isPending} aria-busy={save.isPending}>
                {save.isPending ? '保存中…' : '保存'}
              </Button>
            </div>
          </>
        ) : (
          <EmptyState title="选择或新建输出风格" description="启用后会替换专家默认的输出风格。" />
        )}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="删除输出风格"
        description={`将删除「${deleting ?? ''}」，此操作不可撤销。`}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting);
        }}
      />
    </div>
  );
}
