import type { KnowledgeJob } from '@agentport/shared';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { BusinessIllustration } from '../../../components/business-illustration.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { jobStatusLabel, sourceStatusLabel } from '../../../components/knowledge/knowledge-shared.js';
import { Collapsible, CollapsibleContent } from '../../../components/motion-collapsible.js';
import { PageToolbar } from '../../../components/page.js';
import { EmptyState, ErrorState, LoadingState } from '../../../components/states.js';
import { StatusBadge } from '../../../components/status-badge.js';
import { Button } from '../../../components/ui/button.js';
import { Checkbox } from '../../../components/ui/checkbox.js';
import { FieldLabel } from '../../../components/ui/field.js';
import type { KnowledgeSource } from '../../../lib/api.js';
import { formatRelative } from '../../../lib/format.js';
import { knowledgeJobErrorText } from '../../../lib/knowledge-errors.js';
import {
  isMissingJob,
  isTerminalKnowledgeJob,
  knowledgeJobQuery,
  knowledgeKeys,
  useDeleteKnowledgeSource,
  useDrainPages,
  useKnowledgeJobs,
  useKnowledgeSources,
  useSyncKnowledgeSource,
  useTestKnowledgeSource,
} from '../../../lib/queries.js';
import { toast, toastError, toastSuccess } from '../../../lib/toast.js';
import { type KnowledgeCaps, sourceProvider, sourceTargetSummary } from './shared.js';
import { SourceDialog } from './source-dialog.js';
import { SourceProbeStatus, SourceRuns } from './source-runs.js';

// ---- 来源 -----------------------------------------------------------------

