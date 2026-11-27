import { knowledgeFaqImportMetadataSchema } from '@agentport/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  KnowledgeFaqDetail,
  KnowledgeFaqImportResponse,
  KnowledgeFaqSummary,
} from '../../../lib/api.js';
import { errorMessage } from '../../../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../../../lib/dialog-guard.js';
import {
  isTerminalKnowledgeJob,
  knowledgeKeys,
  summarizeFaqDrafts,
  summarizeFaqJobs,
  useDrainPages,
  useImportKnowledgeFaqs,
  useKnowledgeFaqDrafts,
  useKnowledgeFaqImportJobs,
  useKnowledgeFaqs,
  usePublishKnowledgeFaqBatch,
  useRetryKnowledgeJob,
} from '../../../lib/queries.js';
import { toastSuccess } from '../../../lib/toast.js';
import { ConfirmDialog } from '../../confirm-dialog.js';
import { DialogShell } from '../../dialog-shell.js';
import { Button } from '../../ui/button.js';
import { Dialog } from '../../ui/dialog.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../ui/select.js';
import { Textarea } from '../../ui/textarea.js';
import { DraftGuardDialogs, useDraftGuard } from '../knowledge-shared.js';
import { readString } from './faq-shared.js';

type FaqImportFormat = 'json' | 'csv' | 'xlsx';

const importStatusLabel = {
  success: '成功',
  failed: '失败',
  partial_failed: '部分成功',
  skipped: '跳过',
} as const;

const importOperationLabel = {
  add: '新增',
  merge: '合并',
  skip: '跳过',
} as const;

function detectImportFormat(filename: string): FaqImportFormat {
  const extension = filename.toLowerCase().split('.').pop();
  return extension === 'csv' ? 'csv' : extension === 'xlsx' ? 'xlsx' : 'json';
}

