import {
  type KnowledgeSourceInput,
  knowledgeSourceConfigTypeSchema,
  knowledgeSourceRangeKindSchema,
  knowledgeSourceStatusSchema,
} from '@agentport/shared';
import { useMemo, useState } from 'react';
import { Controller, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { DialogShell } from '../../../components/dialog-shell.js';
import {
  DraftGuardDialogs,
  sourceStatusLabel,
  useDraftGuard,
} from '../../../components/knowledge/knowledge-shared.js';
import { RequiredMark } from '../../../components/required-mark.js';
import { Button } from '../../../components/ui/button.js';
import { Dialog } from '../../../components/ui/dialog.js';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../../../components/ui/field.js';
import { Input } from '../../../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.js';
import { Switch } from '../../../components/ui/switch.js';
import type { KnowledgeSource } from '../../../lib/api.js';
import { cn } from '../../../lib/cn.js';
import { guardedOpenChange, useDialogClose } from '../../../lib/dialog-guard.js';
import { useCreateKnowledgeSource, useUpdateKnowledgeSource } from '../../../lib/queries.js';
import { toastError, toastSuccess } from '../../../lib/toast.js';
import { useZodForm } from '../../../lib/use-zod-form.js';
import {
  type AuthMode,
  authModeOptions,
  configString,
  credentialField,
  emptySourceFields,
  isAuthMode,
  newRangeDraft,
  type RangeDraft,
  type RangeKind,
  rangeExternalLabel,
  rangeIssue,
  rangeKinds,
  type SourceFieldState,
  type SourceType,
  seafilePathIssue,
  sourceFieldId,
  sourceFieldRequired,
  sourceFieldSpecs,
  sourceProvider,
  sourceProviders,
  toRangeInput,
} from './shared.js';
import { RangeRows } from './source-ranges.js';

const rangeDraftSchema = z.object({
  clientId: z.string(),
  kind: knowledgeSourceRangeKindSchema,
  externalId: z.string(),
  ref: z.string().nullable(),
  paths: z.array(z.string()),
  enabled: z.boolean(),
});

const sourceFieldsSchema = z.object({
  appId: z.string(),
  baseUrl: z.string(),
  email: z.string(),
  cloudId: z.string(),
  username: z.string(),
  operatorUnionId: z.string(),
  clientId: z.string(),
});

const sourceFormBaseSchema = z.object({
  type: knowledgeSourceConfigTypeSchema,
  name: z.string(),
  secret: z.string(),
  fields: sourceFieldsSchema,
  authMode: z.enum(['cloud_basic', 'cloud_scoped', 'dc_pat']),
  cron: z.string(),
  syncDeletions: z.boolean(),
  status: knowledgeSourceStatusSchema,
  ranges: z.array(rangeDraftSchema),
});

type SourceFormValues = {
  type: SourceType;
  name: string;
  secret: string;
  fields: SourceFieldState;
  authMode: AuthMode;
  cron: string;
  syncDeletions: boolean;
  status: KnowledgeSource['status'];
  ranges: RangeDraft[];
};

function createSourceFormSchema(editing: boolean, hasExistingSecret: boolean) {
  return sourceFormBaseSchema.superRefine((values, ctx) => {
    if (values.name.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['name'],
        message: '请填写来源名称',
      });
    }
    const credential = credentialField(values.type, values.authMode);
    if (credential !== null && !(editing && hasExistingSecret) && values.secret === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['secret'],
        message: `请填写 ${credential.label}`,
      });
    }
    const visibleSpecs = (sourceFieldSpecs[values.type] ?? []).filter(
      (spec) => spec.visible === undefined || spec.visible(values.authMode),
    );
    visibleSpecs.forEach((spec) => {
      if (sourceFieldRequired(spec, values.authMode) && values.fields[spec.key].trim() === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', spec.key],
          message: `请填写 ${spec.label}`,
        });
      }
    });
    if (
      (values.type === 'feishu_wiki' || values.type === 'feishu_drive') &&
      values.fields.appId.trim() === ''
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields', 'appId'],
        message: '请填写 App ID',
      });
    }
    if (values.type === 'gitlab' && values.fields.baseUrl.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['fields', 'baseUrl'],
        message: '请填写实例 URL',
      });
    }
    values.ranges.forEach((range, index) => {
      if (range.externalId.trim() === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['ranges', index, 'externalId'],
          message: `请填写${rangeExternalLabel(range.kind)}`,
        });
      }
      if (values.type === 'gitlab' && !range.ref?.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['ranges', index, 'ref'],
          message: '请填写 Ref',
        });
      }
      if (values.type === 'seafile') {
        const pathError = seafilePathIssue(range.paths);
        if (pathError !== null) {
          ctx.addIssue({
            code: 'custom',
            path: ['ranges', index, 'paths'],
            message: pathError,
          });
        }
      }
    });
    const overallRangeError = rangeIssue(values.type, values.ranges);
    if (overallRangeError !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['ranges', 'root'],
        message: overallRangeError,
      });
    }
  });
}

