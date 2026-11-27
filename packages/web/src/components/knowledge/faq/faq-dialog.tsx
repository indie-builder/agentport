import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { KnowledgeFaq, KnowledgeFaqDetail, KnowledgeFolder } from '../../../lib/api.js';
import { errorMessage } from '../../../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../../../lib/dialog-guard.js';
import {
  useCreateKnowledgeFaq,
  useKnowledgeFaq,
  useUpdateKnowledgeFaq,
} from '../../../lib/queries.js';
import { toastSuccess } from '../../../lib/toast.js';
import { useZodForm } from '../../../lib/use-zod-form.js';
import { DialogShell } from '../../dialog-shell.js';
import { RequiredMark } from '../../required-mark.js';
import { ErrorState, LoadingState } from '../../states.js';
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
import { Switch } from '../../ui/switch.js';
import { Textarea } from '../../ui/textarea.js';
import { DraftGuardDialogs, folderOptions, useDraftGuard } from '../knowledge-shared.js';
import {
  type FaqForm,
  faqFormSchema,
  indexedErrorMessage,
  rootErrorMessage,
  splitQuestions,
} from './faq-shared.js';

export function FaqDialog({
  baseId,
  documentId,
  folders,
  initialFolderId,
  onClose: onClosed,
}: {
  baseId: string;
  documentId?: string;
  folders: KnowledgeFolder[];
  initialFolderId: string | null;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const detail = useKnowledgeFaq(documentId ?? null);
  if (documentId === undefined) {
    return (
      <FaqEditorForm
        baseId={baseId}
        folders={folders}
        initialFolderId={initialFolderId}
        dialog={dialog}
      />
    );
  }
  if (detail.data === undefined) {
    if (detail.isPending) {
      return (
        <Dialog
          open={dialog.open}
          onOpenChangeComplete={dialog.onOpenChangeComplete}
          onOpenChange={(next) => (next ? undefined : onClose())}
        >
          <DialogShell title="编辑 FAQ">
            <LoadingState rows={4} />
          </DialogShell>
        </Dialog>
      );
    }
    return (
      <Dialog
        open={dialog.open}
        onOpenChangeComplete={dialog.onOpenChangeComplete}
        onOpenChange={(next) => (next ? undefined : onClose())}
      >
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
      dialog={dialog}
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
  dialog,
}: {
  baseId: string;
  detail?: KnowledgeFaqDetail;
  detailError?: unknown;
  onRetryDetail?: () => void;
  folders: KnowledgeFolder[];
  initialFolderId: string | null;
  dialog: ReturnType<typeof useDialogClose>;
}) {
  const onClose = dialog.close;
  const create = useCreateKnowledgeFaq(baseId);
  const update = useUpdateKnowledgeFaq(baseId);
  const pending = create.isPending || update.isPending;
  const [error, setError] = useState<string | null>(null);
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
  const options = folderOptions(folders);
  const expectedVersionId = initialDetail?.draftVersion?.id ?? initialDetail?.publishedVersion?.id;
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
      if (expectedVersionId === undefined) {
        setError('当前 FAQ 没有可编辑的版本，请刷新后重试。');
        return;
      }
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
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell
        title={initialDetail ? '编辑 FAQ' : '新建 FAQ'}
        closeDisabled={pending}
        className="max-w-190 sm:max-w-190"
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
                items={options}
              >
                <SelectTrigger id="faq-folder" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {options.map((option) => (
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
              <span className="text-sm text-muted-foreground">
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