async function importFileContent(file: File, format: FaqImportFormat): Promise<string> {
  if (format !== 'xlsx') return file.text();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function ImportCounts({ response }: { response: KnowledgeFaqImportResponse }) {
  const counts = response.counts;
  return (
    <p className="text-xs text-muted-foreground">
      共 {counts.total} · 成功 {counts.success} · 失败 {counts.failed} · 部分成功{' '}
      {counts.partialFailed} · 跳过 {counts.skipped} · 新增 {counts.added} · 合并 {counts.merged}
    </p>
  );
}

function ImportResults({ response }: { response: KnowledgeFaqImportResponse }) {
  const rows = response.results;
  if (rows.length === 0) return null;
  return (
    <ul className="flex max-h-56 flex-col gap-1 overflow-auto">
      {rows.map((result) => (
        <li key={`${result.row}-${result.status}`} className="text-sm">
          <span className="font-mono text-xs text-muted-foreground">第 {result.row} 行</span>{' '}
          <span className={result.status === 'failed' ? 'text-danger' : 'text-warning'}>
            {importStatusLabel[result.status]}
          </span>
          {result.operation ? ` · ${importOperationLabel[result.operation]}` : ''}
          {result.issues.map((issue) => (
            <span key={`${issue.field}-${issue.code}`} className="text-danger">
              {' '}
              · {issue.field} {issue.code}: {issue.message}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

interface RecoveredMember {
  documentId: string;
  title: string;
  versionId: string;
  expectedVersionId: string | null;
  jobId: string | null;
}

interface RecoveredBatch {
  batchId: string;
  mode: 'append' | 'replace';
  members: RecoveredMember[];
  newestAt: string;
}

type FaqDraftVersion = NonNullable<KnowledgeFaqDetail['draftVersion']>;

function recoverBatches(
  drafts: Array<{ documentId: string; draft: FaqDraftVersion | null }>,
  items: ReadonlyMap<string, KnowledgeFaqSummary>,
): RecoveredBatch[] {
  const groups = new Map<string, RecoveredBatch>();
  for (const { documentId, draft } of drafts) {
    const item = items.get(documentId);
    if (!item || !draft) continue;
    const parsed = knowledgeFaqImportMetadataSchema.safeParse(draft.metadata.faqImport);
    if (!parsed.success) continue;
    const group = groups.get(parsed.data.batchId) ?? {
      batchId: parsed.data.batchId,
      mode: parsed.data.mode,
      members: [],
      newestAt: '',
    };
    group.members.push({
      documentId,
      title: item.title,
      versionId: draft.id,
      expectedVersionId: parsed.data.expectedVersionId,
      jobId: readString(draft.metadata, 'faqImportJobId'),
    });
    if (draft.createdAt > group.newestAt) group.newestAt = draft.createdAt;
    groups.set(group.batchId, group);
  }
  return [...groups.values()].sort((left, right) =>
    left.newestAt < right.newestAt ? 1 : left.newestAt > right.newestAt ? -1 : 0,
  );
}

export function FaqImportDialog({
  baseId,
  canImport,
  canPublish: hasPublishPermission,
  canExecute,
  onClose: onClosed,
}: {
  baseId: string;
  canImport: boolean;
  canPublish: boolean;
  canExecute: boolean;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const importer = useImportKnowledgeFaqs(baseId);
  const publisher = usePublishKnowledgeFaqBatch(baseId);
  const existing = useKnowledgeFaqs(baseId, {});
  useDrainPages(existing);
  const existingItems = existing.data?.pages.flatMap((page) => page.items) ?? [];
  const existingCount = existingItems.length;
  const existingComplete =
    existing.isSuccess && !existing.isError && !existing.hasNextPage && !existing.isFetching;
  const [format, setFormat] = useState<FaqImportFormat>('json');
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [preview, setPreview] = useState<KnowledgeFaqImportResponse | null>(null);
  const [committed, setCommitted] = useState<KnowledgeFaqImportResponse | null>(null);
  const [published, setPublished] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { chunkIds: draftChunkIds, results: draftQueries } = useKnowledgeFaqDrafts(
    existingItems.map((item) => item.id),
    existingComplete && existingItems.length > 0,
  );
  const draftSummary = summarizeFaqDrafts(draftQueries, draftChunkIds);
  const detailErrorCount = draftSummary.errorCount + draftSummary.missing.size;
  const detailsRetrying = draftSummary.retrying;
  const recoveryReadReady = existingComplete && draftSummary.complete;
  const existingById = new Map(existingItems.map((item) => [item.id, item]));
  const recovered =
    recoverBatches(
      [...draftSummary.byDocumentId].map(([documentId, draft]) => ({ documentId, draft })),
      existingById,
    )[0] ?? null;
  const recoveredMembers = recovered?.members ?? [];
  const client = useQueryClient();
  const retryJob = useRetryKnowledgeJob(baseId);
  const [retryingFrom, setRetryingFrom] = useState<Record<string, string>>({});
  const retryPending = (member: RecoveredMember): boolean =>
    member.jobId !== null && retryingFrom[member.documentId] === member.jobId;
  const recovering = recoveredMembers.some(retryPending);
  const recoveredJobIds = [
    ...new Set(recoveredMembers.flatMap((member) => (member.jobId === null ? [] : [member.jobId]))),
  ];
  const { chunkIds: recoveredJobChunks, results: recoveredJobQueries } = useKnowledgeFaqImportJobs(
    baseId,
    recoveredJobIds,
  );
  const recoveredJobs = summarizeFaqJobs(recoveredJobQueries, recoveredJobChunks);
  const recoveredJobsMissing = recoveredJobs.missing.size > 0;
  const recoveredMissingIds = recoveredJobs.missing;
  const recoveredJobError = recoveredJobs.error;
  const recoveredStatus = recoveredJobs.statuses;
  const retryTargets = recoveredMembers.flatMap((member) => {
    const jobId = member.jobId;
    const status = jobId === null ? undefined : recoveredStatus.get(jobId);
    return jobId !== null &&
      !retryPending(member) &&
      !recoveredMissingIds.has(jobId) &&
      (status === 'failed' || status === 'cancelled')
      ? [{ documentId: member.documentId, jobId }]
      : [];
  });
  const recoveredReady =
    recovered !== null &&
    recoveryReadReady &&
    !recoveredJobError &&
    !recoveredJobsMissing &&
    recoveredMembers.every(
      (member) => member.jobId !== null && recoveredStatus.get(member.jobId) === 'succeeded',
    );
  const recoveredStatusLoading =
    recovered !== null &&
    recoveryReadReady &&
    !recoveredJobError &&
    !recoveredJobsMissing &&
    recoveredMembers.some(
      (member) => member.jobId !== null && recoveredStatus.get(member.jobId) === undefined,
    );
  const recoveredWaiting =
    recovered !== null &&
    recoveryReadReady &&
    !recoveredJobError &&
    !recoveredJobsMissing &&
    recoveredMembers.some((member) => {
      const status = member.jobId === null ? undefined : recoveredStatus.get(member.jobId);
      return status !== undefined && !isTerminalKnowledgeJob(status);
    });

  const publishable =
    committed?.results.filter(
      (result) =>
        result.documentId !== undefined &&
        (result.status === 'success' || result.status === 'partial_failed'),
    ) ?? [];
  const jobIds = [
    ...new Set(publishable.flatMap((result) => (result.jobId === undefined ? [] : [result.jobId]))),
  ];
  const { chunkIds: jobChunks, results: jobQueries } = useKnowledgeFaqImportJobs(baseId, jobIds);
  const jobSummary = summarizeFaqJobs(jobQueries, jobChunks);
  const jobsMissing = jobSummary.missing.size > 0;
  const jobsReadError = jobSummary.error;
  const jobsRetrying = jobSummary.retrying;
  const jobsSettled =
    jobIds.length > 0 &&
    jobIds.every(
      (id) => jobSummary.missing.has(id) || isTerminalKnowledgeJob(jobSummary.statuses.get(id)),
    );
  const jobsOk =
    !jobsReadError &&
    !jobsMissing &&
    jobsSettled &&
    jobIds.every((id) => jobSummary.statuses.get(id) === 'succeeded');
  const documentIds = jobsOk
    ? publishable.flatMap((result) => (result.documentId === undefined ? [] : [result.documentId]))
    : [];
  const { chunkIds: committedDraftChunkIds, results: committedDraftQueries } =
    useKnowledgeFaqDrafts(documentIds, jobsOk);
  const committedDraftSummary = summarizeFaqDrafts(committedDraftQueries, committedDraftChunkIds);
  const committedDetailsComplete = documentIds.length > 0 && committedDraftSummary.complete;
  const committedDetailErrorCount =
    committedDraftSummary.errorCount + committedDraftSummary.missing.size;
  const committedDetailsRetrying = committedDraftSummary.retrying;
  const publishItems = publishable.flatMap((result) => {
    if (result.documentId === undefined) return [];
    const draft = committedDraftSummary.byDocumentId.get(result.documentId);
    if (!draft) return [];
    return [
      {
        documentId: result.documentId,
        versionId: draft.id,
        expectedVersionId: result.expectedVersionId ?? null,
      },
    ];
  });
  const canPublish =
    jobsOk &&
    committedDetailsComplete &&
    publishItems.length > 0 &&
    publishItems.length === publishable.length;
  const jobsPending =
    committed !== null &&
    !jobsReadError &&
    jobIds.some(
      (id) => !jobSummary.missing.has(id) && !isTerminalKnowledgeJob(jobSummary.statuses.get(id)),
    );
  const pending =
    importer.isPending ||
    publisher.isPending ||
    jobsPending ||
    recoveredWaiting ||
    retryJob.isPending;
  const locked = pending || committed !== null || published;
  const guard = useDraftGuard(content !== '' && !published, pending, onClose);
  const failedJob = jobQueries
    .flatMap((query) => query.data?.items ?? [])
    .find((job) => job.status === 'failed');

  const resetPreview = (): void => {
    setPreview(null);
    setError(null);
  };

  const runDryRun = (): void => {
    setError(null);
    importer.mutate(
      { format, content, mode, dryRun: true },
      {
        onSuccess: (result) => setPreview(result),
        onError: (reason) => setError(errorMessage(reason)),
      },
    );
  };

  const commit = (): void => {
    setError(null);
    importer.mutate(
      { format, content, mode, dryRun: false },
      {
        onSuccess: (result) => {
          if (!result.committed || result.importBatchId === null) {
            setPreview(result);
            return;
          }
          setPreview(null);
          setCommitted(result);
          toastSuccess(`已创建 ${result.counts.success + result.counts.partialFailed} 条 FAQ 草稿`);
        },
        onError: (reason) => setError(errorMessage(reason)),
      },
    );
  };

  const retryRecovered = async (): Promise<void> => {
    for (const target of retryTargets) {
      try {
        await retryJob.mutateAsync(target.jobId);
        setRetryingFrom((current) => ({ ...current, [target.documentId]: target.jobId }));
        void client.invalidateQueries({ queryKey: knowledgeKeys.faq(target.documentId) });
        void client.invalidateQueries({ queryKey: knowledgeKeys.faqDrafts });
      } catch (reason) {
        setError(errorMessage(reason));
        return;
      }
    }
  };

  const retryList = (): void => {
    if (existing.hasNextPage) void existing.fetchNextPage();
    else void existing.refetch();
  };

  const retryDetails = (): void => {
    for (const query of draftQueries) {
      if (query.isError) void query.refetch();
    }
    if (draftSummary.missing.size > 0) retryList();
  };

  const retryRecoveredJobs = (): void => {
    for (const query of recoveredJobQueries) {
      if (query.isError) void query.refetch();
    }
  };

  const retryCommittedJobs = (): void => {
    for (const query of jobQueries) {
      if (query.isError) void query.refetch();
    }
  };

  const retryCommittedDetails = (): void => {
    committedDraftQueries.forEach((query, index) => {
      const ids = committedDraftChunkIds[index] ?? [];
      const missed = ids.some((id) => committedDraftSummary.missing.has(id));
      if (query.isError || missed) void query.refetch();
    });
  };

  const publishRecovered = (): void => {
    if (!recovered) return;
    setError(null);
    publisher.mutate(
      {
        action: 'publish',
        importBatchId: recovered.batchId,
        items: recovered.members.map(({ documentId, versionId, expectedVersionId }) => ({
          documentId,
          versionId,
          expectedVersionId,
        })),
      },
      {
        onSuccess: () => toastSuccess(`已发布批次 ${recovered.members.length} 条 FAQ`),
        onError: (reason) => setError(errorMessage(reason)),
      },
    );
  };

  const recoveryLoading = !recoveryReadReady
    ? !existing.isError && detailErrorCount === 0
    : !recoveredJobsMissing && (recovering || recoveredWaiting || recoveredStatusLoading);
  const recoveryTone = recoveredReady
    ? 'text-xs text-success'
    : recoveryLoading
      ? 'text-xs text-muted-foreground'
      : 'text-xs text-danger';

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell
        title={canImport ? '导入 FAQ' : '批次发布 FAQ'}
        closeDisabled={pending}
        className="max-w-180 sm:max-w-180"
      >
        <div className="flex flex-col gap-4">
          {recovered && committed === null ? (
            <div className="flex flex-col gap-2 rounded-item border border-line px-3 py-2">
              <span className="text-xs font-medium text-fg">
                继续未完成批次
                {recoveryReadReady ? ` · ${recovered.members.length} 条` : ''} ·{' '}
                {recovered.mode === 'replace' ? '替换全部' : '追加'}
              </span>
              <span className={recoveryTone}>
                {!recoveryReadReady
                  ? existing.isError || detailErrorCount > 0
                    ? '批次成员读取不完整，暂不能整批发布。'
                    : '正在核对批次成员…'
                  : recoveredJobsMissing
                    ? '索引任务记录已被清理，无法确认索引结果，不能整批发布。'
                    : recoveredJobError
                      ? '索引任务状态读取失败，重试后再发布。'
                      : recoveredReady
                        ? '索引已完成，可整批发布。'
                        : recovering
                          ? '重试已提交，等待新的索引任务…'
                          : retryTargets.length > 0
                            ? '有索引任务失败，重试完成后再发布。'
                            : recoveredWaiting
                              ? '等待索引任务完成…'
                              : recoveredStatusLoading
                                ? '正在读取索引任务状态…'
                                : '缺少可跟踪的索引任务，不能整批发布。'}
              </span>
              <div className="flex flex-wrap justify-end gap-2">
                {existing.isError ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={existing.isFetchingNextPage}
                    aria-busy={existing.isFetchingNextPage}
                    onClick={retryList}
                  >
                    {existing.isFetchingNextPage ? '重试中…' : '重试读取列表'}
                  </Button>
                ) : null}
                {detailErrorCount > 0 ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={detailsRetrying}
                    aria-busy={detailsRetrying}
                    onClick={retryDetails}
                  >
                    {detailsRetrying ? '重试中…' : `重试读取 ${detailErrorCount} 条详情`}
                  </Button>
                ) : null}
                {recoveredJobError && !recoveredJobsMissing ? (
                  <Button type="button" variant="outline" size="sm" onClick={retryRecoveredJobs}>
                    重试读取任务状态
                  </Button>
                ) : null}
                {canExecute &&
                recoveryReadReady &&
                !recoveredJobError &&
                !recoveredJobsMissing &&
                retryTargets.length > 0 ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={retryJob.isPending}
                    aria-busy={retryJob.isPending}
                    onClick={() => void retryRecovered()}
                  >
                    {retryJob.isPending ? '重试中…' : '重试失败索引'}
                  </Button>
                ) : null}
                {hasPublishPermission &&
                recoveryReadReady &&
                !recoveredJobError &&
                !recoveredJobsMissing ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={!recoveredReady || publisher.isPending}
                    aria-busy={publisher.isPending}
                    onClick={publishRecovered}
                  >
                    {publisher.isPending
                      ? '发布中…'
                      : `发布批次 ${recovered.members.length} 条 FAQ`}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {recovered === null &&
          committed === null &&
          (existing.isError || detailErrorCount > 0) ? (
            <div className="flex flex-col gap-2 rounded-item border border-line px-3 py-2">
              <span className="text-xs text-danger">
                未能完整读取现有 FAQ，未完成批次可能无法恢复。
              </span>
              <div className="flex flex-wrap justify-end gap-2">
                {existing.isError ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={existing.isFetchingNextPage}
                    aria-busy={existing.isFetchingNextPage}
                    onClick={retryList}
                  >
                    {existing.isFetchingNextPage ? '重试中…' : '重试读取列表'}
                  </Button>
                ) : null}
                {detailErrorCount > 0 ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={detailsRetrying}
                    aria-busy={detailsRetrying}
                    onClick={retryDetails}
                  >
                    {detailsRetrying ? '重试中…' : `重试读取 ${detailErrorCount} 条详情`}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {canImport ? (
            <>
              <FieldGroup className="grid gap-3 sm:grid-cols-2">
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="faq-import-format">格式</FieldLabel>
                  <Select
                    value={format}
                    disabled={locked}
                    onValueChange={(next) => {
                      if (next === 'json' || next === 'csv' || next === 'xlsx') {
                        setFormat(next);
                        resetPreview();
                      }
                    }}
                    items={[
                      { value: 'json', label: 'JSON' },
                      { value: 'csv', label: 'CSV' },
                      { value: 'xlsx', label: 'Excel (.xlsx)' },
                    ]}
                  >
                    <SelectTrigger id="faq-import-format" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="json">JSON</SelectItem>
                        <SelectItem value="csv">CSV</SelectItem>
                        <SelectItem value="xlsx">Excel (.xlsx)</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="faq-import-mode">导入方式</FieldLabel>
                  <Select
                    value={mode}
                    disabled={locked}
                    onValueChange={(next) => {
                      if (next === 'append' || next === 'replace') {
                        setMode(next);
                        resetPreview();
                      }
                    }}
                    items={[
                      { value: 'append', label: '追加' },
                      { value: 'replace', label: '替换全部' },
                    ]}
                  >
                    <SelectTrigger id="faq-import-mode" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="append">追加</SelectItem>
                        <SelectItem value="replace">替换全部</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {mode === 'replace' ? (
                    existingComplete ? (
                      <span className="text-sm text-muted-foreground">
                        旧 FAQ 会保留到整批发布成功；失败时线上不变。
                      </span>
                    ) : existing.isError ? (
                      <span className="text-sm text-danger">旧 FAQ 数量读取失败，暂不能替换。</span>
                    ) : (
                      <span className="text-sm text-muted-foreground">正在读取旧 FAQ 数量…</span>
                    )
                  ) : null}
                </Field>
              </FieldGroup>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="faq-import-content">内容</FieldLabel>
                <Textarea
                  id="faq-import-content"
                  value={content}
                  rows={8}
                  disabled={locked}
                  onChange={(event) => {
                    setContent(event.target.value);
                    resetPreview();
                  }}
                  className="font-mono"
                  placeholder={
                    format === 'xlsx' ? 'Excel 文件会以 base64 读取；也可直接粘贴 base64' : ''
                  }
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="faq-import-file">或选择文件</FieldLabel>
                <Input
                  id="faq-import-file"
                  type="file"
                  accept=".json,.csv,.xlsx,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  disabled={locked}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    const nextFormat = detectImportFormat(file.name);
                    try {
                      const text = await importFileContent(file, nextFormat);
                      setFormat(nextFormat);
                      setContent(text);
                      resetPreview();
                    } catch {
                      setError('文件读取失败，请重新选择。');
                    }
                  }}
                />
              </Field>

              {preview ? (
                <div className="flex flex-col gap-1 rounded-item border border-line px-3 py-2">
                  <span className="text-xs font-medium text-fg">预览 · 未写入</span>
                  <ImportCounts response={preview} />
                  <ImportResults response={preview} />
                  {preview.counts.failed > 0 ? (
                    <span className="text-sm text-danger">存在失败行，整批不会写入。</span>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}

          {committed ? (
            <div className="flex flex-col gap-1 rounded-item border border-line px-3 py-2">
              <span className="text-xs font-medium text-fg">
                {published ? '本批已发布' : '草稿批次已创建'}
              </span>
              <ImportCounts response={committed} />
              <ImportResults response={committed} />
              {published ? (
                <span className="text-xs text-success">
                  已整批上线，旧 FAQ 的替换在发布成功时完成。
                </span>
              ) : jobsReadError ? (
                <span className="flex flex-wrap items-center gap-2 text-sm text-danger">
                  <span className="min-w-0 flex-1">
                    索引任务状态读取失败，重试后再发布；旧 FAQ 仍在线上。
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={jobsRetrying}
                    aria-busy={jobsRetrying}
                    onClick={retryCommittedJobs}
                  >
                    {jobsRetrying ? '重试中…' : '重试读取任务状态'}
                  </Button>
                </span>
              ) : jobsMissing ? (
                <span className="text-sm text-danger">
                  索引任务记录已被清理，无法确认索引结果，未发布；旧 FAQ 仍在线上。
                </span>
              ) : failedJob ? (
                <span className="text-sm text-danger">
                  索引任务失败：{failedJob.error ?? '未知原因'}；旧 FAQ 仍在线上。
                </span>
              ) : jobsSettled && !jobsOk ? (
                <span className="text-sm text-danger">
                  索引任务未全部成功，未发布；旧 FAQ 仍在线上。
                </span>
              ) : jobsOk && committedDetailErrorCount > 0 ? (
                <span className="flex flex-wrap items-center gap-2 text-sm text-danger">
                  <span className="min-w-0 flex-1">
                    草稿版本读取失败，重试后再发布；旧 FAQ 仍在线上。
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={committedDetailsRetrying}
                    aria-busy={committedDetailsRetrying}
                    onClick={retryCommittedDetails}
                  >
                    {committedDetailsRetrying
                      ? '重试中…'
                      : `重试读取 ${committedDetailErrorCount} 条草稿版本`}
                  </Button>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {jobsPending || jobIds.length === 0
                    ? '等待索引任务完成…'
                    : canPublish
                      ? '索引已完成，确认后整批发布。'
                      : '读取草稿版本中…'}
                </span>
              )}
            </div>
          ) : null}

          <FieldError>{error}</FieldError>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={guard.close} disabled={pending}>
              {published ? '完成' : '取消'}
            </Button>
            {committed === null ? (
              canImport ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={runDryRun}
                    disabled={pending || content.trim() === ''}
                  >
                    {importer.isPending && !preview ? '预览中…' : '预览'}
                  </Button>
                  <Button
                    type="button"
                    disabled={
                      pending ||
                      content.trim() === '' ||
                      preview === null ||
                      preview.committed ||
                      preview.counts.failed > 0 ||
                      (mode === 'replace' && !existingComplete)
                    }
                    aria-busy={importer.isPending}
                    onClick={() => {
                      if (mode === 'replace') setConfirmReplace(true);
                      else commit();
                    }}
                  >
                    {importer.isPending ? '导入中…' : '确认导入'}
                  </Button>
                </>
              ) : null
            ) : published || !hasPublishPermission ? null : (
              <Button
                type="button"
                disabled={!canPublish || publisher.isPending}
                aria-busy={publisher.isPending}
                onClick={() => {
                  if (!committed.importBatchId) return;
                  setError(null);
                  publisher.mutate(
                    {
                      action: 'publish',
                      importBatchId: committed.importBatchId,
                      items: publishItems,
                    },
                    {
                      onSuccess: () => {
                        setPublished(true);
                        toastSuccess('本批 FAQ 已发布');
                      },
                      onError: (reason) => setError(errorMessage(reason)),
                    },
                  );
                }}
              >
                {publisher.isPending ? '发布中…' : `发布本批 ${publishable.length} 条 FAQ`}
              </Button>
            )}
          </div>
        </div>
        <DraftGuardDialogs guard={guard} draft="导入内容会丢失。" pending={pending} />
        <ConfirmDialog
          open={confirmReplace}
          title="替换全部 FAQ"
          description={`将先创建草稿，整批发布成功后替换现有 ${existingCount} 条 FAQ；在此之前旧 FAQ 仍在线可读。`}
          confirmLabel="确认导入"
          confirmDisabled={pending}
          onClose={() => setConfirmReplace(false)}
          onConfirm={async () => {
            setConfirmReplace(false);
            commit();
          }}
        />
      </DialogShell>
    </Dialog>
  );
}
