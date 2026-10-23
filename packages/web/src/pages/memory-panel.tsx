import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FilePlus2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Textarea } from '../components/ui/textarea.js';
import { api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { agentMemoryFileQuery, agentMemoryQuery } from '../lib/queries.js';
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
