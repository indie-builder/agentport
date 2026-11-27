import { ruleInputSchema } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { FileText, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { cn } from '../../../lib/cn.js';
import { applyProblemToForm, withFieldMessages } from '../../../lib/form.js';
import { agentRulesQuery, useDeleteAgentRule, useWriteAgentRule } from '../../../lib/queries.js';
import { toastError, toastSuccess } from '../../../lib/toast.js';
import { useEditStateNotify } from '../../../lib/use-edit-state-notify.js';
import { useZodForm } from '../../../lib/use-zod-form.js';
import { ConfirmDialog } from '../../confirm-dialog.js';
import { SourceEditor } from '../../source-editor.js';
import { EmptyState, ErrorState, LoadingState } from '../../states.js';
import { Button } from '../../ui/button.js';
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

const ruleShape = ruleInputSchema.shape;

const ruleFormSchema = z.object({
  slug: withFieldMessages(z.string().trim(), ruleShape.slug, {
    tooSmall: '请填写规则 slug',
    tooBig: '最多 64 个字符，请精简后再保存',
  }),
  globs: withFieldMessages(z.string(), ruleShape.globs.unwrap(), {
    tooBig: '最多 1000 个字符，请精简后再保存',
  }),
  content: withFieldMessages(z.string(), ruleShape.content.unwrap(), {
    tooBig: '最多 100000 个字符，请精简后再保存',
  }),
});

type RuleFormValues = z.infer<typeof ruleFormSchema>;

const EMPTY_RULE_VALUES: RuleFormValues = { slug: '', globs: '', content: '' };

type RuleAction =
  | { type: 'open'; rule: { slug: string; content: string; globs: string } }
  | { type: 'create' }
  | { type: 'delete'; slug: string };

export function RulesPanel({
  agentId,
  canWrite = true,
  onDirtyChange,
  onPendingChange,
}: { agentId: string; canWrite?: boolean } & DraftCallbacks) {
  const rules = useQuery(agentRulesQuery(agentId));
  const [selected, setSelected] = useState<string | null>(null);
  const autoSelected = useRef(false);
  const [creating, setCreating] = useState(false);

  const form = useZodForm(ruleFormSchema, { defaultValues: EMPTY_RULE_VALUES });
  const { register, control, handleSubmit, reset, formState } = form;
  const { errors, isDirty: dirty } = formState;

  const save = useWriteAgentRule(agentId);
  const remove = useDeleteAgentRule(agentId);
  const pending = save.isPending || remove.isPending;
  const disabled = pending || !canWrite;
  const current = rules.data?.find((item) => item.slug === selected) ?? null;

  const open = (rule: { slug: string; content: string; globs: string }): void => {
    setSelected(rule.slug);
    setCreating(false);
    reset({ slug: rule.slug, globs: rule.globs, content: rule.content });
  };

  const startCreate = (): void => {
    setCreating(true);
    setSelected(null);
    reset(EMPTY_RULE_VALUES);
  };

  const switchGuard = useSwitchGuard<RuleAction>(dirty, pending, async (action) => {
    if (action.type === 'open') {
      open(action.rule);
      return;
    }
    if (!canWrite) return;
    if (action.type === 'create') {
      startCreate();
      return;
    }
    await remove.mutateAsync(action.slug);
    toastSuccess('规则已删除');
    setSelected(null);
    setCreating(false);
    reset(EMPTY_RULE_VALUES);
  });

  const guard = (action: RuleAction): void => {
    if (action.type !== 'open' && !canWrite) return;
    switchGuard.request(action, action.type === 'delete');
  };

  useEditStateNotify(dirty, pending, onDirtyChange, onPendingChange);

  useEffect(() => {
    if (autoSelected.current || rules.data === undefined) return;
    autoSelected.current = true;
    if (selected !== null || creating) return;
    const first = rules.data[0];
    if (!first) return;
    setSelected(first.slug);
    reset({ slug: first.slug, globs: first.globs, content: first.content });
  }, [rules.data, selected, creating, reset]);

  const onSubmit = handleSubmit(
    async (values) => {
      if (disabled) return;
      const target = creating ? values.slug : selected;
      if (!target) return;
      try {
        const rule = await save.mutateAsync({
          slug: target,
          content: values.content,
          globs: values.globs,
        });
        setSelected(rule.slug);
        setCreating(false);
        reset({ slug: rule.slug, globs: rule.globs, content: rule.content });
        toastSuccess('规则已保存');
      } catch (error) {
        if (!applyProblemToForm(form, error)) toastError(error);
      }
    },
    (invalidErrors) => {
      if (!invalidErrors.slug && !invalidErrors.globs && invalidErrors.content) {
        document.getElementById('rule-content')?.focus();
      }
    },
  );

  if (rules.isPending) return <LoadingState rows={2} />;
  if (rules.data === undefined) {
    return <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />;
  }

  const confirming = switchGuard.pendingAction;

  return (
    <div className="grid min-w-0 items-start gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-2">
        <Button variant="outline" disabled={disabled} onClick={() => guard({ type: 'create' })}>
          <Plus data-icon="inline-start" /> 新建规则
        </Button>
        <ul className="hidden flex-col gap-0.5 md:flex">
          {rules.data.map((rule) => (
            <li key={rule.id} className="min-w-0 max-w-full">
              <button
                type="button"
                disabled={pending}
                onClick={() => guard({ type: 'open', rule })}
                className={cn(
                  'w-full max-w-full truncate rounded-item px-2 py-1.5 text-left text-sm transition-colors duration-150 ease-out-soft',
                  selected === rule.slug
                    ? 'bg-selected text-selected-foreground'
                    : 'hover:bg-hover',
                )}
              >
                {rule.slug}
              </button>
            </li>
          ))}
        </ul>
        <Select
          value={selected}
          disabled={pending}
          items={rules.data.map((rule) => ({ value: rule.slug, label: rule.slug }))}
          onValueChange={(next) => {
            const rule = rules.data.find((item) => item.slug === next);
            if (rule) guard({ type: 'open', rule });
          }}
        >
          <SelectTrigger className="w-full min-w-0 md:hidden" aria-label="项目规则">
            <SelectValue className="truncate" placeholder="选择规则" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {rules.data.map((rule) => (
                <SelectItem key={rule.id} value={rule.slug}>
                  {rule.slug}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        {rules.isError ? (
          <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />
        ) : null}
        {creating || current ? (
          <form className="flex min-w-0 flex-col gap-3" noValidate onSubmit={onSubmit}>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate font-mono text-md font-semibold text-fg">
                {creating ? '新建规则' : current?.slug}
              </h2>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {current ? (
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    aria-label={`删除规则 ${current.slug}`}
                    title={`删除规则 ${current.slug}`}
                    disabled={disabled}
                    onClick={() => guard({ type: 'delete', slug: current.slug })}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                ) : null}
                <Button type="submit" disabled={disabled || !dirty} aria-busy={save.isPending}>
                  {save.isPending ? '保存中…' : '保存规则'}
                </Button>
              </div>
            </div>
            <FieldGroup>
              {creating ? (
                <Field
                  className="gap-1.5"
                  data-disabled={disabled}
                  data-invalid={Boolean(errors.slug)}
                >
                  <FieldLabel htmlFor="rule-slug">规则 slug</FieldLabel>
                  <Input
                    {...register('slug')}
                    id="rule-slug"
                    placeholder="no-console"
                    className="font-mono"
                    disabled={disabled}
                    aria-invalid={Boolean(errors.slug)}
                    aria-describedby={errors.slug ? 'rule-slug-error' : undefined}
                  />
                  <FieldError id="rule-slug-error">{errors.slug?.message}</FieldError>
                </Field>
              ) : null}
              <Field
                className="gap-1.5"
                data-disabled={disabled}
                data-invalid={Boolean(errors.globs)}
              >
                <FieldLabel htmlFor="rule-globs">路径作用域（可选）</FieldLabel>
                <Input
                  {...register('globs')}
                  id="rule-globs"
                  placeholder="src/**/*.ts, docs/**"
                  className="font-mono"
                  disabled={disabled}
                  aria-invalid={Boolean(errors.globs)}
                  aria-describedby={errors.globs ? 'rule-globs-error' : undefined}
                />
                <FieldError id="rule-globs-error">{errors.globs?.message}</FieldError>
              </Field>
              <Field
                className="gap-1.5"
                data-disabled={disabled}
                data-invalid={Boolean(errors.content)}
              >
                <FieldLabel htmlFor="rule-content">规则内容（Markdown）</FieldLabel>
                <Controller
                  control={control}
                  name="content"
                  render={({ field }) => (
                    <SourceEditor
                      id="rule-content"
                      value={field.value}
                      language="markdown"
                      aria-label="规则内容（Markdown）"
                      aria-invalid={Boolean(errors.content)}
                      aria-describedby={errors.content ? 'rule-content-error' : undefined}
                      disabled={disabled}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      className="min-h-64"
                    />
                  )}
                />
                <FieldError id="rule-content-error">{errors.content?.message}</FieldError>
              </Field>
            </FieldGroup>
          </form>
        ) : (
          <EmptyState
            variant="idle"
            scale="panel"
            icon={<FileText className="size-5" aria-hidden="true" />}
            title="选择左侧规则查看或编辑"
            description="规则会写入 .claude/rules/，按路径作用域在运行期自动加载。"
            action={
              canWrite ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => guard({ type: 'create' })}
                >
                  <Plus data-icon="inline-start" aria-hidden="true" /> 新建规则
                </Button>
              ) : undefined
            }
          />
        )}
      </div>

      <ConfirmDialog
        open={confirming !== null}
        onClose={switchGuard.cancel}
        title={
          confirming?.type === 'delete'
            ? dirty
              ? '放弃修改并删除？'
              : '删除规则？'
            : '放弃未保存的修改？'
        }
        description={
          confirming?.type === 'delete'
            ? dirty
              ? `「${current?.slug ?? ''}」还有未保存的内容，继续会放弃这些修改并删除该规则，此操作不可撤销。`
              : `将删除「${current?.slug ?? ''}」，此操作不可撤销。`
            : `「${current?.slug ?? '新建规则'}」还有未保存的内容，继续后会丢失。`
        }
        confirmLabel={
          confirming?.type === 'delete' && !dirty
            ? '删除'
            : confirming?.type === 'delete'
              ? '放弃并删除'
              : '放弃并继续'
        }
        confirmDisabled={disabled}
        onConfirm={async () => {
          if (!canWrite) return;
          await switchGuard.confirm();
        }}
      />
    </div>
  );
}
