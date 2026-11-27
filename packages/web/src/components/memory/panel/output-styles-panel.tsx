import { type OutputStyle, outputStyleInputSchema } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { cn } from '../../../lib/cn.js';
import { applyProblemToForm, withFieldMessages } from '../../../lib/form.js';
import {
  agentOutputStylesQuery,
  useDeleteAgentOutputStyle,
  useUnselectAgentOutputStyle,
  useWriteAgentOutputStyle,
} from '../../../lib/queries.js';
import { toastError, toastSuccess } from '../../../lib/toast.js';
import { useEditStateNotify } from '../../../lib/use-edit-state-notify.js';
import { useZodForm } from '../../../lib/use-zod-form.js';
import { ConfirmDialog } from '../../confirm-dialog.js';
import { SourceEditor } from '../../source-editor.js';
import { EmptyState, ErrorState, LoadingState } from '../../states.js';
import { Button } from '../../ui/button.js';
import { Checkbox } from '../../ui/checkbox.js';
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
import { type DraftCallbacks, useSwitchGuard } from './shared.js';

const styleShape = outputStyleInputSchema.shape;

const outputStyleFormSchema = z.object({
  slug: withFieldMessages(z.string().trim(), styleShape.slug, {
    tooSmall: '请填写风格 slug',
    tooBig: '最多 64 个字符，请精简后再保存',
  }),
  description: withFieldMessages(z.string(), styleShape.description.unwrap(), {
    tooBig: '最多 500 个字符，请精简后再保存',
  }),
  keepCodingInstructions: styleShape.keepCodingInstructions.unwrap(),
  body: withFieldMessages(z.string(), styleShape.body.unwrap(), {
    tooBig: '最多 50000 个字符，请精简后再保存',
  }),
});

type OutputStyleFormValues = z.infer<typeof outputStyleFormSchema>;

const EMPTY_STYLE_VALUES: OutputStyleFormValues = {
  slug: '',
  description: '',
  keepCodingInstructions: false,
  body: '',
};

function styleValues(style: OutputStyle): OutputStyleFormValues {
  return {
    slug: style.slug,
    description: style.description,
    keepCodingInstructions: style.keepCodingInstructions,
    body: style.body,
  };
}

type StyleAction =
  | { type: 'open'; style: OutputStyle }
  | { type: 'create' }
  | { type: 'delete'; slug: string };

