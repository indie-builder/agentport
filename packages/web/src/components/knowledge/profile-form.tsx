import {
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  knowledgeEmbeddingProtocolSchema,
  knowledgeModelProfileKindSchema,
  supportsKnowledgeImageVectors,
} from '@agentport/shared';
import { type KeyboardEvent, useEffect } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import type { KnowledgeModelProfile } from '../../lib/api.js';
import {
  useCreateKnowledgeModelProfile,
  useUpdateKnowledgeModelProfile,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import { RequiredMark } from '../required-mark.js';
import { Button } from '../ui/button.js';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../ui/field.js';
import { Input } from '../ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';
import { Switch } from '../ui/switch.js';

const profileFormSchema = z.object({
  kind: knowledgeModelProfileKindSchema,
  name: z.string().superRefine((value, ctx) => {
    if (value.trim() === '') ctx.addIssue({ code: 'custom', message: '请填写 profile 名称' });
  }),
  endpointUrl: z.string().superRefine((value, ctx) => {
    if (value.trim() === '') ctx.addIssue({ code: 'custom', message: '请填写 Endpoint URL' });
  }),
  model: z.string().superRefine((value, ctx) => {
    if (value.trim() === '') ctx.addIssue({ code: 'custom', message: '请填写模型 ID' });
  }),
  apiKey: z.string(),
  protocol: knowledgeEmbeddingProtocolSchema,
  imageInput: z.boolean(),
  enabled: z.boolean(),
});

type ProfileFormValues = z.infer<typeof profileFormSchema>;

function defaultProfileValues(
  profile: KnowledgeModelProfile | null,
  lockedKind?: KnowledgeModelProfile['kind'],
): ProfileFormValues {
  return {
    kind: lockedKind ?? profile?.kind ?? 'embedding',
    name: profile?.name ?? '',
    endpointUrl: profile?.endpointUrl ?? '',
    model: profile?.model ?? '',
    apiKey: '',
    protocol: profile?.embeddingProtocol ?? 'openai',
    imageInput: profile?.imageInputEnabled ?? false,
    enabled: profile?.enabled ?? true,
  };
}

export function ProfileForm({
  profile = null,
  lockedKind,
  nested = false,
  idPrefix = 'knowledge-profile',
  submitLabel,
  pendingLabel,
  submitVariant = 'default',
  onCancel,
  onSaved,
  onDirtyChange,
  onPendingChange,
}: {
  profile?: KnowledgeModelProfile | null;
  lockedKind?: 'embedding';
  nested?: boolean;
  idPrefix?: string;
  submitLabel?: string;
  pendingLabel?: string;
  submitVariant?: 'default' | 'outline';
  onCancel?: () => void;
  onSaved?: (profile: KnowledgeModelProfile) => void;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const create = useCreateKnowledgeModelProfile();
  const update = useUpdateKnowledgeModelProfile();
  const { register, control, handleSubmit, watch, reset, formState } = useZodForm(
    profileFormSchema,
    {
      defaultValues: defaultProfileValues(profile, lockedKind),
    },
  );
  const { errors, dirtyFields, isSubmitting } = formState;
  const [kind, protocol, model] = watch(['kind', 'protocol', 'model']);
  const effectiveKind = lockedKind ?? kind;
  const busy = isSubmitting;
  const imageCapable =
    effectiveKind === 'embedding' &&
    supportsKnowledgeImageVectors({ protocol, model, supportsImageInput: true });
  const dirty =
    Object.entries(dirtyFields).some(([key, value]) => key !== 'enabled' && Boolean(value)) ||
    (effectiveKind === 'asr' && Boolean(dirtyFields.enabled));
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onPendingChange?.(isSubmitting), [isSubmitting, onPendingChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const save = handleSubmit(async (values: ProfileFormValues) => {
    const resolvedKind = lockedKind ?? values.kind;
    const imgCapable =
      resolvedKind === 'embedding' &&
      supportsKnowledgeImageVectors({
        protocol: values.protocol,
        model: values.model,
        supportsImageInput: true,
      });
    const input = {
      name: values.name.trim(),
      endpointUrl: values.endpointUrl.trim(),
      model: values.model.trim(),
      ...(resolvedKind === 'embedding'
        ? {
            embeddingProtocol: values.protocol,
            imageInputEnabled: imgCapable && values.imageInput,
          }
        : {}),
      ...(resolvedKind === 'asr' ? { enabled: values.enabled } : {}),
      ...(values.apiKey === '' ? {} : { apiKey: values.apiKey }),
    };
    onPendingChange?.(true);
    try {
      const saved =
        profile === null
          ? await create.mutateAsync({ kind: resolvedKind, ...input })
          : await update.mutateAsync({ id: profile.id, patch: input });
      toastSuccess(
        profile === null
          ? lockedKind === 'embedding'
            ? 'Embedding profile 已创建'
            : '模型 profile 已创建'
          : '模型 profile 已保存',
      );
      reset(defaultProfileValues(profile === null ? null : saved, lockedKind));
      onSaved?.(saved);
    } catch (error) {
      toastError(error);
    } finally {
      onPendingChange?.(false);
    }
  });

  const submitOnEnter = nested
    ? (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void save();
        }
      }
    : undefined;

  const fields = (
    <>
      <FieldGroup className="grid gap-3 sm:grid-cols-2">
        {profile === null && lockedKind === undefined ? (
          <Field className="gap-1.5">
            <FieldLabel htmlFor={`${idPrefix}-kind`}>类型</FieldLabel>
            <Controller
              control={control}
              name="kind"
              render={({ field }) => (
                <Select
                  value={field.value}
                  disabled={busy}
                  onValueChange={(next) => {
                    if (next === 'embedding' || next === 'rerank' || next === 'asr') {
                      field.onChange(next);
                    }
                  }}
                  items={[
                    { value: 'embedding', label: 'Embedding' },
                    { value: 'rerank', label: '重排' },
                    { value: 'asr', label: 'ASR 转录' },
                  ]}
                >
                  <SelectTrigger id={`${idPrefix}-kind`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="embedding">Embedding</SelectItem>
                      <SelectItem value="rerank">重排</SelectItem>
                      <SelectItem value="asr">ASR 转录</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
        ) : null}
        <Field className="gap-1.5" data-invalid={Boolean(errors.name)}>
          <FieldLabel htmlFor={`${idPrefix}-name`}>
            名称 <RequiredMark />
          </FieldLabel>
          <Input
            id={`${idPrefix}-name`}
            {...register('name')}
            disabled={busy}
            onKeyDown={submitOnEnter}
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? `${idPrefix}-name-error` : undefined}
          />
          <FieldError id={`${idPrefix}-name-error`}>{errors.name?.message}</FieldError>
        </Field>
        <Field className="gap-1.5 sm:col-span-2" data-invalid={Boolean(errors.endpointUrl)}>
          <FieldLabel htmlFor={`${idPrefix}-endpoint`}>
            Endpoint URL <RequiredMark />
          </FieldLabel>
          <Input
            id={`${idPrefix}-endpoint`}
            {...register('endpointUrl')}
            disabled={busy}
            placeholder="https://…"
            onKeyDown={submitOnEnter}
            aria-invalid={Boolean(errors.endpointUrl)}
            aria-describedby={errors.endpointUrl ? `${idPrefix}-endpoint-error` : undefined}
          />
          <FieldError id={`${idPrefix}-endpoint-error`}>{errors.endpointUrl?.message}</FieldError>
        </Field>
        <Field className="gap-1.5" data-invalid={Boolean(errors.model)}>
          <FieldLabel htmlFor={`${idPrefix}-model`}>
            模型 <RequiredMark />
          </FieldLabel>
          <Input
            id={`${idPrefix}-model`}
            {...register('model')}
            disabled={busy}
            className="font-mono"
            onKeyDown={submitOnEnter}
            aria-invalid={Boolean(errors.model)}
            aria-describedby={errors.model ? `${idPrefix}-model-error` : undefined}
          />
          <FieldError id={`${idPrefix}-model-error`}>{errors.model?.message}</FieldError>
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor={`${idPrefix}-key`}>API Key</FieldLabel>
          <Input
            id={`${idPrefix}-key`}
            type="password"
            {...register('apiKey')}
            autoComplete="off"
            disabled={busy}
            onKeyDown={submitOnEnter}
            placeholder={profile?.hasSecret ? '留空保持原密钥' : '可选'}
          />
        </Field>
        {effectiveKind === 'embedding' ? (
          <Field className="gap-1.5">
            <FieldLabel htmlFor={`${idPrefix}-protocol`}>Embedding 协议</FieldLabel>
            <Controller
              control={control}
              name="protocol"
              render={({ field }) => (
                <Select
                  value={field.value}
                  disabled={busy}
                  onValueChange={(next) => {
                    const parsed = knowledgeEmbeddingProtocolSchema.safeParse(next);
                    if (parsed.success) field.onChange(parsed.data);
                  }}
                  items={[
                    { value: 'openai', label: 'OpenAI' },
                    { value: 'cohere_v2', label: 'Cohere v2' },
                  ]}
                >
                  <SelectTrigger id={`${idPrefix}-protocol`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="openai">OpenAI</SelectItem>
                      <SelectItem value="cohere_v2">Cohere v2</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
        ) : null}
      </FieldGroup>
      {effectiveKind === 'asr' ? (
        <div className="flex flex-col gap-3">
          <FieldDescription>协议固定为 OpenAI 转录（段级时间）。</FieldDescription>
          <Field orientation="horizontal" className="items-center gap-2">
            <Controller
              control={control}
              name="enabled"
              render={({ field }) => (
                <Switch
                  id={`${idPrefix}-enabled`}
                  checked={field.value}
                  disabled={busy}
                  aria-label="启用"
                  onCheckedChange={field.onChange}
                />
              )}
            />
            <FieldLabel htmlFor={`${idPrefix}-enabled`}>启用</FieldLabel>
          </Field>
        </div>
      ) : null}
      {effectiveKind === 'embedding' ? (
        <>
          <Field orientation="horizontal" className="items-center gap-2">
            <Controller
              control={control}
              name="imageInput"
              render={({ field }) => (
                <Switch
                  id={`${idPrefix}-image-input`}
                  checked={imageCapable && field.value}
                  disabled={busy || !imageCapable}
                  aria-label="图片输入"
                  onCheckedChange={field.onChange}
                />
              )}
            />
            <FieldLabel htmlFor={`${idPrefix}-image-input`}>图片输入</FieldLabel>
          </Field>
          <FieldDescription>
            {imageCapable
              ? `Embedding 维度固定 ${KNOWLEDGE_EMBEDDING_DIMENSIONS}，不可配置。`
              : `仅 Cohere v2 协议的 embed-v4.0 支持图片输入；维度固定 ${KNOWLEDGE_EMBEDDING_DIMENSIONS}。`}
          </FieldDescription>
        </>
      ) : null}
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCancel}>
            取消
          </Button>
        ) : null}
        <Button
          type={nested ? 'button' : 'submit'}
          variant={submitVariant}
          size="sm"
          disabled={busy}
          aria-busy={busy}
          {...(nested ? { onClick: () => void save() } : {})}
        >
          {busy ? (pendingLabel ?? '保存中…') : (submitLabel ?? '保存')}
        </Button>
      </div>
    </>
  );

  if (nested) {
    return <div className="flex flex-col gap-3 rounded-item border border-line p-3">{fields}</div>;
  }

  return (
    <form className="flex flex-col gap-3 rounded-item border border-line p-3" onSubmit={save}>
      {fields}
    </form>
  );
}
