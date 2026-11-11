import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { DialogShell } from '../../components/dialog-shell.js';
import {
  DraftGuardDialogs,
  treeFolders,
  useDraftGuard,
} from '../../components/knowledge/knowledge-shared.js';
import { RequiredMark } from '../../components/required-mark.js';
import { SourceEditor } from '../../components/source-editor.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import type { KnowledgeFolder } from '../../lib/api.js';
import { useCreateKnowledgeManualDocument, useImportKnowledgeUrl } from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';

/** 手写正文 / 网址导入共用文件夹选择；默认落在当前浏览的文件夹。 */
function ImportFolderField({
  id,
  value,
  folders,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  folders: KnowledgeFolder[];
  disabled: boolean;
  onChange: (folderId: string) => void;
}) {
  const options = [
    { value: 'null', label: '未分类' },
    ...treeFolders(folders).map((folder) => ({
      value: folder.id,
      label: `${'　'.repeat(folder.depth)}${folder.label}`,
    })),
  ];
  return (
    <Field className="gap-1.5">
      <FieldLabel htmlFor={id}>文件夹</FieldLabel>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
        items={options}
      >
        <SelectTrigger id={id} className="w-full">
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
  );
}

const manualDocumentFormSchema = z.object({
  title: z.string(),
  content: z.string(),
  tags: z.string(),
  target: z.string(),
});
type ManualDocumentFormValues = z.infer<typeof manualDocumentFormSchema>;

export function ManualDocumentDialog({
  baseId,
  folderId,
  folders,
  onClose,
}: {
  baseId: string;
  folderId: string | null;
  folders: KnowledgeFolder[];
  onClose: () => void;
}) {
  const create = useCreateKnowledgeManualDocument(baseId);
  const initialTarget = folderId ?? 'null';
  const pending = create.isPending;
  const { register, control, handleSubmit, watch, formState } = useZodForm(
    manualDocumentFormSchema,
    {
      defaultValues: { title: '', content: '', tags: '', target: initialTarget },
    },
  );
  const { isDirty } = formState;
  const invalid = watch('title').trim() === '' || watch('content').trim() === '';
  const dirty = isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);
  const submit = handleSubmit((values: ManualDocumentFormValues) => {
    create.mutate(
      {
        title: values.title.trim(),
        content: values.content,
        folderId: values.target === 'null' ? null : values.target,
        tags: values.tags
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      },
      {
        onSuccess: () => {
          toastSuccess('已创建手写文档，正在解析');
          guard.finish();
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
        if (!next) guard.close();
      }}
    >
      <DialogShell title="手写文档" closeDisabled={pending}>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <FieldGroup>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="knowledge-manual-title">
                标题 <RequiredMark />
              </FieldLabel>
              <Input
                id="knowledge-manual-title"
                {...register('title')}
                maxLength={300}
                disabled={pending}
              />
            </Field>
            <Controller
              control={control}
              name="target"
              render={({ field }) => (
                <ImportFolderField
                  id="knowledge-manual-folder"
                  value={field.value}
                  folders={folders}
                  disabled={pending}
                  onChange={field.onChange}
                />
              )}
            />
            <Field className="gap-1.5">
              <FieldLabel htmlFor="knowledge-manual-tags">标签</FieldLabel>
              <Input
                id="knowledge-manual-tags"
                {...register('tags')}
                disabled={pending}
                placeholder="以逗号分隔"
              />
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="knowledge-manual-content">
                正文（Markdown） <RequiredMark />
              </FieldLabel>
              <Controller
                control={control}
                name="content"
                render={({ field }) => (
                  <SourceEditor
                    id="knowledge-manual-content"
                    aria-label="正文（Markdown）"
                    value={field.value}
                    onChange={field.onChange}
                    language="markdown"
                    disabled={pending}
                    className="min-h-48"
                  />
                )}
              />
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending || invalid} aria-busy={pending}>
              {pending ? '导入中…' : '导入'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="手写文档草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

const urlImportFormSchema = z.object({
  url: z.string(),
  target: z.string(),
});
type UrlImportFormValues = z.infer<typeof urlImportFormSchema>;

export function UrlImportDialog({
  baseId,
  folderId,
  folders,
  onClose,
}: {
  baseId: string;
  folderId: string | null;
  folders: KnowledgeFolder[];
  onClose: () => void;
}) {
  const create = useImportKnowledgeUrl(baseId);
  const initialTarget = folderId ?? 'null';
  const pending = create.isPending;
  const { register, control, handleSubmit, watch, formState } = useZodForm(urlImportFormSchema, {
    defaultValues: { url: '', target: initialTarget },
  });
  const { isDirty } = formState;
  const urlValue = watch('url');
  // 后端 httpUrlSchema 只收 http(s)；这里只做按钮可用性判断，最终由入口校验。
  const validUrl = /^https?:\/\/\S+$/i.test(urlValue.trim());
  const invalidUrl = urlValue.trim() !== '' && !validUrl;
  const dirty = isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);
  const submit = handleSubmit((values: UrlImportFormValues) => {
    create.mutate(
      {
        url: values.url.trim(),
        folderId: values.target === 'null' ? null : values.target,
      },
      {
        onSuccess: () => {
          toastSuccess('已提交抓取任务');
          guard.finish();
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
        if (!next) guard.close();
      }}
    >
      <DialogShell title="导入网址" closeDisabled={pending}>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <FieldGroup>
            <Field className="gap-1.5" data-invalid={invalidUrl}>
              <FieldLabel htmlFor="knowledge-url">
                网址 <RequiredMark />
              </FieldLabel>
              <Input
                id="knowledge-url"
                type="url"
                {...register('url')}
                disabled={pending}
                placeholder="https://example.com/doc"
                aria-invalid={invalidUrl}
                aria-describedby={invalidUrl ? 'knowledge-url-error' : 'knowledge-url-hint'}
              />
              {invalidUrl ? (
                <FieldError id="knowledge-url-error">
                  请填写以 http:// 或 https:// 开头的完整地址
                </FieldError>
              ) : (
                <FieldDescription id="knowledge-url-hint">
                  支持网页、PDF 与纯文本类文件，最大 32 MB。
                </FieldDescription>
              )}
            </Field>
            <Controller
              control={control}
              name="target"
              render={({ field }) => (
                <ImportFolderField
                  id="knowledge-url-folder"
                  value={field.value}
                  folders={folders}
                  disabled={pending}
                  onChange={field.onChange}
                />
              )}
            />
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending || !validUrl} aria-busy={pending}>
              {pending ? '导入中…' : '导入'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="网址导入草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