export function OutputStylesPanel({
  agentId,
  canWrite = true,
  onDirtyChange,
  onPendingChange,
}: { agentId: string; canWrite?: boolean } & DraftCallbacks) {
  const styles = useQuery(agentOutputStylesQuery(agentId));
  const [selected, setSelected] = useState<string | null>(null);
  const autoSelected = useRef(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const form = useZodForm(outputStyleFormSchema, { defaultValues: EMPTY_STYLE_VALUES });
  const { register, control, handleSubmit, reset, formState } = form;
  const { errors, isDirty: dirty } = formState;

  const save = useWriteAgentOutputStyle(agentId);
  const unselect = useUnselectAgentOutputStyle(agentId);
  const remove = useDeleteAgentOutputStyle(agentId);
  const pending = save.isPending || unselect.isPending || remove.isPending;
  const disabled = pending || !canWrite;
  const current = styles.data?.find((style) => style.slug === selected) ?? null;

  const open = (style: OutputStyle): void => {
    setSelected(style.slug);
    setCreating(false);
    reset(styleValues(style));
  };

  const startCreate = (): void => {
    setCreating(true);
    setSelected(null);
    reset(EMPTY_STYLE_VALUES);
  };

  const switchGuard = useSwitchGuard<StyleAction>(dirty, pending, (action) => {
    if (action.type === 'open') {
      open(action.style);
      return;
    }
    if (!canWrite) return;
    if (action.type === 'create') startCreate();
    else setDeleting(action.slug);
  });

  const guard = (action: StyleAction): void => {
    if (action.type !== 'open' && !canWrite) return;
    switchGuard.request(action);
  };

  useEditStateNotify(dirty, pending, onDirtyChange, onPendingChange);

  useEffect(() => {
    if (autoSelected.current || styles.data === undefined) return;
    autoSelected.current = true;
    if (selected !== null || creating) return;
    const first = styles.data[0];
    if (!first) return;
    setSelected(first.slug);
    reset(styleValues(first));
  }, [styles.data, selected, creating, reset]);

  const onSubmit = handleSubmit(
    async (values) => {
      if (disabled) return;
      const target = creating ? values.slug : selected;
      if (!target) return;
      try {
        const style = await save.mutateAsync({
          slug: target,
          description: values.description,
          keepCodingInstructions: values.keepCodingInstructions,
          body: values.body,
        });
        setSelected(style.slug);
        setCreating(false);
        reset(styleValues(style));
        toastSuccess('输出风格已保存');
      } catch (error) {
        if (!applyProblemToForm(form, error)) toastError(error);
      }
    },
    (invalidErrors) => {
      if (!invalidErrors.slug && !invalidErrors.description && invalidErrors.body) {
        document.getElementById('output-style-body')?.focus();
      }
    },
  );

  if (styles.isPending) return <LoadingState rows={2} />;
  if (styles.data === undefined) {
    return <ErrorState error={styles.error} onRetry={() => void styles.refetch()} />;
  }

  const confirming = switchGuard.pendingAction;

  return (
    <div className="grid min-w-0 items-start gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-2">
        <Button variant="outline" disabled={disabled} onClick={() => guard({ type: 'create' })}>
          <Plus data-icon="inline-start" /> 新建风格
        </Button>
        <ul className="hidden flex-col gap-0.5 md:flex">
          {styles.data.map((style) => (
            <li key={style.id} className="min-w-0 max-w-full">
              <button
                type="button"
                disabled={pending}
                onClick={() => guard({ type: 'open', style })}
                className={cn(
                  'flex w-full max-w-full items-center gap-1.5 truncate rounded-item px-2 py-1.5 text-left text-sm transition-colors duration-150 ease-out-soft',
                  selected === style.slug
                    ? 'bg-selected text-selected-foreground'
                    : 'hover:bg-hover',
                )}
              >
                <span className="truncate">{style.slug}</span>
                {style.isSelected ? (
                  <span className="ml-auto shrink-0 text-2xs text-muted-foreground">已启用</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        <Select
          value={selected}
          disabled={pending}
          items={styles.data.map((style) => ({ value: style.slug, label: style.slug }))}
          onValueChange={(next) => {
            const style = styles.data.find((item) => item.slug === next);
            if (style) guard({ type: 'open', style });
          }}
        >
          <SelectTrigger className="w-full min-w-0 md:hidden" aria-label="输出风格">
            <SelectValue className="truncate" placeholder="选择输出风格" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {styles.data.map((style) => (
                <SelectItem key={style.id} value={style.slug}>
                  {style.slug}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        {styles.isError ? (
          <ErrorState error={styles.error} onRetry={() => void styles.refetch()} />
        ) : null}
        {creating || current ? (
          <form className="flex min-w-0 flex-col gap-3" noValidate onSubmit={onSubmit}>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate font-mono text-md font-semibold text-fg">
                {creating ? '新建风格' : current?.slug}
              </h2>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {current?.isSelected ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      unselect.mutate(current.slug, {
                        onSuccess: () => toastSuccess('已取消启用'),
                        onError: (error) => toastError(error),
                      })
                    }
                    disabled={disabled}
                  >
                    取消启用
                  </Button>
                ) : null}
                {current ? (
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    aria-label={`删除风格 ${current.slug}`}
                    title={`删除风格 ${current.slug}`}
                    disabled={disabled}
                    onClick={() => guard({ type: 'delete', slug: current.slug })}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                ) : null}
                <Button type="submit" disabled={disabled || !dirty} aria-busy={save.isPending}>
                  {save.isPending ? '保存中…' : '风格保存'}
                </Button>
              </div>
            </div>
            <FieldGroup>
              <Field
                className="gap-1.5"
                data-disabled={!creating || disabled}
                data-invalid={Boolean(errors.slug)}
              >
                <FieldLabel htmlFor="output-style-slug">风格 slug</FieldLabel>
                <Input
                  {...register('slug')}
                  id="output-style-slug"
                  placeholder="风格 slug，如 concise"
                  className="font-mono"
                  disabled={!creating || disabled}
                  aria-invalid={Boolean(errors.slug)}
                  aria-describedby={errors.slug ? 'output-style-slug-error' : undefined}
                />
                <FieldError id="output-style-slug-error">{errors.slug?.message}</FieldError>
              </Field>
              <Field
                className="gap-1.5"
                data-disabled={disabled}
                data-invalid={Boolean(errors.description)}
              >
                <FieldLabel htmlFor="output-style-description">风格描述</FieldLabel>
                <Input
                  {...register('description')}
                  id="output-style-description"
                  placeholder="描述"
                  disabled={disabled}
                  aria-invalid={Boolean(errors.description)}
                  aria-describedby={
                    errors.description ? 'output-style-description-error' : undefined
                  }
                />
                <FieldError id="output-style-description-error">
                  {errors.description?.message}
                </FieldError>
              </Field>
              <Field orientation="horizontal" data-disabled={disabled}>
                <Controller
                  control={control}
                  name="keepCodingInstructions"
                  render={({ field }) => (
                    <Checkbox
                      id="output-style-keep-coding"
                      checked={field.value}
                      disabled={disabled}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
                <FieldLabel htmlFor="output-style-keep-coding">保留编码指令</FieldLabel>
              </Field>
              <Field
                className="gap-1.5"
                data-disabled={disabled}
                data-invalid={Boolean(errors.body)}
              >
                <FieldLabel htmlFor="output-style-body">风格内容</FieldLabel>
                <Controller
                  control={control}
                  name="body"
                  render={({ field }) => (
                    <SourceEditor
                      id="output-style-body"
                      value={field.value}
                      language="markdown"
                      aria-label="风格内容"
                      aria-invalid={Boolean(errors.body)}
                      aria-describedby={errors.body ? 'output-style-body-error' : undefined}
                      disabled={disabled}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      className="min-h-64"
                    />
                  )}
                />
                <FieldError id="output-style-body-error">{errors.body?.message}</FieldError>
              </Field>
            </FieldGroup>
          </form>
        ) : (
          <EmptyState
            variant="idle"
            scale="panel"
            icon={<Sparkles className="size-5" aria-hidden="true" />}
            title="选择左侧风格查看或编辑"
            description="启用后会替换专家默认的输出风格。"
            action={
              canWrite ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => guard({ type: 'create' })}
                >
                  <Plus data-icon="inline-start" aria-hidden="true" /> 新建风格
                </Button>
              ) : undefined
            }
          />
        )}
      </div>

      <ConfirmDialog
        open={confirming !== null}
        onClose={switchGuard.cancel}
        title={confirming?.type === 'delete' ? '放弃修改并删除？' : '放弃未保存的修改？'}
        description={
          confirming?.type === 'delete'
            ? `「${current?.slug ?? ''}」还有未保存的内容，继续会放弃这些修改，并进入删除确认。`
            : `「${current?.slug ?? '新建风格'}」还有未保存的内容，继续后会丢失。`
        }
        confirmLabel="放弃并继续"
        confirmDisabled={disabled}
        onConfirm={async () => {
          if (!canWrite) return;
          await switchGuard.confirm();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => {
          if (pending) return;
          setDeleting(null);
        }}
        title="删除输出风格"
        description={`将删除「${deleting ?? ''}」，此操作不可撤销。`}
        confirmDisabled={disabled}
        onConfirm={async () => {
          if (!canWrite || !deleting) return;
          await remove.mutateAsync(deleting);
          toastSuccess('输出风格已删除');
          setSelected(null);
          setCreating(false);
          reset(EMPTY_STYLE_VALUES);
        }}
      />
    </div>
  );
}