export function SourcesTab({
  baseId,
  caps,
  sourceId,
  onSelectSource,
  onOpenDocument,
}: {
  baseId: string;
  caps: KnowledgeCaps;
  sourceId: string | undefined;
  onSelectSource: (sourceId: string | undefined) => void;
  onOpenDocument: (documentId: string) => void;
}) {
  const sources = useKnowledgeSources(baseId);
  useDrainPages(sources);
  const remove = useDeleteKnowledgeSource(baseId);
  const test = useTestKnowledgeSource();
  const sync = useSyncKnowledgeSource(baseId);
  const jobs = useKnowledgeJobs(baseId);
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(sourceId ?? null);
  useEffect(() => setSelected(sourceId ?? null), [sourceId]);
  const selectSource = (id: string | null): void => {
    setSelected(id);
    onSelectSource(id ?? undefined);
  };
  const [deleting, setDeleting] = useState<KnowledgeSource | null>(null);
  const [deleteDocuments, setDeleteDocuments] = useState(false);
  const [editing, setEditing] = useState<KnowledgeSource | null>(null);
  const [syncJobs, setSyncJobs] = useState<Array<{ id: string; sourceId: string }>>([]);
  const [probeJobs, setProbeJobs] = useState<Record<string, string>>({});
  const settledJobs = useRef(new Set<string>());
  // 自动 Wiki、批量上传等任务会把刚提交的同步任务挤出任务列表前 50 条，只看列表会永远等不到终态。
  // 列表里缺失的任务改用 GET jobs/:id 定向轮询，终态后与列表中的任务走同一套失效。
  const missingSyncJobs = syncJobs.filter(
    (entry) =>
      !settledJobs.current.has(entry.id) && !jobs.data?.some((item) => item.id === entry.id),
  );
  const syncJobDetails = useQueries({
    queries: missingSyncJobs.map((entry) => knowledgeJobQuery(entry.id)),
  });
  const knownSyncJobs = new Map<string, KnowledgeJob>();
  for (const item of jobs.data ?? []) knownSyncJobs.set(item.id, item);
  missingSyncJobs.forEach((entry, index) => {
    const job = syncJobDetails[index]?.data;
    if (job) knownSyncJobs.set(entry.id, job);
  });

  // 任务随来源一起被删时 404：停止跟踪并提示刷新，不把缺失当完成，也不无限轮询。
  useEffect(() => {
    const gone = missingSyncJobs.filter((entry, index) => {
      if (settledJobs.current.has(entry.id)) return false;
      return isMissingJob(syncJobDetails[index]?.error);
    });
    if (gone.length === 0) return;
    for (const entry of gone) settledJobs.current.add(entry.id);
    setSyncJobs((previous) =>
      previous.filter((entry) => !gone.some((item) => item.id === entry.id)),
    );
    toast.warning('同步任务已不存在，可能来源已删除；请刷新来源列表');
  }, [missingSyncJobs, syncJobDetails]);

  // 同步任务跨过终态时在页面内失效一次受影响的查询；任务列表本身继续轮询。
  useEffect(() => {
    if (syncJobs.length === 0) return;
    const finished = syncJobs.filter((entry) => {
      if (settledJobs.current.has(entry.id)) return false;
      const job = knownSyncJobs.get(entry.id);
      return job !== undefined && isTerminalKnowledgeJob(job.status);
    });
    if (finished.length === 0) return;
    for (const entry of finished) {
      settledJobs.current.add(entry.id);
      void client.invalidateQueries({ queryKey: knowledgeKeys.sourceRuns(entry.sourceId) });
    }
    void client.invalidateQueries({ queryKey: knowledgeKeys.sources(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    const failedJob = finished
      .map((entry) => knownSyncJobs.get(entry.id))
      .find((job) => job?.status === 'failed');
    if (failedJob) {
      toastError(
        new Error(
          knowledgeJobErrorText(failedJob.error) ?? '来源同步失败，已保留失败原因，可修正后重试',
        ),
      );
    }
  }, [baseId, client, knownSyncJobs, syncJobs]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageToolbar>
        <span role="status" className="text-xs text-muted-foreground">
          {sources.isPending
            ? '加载中…'
            : sources.isError
              ? '数量不可用'
              : // 分页已自动取完，这里的数量就是全部来源。
                `${sources.data?.length ?? 0} 个来源`}
        </span>
        {caps.sources ? (
          <Button className="ml-auto" onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" /> 新建来源
          </Button>
        ) : null}
      </PageToolbar>
      {sources.isPending ? <LoadingState rows={3} /> : null}
      {sources.isError ? (
        <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
      ) : null}
      {sources.isFetchNextPageError ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => void sources.fetchNextPage()}
        >
          重试加载其余来源
        </Button>
      ) : null}
      {sources.data && sources.data.length === 0 ? (
        <EmptyState
          illustration={<BusinessIllustration name="knowledge" />}
          title="还没有外部来源"
          action={
            caps.sources ? (
              <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                新建来源
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {sources.data && sources.data.length > 0 ? (
        <ul className="flex flex-col">
          {sources.data.map((source) => {
            const provider = sourceProvider(source.type);
            const ProviderIcon = provider.icon;
            const syncable = source.status === 'active';
            const lastSyncStatus = source.lastSyncStatus
              ? (jobStatusLabel[source.lastSyncStatus as keyof typeof jobStatusLabel] ??
                source.lastSyncStatus)
              : null;
            return (
              <li key={source.id} className="border-b py-3 last:border-b-0">
                <Collapsible open={selected === source.id} className="flex min-w-0 flex-col gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-3">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-item border border-line text-muted-foreground">
                      <ProviderIcon className="size-3.5" aria-hidden="true" />
                    </span>
                    <button
                      type="button"
                      className="min-w-0 truncate text-sm font-medium text-fg hover:underline"
                      onClick={() => selectSource(selected === source.id ? null : source.id)}
                      aria-expanded={selected === source.id}
                    >
                      {source.name}
                    </button>
                    <StatusBadge tone="outline">{provider.label}</StatusBadge>
                    <StatusBadge
                      tone={
                        source.status === 'active'
                          ? 'success'
                          : source.status === 'auth_error'
                            ? 'danger'
                            : 'outline'
                      }
                    >
                      {sourceStatusLabel[source.status]}
                    </StatusBadge>
                    <span className="text-xs text-muted-foreground">
                      上次同步 {lastSyncStatus ? `${lastSyncStatus} · ` : ''}
                      {formatRelative(source.lastSyncAt)}
                    </span>
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      {caps.sources ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={test.isPending}
                          title="提交一次只读远程连接测试，结果写入任务"
                          onClick={() =>
                            test.mutate(source.id, {
                              onSuccess: (result) => {
                                setProbeJobs((previous) => ({
                                  ...previous,
                                  [source.id]: result.jobId,
                                }));
                                toastSuccess('已提交连接测试，结果见下方');
                              },
                              onError: toastError,
                            })
                          }
                        >
                          检查配置
                        </Button>
                      ) : null}
                      {caps.execute ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={sync.isPending || !syncable}
                          title={
                            !syncable
                              ? '来源未启用，无法同步'
                              : sync.isPending
                                ? '正在提交同步任务'
                                : '立即提交一次同步任务'
                          }
                          onClick={() =>
                            sync.mutate(source.id, {
                              onSuccess: (result) => {
                                selectSource(source.id);
                                setSyncJobs((previous) => [
                                  ...previous,
                                  { id: result.jobId, sourceId: source.id },
                                ]);
                                toastSuccess('已提交同步任务');
                              },
                              onError: toastError,
                            })
                          }
                        >
                          立即同步
                        </Button>
                      ) : null}
                      {caps.sources ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`编辑来源 ${source.name}`}
                            onClick={() => setEditing(source)}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="destructive"
                            size="icon-sm"
                            aria-label={`删除来源 ${source.name}`}
                            onClick={() => {
                              setDeleteDocuments(false);
                              setDeleting(source);
                            }}
                          >
                            <Trash2 />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <span className="truncate text-xs text-muted-foreground">
                    {sourceTargetSummary(source)}
                  </span>
                  {source.lastError ? (
                    <span className="text-sm text-danger">{source.lastError}</span>
                  ) : null}
                  {probeJobs[source.id] ? (
                    <SourceProbeStatus jobId={probeJobs[source.id] ?? ''} />
                  ) : null}
                  <CollapsibleContent animated>
                    <SourceRuns sourceId={source.id} onOpenDocument={onOpenDocument} />
                  </CollapsibleContent>
                </Collapsible>
              </li>
            );
          })}
        </ul>
      ) : null}
      {creating ? <SourceDialog baseId={baseId} onClose={() => setCreating(false)} /> : null}
      {editing ? (
        <SourceDialog baseId={baseId} source={editing} onClose={() => setEditing(null)} />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除来源"
          description={
            deleteDocuments
              ? `将删除「${deleting.name}」及其导入的全部文档与分块。此操作不可撤销。`
              : `将删除「${deleting.name}」，已导入的文档保留但停用、不再参与检索。`
          }
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync({
              sourceId: deleting.id,
              documents: deleteDocuments ? 'delete' : 'keep',
            });
            if (selected === deleting.id) selectSource(null);
            toastSuccess('来源已删除');
          }}
        >
          <div className="flex items-center gap-2 text-xs text-fg">
            <Checkbox
              id="knowledge-source-delete-documents"
              checked={deleteDocuments}
              onCheckedChange={(checked) => setDeleteDocuments(checked)}
            />
            <FieldLabel htmlFor="knowledge-source-delete-documents">
              同时删除已导入的文档
            </FieldLabel>
          </div>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
