import { useEffect, useState } from 'react';
import type {
  KnowledgeBatchInput,
  KnowledgeBatchResult,
  KnowledgeDocumentVersion,
  KnowledgeFolder,
  KnowledgeManualDraft,
} from '../lib/api.js';
import { errorMessage } from '../lib/api.js';
import { knowledgeJobErrorText } from '../lib/knowledge-errors.js';
import {
  useBatchKnowledgeDocuments,
  useKnowledgeDocumentJob,
  useKnowledgeDocumentManual,
  useSaveKnowledgeDocumentManual,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { DialogShell } from './dialog-shell.js';
import {
  DraftGuardDialogs,
  isTerminalJobStatus,
  treeFolders,
  useDraftGuard,
  versionLabel,
} from './knowledge-shared.js';
import { SourceEditor } from './source-editor.js';
import { ErrorState, LoadingState } from './states.js';
import { StatusBadge } from './status-badge.js';
import { Button } from './ui/button.js';
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

const batchActionLabel = {
  move: '移动',
  copy: '复制',
  tag: '标签',
  delete: '删除',
  reprocess: '重新解析',
} as const;

type BatchAction = keyof typeof batchActionLabel;

/** 批量结果逐项展示；部分成功不会被包装成全部成功。 */
function BatchResults({
  results,
  titles,
  onClose,
}: {
  results: KnowledgeBatchResult[];
  titles: Record<string, string>;
  onClose: () => void;
}) {
  const succeeded = results.filter((result) => result.status === 'succeeded').length;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        成功 {succeeded} 项 · 失败 {results.length - succeeded} 项
      </p>
      <ul className="flex max-h-72 flex-col overflow-y-auto">
        {results.map((result) => (
          <li
            key={result.documentId}
            className="flex flex-col gap-1 border-b border-line py-2 text-xs last:border-b-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={result.status === 'succeeded' ? 'success' : 'danger'}>
                {result.status === 'succeeded' ? '成功' : '失败'}
              </StatusBadge>
              <span className="min-w-0 truncate text-fg">
                {titles[result.documentId] ?? result.documentId}
              </span>
              {result.newDocumentId ? (
                <span className="font-mono text-2xs text-muted-foreground">
                  新文档 {result.newDocumentId}
                </span>
              ) : null}
              {result.jobId ? (
                <span className="font-mono text-2xs text-muted-foreground">
                  任务 {result.jobId}
                </span>
              ) : null}
            </div>
            {result.code || result.message ? (
              <span className="text-2xs text-danger">
                {[result.code, result.message].filter(Boolean).join(': ')}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button onClick={onClose}>完成</Button>
      </div>
    </div>
  );
}

/**
 * 批量操作一次只提交一个 action；移动/复制选择目标目录，标签选择模式与本批标签。
 * 每个文档由后端单独事务处理，UI 原样展示逐项结果。
 */
export function BatchActionDialog({
  baseId,
  action,
  documentIds,
  titles,
  folders,
  onClose,
}: {
  baseId: string;
  action: BatchAction;
  documentIds: string[];
  titles: Record<string, string>;
  folders: KnowledgeFolder[];
  onClose: () => void;
}) {
  const batch = useBatchKnowledgeDocuments(baseId);
  const [selection] = useState(() => ({ ids: [...documentIds], titles: { ...titles } }));
  const guard = useDraftGuard(false, batch.isPending, onClose);
  const [targetFolder, setTargetFolder] = useState('null');
  const [tagMode, setTagMode] = useState<NonNullable<KnowledgeBatchInput['tagMode']>>('add');
  const [tags, setTags] = useState('');
  const [results, setResults] = useState<KnowledgeBatchResult[] | null>(null);
  const folderOptions = [
    { value: 'null', label: '未分类' },
    ...treeFolders(folders).map((folder) => ({
      value: folder.id,
      label: `${'　'.repeat(folder.depth)}${folder.label}`,
    })),
  ];
  const tagList = tags
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = action === 'tag' && tagList.length === 0;

  const submit = (): void => {
    const input: KnowledgeBatchInput = {
      documentIds: selection.ids,
      action,
      ...(action === 'move' || action === 'copy'
        ? { folderId: targetFolder === 'null' ? null : targetFolder }
        : {}),
      ...(action === 'tag' ? { tags: tagList, tagMode } : {}),
      ...(action === 'reprocess' ? { confirmOverwriteManualChunks: true } : {}),
    };
    batch.mutate(input, {
      onSuccess: (data) => {
        setResults(data.results);
        const failed = data.results.filter((result) => result.status === 'failed').length;
        if (failed === 0)
          toastSuccess(`已${batchActionLabel[action]} ${data.results.length} 个文档`);
        else toastError(new Error(`${failed} 个文档没有完成，请查看逐项结果`));
      },
      onError: (error) => toastError(error),
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (batch.isPending) details.cancel();
        else if (!next) guard.close();
      }}
    >
      <DialogShell
        title={`批量${batchActionLabel[action]}`}
        description={`将处理选中的 ${selection.ids.length} 个文档。`}
        closeDisabled={batch.isPending}
      >
        {results === null ? (
          <div className="flex flex-col gap-4">
            {action === 'move' || action === 'copy' ? (
              <Field className="gap-1.5">
                <FieldLabel htmlFor="knowledge-batch-folder">目标文件夹</FieldLabel>
                <Select
                  value={targetFolder}
                  disabled={batch.isPending}
                  onValueChange={(next) => {
                    if (next !== null) setTargetFolder(next);
                  }}
                  items={folderOptions}
                >
                  <SelectTrigger id="knowledge-batch-folder" className="w-full">
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
            ) : null}
            {action === 'copy' ? (
              <p className="text-xs text-muted-foreground">
                复制会创建独立文档并保留内容与标签，不继承来源授权或同步身份。
              </p>
            ) : null}
            {action === 'tag' ? (
              <FieldGroup className="grid gap-3 sm:grid-cols-2">
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="knowledge-batch-tag-mode">方式</FieldLabel>
                  <Select
                    value={tagMode}
                    disabled={batch.isPending}
                    onValueChange={(next) => {
                      if (next === 'add' || next === 'remove' || next === 'replace') {
                        setTagMode(next);
                      }
                    }}
                    items={[
                      { value: 'add', label: '添加' },
                      { value: 'remove', label: '移除' },
                      { value: 'replace', label: '替换为' },
                    ]}
                  >
                    <SelectTrigger id="knowledge-batch-tag-mode" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="add">添加</SelectItem>
                        <SelectItem value="remove">移除</SelectItem>
                        <SelectItem value="replace">替换为</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field className="gap-1.5" data-invalid={invalid}>
                  <FieldLabel htmlFor="knowledge-batch-tags">标签</FieldLabel>
                  <Input
                    id="knowledge-batch-tags"
                    value={tags}
                    disabled={batch.isPending}
                    onChange={(event) => setTags(event.target.value)}
                    placeholder="以逗号分隔"
                  />
                </Field>
              </FieldGroup>
            ) : null}
            {action === 'delete' ? (
              <p className="text-xs text-fg">
                将删除选中文档及其分块；引用它们的 Wiki 页面会标记为待刷新。此操作不可撤销。
              </p>
            ) : null}
            {action === 'reprocess' ? (
              <p className="text-xs text-fg">
                将重新解析选中文档并生成新版本；人工编辑过的分块会被丢弃。
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={guard.close} disabled={batch.isPending}>
                取消
              </Button>
              <Button
                variant={action === 'delete' ? 'destructive' : 'default'}
                onClick={submit}
                disabled={batch.isPending || invalid || selection.ids.length === 0}
                aria-busy={batch.isPending}
              >
                {batch.isPending ? '处理中…' : batchActionLabel[action]}
              </Button>
            </div>
            <FieldError>{invalid ? '至少填写一个标签' : null}</FieldError>
          </div>
        ) : (
          <BatchResults results={results} titles={selection.titles} onClose={guard.finish} />
        )}
        <DraftGuardDialogs guard={guard} draft="" pending={batch.isPending} />
      </DialogShell>
    </Dialog>
  );
}

export function DocumentVersionPicker({
  versions,
  selectedVersionId,
  onSelect,
}: {
  versions: KnowledgeDocumentVersion[];
  selectedVersionId: string | null;
  onSelect: (versionId: string) => void;
}) {
  if (versions.length === 0) return null;
  return (
    <Select
      value={selectedVersionId ?? versions[0]?.id ?? ''}
      onValueChange={(next) => {
        if (next !== null) onSelect(next);
      }}
      items={versions.map((version) => ({
        value: version.id,
        label: `${versionLabel(version)}${version.isCurrent ? ' · 当前' : ''}`,
      }))}
    >
      <SelectTrigger aria-label="选择文档版本" className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {versions.map((version) => (
            <SelectItem key={version.id} value={version.id}>
              {versionLabel(version)}
              {version.isCurrent ? ' · 当前' : ''}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function manualStatusLabel(draft: KnowledgeManualDraft): string {
  return draft.status === 'draft' ? '未发布草稿' : '已发布版本';
}

/**
 * 手写正文显式草稿：保存只写新草稿版本，发布仍在版本列表里单独确认。
 * 保存失败保留输入；关闭与路由离开由统一 dirty/pending 守卫处理。
 */
export function ManualDraftDialog({
  baseId,
  documentId,
  title,
  onClose,
}: {
  baseId: string;
  documentId: string;
  title: string;
  onClose: () => void;
}) {
  const manual = useKnowledgeDocumentManual(documentId);
  const save = useSaveKnowledgeDocumentManual(baseId);
  const [content, setContent] = useState('');
  const [initial, setInitial] = useState<KnowledgeManualDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useKnowledgeDocumentJob(baseId, documentId, jobId);
  const pending = save.isPending || (jobId !== null && !isTerminalJobStatus(job.data?.status));
  const draft = manual.data;
  const dirty = initial !== null && content !== initial.content;
  const guard = useDraftGuard(dirty, pending, onClose);

  useEffect(() => {
    if (initial === null && draft !== undefined) {
      setContent(draft.content);
      setInitial(draft);
    }
  }, [draft, initial]);
  useEffect(() => {
    if (!jobId || !isTerminalJobStatus(job.data?.status)) return;
    if (job.data?.status === 'succeeded') {
      setJobId(null);
      toastSuccess('草稿已解析，可在版本列表发布');
      guard.finish();
    } else {
      setError(job.data?.error ? knowledgeJobErrorText(job.data.error) : '正文解析未完成，请重试');
      setJobId(null);
    }
  }, [jobId, job.data, guard.finish]);

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
      <DialogShell title={`编辑正文 · ${title}`} closeDisabled={pending}>
        {manual.isPending ? <LoadingState rows={4} /> : null}
        {manual.isError ? (
          <ErrorState error={manual.error} onRetry={() => void manual.refetch()} />
        ) : null}
        {draft ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              if (content.trim() === '') return;
              save.mutate(
                {
                  documentId,
                  content,
                  expectedVersionId: initial?.versionId ?? null,
                },
                {
                  onSuccess: (data) => setJobId(data.jobId),
                  onError: (reason) => setError(errorMessage(reason)),
                },
              );
            }}
          >
            <p className="text-xs text-muted-foreground">{manualStatusLabel(draft)}</p>
            <Field className="gap-1.5" data-invalid={error !== null}>
              <FieldLabel htmlFor="knowledge-manual-draft">正文（Markdown）</FieldLabel>
              <SourceEditor
                id="knowledge-manual-draft"
                aria-label="正文（Markdown）"
                value={content}
                onChange={setContent}
                language="markdown"
                disabled={pending}
                className="min-h-56"
              />
              <FieldError>{error}</FieldError>
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={guard.close} disabled={pending}>
                取消
              </Button>
              <Button type="submit" disabled={pending || content.trim() === ''} aria-busy={pending}>
                {jobId !== null ? '解析中…' : pending ? '保存中…' : '保存草稿'}
              </Button>
            </div>
          </form>
        ) : null}
        {jobId !== null && job.isError ? (
          <ErrorState error={job.error} onRetry={() => void job.refetch()} />
        ) : null}
        <DraftGuardDialogs guard={guard} draft="正文草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
