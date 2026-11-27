import type { MemoryChange, MemoryFileContent } from '@agentport/shared';
import { memoryFileNameSchema, validateMemoryContent } from '@agentport/shared';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { Download, History, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { api, errorMessage } from '../../../lib/api.js';
import { cn } from '../../../lib/cn.js';
import { applyProblemToForm } from '../../../lib/form.js';
import { formatDateTime } from '../../../lib/format.js';
import {
  agentMemoryFileQuery,
  agentMemoryQuery,
  memoryVersionsQuery,
  useDeleteAgentMemoryFile,
  useRollbackMemoryChange,
  useWriteAgentMemoryFile,
} from '../../../lib/queries.js';
import { toastError, toastSuccess } from '../../../lib/toast.js';
import { useEditStateNotify } from '../../../lib/use-edit-state-notify.js';
import { useZodForm } from '../../../lib/use-zod-form.js';
import { CodeBlock } from '../../code-block.js';
import { ConfirmDialog } from '../../confirm-dialog.js';
import { DialogShell } from '../../dialog-shell.js';
import { SourceEditor } from '../../source-editor.js';
import { EmptyState, ErrorState, LoadingState } from '../../states.js';
import { Button, buttonVariants } from '../../ui/button.js';
import { Dialog } from '../../ui/dialog.js';
import { Field, FieldError, FieldLabel } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../ui/select.js';
import { type DraftCallbacks, useSwitchGuard } from './shared.js';

function changeAfterContent(change: MemoryChange, name: string): string | null {
  if (change.target.kind !== 'agent_memory' || change.target.name === name) {
    return change.after.content;
  }
  return change.after.index?.content ?? null;
}

function changeIndexChanged(change: MemoryChange): boolean {
  return (change.before.index?.content ?? null) !== (change.after.index?.content ?? null);
}

function changePreview(change: MemoryChange, name: string): string {
  const content = changeAfterContent(change, name) ?? '';
  if (change.target.kind !== 'agent_memory' || change.target.name === name) {
    return content.trim().split('\n')[0] ?? '';
  }
  const beforeLines = new Set((change.before.index?.content ?? '').split('\n'));
  const changed = content.split('\n').find((line) => line.trim() !== '' && !beforeLines.has(line));
  return (changed ?? content.trim().split('\n')[0] ?? '').trim();
}

function changeFiles(
  change: MemoryChange,
): { key: string; label: string; content: string | null }[] {
  if (change.target.kind !== 'agent_memory') {
    return [{ key: 'target', label: '变更后内容', content: change.after.content }];
  }
  const name = change.target.name;
  const files = [
    {
      key: name,
      label: name === 'MEMORY.md' ? 'MEMORY.md' : `主题「${name}」正文`,
      content: change.after.content,
    },
  ];
  if (name !== 'MEMORY.md' && changeIndexChanged(change)) {
    files.push({
      key: 'MEMORY.md',
      label: 'MEMORY.md 索引',
      content: change.after.index?.content ?? null,
    });
  }
  return files;
}

function rollbackImpact(change: MemoryChange): string {
  if (change.target.kind !== 'agent_memory') return '恢复此前的保存内容。';
  const name = change.target.name;
  const indexText = changeIndexChanged(change) ? '，并恢复此前的 MEMORY.md 索引' : '';
  if (change.before.content === null && change.after.content !== null) {
    return name === 'MEMORY.md'
      ? '删除新建的 MEMORY.md。'
      : `删除新建的主题「${name}」${indexText}。`;
  }
  return `恢复「${name}」此前的正文${indexText}。`;
}

function MemoryReviewLink({ agentId }: { agentId: string }) {
  const query = new URLSearchParams({ agent: agentId });
  return (
    <div className="flex justify-end">
      <a
        href={`/personal/reviews?${query.toString()}`}
        className="text-sm text-[var(--color-link)] underline underline-offset-4"
      >
        记忆提案
      </a>
    </div>
  );
}

type FilesAction = { type: 'select'; name: string } | { type: 'create' };

function createNewMemoryFileSchema(existingNames: readonly string[]) {
  return z.object({
    name: z.string().superRefine((value, ctx) => {
      const trimmed = value.trim();
      if (!trimmed) {
        ctx.addIssue({ code: 'custom', message: '请填写记忆文件名' });
        return;
      }
      const fileName = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
      const parsed = memoryFileNameSchema.safeParse(fileName);
      if (!parsed.success) {
        ctx.addIssue({
          code: 'custom',
          message: parsed.error.issues[0]?.message ?? '记忆文件名非法',
        });
        return;
      }
      if (existingNames.includes(fileName)) {
        ctx.addIssue({ code: 'custom', message: '同名记忆文件已存在，请换一个名字。' });
      }
    }),
  });
}

function createMemoryContentSchema(name: string) {
  return z
    .object({
      content: z.string(),
    })
    .superRefine((values, ctx) => {
      const problem = validateMemoryContent(name, values.content);
      if (problem !== null) {
        ctx.addIssue({ code: 'custom', path: ['content'], message: problem });
      }
    });
}

export function MemoryFilesPanel({
  agentId,
  canWrite = true,
  onDirtyChange,
  onPendingChange,
}: { agentId: string; canWrite?: boolean } & DraftCallbacks) {
  const memory = useQuery(agentMemoryQuery(agentId));
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorPending, setEditorPending] = useState(false);
  const files = memory.data?.files ?? [];
  const active = files.some((file) => file.name === selected)
    ? selected
    : (files.find((file) => file.name === 'MEMORY.md')?.name ?? files[0]?.name ?? null);

  const create = useWriteAgentMemoryFile(agentId);
  const remove = useDeleteAgentMemoryFile(agentId);

  const newFileSchema = useMemo(
    () => createNewMemoryFileSchema(files.map((file) => file.name)),
    [files],
  );
  const newFileForm = useZodForm(newFileSchema, { defaultValues: { name: '' } });

  const createFile = async (fileName: string): Promise<void> => {
    try {
      const file = await create.mutateAsync({ name: fileName, content: '' });
      toastSuccess(`已创建 ${file.name}`);
      newFileForm.reset({ name: '' });
      setCreating(false);
      setSelected(file.name);
    } catch (error) {
      if (!applyProblemToForm(newFileForm, error)) toastError(error);
    }
  };

  const dirty = editorDirty || (creating && newFileForm.formState.isDirty);
  const pending = editorPending || remove.isPending || create.isPending;
  useEditStateNotify(dirty, pending, onDirtyChange, onPendingChange);

  const switchGuard = useSwitchGuard<FilesAction>(dirty, pending, (action) => {
    if (action.type === 'select') {
      if (creating) {
        newFileForm.reset({ name: '' });
        setCreating(false);
      }
      setSelected(action.name);
      return;
    }
    newFileForm.reset({ name: '' });
    setCreating(true);
  });

  const cancelCreate = (): void => {
    if (create.isPending) return;
    newFileForm.reset({ name: '' });
    setCreating(false);
  };

  const submitNewFile = newFileForm.handleSubmit(async (values) => {
    if (pending) return;
    const trimmed = values.name.trim();
    const fileName = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
    await createFile(fileName);
  });

  if (memory.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <MemoryReviewLink agentId={agentId} />
        <LoadingState rows={4} />
      </div>
    );
  }
  if (memory.data === undefined) {
    return (
      <div className="flex flex-col gap-4">
        <MemoryReviewLink agentId={agentId} />
        <ErrorState error={memory.error} onRetry={() => void memory.refetch()} />
      </div>
    );
  }
  if (!memory.data.initialized && (canWrite || files.length === 0)) {
    return (
      <div className="flex flex-col gap-4">
        <MemoryReviewLink agentId={agentId} />
        {memory.isError ? (
          <ErrorState error={memory.error} onRetry={() => void memory.refetch()} />
        ) : null}
        <EmptyState
          variant="stage"
          scale="section"
          specimen="memory"
          title={canWrite ? '初始化记忆' : '尚未初始化记忆'}
          description="MEMORY.md 作为索引，跨会话保留这位专家的长期记忆。"
          action={
            canWrite ? (
              <Button
                disabled={create.isPending}
                aria-busy={create.isPending}
                onClick={() => void createFile('MEMORY.md')}
              >
                <Plus data-icon="inline-start" aria-hidden="true" /> 初始化 MEMORY.md
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const nameError = newFileForm.formState.errors.name;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <MemoryReviewLink agentId={agentId} />
        <a
          href={api.agentMemoryDownloadUrl(agentId)}
          download
          className={buttonVariants({ variant: 'outline' })}
        >
          <Download data-icon="inline-start" aria-hidden="true" />
          下载记忆
        </a>
      </div>
      {memory.isError ? (
        <ErrorState error={memory.error} onRetry={() => void memory.refetch()} />
      ) : null}
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
                    if (file.name !== active)
                      switchGuard.request({ type: 'select', name: file.name });
                  }}
                  className={cn(
                    'flex w-full max-w-full min-w-0 items-center rounded-icon px-2 py-1.5 text-left font-mono text-xs transition-colors duration-150 ease-out-soft',
                    file.name === active
                      ? 'bg-selected font-medium text-selected-foreground'
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
              if (next !== null && next !== active) {
                switchGuard.request({ type: 'select', name: next });
              }
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
            <form onSubmit={submitNewFile} className="mt-2 flex flex-col gap-2" noValidate>
              <Field
                className="gap-1.5"
                data-disabled={create.isPending}
                data-invalid={Boolean(nameError)}
              >
                <Input
                  {...newFileForm.register('name')}
                  autoFocus
                  aria-label="记忆文件名"
                  aria-invalid={Boolean(nameError)}
                  aria-describedby={nameError ? 'memory-new-file-error' : undefined}
                  placeholder="主题.md"
                  disabled={create.isPending}
                  className="font-mono"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') cancelCreate();
                  }}
                />
                <FieldError id="memory-new-file-error">{nameError?.message}</FieldError>
              </Field>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={create.isPending}
                  onClick={cancelCreate}
                >
                  取消
                </Button>
                <Button type="submit" disabled={create.isPending} aria-busy={create.isPending}>
                  {create.isPending ? '创建中…' : '创建'}
                </Button>
              </div>
            </form>
          ) : canWrite ? (
            <Button
              variant="outline"
              className="mt-2 justify-start"
              disabled={pending}
              onClick={() => switchGuard.request({ type: 'create' })}
            >
              <Plus data-icon="inline-start" aria-hidden="true" /> 新建记忆文件
            </Button>
          ) : null}
        </div>

        {active ? (
          <MemoryFileEditor
            key={active}
            agentId={agentId}
            name={active}
            canWrite={canWrite}
            onDelete={() => setDeleting(active)}
            onDirtyChange={setEditorDirty}
            onPendingChange={setEditorPending}
          />
        ) : null}

        <ConfirmDialog
          open={switchGuard.pendingAction !== null}
          onClose={switchGuard.cancel}
          title="放弃未保存的修改？"
          description={`「${creating && newFileForm.formState.isDirty && !editorDirty ? '新建记忆文件' : (active ?? '')}」还有未保存的内容，继续后会丢失。`}
          confirmLabel="放弃并继续"
          confirmDisabled={pending}
          onConfirm={switchGuard.confirm}
        />

        <ConfirmDialog
          open={deleting !== null}
          onClose={() => {
            if (pending) return;
            setDeleting(null);
          }}
          title="删除记忆文件"
          description={`将删除「${deleting ?? ''}」，并记入版本账本。`}
          confirmDisabled={pending}
          onConfirm={async () => {
            if (deleting) {
              await remove.mutateAsync(deleting, {
                onSuccess: (_data, fileName) => {
                  toastSuccess(`已删除 ${fileName}`);
                  if (selected === fileName) setSelected(null);
                },
              });
            }
          }}
        />
      </div>
    </div>
  );
}

