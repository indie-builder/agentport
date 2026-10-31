import { knowledgeFaqImportMetadataSchema } from '@agentport/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import type {
  KnowledgeFaq,
  KnowledgeFaqBatchInput,
  KnowledgeFaqBatchResult,
  KnowledgeFaqDetail,
  KnowledgeFaqImportResponse,
  KnowledgeFaqSummary,
  KnowledgeFolder,
} from '../lib/api.js';
import { api, errorMessage } from '../lib/api.js';
import {
  isTerminalKnowledgeJob,
  knowledgeKeys,
  useCreateKnowledgeFaq,
  useDeleteKnowledgeFaq,
  useDrainPages,
  useExportKnowledgeFaqs,
  useImportKnowledgeFaqs,
  useKnowledgeDocumentVersions,
  useKnowledgeFaq,
  useKnowledgeFaqDraftVersions,
  useKnowledgeFaqImportJobs,
  useKnowledgeFaqs,
  useKnowledgeFaqTest,
  useKnowledgeFolders,
  usePublishKnowledgeFaq,
  usePublishKnowledgeFaqBatch,
  useRetryKnowledgeJob,
  useRollbackKnowledgeDocument,
  useSetKnowledgeFaqStatus,
  useUpdateKnowledgeFaq,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useDebouncedValue } from '../lib/use-debounced-value.js';
import { useZodForm } from '../lib/use-zod-form.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { DialogShell } from './dialog-shell.js';
import { FilterSelect } from './filter-select.js';
import { FaqRetrievalControls, KnowledgeSearchResults } from './knowledge-search.js';
import {
  DraftGuardDialogs,
  documentStatusLabel,
  treeFolders,
  useDraftGuard,
  versionLabel,
} from './knowledge-shared.js';
import { PageSection, PageToolbar } from './page.js';
import { RequiredMark } from './required-mark.js';
import { SearchInput } from './search-input.js';
import { EmptyState, ErrorState, LoadingState } from './states.js';
import { StatusBadge } from './status-badge.js';
import { Button } from './ui/button.js';
import { Checkbox } from './ui/checkbox.js';
import { Dialog } from './ui/dialog.js';
import { Field, FieldError, FieldGroup, FieldLabel } from './ui/field.js';
import { Input } from './ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select.js';
import { Switch } from './ui/switch.js';
import { Textarea } from './ui/textarea.js';

const faqFormSchema = z.object({
  title: z.string().max(300, '最多 300 个字符'),
  question: z.string().trim().min(1, '请填写标准问').max(500, '最多 500 个字符'),
  similarQuestions: z.string(),
  negativeQuestions: z.string(),
  answers: z
    .array(z.string().max(20_000, '每个答案最多 20000 个字符'))
    .min(1, '至少一个答案')
    .refine((answers) => answers.some((answer) => answer.trim() !== ''), '至少填写一个答案'),
  folderId: z.string(),
  tags: z.string(),
  answerStrategy: z.enum(['all', 'random']),
  isRecommended: z.boolean(),
});

type FaqForm = z.infer<typeof faqFormSchema>;

function splitQuestions(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 数组字段的错误挂在 answers[index]，根上只有数组级 refine 的 message。 */
function indexedErrorMessage(errors: unknown, index: number): string | undefined {
  if (!Array.isArray(errors)) return undefined;
  const entry = errors[index] as { message?: unknown } | undefined;
  return typeof entry?.message === 'string' ? entry.message : undefined;
}

function rootErrorMessage(errors: unknown): string | undefined {
  if (Array.isArray(errors)) return undefined;
  const entry = errors as { message?: unknown } | undefined;
  return typeof entry?.message === 'string' ? entry.message : undefined;
}

function readString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

// 服务端普通批量操作上限 100 条；超过会整批 400。
const FAQ_BATCH_LIMIT = 100;

function useBatchKnowledgeFaqs(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: KnowledgeFaqBatchInput) => api.batchKnowledgeFaqs(baseId, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.faqs(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
    },
  });
}

function faqStatus(
  item: KnowledgeFaqSummary,
): 'published' | 'draft' | 'disabled' | 'processing' | 'failed' {
  if (item.status === 'failed') return 'failed';
  if (item.status === 'processing') return 'processing';
  if (item.status === 'disabled') return 'disabled';
  // pending 只表示还没有线上版本，不是索引中；否则会被误读成“解析中/排队”。
  if (item.status === 'pending') return 'draft';
  return item.currentVersionId ? 'published' : 'draft';
}

const faqStatusLabel = {
  published: '已发布',
  draft: '未发布草稿',
  disabled: '已停用',
  processing: '解析中',
  failed: '失败',
} as const;

const faqStatusTone = {
  published: 'success',
  draft: 'warn',
  disabled: 'outline',
  processing: 'warn',
  failed: 'danger',
} as const;

/** 编辑先取详情：列表只带最新 FAQ 快照，没有草稿/发布版本信息。 */
function FaqDialog({
  baseId,
  documentId,
  folders,
  initialFolderId,
  onClose,
}: {
  baseId: string;
  documentId?: string;
  folders: KnowledgeFolder[];
  initialFolderId: string | null;
  onClose: () => void;
}) {
  const detail = useKnowledgeFaq(documentId ?? null);
  if (documentId === undefined) {
    return (
      <FaqEditorForm
        baseId={baseId}
        folders={folders}
        initialFolderId={initialFolderId}
        onClose={onClose}
      />
    );
  }
  // 有缓存就先保住编辑子树：后台 refetch 失败只提示并允许重试，不能把草稿卸载。
  if (detail.data === undefined) {
    if (detail.isPending) {
      return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
          <DialogShell title="编辑 FAQ">
            <LoadingState rows={4} />
          </DialogShell>
        </Dialog>
      );
    }
    return (
      <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
        <DialogShell title="编辑 FAQ">
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        </DialogShell>
      </Dialog>
    );
  }
  return (
    <FaqEditorForm
      baseId={baseId}
      detail={detail.data}
      detailError={detail.isError ? detail.error : null}
      onRetryDetail={() => void detail.refetch()}
      folders={folders}
      initialFolderId={initialFolderId}
      onClose={onClose}
    />
  );
}

