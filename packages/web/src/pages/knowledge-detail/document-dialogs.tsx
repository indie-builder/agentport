import type { KnowledgeDocument } from '@agentport/shared';
import { Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DialogShell } from '../../components/dialog-shell.js';
import {
  DraftGuardDialogs,
  treeFolders,
  useDraftGuard,
} from '../../components/knowledge-shared.js';
import { RequiredMark } from '../../components/required-mark.js';
import { ErrorState, InlineEmpty, LoadingState } from '../../components/states.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Field, FieldGroup, FieldLabel } from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import type { KnowledgeFolder, KnowledgeTag } from '../../lib/api.js';
import { useFormBlocker } from '../../lib/form.js';
import {
  useCreateKnowledgeFolder,
  useCreateKnowledgeTag,
  useDeleteKnowledgeTag,
  useKnowledgeTags,
  useRenameKnowledgeTag,
  useUpdateKnowledgeDocument,
  useUpdateKnowledgeFolder,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';

export function FolderDialog({
  baseId,
  state,
  onClose,
  onCreated,
  finalFocus,
}: {
  baseId: string;
  state: { mode: 'create'; parentId: string | null } | { mode: 'rename'; folder: KnowledgeFolder };
  onClose: () => void;
  onCreated: (folder: KnowledgeFolder) => void;
  finalFocus: () => HTMLElement | null;
}) {
  const create = useCreateKnowledgeFolder(baseId);
  const update = useUpdateKnowledgeFolder(baseId);
  const initialName = state.mode === 'rename' ? state.folder.name : '';
  const [name, setName] = useState(initialName);
  const pending = create.isPending || update.isPending;
  const trimmed = name.trim();
  const unchanged = state.mode === 'rename' && trimmed === state.folder.name;
  const title = state.mode === 'rename' ? '重命名文件夹' : '新建文件夹';
  const guard = useDraftGuard(name !== initialName, pending, onClose);

  const submit = (): void => {
    if (state.mode === 'rename') {
      update.mutate(
        { folderId: state.folder.id, patch: { name: trimmed } },
        {
          onSuccess: () => {
            toastSuccess('文件夹已重命名');
            guard.finish();
          },
          onError: toastError,
        },
      );
      return;
    }
    create.mutate(
      { parentId: state.parentId, name: trimmed },
      {
        onSuccess: (folder) => {
          toastSuccess('文件夹已创建');
          // 先解除本弹层的离开拦截，再让父级切到新文件夹。
          guard.finish();
          onCreated(folder);
        },
        onError: toastError,
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) guard.close();
      }}
    >
      <DialogShell title={title} closeDisabled={pending} finalFocus={finalFocus}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field className="gap-1.5">
            <FieldLabel htmlFor="knowledge-folder-name">
              名称 <RequiredMark />
            </FieldLabel>
            <Input
              id="knowledge-folder-name"
              value={name}
              maxLength={120}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button
              type="submit"
              disabled={pending || trimmed === '' || unchanged}
              aria-busy={pending}
            >
              {pending ? '保存中…' : state.mode === 'rename' ? '保存' : '创建'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="文件夹名称草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

export function TagDialog({ baseId, onClose }: { baseId: string; onClose: () => void }) {
  const tags = useKnowledgeTags(baseId);
  const create = useCreateKnowledgeTag(baseId);
  const rename = useRenameKnowledgeTag(baseId);
  const remove = useDeleteKnowledgeTag(baseId);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeTag | null>(null);
  const trimmed = name.trim();
  const pending = create.isPending || rename.isPending || remove.isPending;
  const guard = useDraftGuard(trimmed !== '', pending, onClose);

  function submitRename() {
    if (!editing) return;
    const next = editing.name.trim();
    const current = tags.data?.find((tag) => tag.id === editing.id)?.name;
    if (next === '' || next === current) return;
    rename.mutate(
      { tagId: editing.id, name: next },
      {
        onSuccess: () => {
          setEditing(null);
          toastSuccess('标签已重命名');
        },
        onError: toastError,
      },
    );
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={(next, details) => {
          if (pending) {
            details.cancel();
            return;
          }
          if (!next) guard.close();
        }}
      >
        <DialogShell title="管理标签" closeDisabled={pending}>
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate(trimmed, {
                onSuccess: () => {
                  setName('');
                  toastSuccess('标签已添加');
                },
                onError: toastError,
              });
            }}
          >
            <Field className="flex-1 gap-1.5">
              <FieldLabel htmlFor="knowledge-tag-name">标签名称</FieldLabel>
              <Input
                id="knowledge-tag-name"
                value={name}
                maxLength={64}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Button type="submit" disabled={pending || trimmed === ''} aria-busy={create.isPending}>
              添加
            </Button>
          </form>
          {tags.isPending ? <LoadingState rows={2} /> : null}
          {tags.isError ? (
            <ErrorState error={tags.error} onRetry={() => void tags.refetch()} />
          ) : null}
          {tags.data && tags.data.length === 0 ? <InlineEmpty>还没有标签</InlineEmpty> : null}
          {tags.data && tags.data.length > 0 ? (
            <ul className="mt-3 flex flex-col">
              {tags.data.map((tag) => (
                <li
                  key={tag.id}
                  className="flex items-center gap-2 border-b py-2 text-sm last:border-b-0"
                >
                  {editing?.id === tag.id ? (
                    <form
                      className="flex min-w-0 flex-1 items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        submitRename();
                      }}
                    >
                      <Input
                        id="knowledge-tag-rename"
                        className="min-w-0 flex-1"
                        value={editing.name}
                        maxLength={64}
                        disabled={rename.isPending}
                        autoFocus
                        onChange={(event) => setEditing({ id: tag.id, name: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key !== 'Escape') return;
                          event.preventDefault();
                          setEditing(null);
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={rename.isPending}
                        onClick={() => setEditing(null)}
                      >
                        取消
                      </Button>
                      <Button
                        type="submit"
                        disabled={
                          rename.isPending ||
                          editing.name.trim() === '' ||
                          editing.name.trim() === tag.name
                        }
                        aria-busy={rename.isPending}
                      >
                        保存
                      </Button>
                    </form>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`重命名标签 ${tag.name}`}
                        disabled={pending}
                        onClick={() => setEditing({ id: tag.id, name: tag.name })}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`删除标签 ${tag.name}`}
                        disabled={pending}
                        onClick={() => setDeleting(tag)}
                      >
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          <DraftGuardDialogs guard={guard} draft="标签草稿会丢失。" pending={pending} />
        </DialogShell>
      </Dialog>
      {deleting ? (
        <ConfirmDialog
          open
          title="删除标签"
          description={`将删除标签「${deleting.name}」，并从所有文档上移除；文档本身不会删除。`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toastSuccess('标签已删除');
          }}
        />
      ) : null}
    </>
  );
}

const documentPropertiesSchema = z.object({
  title: z.string(),
  folderId: z.string(),
  tags: z.string(),
  status: z.enum(['ready', 'disabled']),
});
type DocumentPropertiesValues = z.infer<typeof documentPropertiesSchema>;

export function DocumentDialog({
  baseId,
  document,
  folders,
  onClose,
}: {
  baseId: string;
  document: KnowledgeDocument;
  folders: KnowledgeFolder[];
  onClose: () => void;
}) {
  const update = useUpdateKnowledgeDocument(baseId);
  // 基线取打开时的值，列表轮询刷新文档对象不重置用户草稿。
  const [initial] = useState(() => ({
    title: document.title,
    folderId: document.folderId ?? 'null',
    tags: document.tags.join(', '),
    status: document.status === 'disabled' ? ('disabled' as const) : ('ready' as const),
  }));
  const { register, control, handleSubmit, watch, formState } = useZodForm(
    documentPropertiesSchema,
    {
      defaultValues: initial,
    },
  );
  const { isDirty } = formState;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pending = update.isPending;
  const dirty = isDirty;
  const blocker = useFormBlocker(dirty, pending);
  // 保存回调在拦截发生前创建，不能读当时的 blocker 快照。
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);
  // 关闭会卸载编辑器并摘掉 blocker：先取消期间被拦下的离开，否则其 resolver 永远挂着。
  const finish = (): void => {
    blockerRef.current.reset?.();
    onClose();
  };
  const close = (): void => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else finish();
  };
  const submit = handleSubmit((values: DocumentPropertiesValues) => {
    update.mutate(
      {
        documentId: document.id,
        patch: {
          title: values.title.trim(),
          folderId: values.folderId === 'null' ? null : values.folderId,
          tags: values.tags
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
          ...(document.status === 'failed' || document.status === 'pending'
            ? {}
            : { status: values.status }),
        },
      },
      {
        onSuccess: () => {
          toastSuccess('文档已更新');
          finish();
        },
        onError: toastError,
      },
    );
  });

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) close();
      }}
    >
      <DialogShell title="编辑文档" closeDisabled={pending}>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <FieldGroup>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="document-title">
                标题 <RequiredMark />
              </FieldLabel>
              <Input id="document-title" {...register('title')} disabled={pending} />
            </Field>
            <FieldGroup className="grid gap-3 sm:grid-cols-2">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="document-folder">文件夹</FieldLabel>
                <Controller
                  control={control}
                  name="folderId"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      disabled={pending}
                      onValueChange={(next) => {
                        if (next !== null) field.onChange(next);
                      }}
                      items={[
                        { value: 'null', label: '未分类' },
                        ...treeFolders(folders).map((folder) => ({
                          value: folder.id,
                          label: `${'　'.repeat(folder.depth)}${folder.label}`,
                        })),
                      ]}
                    >
                      <SelectTrigger id="document-folder" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="null">未分类</SelectItem>
                          {treeFolders(folders).map((folder) => (
                            <SelectItem key={folder.id} value={folder.id}>
                              {`${'　'.repeat(folder.depth)}${folder.label}`}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="document-status">状态</FieldLabel>
                <Controller
                  control={control}
                  name="status"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      disabled={
                        pending || document.status === 'failed' || document.status === 'pending'
                      }
                      onValueChange={(next) => {
                        if (next === 'ready' || next === 'disabled') field.onChange(next);
                      }}
                      items={[
                        { value: 'ready', label: '可检索' },
                        { value: 'disabled', label: '已停用' },
                      ]}
                    >
                      <SelectTrigger id="document-status" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="ready">可检索</SelectItem>
                          <SelectItem value="disabled">已停用</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
            </FieldGroup>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="document-tags">标签</FieldLabel>
              <Input
                id="document-tags"
                {...register('tags')}
                disabled={pending}
                placeholder="以逗号分隔"
              />
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={close} disabled={pending}>
              取消
            </Button>
            <Button
              type="submit"
              disabled={pending || watch('title').trim() === ''}
              aria-busy={pending}
            >
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后文档属性草稿会丢失。"
          confirmLabel="放弃并关闭"
          confirmDisabled={pending}
          onConfirm={async () => {
            if (!pending) finish();
          }}
        />
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title="放弃未保存的更改？"
          description={pending ? '正在保存，请等待请求完成。' : '离开后文档属性草稿会丢失。'}
          confirmLabel="放弃并离开"
          confirmDisabled={pending}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}
