import type { KnowledgeJob } from '@agentport/shared';
import {
  jobStatusLabel,
  jobStatusTone,
  jobTypeLabel,
} from '../../../components/knowledge/knowledge-shared.js';
import { PageNote } from '../../../components/page.js';
import {
  type EmptyFilterChip,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../components/states.js';
import { StatusBadge } from '../../../components/status-badge.js';
import { Button } from '../../../components/ui/button.js';
import {
  Progress,
  ProgressIndicator,
  ProgressTrack,
  ProgressValue,
} from '../../../components/ui/progress.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table.js';
import { formatDateTime, formatDuration, formatRelative } from '../../../lib/format.js';
import { knowledgeJobErrorText } from '../../../lib/knowledge-errors.js';
import {
  knowledgeShouldPoll,
  useCancelKnowledgeJob,
  useKnowledgeJobs,
  useRetryKnowledgeJob,
} from '../../../lib/queries.js';
import { toastError, toastSuccess } from '../../../lib/toast.js';

function jobTargetLabel(job: KnowledgeJob): string {
  return job.documentTitle ?? job.sourceName ?? job.documentId ?? job.sourceId ?? '整库';
}

export function JobsTab({
  baseId,
  canExecute,
  canUpload,
  documentId,
  onClearDocument,
  onGoDocuments,
  onOpenDocument,
  onOpenSource,
}: {
  baseId: string;
  canExecute: boolean;
  canUpload: boolean;
  documentId: string | undefined;
  onClearDocument: () => void;
  onGoDocuments: () => void;
  onOpenDocument: (documentId: string) => void;
  onOpenSource: (sourceId: string) => void;
}) {
  const jobs = useKnowledgeJobs(baseId, documentId === undefined ? {} : { documentId });
  const retry = useRetryKnowledgeJob(baseId);
  const cancel = useCancelKnowledgeJob(baseId);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {documentId ? (
        <PageNote
          title="只显示该文档的处理记录"
          action={
            <Button variant="outline" size="sm" onClick={onClearDocument}>
              查看全部处理记录
            </Button>
          }
        />
      ) : null}
      <span role="status" className="text-xs text-muted-foreground">
        {jobs.isPending
          ? '加载中…'
          : jobs.isError && jobs.data === undefined
            ? '数量不可用'
            : jobs.hasNextPage
              ? `已加载 ${jobs.data?.length ?? 0} 条处理记录`
              : `共 ${jobs.data?.length ?? 0} 条处理记录`}
      </span>
      {jobs.data?.some((job) => job.status === 'queued' || job.status === 'running') &&
      !knowledgeShouldPoll(jobs.data) ? (
        <PageNote
          title="已停止自动刷新"
          description="任务已超过其类型的最长执行时间仍未结束，可能已经卡住；刷新查看状态，或取消后重试。"
          action={
            <Button variant="outline" size="sm" onClick={() => void jobs.refetch()}>
              刷新
            </Button>
          }
        />
      ) : null}
      {jobs.isPending ? <LoadingState rows={4} /> : null}
      {jobs.isError && jobs.data === undefined ? (
        <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
      ) : null}
      {jobs.data && jobs.data.length === 0 ? (
        documentId ? (
          <EmptyState
            variant="filter"
            scale="section"
            title="该文档还没有处理记录"
            description="它可能尚未上传成功，或任务已被清理。重新上传文档后会生成新的处理记录。"
            activeFilters={
              [
                {
                  key: 'document',
                  label: '文档',
                  value: documentId,
                  onRemove: onClearDocument,
                },
              ] satisfies EmptyFilterChip[]
            }
            action={
              <Button variant="outline" size="sm" onClick={onClearDocument}>
                查看全部处理记录
              </Button>
            }
            secondaryAction={
              canUpload ? (
                <Button variant="outline" size="sm" onClick={onGoDocuments}>
                  重新上传文档
                </Button>
              ) : undefined
            }
          />
        ) : (
          <EmptyState
            variant="stage"
            scale="section"
            specimen="runs"
            title="还没有后台处理任务"
            description="上传文档或同步来源后，处理任务会出现在这里。"
          />
        )
      ) : null}
      {jobs.data && jobs.data.length > 0 ? (
        <Table aria-label="知识库任务" className="min-w-5xl">
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">类型</TableHead>
              <TableHead className="min-w-56">对象</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="min-w-60">步骤</TableHead>
              <TableHead className="w-28 text-end">进度</TableHead>
              <TableHead className="w-32">创建</TableHead>
              <TableHead className="w-32">已运行</TableHead>
              <TableHead className="w-28">
                <span className="sr-only">操作</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.data.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                canExecute={canExecute}
                busy={retry.isPending || cancel.isPending}
                onOpenDocument={onOpenDocument}
                onOpenSource={onOpenSource}
                onRetry={() =>
                  retry.mutate(job.id, {
                    onSuccess: () => toastSuccess('已重新提交任务'),
                    onError: toastError,
                  })
                }
                onCancel={() =>
                  cancel.mutate(job.id, {
                    onSuccess: () => toastSuccess('已请求取消'),
                    onError: toastError,
                  })
                }
              />
            ))}
          </TableBody>
        </Table>
      ) : null}
      {jobs.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={jobs.isFetchingNextPage}
          aria-busy={jobs.isFetchingNextPage}
          onClick={() => void jobs.fetchNextPage()}
        >
          {jobs.isFetchingNextPage ? '加载中…' : '加载更多处理记录'}
        </Button>
      ) : null}
      {jobs.isFetchNextPageError ? (
        <ErrorState
          error={jobs.error}
          title="更多处理记录没有加载出来"
          onRetry={() => void jobs.fetchNextPage()}
        />
      ) : null}
    </div>
  );
}

