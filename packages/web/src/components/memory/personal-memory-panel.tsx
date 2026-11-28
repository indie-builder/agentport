import { type MemoryChange, PERSONAL_MEMORY_MAX_CHARS } from '@agentport/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Download, History, Pencil, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { formatDateTime } from '../../lib/format.js';
import {
  usePersonalMemory,
  usePersonalMemoryVersions,
  useRollbackMemoryChange,
  useSavePersonalMemory,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useEditStateNotify } from '../../lib/use-edit-state-notify.js';
import { ConfirmDialog } from '../confirm-dialog.js';
import { Markdown } from '../markdown.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../motion-collapsible.js';
import { PageSection } from '../page.js';
import { SourceEditor } from '../source-editor.js';
import { EmptyState, ErrorState, LoadingState } from '../states.js';
import { Button, buttonVariants } from '../ui/button.js';
import { Field, FieldError, FieldLabel } from '../ui/field.js';

const PERSONAL_MEMORY_NEAR_LIMIT = 8500;

export function PersonalMemoryPanel({
  canWrite,
  canReview,
  canConverse,
  onDirtyChange,
  onPendingChange,
}: {
  canWrite: boolean;
  canReview: boolean;
  canConverse: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const memory = usePersonalMemory();
  const versions = usePersonalMemoryVersions();
  const save = useSavePersonalMemory();
  const rollback = useRollbackMemoryChange();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [draftBaseline, setDraftBaseline] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [reloadOpen, setReloadOpen] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<MemoryChange | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const editTrigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  const content = editing ? (draft ?? memory.data?.content ?? '') : (memory.data?.content ?? '');
  const chars = [...content].length;
  const overLimit = chars > PERSONAL_MEMORY_MAX_CHARS;
  const nearLimit = chars >= PERSONAL_MEMORY_NEAR_LIMIT;
  const dirty = editing && draft !== null && draft !== memory.data?.content;
  const pending = save.isPending || rollback.isPending;

  useEditStateNotify(dirty, pending, onDirtyChange, onPendingChange);

  useEffect(() => {
    if (editing || !restoreFocus.current) return;
    restoreFocus.current = false;
    const frame = requestAnimationFrame(() => editTrigger.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  const exitEditing = (): void => {
    setEditing(false);
    setDraft(null);
    setDraftBaseline(null);
    setConflict(false);
    restoreFocus.current = true;
  };

  const beginEditing = (): void => {
    if (!memory.data || !canWrite) return;
    setSavedNotice(false);
    setConflict(false);
    setDraft(memory.data.content);
    setDraftBaseline(memory.data.revision);
    setEditing(true);
  };

  const submit = (): void => {
    if (!memory.data || overLimit || save.isPending) return;
    setConflict(false);
    save.mutate(
      { content, expectedRevision: draftBaseline ?? memory.data.revision },
      {
        onSuccess: () => {
          exitEditing();
          setSavedNotice(true);
          toastSuccess('个人记忆已保存，下一轮对话会带入');
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409) {
            setConflict(true);
            return;
          }
          toastError(error);
        },
      },
    );
  };

  const reload = async (): Promise<void> => {
    const [memoryResult, versionsResult] = await Promise.all([
      memory.refetch(),
      versions.refetch(),
    ]);
    if (memoryResult.isError || versionsResult.isError) {
      throw memoryResult.error ?? versionsResult.error ?? new Error('重新加载失败');
    }
    setDraft(null);
    setDraftBaseline(null);
    setConflict(false);
    setRollbackError(null);
    setReloadOpen(false);
    setReloadError(null);
  };

  const requestReload = (): void => {
    if (dirty) {
      setReloadOpen(true);
      setReloadError(null);
    } else void reload().catch((error) => toastError(error));
  };

  const rollbackTo = async (change: MemoryChange): Promise<void> => {
    try {
      await rollback.mutateAsync(change.id);
      exitEditing();
      setRollbackError(null);
      toastSuccess('已回滚这次保存');
      await memory.refetch();
    } catch (error) {
      setRollbackError(errorMessage(error));
    }
  };

  if (memory.isPending) return <LoadingState rows={4} />;
  if (memory.data === undefined) {
    return <ErrorState error={memory.error} onRetry={() => void memory.refetch()} />;
  }

  const status = save.isPending
    ? '保存中…'
    : conflict
      ? '保存未完成'
      : dirty
        ? '未保存'
        : savedNotice
          ? '已保存'
          : null;
  const versionCount = versions.data?.items.length ?? 0;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {memory.isError ? (
        <ErrorState error={memory.error} onRetry={() => void memory.refetch()} />
      ) : null}

      <section aria-label="个人记忆" className="flex min-w-0 flex-col gap-3">
        {!editing && content.trim() !== '' ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {status ? (
              <span
                aria-live="polite"
                className={cn(
                  'mr-auto text-xs',
                  conflict || dirty ? 'text-muted-foreground' : 'text-success',
                )}
              >
                {status}
              </span>
            ) : null}
            <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
              {canReview ? (
                <Link
                  to="/personal/reviews"
                  search={{ create: true }}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  从对话整理
                </Link>
              ) : null}
              {canConverse ? (
                <Link to="/chat" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                  去对话
                </Link>
              ) : null}
              <a
                href={api.personalMemoryDownloadUrl}
                download
                className={buttonVariants({ variant: 'ghost', size: 'sm' })}
              >
                <Download data-icon="inline-start" aria-hidden="true" />
                下载
              </a>
              {canWrite ? (
                <Button ref={editTrigger} size="sm" onClick={beginEditing}>
                  <Pencil data-icon="inline-start" aria-hidden="true" />
                  编辑
                </Button>
              ) : null}
            </div>
          </div>
        ) : status ? (
          <span
            aria-live="polite"
            className={cn('text-xs', conflict || dirty ? 'text-muted-foreground' : 'text-success')}
          >
            {status}
          </span>
        ) : null}

        {editing ? (
          <>
            <Field
              data-disabled={save.isPending}
              data-invalid={overLimit || undefined}
              className="gap-1.5"
            >
              <div className="flex min-h-8 flex-wrap items-center gap-2">
                <FieldLabel htmlFor="personal-memory-content">个人记忆内容（Markdown）</FieldLabel>
                {nearLimit ? (
                  <span
                    className={cn(
                      'ml-auto text-xs',
                      overLimit ? 'text-danger' : 'text-muted-foreground',
                    )}
                  >
                    {chars} / {PERSONAL_MEMORY_MAX_CHARS}
                  </span>
                ) : null}
              </div>
              <SourceEditor
                id="personal-memory-content"
                value={content}
                language="markdown"
                aria-label="个人记忆内容（Markdown）"
                aria-invalid={overLimit}
                disabled={pending || !canWrite}
                onChange={(next) => {
                  setDraft(next);
                  setConflict(false);
                  setSavedNotice(false);
                  setDraftBaseline((previous) =>
                    next === (memory.data?.content ?? '')
                      ? null
                      : (previous ?? memory.data?.revision ?? null),
                  );
                }}
                className="min-h-96 [&_.cm-editor]:h-full"
              />
            </Field>
            {overLimit ? (
              <FieldError>
                超出 {chars - PERSONAL_MEMORY_MAX_CHARS} 个字符，请精简后再保存。
              </FieldError>
            ) : null}
            {conflict ? (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-danger-soft px-3.5 py-2.5 text-sm"
              >
                <span className="min-w-0 text-fg">个人记忆已被其他编辑更新，当前草稿已保留。</span>
                <Button variant="outline" size="sm" className="ml-auto" onClick={requestReload}>
                  重新加载
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="mr-auto text-xs text-muted-foreground">
                保存后下一轮对话会带入新内容。
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={save.isPending}
                onClick={() => {
                  if (dirty) setCancelOpen(true);
                  else exitEditing();
                }}
              >
                取消
              </Button>
              <Button
                size="sm"
                onClick={submit}
                disabled={!dirty || overLimit || save.isPending || !canWrite}
                aria-busy={save.isPending}
              >
                {save.isPending ? '保存中…' : '保存'}
              </Button>
            </div>
          </>
        ) : content.trim() === '' ? (
          <EmptyState
            variant="stage"
            scale="section"
            specimen="memory"
            title="建立你的个人记忆"
            description="记录偏好、背景与长期上下文，后续每轮对话都会自动带入。"
            action={
              canWrite ? (
                <Button ref={editTrigger} onClick={beginEditing}>
                  自己填写
                </Button>
              ) : undefined
            }
            secondaryAction={
              canReview ? (
                <Link
                  to="/personal/reviews"
                  search={{ create: true }}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  从对话整理
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="min-w-0 max-w-[75ch]">
              <Markdown text={content} staticContent />
            </div>
            <p className="text-xs text-muted-foreground">每轮对话会带入这些长期信息。</p>
          </>
        )}
      </section>

      <PageSection>
        <Collapsible open={versionsOpen} onOpenChange={setVersionsOpen}>
          <CollapsibleTrigger
            render={
              <Button variant="plain" size="none" className="justify-start" aria-label="版本历史" />
            }
          >
            <span className="inline-flex h-7 items-center gap-1 rounded-lg text-sm text-fg group-hover/button:bg-hover">
              <ChevronRight
                className={cn(
                  'size-3.5 transition-transform duration-150 ease-out-soft',
                  versionsOpen && 'rotate-90',
                )}
                aria-hidden="true"
              />
              版本历史{versionCount > 0 ? `（${versionCount}）` : ''}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent animated>
            <aside aria-label="个人记忆版本" className="flex min-w-0 flex-col gap-2 pt-2">
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
                    title="保存修改后会自动记录版本历史"
                  />
                ) : (
                  <ul className="divide-y border-y">
                    {versions.data.items.map((change) => {
                      const preview = change.after.content?.trim().split('\n')[0] ?? '';
                      return (
                        <li key={change.id} className="flex items-start gap-2 py-2.5">
                          <div className="min-w-0 flex-1">
                            <div className="text-sm text-fg">
                              {formatDateTime(change.createdAt)}
                            </div>
                            <div
                              className="truncate text-xs text-muted-foreground"
                              title={change.after.content ?? ''}
                            >
                              {preview || '空内容'}
                            </div>
                            {change.reversesChangeId ? (
                              <div className="text-xs text-muted-foreground">回滚记录</div>
                            ) : null}
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={pending || dirty || !canWrite}
                            title={
                              !canWrite
                                ? '没有修改个人记忆的权限'
                                : dirty
                                  ? '先保存或放弃当前草稿再回滚'
                                  : undefined
                            }
                            aria-label={`回滚 ${formatDateTime(change.createdAt)} 的保存`}
                            onClick={() => {
                              setRollbackError(null);
                              setRollbackTarget(change);
                            }}
                          >
                            <RotateCcw data-icon="inline-start" aria-hidden="true" />
                            回滚
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )
              ) : null}
              {rollbackError ? (
                <div role="alert" className="text-sm text-danger">
                  {rollbackError}
                  <Button variant="link" size="sm" onClick={requestReload}>
                    重新加载
                  </Button>
                </div>
              ) : null}
            </aside>
          </CollapsibleContent>
        </Collapsible>
      </PageSection>

      <ConfirmDialog
        open={reloadOpen}
        onClose={() => {
          setReloadOpen(false);
          setReloadError(null);
        }}
        title="重新加载并放弃草稿？"
        description="服务器上的个人记忆已在别处更新。重新加载会放弃当前草稿。加载失败时会保留当前草稿。"
        confirmLabel="放弃并重新加载"
        onConfirm={reload}
        onError={(error) => setReloadError(errorMessage(error))}
      >
        {reloadError ? <FieldError>{reloadError}</FieldError> : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="放弃未保存的修改？"
        description="当前修改不会保存，仍保留服务器上已有的内容。"
        confirmLabel="放弃修改"
        onConfirm={async () => exitEditing()}
      />

      <ConfirmDialog
        open={rollbackTarget !== null}
        onClose={() => setRollbackTarget(null)}
        title="回滚这次保存？"
        description={
          rollbackTarget
            ? `将撤销 ${formatDateTime(rollbackTarget.createdAt)} 的这次保存，恢复到它保存前的内容。`
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