function createInitialValues(source: KnowledgeSource | undefined): SourceFormValues {
  return {
    type: source ? source.type : 'feishu_wiki',
    name: source?.name ?? '',
    secret: '',
    fields: {
      ...emptySourceFields,
      appId: configString(source, 'appId'),
      baseUrl: configString(source, 'baseUrl'),
      email: configString(source, 'email'),
      cloudId: configString(source, 'cloudId'),
      username: configString(source, 'username'),
      operatorUnionId: configString(source, 'operatorUnionId'),
      clientId: configString(source, 'clientId'),
    },
    authMode: isAuthMode(source?.config.authMode) ? source.config.authMode : 'cloud_basic',
    cron: source?.syncCron ?? '',
    syncDeletions: source?.config.syncDeletions === true,
    status: source?.status ?? 'active',
    ranges: source
      ? source.ranges.map(({ id, ...range }) => ({
          ...range,
          clientId: id,
          paths: range.kind === 'seafile_repo' && range.paths.length === 0 ? ['/'] : range.paths,
        }))
      : [newRangeDraft(rangeKinds.feishu_wiki[0] as RangeKind)],
  };
}

function buildSourceConfig(
  values: SourceFormValues,
  normalized: Array<ReturnType<typeof toRangeInput>>,
): Record<string, unknown> {
  const { type, fields, authMode, syncDeletions, ranges } = values;
  switch (type) {
    case 'feishu_wiki':
    case 'feishu_drive':
      return {
        appId: fields.appId.trim(),
        ...(fields.baseUrl.trim() ? { baseUrl: fields.baseUrl.trim() } : {}),
        syncDeletions,
      };
    case 'lark_wiki':
    case 'lark_drive':
      return { appId: fields.appId.trim(), syncDeletions };
    case 'github':
      return {
        ...(fields.baseUrl.trim() ? { baseUrl: fields.baseUrl.trim() } : {}),
        projectId: normalized[0]?.externalId ?? '',
        syncDeletions,
      };
    case 'gitlab':
      return {
        ...(fields.baseUrl.trim() ? { baseUrl: fields.baseUrl.trim() } : {}),
        projectId: normalized[0]?.externalId ?? '',
        ref: ranges.find((range) => range.ref)?.ref?.trim() ?? '',
        syncDeletions,
      };
    case 'notion':
    case 'yuque':
      return { syncDeletions };
    case 'confluence':
      return {
        authMode,
        baseUrl: fields.baseUrl.trim(),
        ...(authMode === 'dc_pat' ? {} : { email: fields.email.trim() }),
        ...(authMode === 'cloud_scoped' ? { cloudId: fields.cloudId.trim() } : {}),
        syncDeletions,
      };
    case 'dingtalk':
      return {
        clientId: fields.clientId.trim(),
        operatorUnionId: fields.operatorUnionId.trim(),
        syncDeletions,
      };
    case 'ima':
      return { clientId: fields.clientId.trim(), syncDeletions };
    case 'seafile':
      return { baseUrl: fields.baseUrl.trim(), syncDeletions };
    case 'nextcloud':
      return { baseUrl: fields.baseUrl.trim(), username: fields.username.trim(), syncDeletions };
    default:
      return {};
  }
}

