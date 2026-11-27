import { useState } from 'react';
import { errorMessage } from '../../../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../../../lib/dialog-guard.js';
import {
  summarizeFaqJobs,
  useKnowledgeFaq,
  useKnowledgeFaqImportJobs,
  usePublishKnowledgeFaq,
  useRetryKnowledgeJob,
} from '../../../lib/queries.js';
import { toastError, toastSuccess } from '../../../lib/toast.js';
import { DialogShell } from '../../dialog-shell.js';
import { ErrorState, LoadingState } from '../../states.js';
import { Button } from '../../ui/button.js';
import { Dialog } from '../../ui/dialog.js';
import { readString } from './faq-shared.js';

export function FaqPublishDialog({
  baseId,
  documentId,
  canExecute,
  onClose: onClosed,
}: {
  baseId: string;
  documentId: string;
  canExecute: boolean;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const detail = useKnowledgeFaq(documentId);
  const publish = usePublishKnowledgeFaq(baseId);
  const retry = useRetryKnowledgeJob(baseId);
  const cached = detail.data;
  const draft = cached?.draftVersion;
  const draftJobId =
    draft === null || draft === undefined
      ? null
      : (readString(draft.metadata, 'indexingJobId') ??
        readString(draft.metadata, 'faqImportJobId'));
  const [retriedJobId, setRetriedJobId] = useState<string | null>(null);
  const jobId = retriedJobId ?? draftJobId;
  const { chunkIds: jobChunks, results: jobQueries } = useKnowledgeFaqImportJobs(
    baseId,
    jobId === null ? [] : [jobId],
  );
  const jobSummary = summarizeFaqJobs(jobQueries, jobChunks);
  const jobMissing = jobSummary.missing.size > 0;
  const jobStatus = jobId === null ? undefined : jobSummary.statuses.get(jobId);
  const importDraft =
    draft != null &&
    draft.metadata.faqImport !== undefined &&
    draft.metadata.publication !== 'published';
  const indexSucceeded = (draftJobId === null || jobStatus === 'succeeded') && !jobMissing;
  const indexFailed = (jobStatus === 'failed' || jobStatus === 'cancelled') && !jobMissing;
  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(publish.isPending, onClose)}
    >
      <DialogShell title="发布 FAQ" closeDisabled={publish.isPending}>
        {cached === undefined && detail.isPending ? <LoadingState rows={2} /> : null}
        {cached === undefined && detail.isError ? (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        ) : null}
        {cached === undefined ? null : (
          <div className="flex flex-col gap-4">
            {detail.isError ? (
              <div
                role="alert"
                className="flex items-center gap-2 rounded-item border border-line px-3 py-2 text-xs text-danger"
              >
                <span className="min-w-0 flex-1">{errorMessage(detail.error)}</span>
                <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
                  重试
                </Button>
              </div>
            ) : null}
            {draft ? (
              <p className="text-sm text-fg">
                将 v{draft.version}「{cached.faq?.question ?? cached.document.title}
                」发布为可召回版本；历史版本保留。
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                没有待发布的草稿；当前发布版本已是最新。
              </p>
            )}
            {importDraft ? (
              <p className="text-xs text-danger">该草稿属于导入批次，请在导入对话框中整批发布。</p>
            ) : draft && draftJobId !== null && jobMissing ? (
              <p className="text-xs text-danger">
                本次索引任务记录已被清理，无法确认索引结果，暂不能发布。
              </p>
            ) : draft && draftJobId !== null && jobStatus === undefined ? (
              <p className="text-xs text-muted-foreground">等待本次索引任务完成…</p>
            ) : indexFailed ? (
              <p className="text-xs text-danger">本次索引失败，重试后再发布。</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={publish.isPending}>
                取消
              </Button>
              {canExecute && indexFailed && jobId !== null ? (
                <Button
                  variant="outline"
                  disabled={retry.isPending}
                  aria-busy={retry.isPending}
                  onClick={() =>
                    retry.mutate(jobId, {
                      onSuccess: (result) => setRetriedJobId(result.jobId),
                      onError: toastError,
                    })
                  }
                >
                  {retry.isPending ? '重试中…' : '重试索引'}
                </Button>
              ) : null}
              <Button
                disabled={!draft || importDraft || !indexSucceeded || publish.isPending}
                aria-busy={publish.isPending}
                onClick={() => {
                  if (!draft) return;
                  publish.mutate(
                    {
                      documentId,
                      versionId: draft.id,
                      expectedVersionId: cached.document.currentVersionId,
                    },
                    {
                      onSuccess: () => {
                        toastSuccess('FAQ 已发布');
                        onClose();
                      },
                      onError: toastError,
                    },
                  );
                }}
              >
                {publish.isPending ? '发布中…' : '发布'}
              </Button>
            </div>
          </div>
        )}
      </DialogShell>
    </Dialog>
  );
}
