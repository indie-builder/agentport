import type { MemoryChange } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Download, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { MemoryReviews } from '../components/memory-review.js';
import { Page, PageHeader } from '../components/page.js';
import { SourceEditor } from '../components/source-editor.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import { Field, FieldError, FieldLabel } from '../components/ui/field.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { can } from '../lib/access.js';
import { ApiError, api, errorMessage } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { useFormBlocker } from '../lib/form.js';
import { formatDateTime } from '../lib/format.js';
import {
  meQuery,
  usePersonalMemory,
  usePersonalMemoryVersions,
  useRollbackMemoryChange,
  useSavePersonalMemory,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';

/** 与后端 PERSONAL_MEMORY_MAX_CHARS 一致；按 Unicode 码点计数，不是 UTF-8 字节。 */
const PERSONAL_MEMORY_MAX_CHARS = 9000;
const PERSONAL_MEMORY_NEAR_LIMIT = 8500;

type MemoryTab = 'personal' | 'reviews';

export function MemoryPage() {
  const search = useSearch({ from: '/_shell/memory' });
  const navigate = useNavigate();
  const me = useQuery(meQuery);
  const canWrite = can(me.data, 'personal_memory.write');
  const canReview = can(me.data, 'personal_memory.review');
  const requestedTab: MemoryTab = search.tab ?? 'personal';
  const tab: MemoryTab = requestedTab === 'reviews' && !canReview ? 'personal' : requestedTab;
  const [personalDirty, setPersonalDirty] = useState(false);
  const [personalPending, setPersonalPending] = useState(false);
  // 确认放弃后重建个人偏好面板，丢掉子组件里的草稿。
  const [draftResetKey, setDraftResetKey] = useState(0);
  const blocker = useFormBlocker(personalDirty, personalPending);

  const switchTab = (next: MemoryTab): void => {
    if (next === tab || personalPending) return;
    void navigate({ to: '/memory', search: { ...search, tab: next } });
  };

  return (
    <Page>
      <PageHeader title="记忆" />

      <Tabs value={tab} onValueChange={(next) => switchTab(next as MemoryTab)}>
        <TabsList variant="line" aria-label="记忆任务" className="gap-4 border-b pb-3">
          <TabsTrigger value="personal">个人偏好</TabsTrigger>
          {canReview ? <TabsTrigger value="reviews">历史回顾</TabsTrigger> : null}
        </TabsList>

        <TabsContent value="personal">
          <PersonalMemoryPanel
            key={draftResetKey}
            canWrite={canWrite}
            onDirtyChange={setPersonalDirty}
            onPendingChange={setPersonalPending}
          />
        </TabsContent>

        <TabsContent value="reviews">
          <MemoryReviews
            agentId={search.agent ?? null}
            onAgentChange={(next) =>
              void navigate({
                to: '/memory',
                search: { ...search, tab: 'reviews', agent: next ?? undefined },
              })
            }
          />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="放弃未保存的个人偏好？"
        description="切换页签或离开页面后，当前草稿会丢失。可以先保存再继续。"
        confirmLabel="放弃并离开"
        confirmDisabled={personalPending}
        onConfirm={async () => {
          setDraftResetKey((value) => value + 1);
          blocker.proceed();
        }}
      />
    </Page>
  );
}

function PersonalMemoryPanel({
  canWrite,
  onDirtyChange,
  onPendingChange,
}: {
  canWrite: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const memory = usePersonalMemory();
  const versions = usePersonalMemoryVersions();
  const save = useSavePersonalMemory();
  const rollback = useRollbackMemoryChange();
  const [draft, setDraft] = useState<string | null>(null);
  // 编辑开始时的服务端 revision；查询缓存后来刷新也不能改这次保存的乐观锁基线。
  const [draftBaseline, setDraftBaseline] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reloadOpen, setReloadOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<MemoryChange | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  const content = draft ?? memory.data?.content ?? '';
  const chars = [...content].length;
  const overLimit = chars > PERSONAL_MEMORY_MAX_CHARS;
  const nearLimit = chars >= PERSONAL_MEMORY_NEAR_LIMIT;
  const dirty = draft !== null && draft !== memory.data?.content;
  const pending = save.isPending || rollback.isPending;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => onPendingChange(pending), [pending, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);

  const submit = (): void => {
    if (!memory.data || overLimit || save.isPending) return;
    setConflict(false);
    save.mutate(
      { content, expectedRevision: draftBaseline ?? memory.data.revision },
      {
        onSuccess: () => {
          setDraft(null);
          setDraftBaseline(null);
          toastSuccess('个人偏好已保存');
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
    setDraft(null);
    setDraftBaseline(null);
    setConflict(false);
    setReloadOpen(false);
    setRollbackError(null);
    await memory.refetch();
    await versions.refetch();
  };

  const requestReload = (): void => {
    if (dirty) setReloadOpen(true);
    else void reload();
  };

  const rollbackTo = async (change: MemoryChange): Promise<void> => {
    try {
      await rollback.mutateAsync(change.id);
      setDraft(null);
      setDraftBaseline(null);
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
        : memory.data.updatedAt
          ? '已保存'
          : null;

  return (
    <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={submit}
            disabled={!dirty || overLimit || save.isPending || !canWrite}
            aria-busy={save.isPending}
          >
            {save.isPending ? '保存中…' : '保存'}
          </Button>
          <a
            href={api.personalMemoryDownloadUrl}
            download
            className={buttonVariants({ variant: 'outline' })}
          >
            <Download data-icon="inline-start" aria-hidden="true" />
            下载
          </a>
          {status ? (
            <span
              aria-live="polite"
              className={cn(
                'text-xs',
                conflict || dirty ? 'text-muted-foreground' : 'text-success',
              )}
            >
              {status}
            </span>
          ) : null}
          {nearLimit ? (
            <span
              className={cn('ml-auto text-xs', overLimit ? 'text-danger' : 'text-muted-foreground')}
            >
              {chars} / {PERSONAL_MEMORY_MAX_CHARS}
            </span>
          ) : null}
        </div>

        {memory.isError ? (
          <ErrorState error={memory.error} onRetry={() => void memory.refetch()} />
        ) : null}

        {conflict ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-danger-soft px-3.5 py-2.5 text-sm"
          >
            <span className="min-w-0 text-fg">个人偏好已被其他编辑更新，当前草稿已保留。</span>
            <Button variant="outline" size="sm" className="ml-auto" onClick={requestReload}>
              重新加载
            </Button>
          </div>
        ) : null}

        <Field
          data-disabled={save.isPending}
          data-invalid={overLimit || undefined}
          className="gap-1.5"
        >
          <FieldLabel htmlFor="personal-memory-content">个人偏好内容（Markdown）</FieldLabel>
          <SourceEditor
            id="personal-memory-content"
            value={content}
            language="markdown"
            aria-label="个人偏好内容（Markdown）"
            aria-invalid={overLimit}
            disabled={pending || !canWrite}
            onChange={(next) => {
              setDraft(next);
              setConflict(false);
              setDraftBaseline((previous) =>
                next === (memory.data?.content ?? '')
                  ? null
                  : (previous ?? memory.data?.revision ?? null),
              );
            }}
            className="min-h-[22rem]"
          />
        </Field>
        {overLimit ? (
          <FieldError>超出 {chars - PERSONAL_MEMORY_MAX_CHARS} 个字符，请精简后再保存。</FieldError>
        ) : null}
      </div>

      <aside aria-label="个人偏好版本" className="flex min-w-0 flex-col gap-2">
        <h2 className="text-sm font-medium text-fg">版本</h2>
        {versions.isPending ? <LoadingState rows={3} /> : null}
        {versions.isError ? (
          <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
        ) : null}
        {versions.data ? (
          versions.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">保存后会记录版本。</p>
          ) : (
            <ul className="divide-y border-y">
              {versions.data.items.map((change) => {
                const preview = change.after.content?.trim().split('\n')[0] ?? '';
                return (
                  <li key={change.id} className="flex items-start gap-2 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-fg">{formatDateTime(change.createdAt)}</div>
                      <div
                        className="truncate text-xs text-muted-foreground"
                        title={change.after.content ?? ''}
                      >
                        {preview || '空内容'}
                      </div>
                      {change.reversesChangeId ? (
                        <div className="text-2xs text-muted-foreground">回滚记录</div>
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

      <ConfirmDialog
        open={reloadOpen}
        onClose={() => setReloadOpen(false)}
        title="重新加载并放弃草稿？"
        description="服务器上的个人偏好已在别处更新。重新加载会放弃当前草稿。"
        confirmLabel="放弃并重新加载"
        onConfirm={reload}
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