export function SourceDialog({
  baseId,
  source,
  onClose: onClosed,
}: {
  baseId: string;
  source?: KnowledgeSource;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const editing = source !== undefined;
  const hasExistingSecret = source?.hasSecret ?? false;
  const create = useCreateKnowledgeSource(baseId);
  const update = useUpdateKnowledgeSource(baseId);
  const pending = create.isPending || update.isPending;
  const [step, setStep] = useState<'choose' | 'configure'>(editing ? 'configure' : 'choose');
  const [confirmSwitch, setConfirmSwitch] = useState(false);

  const schema = useMemo(
    () => createSourceFormSchema(editing, hasExistingSecret),
    [editing, hasExistingSecret],
  );
  const defaultValues = useMemo(() => createInitialValues(source), [source]);

  const { register, control, handleSubmit, reset, getValues, setValue, clearErrors, formState } =
    useZodForm<SourceFormValues>(schema, { defaultValues });
  const { isDirty, errors } = formState;

  const [type, authMode] = useWatch({ control, name: ['type', 'authMode'] });
  const provider = sourceProvider(type);
  const ProviderIcon = provider.icon;
  const credential = credentialField(type, authMode);
  const secretRequired = credential !== null && !(editing && hasExistingSecret);
  const dirty = step === 'configure' && isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);
  const specs = (sourceFieldSpecs[type] ?? []).filter(
    (spec) => spec.visible === undefined || spec.visible(authMode),
  );

  const chooseType = (next: SourceType): void => {
    reset({
      ...getValues(),
      type: next,
      secret: '',
      fields: { ...emptySourceFields },
      authMode: 'cloud_basic',
      ranges: [newRangeDraft(rangeKinds[next][0] as RangeKind)],
    });
    setStep('configure');
  };

  const requestChooseType = (): void => {
    if (pending) return;
    if (dirty) setConfirmSwitch(true);
    else setStep('choose');
  };

  const submit = handleSubmit((values) => {
    if (pending) return;
    const normalized = values.ranges.map(toRangeInput);
    const syncCron = values.cron.trim() === '' ? null : values.cron.trim();
    const activeCredential = credentialField(values.type, values.authMode);
    if (source) {
      const patchStatus =
        values.status === 'auth_error'
          ? values.secret !== ''
            ? 'active'
            : undefined
          : values.status === source.status
            ? undefined
            : values.status;
      update.mutate(
        {
          sourceId: source.id,
          patch: {
            name: values.name.trim(),
            ...(patchStatus === undefined ? {} : { status: patchStatus }),
            syncCron,
            ranges: normalized,
            ...(values.type === 'feed' ? {} : { config: buildSourceConfig(values, normalized) }),
            ...(activeCredential && values.secret !== ''
              ? { secrets: { [activeCredential.key]: values.secret } }
              : {}),
          },
        },
        {
          onSuccess: (result) => {
            const revoked = result.disabledDocumentIds?.length ?? 0;
            toastSuccess(revoked > 0 ? `来源已更新，${revoked} 个文档立即撤权` : '来源已更新');
            guard.finish();
          },
          onError: toastError,
        },
      );
      return;
    }
    const secrets = activeCredential ? { [activeCredential.key]: values.secret } : {};
    create.mutate(
      {
        name: values.name.trim(),
        syncCron,
        ranges: normalized,
        type: values.type,
        config: buildSourceConfig(values, normalized),
        secrets,
      } as KnowledgeSourceInput,
      {
        onSuccess: () => {
          toastSuccess('来源已创建');
          guard.finish();
        },
        onError: toastError,
      },
    );
  });

  const secretInput =
    credential === null ? null : (
      <Field className="gap-1.5" data-invalid={Boolean(errors.secret)}>
        <FieldLabel htmlFor="knowledge-source-secret">
          {credential.label} {secretRequired ? <RequiredMark /> : null}
        </FieldLabel>
        <Input
          id="knowledge-source-secret"
          type="password"
          {...register('secret')}
          autoComplete="off"
          disabled={pending}
          aria-required={secretRequired ? 'true' : undefined}
          aria-invalid={Boolean(errors.secret)}
          aria-describedby={errors.secret ? 'knowledge-source-secret-error' : undefined}
          placeholder={editing ? (hasExistingSecret ? '留空保持原凭证' : '填写凭证') : '填写凭据'}
        />
        <FieldError id="knowledge-source-secret-error">{errors.secret?.message}</FieldError>
        {type === 'github' ? (
          <FieldDescription>需要 Contents 只读权限；私有仓库还需 Metadata 只读。</FieldDescription>
        ) : credential.description ? (
          <FieldDescription>{credential.description}</FieldDescription>
        ) : null}
      </Field>
    );

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell
        title={editing ? '编辑来源' : '新建来源'}
        closeDisabled={pending}
        className="max-w-190 sm:max-w-190"
        footer={
          step === 'choose' ? (
            <div className="flex justify-end">
              <Button variant="outline" onClick={guard.close} disabled={pending}>
                取消
              </Button>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={guard.close} disabled={pending}>
                取消
              </Button>
              <Button type="submit" form="source-form" disabled={pending} aria-busy={pending}>
                {pending ? (editing ? '保存中…' : '创建中…') : editing ? '保存' : '创建'}
              </Button>
            </div>
          )
        }
      >
        <form id="source-form" className="flex flex-col gap-4" noValidate onSubmit={submit}>
          {step === 'choose' ? (
            <div className="flex flex-col">
              {sourceProviders.map((option) => {
                const OptionIcon = option.icon;
                return (
                  <button
                    key={option.type}
                    type="button"
                    disabled={pending}
                    onClick={() => chooseType(option.type)}
                    className="flex items-center gap-3 border-b border-line px-2 py-3 text-left transition-colors duration-150 ease-out-soft last:border-b-0 hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-item border border-line text-muted-foreground">
                      <OptionIcon className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-fg">{option.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-item border border-line text-muted-foreground">
                  <ProviderIcon className="size-3.5" aria-hidden="true" />
                </span>
                <span className="text-xs font-medium text-fg">{provider.label}</span>
                {editing ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="ml-auto"
                    disabled={pending}
                    onClick={requestChooseType}
                  >
                    更换来源
                  </Button>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-fg">连接</span>
                <FieldGroup className="grid gap-3 sm:grid-cols-2">
                  <Field
                    className={cn('gap-1.5', !editing && 'sm:col-span-2')}
                    data-invalid={Boolean(errors.name)}
                  >
                    <FieldLabel htmlFor="source-name">
                      名称 <RequiredMark />
                    </FieldLabel>
                    <Input
                      id="source-name"
                      {...register('name')}
                      maxLength={120}
                      disabled={pending}
                      aria-required="true"
                      aria-invalid={Boolean(errors.name)}
                      aria-describedby={errors.name ? 'source-name-error' : undefined}
                    />
                    <FieldError id="source-name-error">{errors.name?.message}</FieldError>
                  </Field>
                  {editing ? (
                    <Field className="gap-1.5">
                      <FieldLabel htmlFor="knowledge-source-status">状态</FieldLabel>
                      <Controller
                        control={control}
                        name="status"
                        render={({ field }) => {
                          const statusOptions = [
                            ...(field.value === 'auth_error'
                              ? [
                                  {
                                    value: 'auth_error' as const,
                                    label: sourceStatusLabel.auth_error,
                                  },
                                ]
                              : []),
                            { value: 'active' as const, label: sourceStatusLabel.active },
                            { value: 'paused' as const, label: sourceStatusLabel.paused },
                            { value: 'disabled' as const, label: sourceStatusLabel.disabled },
                          ];
                          return (
                            <Select
                              value={field.value}
                              disabled={pending}
                              onValueChange={(next) => {
                                if (next === 'active' || next === 'paused' || next === 'disabled') {
                                  field.onChange(next);
                                }
                              }}
                              items={statusOptions}
                            >
                              <SelectTrigger id="knowledge-source-status" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {statusOptions.map((option) => (
                                    <SelectItem key={option.value} value={option.value}>
                                      {option.label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          );
                        }}
                      />
                    </Field>
                  ) : null}
                  {type === 'feishu_wiki' || type === 'feishu_drive' ? (
                    <>
                      <Field className="gap-1.5" data-invalid={Boolean(errors.fields?.appId)}>
                        <FieldLabel htmlFor="source-app-id">
                          App ID <RequiredMark />
                        </FieldLabel>
                        <Input
                          id="source-app-id"
                          {...register('fields.appId')}
                          disabled={pending}
                          aria-required="true"
                          aria-invalid={Boolean(errors.fields?.appId)}
                          aria-describedby={
                            errors.fields?.appId ? 'source-app-id-error' : undefined
                          }
                          className="font-mono"
                        />
                        <FieldError id="source-app-id-error">
                          {errors.fields?.appId?.message}
                        </FieldError>
                      </Field>
                      {secretInput}
                      <Field className="gap-1.5 sm:col-span-2">
                        <FieldLabel htmlFor="source-base-url">Base URL</FieldLabel>
                        <Input
                          id="source-base-url"
                          {...register('fields.baseUrl')}
                          disabled={pending}
                          placeholder="留空使用官方地址"
                          className="font-mono"
                        />
                      </Field>
                    </>
                  ) : type === 'github' ? (
                    <>
                      <Field className="gap-1.5">
                        <FieldLabel htmlFor="source-github-api">API 地址</FieldLabel>
                        <Input
                          id="source-github-api"
                          {...register('fields.baseUrl')}
                          disabled={pending}
                          placeholder="https://api.github.com"
                          className="font-mono"
                        />
                      </Field>
                      {secretInput}
                    </>
                  ) : type === 'gitlab' ? (
                    <>
                      <Field className="gap-1.5" data-invalid={Boolean(errors.fields?.baseUrl)}>
                        <FieldLabel htmlFor="source-gitlab-url">
                          实例 URL <RequiredMark />
                        </FieldLabel>
                        <Input
                          id="source-gitlab-url"
                          {...register('fields.baseUrl')}
                          disabled={pending}
                          aria-required="true"
                          aria-invalid={Boolean(errors.fields?.baseUrl)}
                          aria-describedby={
                            errors.fields?.baseUrl ? 'source-gitlab-url-error' : undefined
                          }
                          placeholder="https://gitlab.example.com"
                          className="font-mono"
                        />
                        <FieldError id="source-gitlab-url-error">
                          {errors.fields?.baseUrl?.message}
                        </FieldError>
                      </Field>
                      {secretInput}
                    </>
                  ) : (
                    <>
                      {type === 'confluence' ? (
                        <Field className="gap-1.5 sm:col-span-2">
                          <FieldLabel htmlFor="source-confluence-auth">认证模式</FieldLabel>
                          <Controller
                            control={control}
                            name="authMode"
                            render={({ field }) => (
                              <Select
                                value={field.value}
                                disabled={pending || editing}
                                onValueChange={(next) => {
                                  if (!next || !isAuthMode(next)) return;
                                  field.onChange(next);
                                  setValue('secret', '', { shouldDirty: true });
                                  clearErrors(['secret', 'fields.email', 'fields.cloudId']);
                                }}
                                items={authModeOptions}
                              >
                                <SelectTrigger id="source-confluence-auth" className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    {authModeOptions.map((option) => (
                                      <SelectItem key={option.value} value={option.value}>
                                        {option.label}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            )}
                          />
                        </Field>
                      ) : null}
                      {specs.map((spec) => {
                        const error = errors.fields?.[spec.key]?.message;
                        const id = sourceFieldId(spec.key);
                        const required = sourceFieldRequired(spec, authMode);
                        return (
                          <Field key={spec.key} className="gap-1.5" data-invalid={Boolean(error)}>
                            <FieldLabel htmlFor={id}>
                              {spec.label} {required ? <RequiredMark /> : null}
                            </FieldLabel>
                            <Input
                              id={id}
                              {...register(`fields.${spec.key}`)}
                              disabled={pending || (editing && spec.identity === true)}
                              aria-required={required ? 'true' : undefined}
                              aria-invalid={Boolean(error)}
                              aria-describedby={error ? `${id}-error` : undefined}
                              placeholder={spec.placeholder}
                              className="font-mono"
                            />
                            <FieldError id={`${id}-error`}>{error}</FieldError>
                          </Field>
                        );
                      })}
                      {secretInput}
                      {type === 'lark_wiki' || type === 'lark_drive' ? (
                        <FieldDescription className="sm:col-span-2">
                          使用 Lark 应用（open.larksuite.com），与飞书应用不互通。
                        </FieldDescription>
                      ) : type === 'notion' ? (
                        <FieldDescription className="sm:col-span-2">
                          连接需有读取权限，目标页面或数据库已共享给该连接。
                        </FieldDescription>
                      ) : type === 'confluence' ? (
                        <FieldDescription className="sm:col-span-2">
                          Cloud 使用 Email + API Token；Data Center 使用
                          PAT。认证模式与站点在创建后不可修改。
                        </FieldDescription>
                      ) : type === 'yuque' ? (
                        <FieldDescription className="sm:col-span-2">
                          知识库 ID 为语雀的数字 ID，不是 namespace 或 slug。
                        </FieldDescription>
                      ) : type === 'ima' ? (
                        <FieldDescription className="sm:col-span-2">
                          笔记仅作者可读；部分媒体不提供原文下载。
                        </FieldDescription>
                      ) : type === 'seafile' ? (
                        <FieldDescription className="sm:col-span-2">
                          适用于 Seafile 11+，使用 Bearer API Token。
                        </FieldDescription>
                      ) : type === 'nextcloud' ? (
                        <FieldDescription className="sm:col-span-2">
                          使用账号的应用密码，不读取网页登录 Cookie。
                        </FieldDescription>
                      ) : null}
                    </>
                  )}
                </FieldGroup>
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-fg">同步范围</span>
                <Controller
                  control={control}
                  name="ranges"
                  render={({ field }) => {
                    const rangesErrors = errors.ranges;
                    const rowErrors = field.value.map((_, index) => ({
                      externalId: rangesErrors?.[index]?.externalId?.message ?? null,
                      ref: rangesErrors?.[index]?.ref?.message ?? null,
                      paths: rangesErrors?.[index]?.paths?.message ?? null,
                    }));
                    const structuralRangeIssue =
                      field.value.length === 0
                        ? '至少需要一个范围'
                        : !field.value.some((range) => range.enabled)
                          ? '至少需要一个启用的范围'
                          : null;
                    const rangesBannerError =
                      structuralRangeIssue ?? rangesErrors?.root?.message ?? null;
                    return (
                      <>
                        <RangeRows
                          type={type}
                          ranges={field.value}
                          disabled={pending}
                          errors={rowErrors}
                          onChange={(next) => {
                            if (errors.ranges) clearErrors('ranges');
                            field.onChange(next);
                          }}
                        />
                        {rangesBannerError ? (
                          <FieldError id="knowledge-source-ranges-error">
                            {rangesBannerError}
                          </FieldError>
                        ) : null}
                      </>
                    );
                  }}
                />
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="knowledge-source-cron">同步 cron（UTC）</FieldLabel>
                  <Input
                    id="knowledge-source-cron"
                    {...register('cron')}
                    disabled={pending}
                    placeholder="留空不自动同步"
                    className="font-mono"
                  />
                </Field>
                {type === 'feed' ? (
                  <FieldDescription>
                    Feed 只暴露最近窗口，不会把条目滚出窗口当作删除；因此不提供删除传播开关。
                  </FieldDescription>
                ) : (
                  <Field orientation="horizontal" className="items-center gap-2">
                    <Controller
                      control={control}
                      name="syncDeletions"
                      render={({ field }) => (
                        <Switch
                          id="knowledge-source-sync-deletions"
                          checked={field.value}
                          disabled={pending}
                          onCheckedChange={field.onChange}
                        />
                      )}
                    />
                    <FieldLabel htmlFor="knowledge-source-sync-deletions">
                      远端删除时停用文档
                    </FieldLabel>
                  </Field>
                )}
              </div>
            </>
          )}
        </form>
        <DraftGuardDialogs guard={guard} draft="来源配置草稿会丢失。" pending={pending} />
        <ConfirmDialog
          open={confirmSwitch}
          title="放弃未保存的更改？"
          description="切换来源类型会清空当前连接与范围草稿。"
          confirmLabel="放弃并切换"
          confirmDisabled={pending}
          onClose={() => setConfirmSwitch(false)}
          onConfirm={async () => {
            setConfirmSwitch(false);
            setStep('choose');
          }}
        />
      </DialogShell>
    </Dialog>
  );
}