function JobRow({
  job,
  canExecute,
  busy,
  onRetry,
  onCancel,
  onOpenDocument,
  onOpenSource,
}: {
  job: KnowledgeJob;
  canExecute: boolean;
  busy: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onOpenDocument: (documentId: string) => void;
  onOpenSource: (sourceId: string) => void;
}) {
  const active = job.status === 'queued' || job.status === 'running';
  const runningMs = job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : null;
  const reason = knowledgeJobErrorText(job.error);
  const targetTitle = job.documentId ?? job.sourceId ?? undefined;
  const openTarget = (): void => {
    if (job.documentId) onOpenDocument(job.documentId);
    else if (job.sourceId) onOpenSource(job.sourceId);
  };
  return (
    <TableRow>
      <TableCell className="text-sm">{jobTypeLabel[job.type]}</TableCell>
      <TableCell className="whitespace-normal">
        {targetTitle ? (
          <Button
            variant="link"
            size="xs"
            className="h-auto whitespace-normal px-0 text-sm text-left break-words"
            title={targetTitle}
            onClick={openTarget}
          >
            {jobTargetLabel(job)}
          </Button>
        ) : (
          <span className="block break-words text-sm text-fg" title={targetTitle}>
            {jobTargetLabel(job)}
          </span>
        )}
      </TableCell>
      <TableCell>
        <StatusBadge tone={jobStatusTone[job.status]}>{jobStatusLabel[job.status]}</StatusBadge>
      </TableCell>
      <TableCell className="whitespace-normal">
        <span
          className="block break-words text-sm text-muted-foreground"
          title={job.error ?? job.step ?? ''}
        >
          {reason ?? job.step ?? '—'}
        </span>
      </TableCell>
      <TableCell className="text-end">
        <Progress
          value={job.progress}
          aria-label={`${jobTypeLabel[job.type]} ${jobTargetLabel(job)} 进度`}
          className="grid-cols-[minmax(0,1fr)_auto] items-center gap-2"
        >
          <ProgressTrack className="col-span-1">
            <ProgressIndicator />
          </ProgressTrack>
          <ProgressValue>{job.progress}%</ProgressValue>
        </Progress>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground" title={formatDateTime(job.createdAt)}>
        {formatRelative(job.createdAt)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {active && runningMs !== null ? `已运行 ${formatDuration(runningMs)}` : '—'}
      </TableCell>
      <TableCell>
        {!canExecute ? null : active ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            取消
          </Button>
        ) : job.status === 'failed' || job.status === 'cancelled' ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRetry}>
            重试
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