function FaqEditorForm({
  baseId,
  detail,
  detailError,
  onRetryDetail,
  folders,
  initialFolderId,
  onClose,
}: {
  baseId: string;
  detail?: KnowledgeFaqDetail;
  detailError?: unknown;
  onRetryDetail?: () => void;
  folders: KnowledgeFolder[];
  initialFolderId: string | null;
  onClose: () => void;
}) {
  const create = useCreateKnowledgeFaq(baseId);
  const update = useUpdateKnowledgeFaq(baseId);
  const pending = create.isPending || update.isPending;
  const [error, setError] = useState<string | null>(null);
  // 正文默认值和 expectedVersionId 必须来自同一个初始快照；refetch 不能只让版本号漂移。
  const [initialDetail] = useState(() => detail);
  const form = useZodForm(faqFormSchema, {
    defaultValues: {
      title: initialDetail?.document.title ?? '',
      question: initialDetail?.faq?.question ?? '',
      similarQuestions: initialDetail?.faq?.similarQuestions.join('\n') ?? '',
      negativeQuestions: initialDetail?.faq?.negativeQuestions.join('\n') ?? '',
      answers:
        initialDetail?.faq?.answers !== undefined && initialDetail.faq.answers.length > 0
          ? initialDetail.faq.answers
          : [''],
      folderId: initialDetail?.document.folderId ?? initialFolderId ?? 'null',
      tags: initialDetail?.document.tags.join(', ') ?? '',
      answerStrategy: initialDetail?.faq?.answerStrategy ?? 'all',
      isRecommended: initialDetail?.faq?.isRecommended ?? true,
    } satisfies FaqForm,
  });
  const answers = form.watch('answers');
  const answerStrategy = form.watch('answerStrategy');
  const isRecommended = form.watch('isRecommended');
  const dirty = form.formState.isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);
  const folderOptions = [
    { value: 'null', label: '未分类' },
    ...treeFolders(folders).map((folder) => ({
      value: folder.id,
      label: `${'　'.repeat(folder.depth)}${folder.label}`,
    })),
  ];
  const expectedVersionId =
    initialDetail?.draftVersion?.id ?? initialDetail?.publishedVersion?.id ?? null;
  const answerErrors = form.formState.errors.answers;
  const answersRootError = rootErrorMessage(answerErrors);

  const submit = form.handleSubmit((values) => {
    setError(null);
    const faq: KnowledgeFaq = {
      question: values.question.trim(),
      similarQuestions: splitQuestions(values.similarQuestions),
      negativeQuestions: splitQuestions(values.negativeQuestions),
      answers: values.answers.map((answer) => answer.trim()).filter(Boolean),
      answerStrategy: values.answerStrategy,
      isRecommended: values.isRecommended,
    };
    const common = {
      ...(values.title.trim() === '' ? {} : { title: values.title.trim() }),
      faq,
      folderId: values.folderId === 'null' ? null : values.folderId,
      tags: values.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    };
    const onSuccess = (): void => {
      toastSuccess('FAQ 草稿已保存，发布后可召回');
      guard.finish();
    };
    if (initialDetail) {
      update.mutate(
        { documentId: initialDetail.document.id, ...common, expectedVersionId },
        { onSuccess, onError: (reason) => setError(errorMessage(reason)) },
      );
      return;
    }
    create.mutate(common, {
      onSuccess,
      onError: (reason) => setError(errorMessage(reason)),
    });
  });

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
      <DialogShell
        title={initialDetail ? '编辑 FAQ' : '新建 FAQ'}
        closeDisabled={pending}
        className="max-w-[760px] sm:max-w-[760px]"
      >
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            return submit();
          }}
        >
          {detailError ? (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-item border border-line px-3 py-2 text-xs text-danger"
            >
              <span className="min-w-0 flex-1">{errorMessage(detailError)}</span>
              {onRetryDetail ? (
                <Button type="button" variant="outline" size="sm" onClick={onRetryDetail}>
                  重试
                </Button>
              ) : null}
            </div>
          ) : null}
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field className="gap-1.5" data-invalid={Boolean(form.formState.errors.title)}>
              <FieldLabel htmlFor="faq-title">标题</FieldLabel>
              <Input
                {...form.register('title')}
                id="faq-title"
                disabled={pending}
                placeholder="默认使用标准问"
                aria-invalid={Boolean(form.formState.errors.title)}
                aria-describedby={form.formState.errors.title ? 'faq-title-error' : undefined}
              />
              <FieldError id="faq-title-error">{form.formState.errors.title?.message}</FieldError>
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="faq-folder">文件夹</FieldLabel>
              <Select
                value={form.watch('folderId')}
                disabled={pending}
                onValueChange={(next) => {
                  if (next !== null)
                    form.setValue('folderId', next, { shouldDirty: true, shouldValidate: true });
                }}
                items={folderOptions}
              >
                <SelectTrigger id="faq-folder" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {folderOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <Field className="gap-1.5" data-invalid={Boolean(form.formState.errors.question)}>
            <FieldLabel htmlFor="faq-question">
              标准问 <RequiredMark />
            </FieldLabel>
            <Input
              {...form.register('question')}
              id="faq-question"
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.question)}
              aria-describedby={form.formState.errors.question ? 'faq-question-error' : undefined}
            />
            <FieldError id="faq-question-error">
              {form.formState.errors.question?.message}
            </FieldError>
          </Field>
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="faq-similar">相似问</FieldLabel>
              <Textarea
                {...form.register('similarQuestions')}
                id="faq-similar"
                rows={4}
                disabled={pending}
                placeholder="每行一个"
              />
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="faq-negative">反例问题</FieldLabel>
              <Textarea
                {...form.register('negativeQuestions')}
                id="faq-negative"
                rows={4}
                disabled={pending}
                placeholder="每行一个；规范化后完全相同才排除该 FAQ"
              />
            </Field>
          </FieldGroup>
          <Field className="gap-1.5" data-invalid={Boolean(form.formState.errors.answers)}>
            <FieldLabel>
              答案 <RequiredMark />
            </FieldLabel>
            <div className="flex flex-col gap-2">
              {answers.map((_answer, index) => {
                const message = indexedErrorMessage(answerErrors, index);
                const describedBy =
                  [
                    message ? `faq-answer-${index}-error` : null,
                    answersRootError ? 'faq-answers-error' : null,
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 答案按表单顺序渲染，不提供排序
                  <div key={`answer-${index}`} className="flex items-start gap-2">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <Textarea
                        {...form.register(`answers.${index}`)}
                        aria-label={`答案 ${index + 1}`}
                        aria-invalid={Boolean(message ?? answersRootError)}
                        aria-describedby={describedBy}
                        rows={3}
                        disabled={pending}
                        className="min-w-0 flex-1"
                      />
                      <FieldError id={`faq-answer-${index}-error`}>{message}</FieldError>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`删除答案 ${index + 1}`}
                      disabled={pending || answers.length === 1}
                      onClick={() =>
                        form.setValue(
                          'answers',
                          answers.filter((_, item) => item !== index),
                          { shouldDirty: true },
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                );
              })}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                disabled={pending}
                onClick={() => form.setValue('answers', [...answers, ''], { shouldDirty: true })}
              >
                <Plus data-icon="inline-start" aria-hidden="true" /> 添加答案
              </Button>
            </div>
            <FieldError id="faq-answers-error">{rootErrorMessage(answerErrors)}</FieldError>
          </Field>
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="faq-answer-strategy">答案策略</FieldLabel>
              <Select
                value={answerStrategy}
                disabled={pending}
                onValueChange={(next) => {
                  if (next === 'all' || next === 'random')
                    form.setValue('answerStrategy', next, {
                      shouldDirty: true,
                      shouldValidate: true,
                    });
                }}
                items={[
                  { value: 'all', label: '全部答案' },
                  { value: 'random', label: '随机一条' },
                ]}
              >
                <SelectTrigger id="faq-answer-strategy" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">全部答案</SelectItem>
                    <SelectItem value="random">随机一条</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <span className="text-2xs text-muted-foreground">
                只影响检索命中；管理详情与导出始终保留全部答案。
              </span>
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="faq-recommended">推荐</FieldLabel>
              <span className="flex h-8 items-center gap-2">
                <Switch
                  id="faq-recommended"
                  checked={isRecommended}
                  disabled={pending}
                  onCheckedChange={(checked) =>
                    form.setValue('isRecommended', checked, { shouldDirty: true })
                  }
                />
                <span className="text-xs text-muted-foreground">
                  {isRecommended ? '可被推荐筛选命中' : '不参与推荐筛选'}
                </span>
              </span>
            </Field>
          </FieldGroup>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="faq-tags">标签</FieldLabel>
            <Input
              {...form.register('tags')}
              id="faq-tags"
              disabled={pending}
              placeholder="以逗号分隔"
            />
          </Field>
          <FieldError>{error}</FieldError>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? '保存中…' : '保存草稿'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="FAQ 草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

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
        <li key={`${result.row}-${result.status}`} className="text-2xs">
          <span className="font-mono text-muted-foreground">第 {result.row} 行</span>{' '}
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

/** 批次身份只落在草稿版本 metadata；重开对话框时从各 FAQ 详情恢复完整成员。 */
function recoverBatches(details: Array<KnowledgeFaqDetail | undefined>): RecoveredBatch[] {
  const groups = new Map<string, RecoveredBatch>();
  for (const detail of details) {
    const draft = detail?.draftVersion;
    if (!detail || !draft) continue;
    const parsed = knowledgeFaqImportMetadataSchema.safeParse(draft.metadata.faqImport);
    if (!parsed.success) continue;
    const group = groups.get(parsed.data.batchId) ?? {
      batchId: parsed.data.batchId,
      mode: parsed.data.mode,
      members: [],
      newestAt: '',
    };
    group.members.push({
      documentId: detail.document.id,
      title: detail.document.title,
      versionId: draft.id,
      // 发布校验只认导入保存时锁定的线上版本，不能用今天的 current 重新猜。
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

function FaqImportDialog({ baseId, onClose }: { baseId: string; onClose: () => void }) {
  const importer = useImportKnowledgeFaqs(baseId);
  const publisher = usePublishKnowledgeFaqBatch(baseId);
  const existing = useKnowledgeFaqs(baseId, {});
  useDrainPages(existing);
  const existingItems = existing.data?.pages.flatMap((page) => page.items) ?? [];
  const existingCount = existingItems.length;
  // 只有全部页读完且无读取错误，才能确定现有 FAQ 与未完成批次的完整成员。
  const existingComplete =
    existing.isSuccess &&
    !existing.isError &&
    !existing.hasNextPage &&
    !existing.isFetchingNextPage;
  const [format, setFormat] = useState<FaqImportFormat>('json');
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [preview, setPreview] = useState<KnowledgeFaqImportResponse | null>(null);
  const [committed, setCommitted] = useState<KnowledgeFaqImportResponse | null>(null);
  const [published, setPublished] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const faqIds = existingItems.map((item) => item.id);
  const faqDetails = useKnowledgeFaqDraftVersions(faqIds, faqIds.length > 0);
  const detailsComplete =
    faqIds.length > 0 &&
    faqDetails.every((query) => query.isSuccess && !query.isError && !query.isFetching);
  const detailErrorCount = faqDetails.filter((query) => query.isError).length;
  const detailsRetrying = faqDetails.some((query) => query.isError && query.isFetching);
  const recoveryReadReady = existingComplete && detailsComplete;
  const recovered = recoverBatches(faqDetails.map((query) => query.data))[0] ?? null;
  const recoveredMembers = recovered?.members ?? [];
  const client = useQueryClient();
  const retryJob = useRetryKnowledgeJob(baseId);
  // 重试提交后到详情读回新 job 的短暂窗口；新任务 id 的唯一权威仍是草稿 metadata。
  const [retryingFrom, setRetryingFrom] = useState<Record<string, string>>({});
  const retryPending = (member: RecoveredMember): boolean =>
    member.jobId !== null && retryingFrom[member.documentId] === member.jobId;
  const recovering = recoveredMembers.some(retryPending);
  const recoveredJobIds = [
    ...new Set(recoveredMembers.flatMap((member) => (member.jobId === null ? [] : [member.jobId]))),
  ];
  const recoveredJobs = useKnowledgeFaqImportJobs(recoveredJobIds);
  const recoveredJobError = recoveredJobs.some((query) => query.isError);
  const recoveredStatus = new Map(
    recoveredJobs.map((query, index) => [recoveredJobIds[index], query.data?.status]),
  );
  const retryTargets = recoveredMembers.flatMap((member) => {
    const jobId = member.jobId;
    const status = jobId === null ? undefined : recoveredStatus.get(jobId);
    return jobId !== null &&
      !retryPending(member) &&
      (status === 'failed' || status === 'cancelled')
      ? [{ documentId: member.documentId, jobId }]
      : [];
  });
  const recoveredReady =
    recovered !== null &&
    recoveryReadReady &&
    !recoveredJobError &&
    recoveredMembers.every(
      (member) => member.jobId !== null && recoveredStatus.get(member.jobId) === 'succeeded',
    );
  const recoveredStatusLoading =
    recovered !== null &&
    recoveryReadReady &&
    !recoveredJobError &&
    recoveredMembers.some(
      (member) => member.jobId !== null && recoveredStatus.get(member.jobId) === undefined,
    );
  // 读取错误或尚未返回的任务状态都不是“进行中”：只让已知的非终态任务锁窗。
  const recoveredWaiting =
    recovered !== null &&
    recoveryReadReady &&
    !recoveredJobError &&
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
  const jobs = useKnowledgeFaqImportJobs(jobIds);
  const jobsReadError = jobs.some((job) => job.isError);
  const jobsRetrying = jobs.some((job) => job.isError && job.isFetching);
  const jobsSettled =
    jobs.length > 0 && jobs.every((job) => isTerminalKnowledgeJob(job.data?.status));
  const jobsOk =
    !jobsReadError && jobsSettled && jobs.every((job) => job.data?.status === 'succeeded');
  const documentIds = jobsOk
    ? publishable.flatMap((result) => (result.documentId === undefined ? [] : [result.documentId]))
    : [];
  const details = useKnowledgeFaqDraftVersions(documentIds, jobsOk);
  // 读取失败时 TanStack 仍保留旧草稿缓存；只有全部详情读成且不在请求中才算可发布。
  const committedDetailsComplete =
    documentIds.length > 0 &&
    details.every((detail) => detail.isSuccess && !detail.isError && !detail.isFetching);
  const committedDetailErrorCount = details.filter((detail) => detail.isError).length;
  const committedDetailsRetrying = details.some((detail) => detail.isError && detail.isFetching);
  const publishItems = details.flatMap((detail, index) => {
    const draft = detail.data?.draftVersion;
    const result = publishable[index];
    if (!draft || !result?.documentId) return [];
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
    jobs.some((job) => !isTerminalKnowledgeJob(job.data?.status));
  const pending =
    importer.isPending ||
    publisher.isPending ||
    jobsPending ||
    recoveredWaiting ||
    retryJob.isPending;
  const locked = pending || committed !== null || published;
  const guard = useDraftGuard(content !== '' && !published, pending, onClose);
  const failedJob = jobs.find((job) => job.data?.status === 'failed')?.data;

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
        // 重试只回传 task id；把草稿详情读回的新 faqImportJobId 作为权威，读完前保持等待。
        setRetryingFrom((current) => ({ ...current, [target.documentId]: target.jobId }));
        void client.invalidateQueries({ queryKey: knowledgeKeys.faq(target.documentId) });
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
    for (const query of faqDetails) {
      if (query.isError) void query.refetch();
    }
  };

  const retryRecoveredJobs = (): void => {
    for (const query of recoveredJobs) {
      if (query.isError) void query.refetch();
    }
  };

  const retryCommittedJobs = (): void => {
    for (const query of jobs) {
      if (query.isError) void query.refetch();
    }
  };

  const retryCommittedDetails = (): void => {
    for (const detail of details) {
      if (detail.isError) void detail.refetch();
    }
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
    : recovering || recoveredWaiting || recoveredStatusLoading;
  const recoveryTone = recoveredReady
    ? 'text-xs text-success'
    : recoveryLoading
      ? 'text-xs text-muted-foreground'
      : 'text-xs text-danger';

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
      <DialogShell
        title="导入 FAQ"
        closeDisabled={pending}
        className="max-w-[720px] sm:max-w-[720px]"
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
                {recoveredJobError ? (
                  <Button type="button" variant="outline" size="sm" onClick={retryRecoveredJobs}>
                    重试读取任务状态
                  </Button>
                ) : null}
                {recoveryReadReady && !recoveredJobError && retryTargets.length > 0 ? (
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
                {recoveryReadReady && !recoveredJobError ? (
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
                  <span className="text-2xs text-muted-foreground">
                    旧 FAQ 会保留到整批发布成功；失败时线上不变。
                  </span>
                ) : existing.isError ? (
                  <span className="text-2xs text-danger">旧 FAQ 数量读取失败，暂不能替换。</span>
                ) : (
                  <span className="text-2xs text-muted-foreground">正在读取旧 FAQ 数量…</span>
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
                <span className="text-xs text-danger">存在失败行，整批不会写入。</span>
              ) : null}
            </div>
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
                <span className="flex flex-wrap items-center gap-2 text-xs text-danger">
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
              ) : failedJob ? (
                <span className="text-xs text-danger">
                  索引任务失败：{failedJob.error ?? '未知原因'}；旧 FAQ 仍在线上。
                </span>
              ) : jobsSettled && !jobsOk ? (
                <span className="text-xs text-danger">
                  索引任务未全部成功，未发布；旧 FAQ 仍在线上。
                </span>
              ) : jobsOk && committedDetailErrorCount > 0 ? (
                <span className="flex flex-wrap items-center gap-2 text-xs text-danger">
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
                  {jobsPending || jobs.length === 0
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
            ) : published ? null : (
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

function FaqTest({ baseId }: { baseId: string }) {
  const [draft, setDraft] = useState('');
  const [term, setTerm] = useState('');
  const [rerank, setRerank] = useState(true);
  const [minVectorScore, setMinVectorScore] = useState(0.3);
  const [faqOptions, setFaqOptions] = useState<{
    onlyRecommended?: boolean | undefined;
    faqPriority?: boolean | undefined;
    faqDirectAnswerThreshold?: number | undefined;
  }>({});
  const result = useKnowledgeFaqTest(baseId, {
    q: term,
    rerank,
    minVectorScore,
    ...faqOptions,
  });
  return (
    <PageSection title="命中测试" divided>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const next = draft.trim();
          // 同词重复测试时 state 不变；显式 refetch，随机答案才会重新抽一次。
          if (next === term) {
            if (next !== '') void result.refetch();
            return;
          }
          setTerm(next);
        }}
      >
        <SearchInput
          label="FAQ 命中测试"
          placeholder="输入用户问法…"
          value={draft}
          onChange={setDraft}
          className="min-w-48 flex-1 sm:max-w-md"
        />
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={rerank} onCheckedChange={setRerank} aria-label="启用重排" /> 重排
        </span>
        <Field className="w-32 gap-1">
          <FieldLabel htmlFor="faq-test-threshold" className="text-2xs">
            向量门槛
          </FieldLabel>
          <Input
            id="faq-test-threshold"
            type="number"
            min={-1}
            max={1}
            step={0.05}
            value={minVectorScore}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next) && next >= -1 && next <= 1) setMinVectorScore(next);
            }}
            className="h-8"
          />
        </Field>
        <FaqRetrievalControls
          idPrefix="faq-test"
          value={faqOptions}
          onChange={(patch) => setFaqOptions((current) => ({ ...current, ...patch }))}
        />
        <Button type="submit" disabled={draft.trim() === ''}>
          <Search data-icon="inline-start" aria-hidden="true" /> 测试
        </Button>
      </form>
      {term === '' ? null : result.isPending ? <LoadingState rows={2} /> : null}
      {term !== '' && result.isError ? (
        <ErrorState error={result.error} onRetry={() => void result.refetch()} />
      ) : null}
      {result.data ? (
        <KnowledgeSearchResults result={result.data} emptyTitle="没有命中 FAQ" />
      ) : null}
    </PageSection>
  );
}

/** FAQ 是 contentKind=faq 的文档：列表、编辑、发布与启停都复用文档版本语义。 */
export function FaqTab({ baseId }: { baseId: string }) {
  const [query, setQuery] = useState('');
  const settledQuery = useDebouncedValue(query.trim(), 300);
  const [status, setStatus] = useState('all');
  const [folder, setFolder] = useState('all');
  const [recommended, setRecommended] = useState('all');
  const folders = useKnowledgeFolders(baseId);
  const faqs = useKnowledgeFaqs(baseId, {
    ...(settledQuery === '' ? {} : { q: settledQuery }),
    ...(status === 'all' ? {} : { status }),
    ...(folder === 'all' ? {} : { folderId: folder }),
    ...(recommended === 'all' ? {} : { isRecommended: recommended === 'true' }),
  });
  useDrainPages(faqs);
  const items = faqs.data?.pages.flatMap((page) => page.items) ?? [];
  const publish = usePublishKnowledgeFaq(baseId);
  const setStatusMutation = useSetKnowledgeFaqStatus(baseId);
  const remove = useDeleteKnowledgeFaq(baseId);
  const exporter = useExportKnowledgeFaqs();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<KnowledgeFaqSummary | null>(null);
  const [publishing, setPublishing] = useState<KnowledgeFaqSummary | null>(null);
  const [historying, setHistorying] = useState<KnowledgeFaqSummary | null>(null);
  const [exportVersion, setExportVersion] = useState<'published' | 'draft'>('published');
  const batch = useBatchKnowledgeFaqs(baseId);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const pending =
    publish.isPending || setStatusMutation.isPending || exporter.isPending || batch.isPending;

  const toggleSelected = (id: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectedItems = items.filter((item) => selectedIds.has(item.id));
  // 筛选变化后已不在当前列表的 FAQ 不再参与批量操作。
  useEffect(() => {
    setSelectedIds((current) => {
      const visible = new Set(items.map((item) => item.id));
      const next = new Set([...current].filter((id) => visible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const reportBatch = (results: KnowledgeFaqBatchResult['results'], successText: string): void => {
    const failed = results.filter((item) => item.status === 'failed');
    if (failed.length === 0) {
      setSelectedIds(new Set());
      toastSuccess(successText);
      return;
    }
    toastError(`${failed.length} 条失败：${failed[0]?.message ?? failed[0]?.code ?? '未知原因'}`);
  };

  // 服务端普通批量操作上限 100 条；按顺序切片，任一批失败都不算整体成功。
  const runBatch = async (
    action: 'enable' | 'disable' | 'delete',
    successText: string,
  ): Promise<void> => {
    if (selectedItems.length === 0) return;
    const targets = selectedItems.map((item) => ({ documentId: item.id }));
    const results: KnowledgeFaqBatchResult['results'] = [];
    for (let index = 0; index < targets.length; index += FAQ_BATCH_LIMIT) {
      try {
        const result = await batch.mutateAsync({
          action,
          items: targets.slice(index, index + FAQ_BATCH_LIMIT),
        });
        results.push(...result.results);
      } catch (reason) {
        const failedSoFar = results.filter((item) => item.status === 'failed').length;
        toastError(
          results.length === 0
            ? reason
            : `批量操作中断：已返回 ${results.length} 条${failedSoFar > 0 ? `（失败 ${failedSoFar} 条）` : ''}，${errorMessage(reason)}`,
        );
        return;
      }
    }
    reportBatch(results, successText);
  };

  const download = (format: 'json' | 'csv'): void => {
    exporter.mutate(
      { baseId, format, version: exportVersion },
      {
        onSuccess: (blob) => {
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `faqs-${exportVersion}.${format}`;
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 0);
        },
        onError: toastError,
      },
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageToolbar>
        <div className="flex flex-wrap items-center gap-3">
          <FilterSelect
            label="按 FAQ 状态筛选"
            value={status}
            onValueChange={setStatus}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'ready', label: '可召回' },
              { value: 'pending', label: '未发布草稿' },
              { value: 'disabled', label: '已停用' },
            ]}
            className="w-36"
          />
          <FilterSelect
            label="按推荐筛选"
            value={recommended}
            onValueChange={setRecommended}
            options={[
              { value: 'all', label: '全部推荐状态' },
              { value: 'true', label: '推荐' },
              { value: 'false', label: '不推荐' },
            ]}
            className="w-36"
          />
          {folders.data && folders.data.length > 0 ? (
            <Select
              value={folder}
              onValueChange={(next) => {
                if (next !== null) setFolder(next);
              }}
              items={[
                { value: 'all', label: '全部目录' },
                ...treeFolders(folders.data).map((item) => ({
                  value: item.id,
                  label: `${'　'.repeat(item.depth)}${item.label}`,
                })),
              ]}
            >
              <SelectTrigger aria-label="按 FAQ 目录筛选" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">全部目录</SelectItem>
                  {treeFolders(folders.data).map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {`${'　'.repeat(item.depth)}${item.label}`}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SearchInput
            label="搜索 FAQ"
            placeholder="搜索标准问…"
            value={query}
            onChange={setQuery}
            className="min-w-40 flex-1 sm:w-56 sm:flex-none"
          />
          <Button variant="outline" onClick={() => setImporting(true)}>
            <Upload data-icon="inline-start" aria-hidden="true" /> 导入
          </Button>
          <Select
            value={exportVersion}
            onValueChange={(next) => {
              if (next === 'published' || next === 'draft') setExportVersion(next);
            }}
            items={[
              { value: 'published', label: '已发布' },
              { value: 'draft', label: '草稿' },
            ]}
          >
            <SelectTrigger aria-label="导出 FAQ 版本" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="published">已发布</SelectItem>
                <SelectItem value="draft">草稿</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            disabled={exporter.isPending}
            aria-busy={exporter.isPending}
            onClick={() => download('json')}
          >
            <Download data-icon="inline-start" aria-hidden="true" /> JSON
          </Button>
          <Button
            variant="outline"
            disabled={exporter.isPending}
            aria-busy={exporter.isPending}
            onClick={() => download('csv')}
          >
            <Download data-icon="inline-start" aria-hidden="true" /> CSV
          </Button>
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" /> 新建 FAQ
          </Button>
        </div>
      </PageToolbar>

      {selectedItems.length > 0 ? (
        <div
          role="toolbar"
          aria-label="FAQ 批量操作"
          className="flex min-w-0 flex-wrap items-center gap-2 rounded-item bg-sunken px-3 py-2"
        >
          <span className="text-xs text-fg">已选 {selectedItems.length} 个</span>
          <Button
            variant="outline"
            size="sm"
            disabled={batch.isPending}
            onClick={() => void runBatch('enable', 'FAQ 已批量启用')}
          >
            启用
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={batch.isPending}
            onClick={() => void runBatch('disable', 'FAQ 已批量停用')}
          >
            停用
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={batch.isPending}
            onClick={() => setBatchDeleting(true)}
          >
            删除
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setSelectedIds(new Set())}
          >
            取消选择
          </Button>
        </div>
      ) : null}

      {faqs.isPending ? <LoadingState rows={4} /> : null}
      {faqs.isError ? <ErrorState error={faqs.error} onRetry={() => void faqs.refetch()} /> : null}
      {faqs.isSuccess && items.length === 0 ? (
        <EmptyState
          title={settledQuery === '' ? '还没有 FAQ' : '没有匹配的 FAQ'}
          {...(settledQuery === '' ? { description: '新建或导入 FAQ，发布后可被专家召回。' } : {})}
          action={
            settledQuery === '' ? (
              <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                新建 FAQ
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                清除搜索
              </Button>
            )
          }
        />
      ) : null}
      {items.length > 0 ? (
        <ul className="flex flex-col">
          {items.map((item) => {
            const statusValue = faqStatus(item);
            return (
              <li key={item.id} className="flex flex-col gap-1 border-b py-3 last:border-b-0">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Checkbox
                    className="self-center"
                    checked={selectedIds.has(item.id)}
                    onCheckedChange={() => toggleSelected(item.id)}
                    aria-label={`选择 ${item.faq?.question ?? item.title}`}
                  />
                  <span className="min-w-0 truncate text-sm font-medium text-fg">
                    {item.faq?.question ?? item.title}
                  </span>
                  <StatusBadge tone={faqStatusTone[statusValue]}>
                    {faqStatusLabel[statusValue]}
                  </StatusBadge>
                  {item.faq && item.faq.answers.length > 1 ? (
                    <span className="text-2xs text-muted-foreground">
                      {item.faq.answers.length} 个答案
                    </span>
                  ) : null}
                  {item.faq ? (
                    <span className="text-2xs text-muted-foreground">
                      {item.faq.answerStrategy === 'random' ? '随机一条' : '全部答案'}
                    </span>
                  ) : null}
                  {item.faq?.isRecommended ? <StatusBadge tone="outline">推荐</StatusBadge> : null}
                  {item.status === 'pending' ? null : (
                    <span className="ml-auto text-2xs text-muted-foreground">
                      {documentStatusLabel[item.status]}
                    </span>
                  )}
                </div>
                {item.faq?.answers[0] ? (
                  <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {item.faq.answers[0]}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={item.faq === null}
                    onClick={() => setEditing(item.id)}
                  >
                    <Pencil data-icon="inline-start" aria-hidden="true" /> 编辑
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setHistorying(item)}>
                    历史
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => setPublishing(item)}
                  >
                    发布草稿
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      pending || (item.disabledReason !== null && item.disabledReason !== 'manual')
                    }
                    title={
                      item.disabledReason !== null && item.disabledReason !== 'manual'
                        ? '来源失效导致的停用需先恢复来源'
                        : undefined
                    }
                    onClick={() =>
                      setStatusMutation.mutate(
                        {
                          documentId: item.id,
                          enabled: item.status === 'disabled',
                        },
                        {
                          onSuccess: () =>
                            toastSuccess(item.status === 'disabled' ? 'FAQ 已启用' : 'FAQ 已停用'),
                          onError: toastError,
                        },
                      )
                    }
                  >
                    {item.status === 'disabled' ? '启用' : '停用'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => setDeleting(item)}
                  >
                    <Trash2 data-icon="inline-start" aria-hidden="true" /> 删除
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {faqs.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={faqs.isFetchingNextPage}
          aria-busy={faqs.isFetchingNextPage}
          onClick={() => void faqs.fetchNextPage()}
        >
          {faqs.isFetchingNextPage ? '加载中…' : '加载更多 FAQ'}
        </Button>
      ) : null}

      <FaqTest baseId={baseId} />

      {creating ? (
        <FaqDialog
          baseId={baseId}
          folders={folders.data ?? []}
          initialFolderId={null}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {editing ? (
        <FaqDialog
          baseId={baseId}
          documentId={editing}
          folders={folders.data ?? []}
          initialFolderId={null}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {publishing ? (
        <FaqPublishDialog
          baseId={baseId}
          documentId={publishing.id}
          onClose={() => setPublishing(null)}
        />
      ) : null}
      {historying ? (
        <FaqHistoryDialog baseId={baseId} item={historying} onClose={() => setHistorying(null)} />
      ) : null}
      {importing ? <FaqImportDialog baseId={baseId} onClose={() => setImporting(false)} /> : null}
      {batchDeleting ? (
        <ConfirmDialog
          open
          title="批量删除 FAQ"
          description={`将删除选中的 ${selectedItems.length} 条 FAQ 及其版本与索引。此操作不可撤销。`}
          confirmLabel="删除"
          confirmDisabled={batch.isPending}
          onClose={() => setBatchDeleting(false)}
          onConfirm={async () => {
            setBatchDeleting(false);
            await runBatch('delete', 'FAQ 已批量删除');
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除 FAQ"
          description={`将删除「${deleting.faq?.question ?? deleting.title}」及其版本与索引。此操作不可撤销。`}
          confirmLabel="删除"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toastSuccess('FAQ 已删除');
          }}
        />
      ) : null}
    </div>
  );
}

/** 历史版本以版本自身的 faq 正文为准，不用当前详情兜底。 */
function FaqHistoryDialog({
  baseId,
  item,
  onClose,
}: {
  baseId: string;
  item: KnowledgeFaqSummary;
  onClose: () => void;
}) {
  const versions = useKnowledgeDocumentVersions(item.id);
  const rollback = useRollbackKnowledgeDocument(baseId);
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = versions.versions.find((version) => version.id === selectedId) ?? null;
  const blockedImport =
    selected !== null &&
    selected.metadata.faqImport !== undefined &&
    selected.metadata.publication !== 'published';
  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (rollback.isPending) {
          details.cancel();
          return;
        }
        if (!next) onClose();
      }}
    >
      <DialogShell
        title="FAQ 版本历史"
        closeDisabled={rollback.isPending}
        className="max-w-[680px] sm:max-w-[680px]"
      >
        {versions.isPending ? <LoadingState rows={3} /> : null}
        {versions.isError ? (
          <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
        ) : null}
        {versions.isSuccess ? (
          <div className="flex flex-col gap-3">
            {versions.versions.length === 0 ? (
              <EmptyState title="还没有历史版本" />
            ) : (
              <ul className="flex max-h-[50vh] flex-col overflow-auto">
                {versions.versions.map((version) => (
                  <li key={version.id} className="border-b py-2 last:border-b-0">
                    <button
                      type="button"
                      className="flex w-full flex-col gap-1 text-left"
                      aria-pressed={selectedId === version.id}
                      onClick={() => setSelectedId(version.id)}
                    >
                      <span className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium text-fg">{versionLabel(version)}</span>
                        {version.id === item.currentVersionId ? (
                          <StatusBadge tone="success">当前发布</StatusBadge>
                        ) : null}
                        <span className="ml-auto text-2xs text-muted-foreground">
                          {new Date(version.createdAt).toLocaleString('zh-CN')}
                        </span>
                      </span>
                      {version.faq ? (
                        <span className="text-sm text-fg">{version.faq.question}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">没有 FAQ 正文</span>
                      )}
                      {version.faq?.answers.map((answer) => (
                        <span
                          key={`${version.id}-${answer}`}
                          className="line-clamp-2 text-xs text-muted-foreground"
                        >
                          {answer}
                        </span>
                      ))}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {versions.versions.length === 0 ? null : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {blockedImport
                    ? '导入批次草稿需整批发布，不能逐条上线'
                    : selected === null
                      ? '选择要回退的版本'
                      : ''}
                </span>
                <div className="ml-auto flex gap-2">
                  <Button variant="outline" onClick={onClose} disabled={rollback.isPending}>
                    取消
                  </Button>
                  <Button
                    disabled={
                      selected === null ||
                      selected.id === item.currentVersionId ||
                      blockedImport ||
                      rollback.isPending
                    }
                    aria-busy={rollback.isPending}
                    onClick={() => {
                      if (!selected) return;
                      rollback.mutate(
                        {
                          documentId: item.id,
                          versionId: selected.id,
                          expectedVersionId: item.currentVersionId,
                        },
                        {
                          onSuccess: () => {
                            void client.invalidateQueries({ queryKey: knowledgeKeys.faq(item.id) });
                            void client.invalidateQueries({ queryKey: knowledgeKeys.faqs(baseId) });
                            toastSuccess('FAQ 已回退');
                            onClose();
                          },
                          onError: toastError,
                        },
                      );
                    }}
                  >
                    {rollback.isPending ? '回退中…' : '回退到所选版本'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </DialogShell>
    </Dialog>
  );
}

/** 发布前先读详情：列表不返回草稿版本，不能凭列表猜版本号。 */
function FaqPublishDialog({
  baseId,
  documentId,
  onClose,
}: {
  baseId: string;
  documentId: string;
  onClose: () => void;
}) {
  const detail = useKnowledgeFaq(documentId);
  const publish = usePublishKnowledgeFaq(baseId);
  const retry = useRetryKnowledgeJob(baseId);
  const cached = detail.data;
  const draft = cached?.draftVersion;
  // 只认这个草稿版本自己的索引任务，不能借更早版本的 succeeded。
  const draftJobId =
    draft === null || draft === undefined
      ? null
      : (readString(draft.metadata, 'indexingJobId') ??
        readString(draft.metadata, 'faqImportJobId'));
  const [retriedJobId, setRetriedJobId] = useState<string | null>(null);
  const jobId = retriedJobId ?? draftJobId;
  const jobs = useKnowledgeFaqImportJobs(jobId === null ? [] : [jobId]);
  const jobStatus = jobId === null ? undefined : jobs[0]?.data?.status;
  const importDraft =
    draft != null &&
    draft.metadata.faqImport !== undefined &&
    draft.metadata.publication !== 'published';
  const indexSucceeded = draftJobId === null || jobStatus === 'succeeded';
  const indexFailed = jobStatus === 'failed' || jobStatus === 'cancelled';
  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (publish.isPending) {
          details.cancel();
          return;
        }
        if (!next) onClose();
      }}
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
            ) : draft && draftJobId !== null && jobStatus === undefined ? (
              <p className="text-xs text-muted-foreground">等待本次索引任务完成…</p>
            ) : indexFailed ? (
              <p className="text-xs text-danger">本次索引失败，重试后再发布。</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={publish.isPending}>
                取消
              </Button>
              {indexFailed && jobId !== null ? (
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