function MemoryFileEditor({
  agentId,
  name,
  canWrite,
  onDelete,
  onDirtyChange,
  onPendingChange,
}: {
  agentId: string;
  name: string;
  canWrite: boolean;
  onDelete: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const file = useQuery(agentMemoryFileQuery(agentId, name));

  if (file.isPending) return <LoadingState rows={4} />;
  if (file.data === undefined) {
    return <ErrorState error={file.error} onRetry={() => void file.refetch()} />;
  }

  return (
    <MemoryFileForm
      agentId={agentId}
      name={name}
      file={file}
      initialContent={file.data.content}
      canWrite={canWrite}
      onDelete={onDelete}
      onDirtyChange={onDirtyChange}
      onPendingChange={onPendingChange}
    />
  );
}

function MemoryFileForm({
  agentId,
  name,
  file,
  initialContent,
  canWrite,
  onDelete,
  onDirtyChange,
  onPendingChange,
}: {
  agentId: string;
  name: string;
  file: UseQueryResult<MemoryFileContent>;
  initialContent: string;
  canWrite: boolean;
  onDelete: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const versions = useQuery(memoryVersionsQuery({ kind: 'agent_memory', agentId, name }));
  const rollback = useRollbackMemoryChange();
  const save = useWriteAgentMemoryFile(agentId);
  const [viewing, setViewing] = useState<MemoryChange | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<MemoryChange | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  const schema = useMemo(() => createMemoryContentSchema(name), [name]);
  const form = useZodForm(schema, {
    defaultValues: { content: initialContent },
  });
  const { control, handleSubmit, reset, formState } = form;
  const { errors, isDirty: dirty } = formState;
  const pending = save.isPending || rollback.isPending;

  const syncedContent = useRef(initialContent);
  const latestContent = file.data?.content ?? initialContent;
  useEffect(() => {
    if (dirty || syncedContent.current === latestContent) return;
    syncedContent.current = latestContent;
    reset({ content: latestContent });
  }, [latestContent, dirty, reset]);

  useEditStateNotify(dirty, pending, onDirtyChange, onPendingChange);

  const rollbackTo = async (change: MemoryChange): Promise<void> => {
    try {
      await rollback.mutateAsync(change.id);
      const refreshed = await file.refetch();
      const nextContent = refreshed.data?.content ?? latestContent;
      syncedContent.current = nextContent;
      reset({ content: nextContent });
      setRollbackError(null);
      toastSuccess('已回滚这次变更');
      await versions.refetch();
    } catch (error) {
      setRollbackError(errorMessage(error));
    }
  };

  const onSubmit = handleSubmit(
    async (values) => {
      if (pending || !canWrite) return;
      try {
        const saved = await save.mutateAsync({ name, content: values.content });
        syncedContent.current = saved.content;
        reset({ content: saved.content });
        toastSuccess('记忆已保存');
      } catch (error) {
        if (!applyProblemToForm(form, error)) toastError(error);
      }
    },
    () => {
      document.getElementById('memory-content')?.focus();
    },
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {file.isError ? <ErrorState error={file.error} onRetry={() => void file.refetch()} /> : null}
      <form className="flex min-w-0 flex-col gap-3" noValidate onSubmit={onSubmit}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 truncate font-mono text-md font-semibold text-fg">{name}</h2>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {canWrite ? (
              <>
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  aria-label={`删除 ${name}`}
                  title={`删除 ${name}`}
                  disabled={pending}
                  onClick={onDelete}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
                <Button type="submit" disabled={!dirty || pending} aria-busy={save.isPending}>
                  {save.isPending ? '保存中…' : '记忆保存'}
                </Button>
              </>
            ) : null}
          </div>
        </div>
        <Field
          data-disabled={pending || !canWrite}
          data-invalid={Boolean(errors.content)}
          className="gap-1.5"
        >
          <FieldLabel htmlFor="memory-content">{name} 内容</FieldLabel>
          <Controller
            control={control}
            name="content"
            render={({ field }) => (
              <SourceEditor
                id="memory-content"
                value={field.value}
                language="markdown"
                aria-label={`${name} 内容`}
                aria-invalid={Boolean(errors.content)}
                aria-describedby={errors.content ? 'memory-content-error' : undefined}
                disabled={pending || !canWrite}
                onChange={field.onChange}
                onBlur={field.onBlur}
                className="min-h-72"
              />
            )}
          />
          <FieldError id="memory-content-error">{errors.content?.message}</FieldError>
        </Field>
      </form>

      <section aria-label={`${name} 版本`} className="flex flex-col gap-2 border-t pt-3">
        <h3 className="text-sm font-medium text-fg">版本</h3>
        {dirty ? (
          <p id="memory-rollback-blocked" className="text-xs text-muted-foreground">
            先保存或放弃当前草稿再回滚。
          </p>
        ) : null}
        {versions.isPending ? <LoadingState rows={3} /> : null}
        {versions.isError ? (
          <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
        ) : null}
        {versions.data ? (
          versions.data.items.length === 0 ? (
            <EmptyState
              variant="idle"
              scale="inline"
              icon={<History className="size-4" aria-hidden="true" />}
              title="保存后会记录版本"
            />
          ) : (
            <ul className="divide-y border-y">
              {versions.data.items.map((change) => {
                const content = changeAfterContent(change, name);
                const preview = changePreview(change, name);
                return (
                  <li key={change.id} className="flex items-start gap-2 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-fg">{formatDateTime(change.createdAt)}</div>
                      <div className="truncate text-xs text-muted-foreground" title={content ?? ''}>
                        {preview || '空内容'}
                      </div>
                      {change.reversesChangeId ? (
                        <div className="text-2xs text-muted-foreground">回滚记录</div>
                      ) : null}
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setViewing(change)}>
                      查看
                    </Button>
                    {canWrite ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending || dirty}
                        aria-describedby={dirty ? 'memory-rollback-blocked' : undefined}
                        title={dirty ? '先保存或放弃当前草稿再回滚' : undefined}
                        aria-label={`回滚 ${formatDateTime(change.createdAt)} 的变更`}
                        onClick={() => {
                          setRollbackError(null);
                          setRollbackTarget(change);
                        }}
                      >
                        <RotateCcw data-icon="inline-start" aria-hidden="true" />
                        回滚
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
        {rollbackError ? (
          <div role="alert" className="text-sm text-danger">
            {rollbackError}
          </div>
        ) : null}
      </section>

      <Dialog
        open={viewing !== null}
        onOpenChange={(next) => {
          if (!next) setViewing(null);
        }}
      >
        <DialogShell title={`${name} 版本`} className="max-w-2xl">
          {viewing ? (
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                {formatDateTime(viewing.createdAt)}
              </p>
              <div className="flex flex-col gap-3">
                {changeFiles(viewing).map((item) => (
                  <div key={item.key} className="flex min-w-0 flex-col gap-1.5">
                    <h3 className="text-sm font-medium text-fg">{item.label}</h3>
                    <CodeBlock
                      code={item.content ?? ''}
                      maxHeight="24rem"
                      copyable={false}
                      className="min-w-0"
                    />
                  </div>
                ))}
              </div>
            </>
          ) : null}
          <div className="mt-4 flex justify-end">
            <Button variant="outline" onClick={() => setViewing(null)}>
              关闭
            </Button>
          </div>
        </DialogShell>
      </Dialog>

      <ConfirmDialog
        open={rollbackTarget !== null}
        onClose={() => setRollbackTarget(null)}
        title="回滚这次变更？"
        description={
          rollbackTarget
            ? `将撤销 ${formatDateTime(rollbackTarget.createdAt)} 的这次变更：${rollbackImpact(rollbackTarget)}`
            : ''
        }
        confirmLabel="回滚"
        confirmDisabled={pending || dirty}
        onConfirm={async () => {
          if (rollbackTarget) await rollbackTo(rollbackTarget);
        }}
      />
    </div>
  );
}
