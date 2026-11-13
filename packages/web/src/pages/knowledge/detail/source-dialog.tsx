import type { KnowledgeSourceInput } from '@agentport/shared';
import { useState } from 'react';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { DialogShell } from '../../../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../../../components/knowledge/knowledge-shared.js';
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
import { guardedOpenChange } from '../../../lib/dialog-guard.js';
import { useCreateKnowledgeSource, useUpdateKnowledgeSource } from '../../../lib/queries.js';
import { toastError, toastSuccess } from '../../../lib/toast.js';
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
  type SourceFieldKey,
  type SourceFieldState,
  type SourceType,
  seafilePathIssue,
  sourceDraftSignature,
  sourceFieldId,
  sourceFieldRequired,
  sourceFieldSpecs,
  sourceProvider,
  sourceProviders,
  toRangeInput,
} from './shared.js';
import { RangeRows } from './source-ranges.js';

export function SourceDialog({
  baseId,
  source,
  onClose,
}: {
  baseId: string;
  source?: KnowledgeSource;
  onClose: () => void;
}) {
  const editing = source !== undefined;
  const create = useCreateKnowledgeSource(baseId);
  const update = useUpdateKnowledgeSource(baseId);
  const pending = create.isPending || update.isPending;
  const [step, setStep] = useState<'choose' | 'configure'>(editing ? 'configure' : 'choose');
  const [type, setType] = useState<SourceType>(source ? source.type : 'feishu_wiki');
  const [name, setName] = useState(source?.name ?? '');
  const [secret, setSecret] = useState('');
  const [fields, setFields] = useState<SourceFieldState>(() => ({
    ...emptySourceFields,
    appId: configString(source, 'appId'),
    baseUrl: configString(source, 'baseUrl'),
    email: configString(source, 'email'),
    cloudId: configString(source, 'cloudId'),
    username: configString(source, 'username'),
    operatorUnionId: configString(source, 'operatorUnionId'),
    clientId: configString(source, 'clientId'),
  }));
  const [authMode, setAuthMode] = useState<AuthMode>(() =>
    isAuthMode(source?.config.authMode) ? source.config.authMode : 'cloud_basic',
  );
  const [cron, setCron] = useState(source?.syncCron ?? '');
  const [syncDeletions, setSyncDeletions] = useState(source?.config.syncDeletions === true);
  // auth_error 不在可写枚举里：保持原值，只有用户主动改状态才提交。
  const [status, setStatus] = useState<KnowledgeSource['status']>(source?.status ?? 'active');
  const [ranges, setRanges] = useState<RangeDraft[]>(() =>
    source
      ? source.ranges.map(({ id, ...range }) => ({
          ...range,
          clientId: id,
          // 后端空 paths 表示全库；草稿显式写 /，清空后才是真正的空。
          paths: range.kind === 'seafile_repo' && range.paths.length === 0 ? ['/'] : range.paths,
        }))
      : [newRangeDraft(rangeKinds.feishu_wiki[0] as RangeKind)],
  );
  const [submitted, setSubmitted] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [baseline, setBaseline] = useState(() =>
    sourceDraftSignature({
      type: source ? source.type : 'feishu_wiki',
      name: source?.name ?? '',
      secret: '',
      fields,
      authMode,
      cron: source?.syncCron ?? '',
      syncDeletions: source?.config.syncDeletions === true,
      status: source?.status ?? 'active',
      ranges,
    }),
  );
  const provider = sourceProvider(type);
  const ProviderIcon = provider.icon;
  const credential = credentialField(type, authMode);
  const secretRequired = credential !== null && !(editing && source.hasSecret);
  const issue = rangeIssue(type, ranges);
  const normalized = ranges.map(toRangeInput);
  const syncCron = cron.trim() === '' ? null : cron.trim();
  const dirty =
    step === 'configure' &&
    sourceDraftSignature({
      type,
      name,
      secret,
      fields,
      authMode,
      cron,
      syncDeletions,
      status,
      ranges,
    }) !== baseline;
  const guard = useDraftGuard(dirty, pending, onClose);
  const specs = (sourceFieldSpecs[type] ?? []).filter(
    (spec) => spec.visible === undefined || spec.visible(authMode),
  );
  const fieldIssues = Object.fromEntries(
    specs.map((spec) => [
      spec.key,
      sourceFieldRequired(spec, authMode) && fields[spec.key].trim() === ''
        ? `请填写 ${spec.label}`
        : null,
    ]),
  ) as Partial<Record<SourceFieldKey, string | null>>;
  const nameIssue = name.trim() === '' ? '请填写来源名称' : null;
  const secretIssue = secretRequired && secret === '' ? `请填写 ${credential.label}` : null;
  const legacyIssues = {
    appId:
      (type === 'feishu_wiki' || type === 'feishu_drive') && fields.appId.trim() === ''
        ? '请填写 App ID'
        : null,
    baseUrl: type === 'gitlab' && fields.baseUrl.trim() === '' ? '请填写实例 URL' : null,
  };
  const rowIssues = ranges.map((range) => ({
    externalId: range.externalId.trim() === '' ? `请填写${rangeExternalLabel(range.kind)}` : null,
    ref: type === 'gitlab' && !range.ref?.trim() ? '请填写 Ref' : null,
    paths: type === 'seafile' ? seafilePathIssue(range.paths) : null,
  }));
  const hasSubmitIssue =
    nameIssue !== null ||
    secretIssue !== null ||
    Object.values(fieldIssues).some(Boolean) ||
    Object.values(legacyIssues).some(Boolean) ||
    rowIssues.some((row) => row.externalId !== null || row.ref !== null || row.paths !== null) ||
    issue !== null;

  // 各类型的范围 kind 与外键含义不同，切换类型时整套重建，不能把旧行带过去；
  // 凭证与连接地址也只属于原类型，必须清空。
  const chooseType = (next: SourceType): void => {
    const nextRanges = [newRangeDraft(rangeKinds[next][0] as RangeKind)];
    setType(next);
    setSecret('');
    setFields({ ...emptySourceFields });
    setAuthMode('cloud_basic');
    setRanges(nextRanges);
    setStep('configure');
    setSubmitted(false);
    // 选类型本身不算草稿；只有真正改过字段才需要离开确认。
    setBaseline(
      sourceDraftSignature({
        type: next,
        name,
        secret: '',
        fields: { ...emptySourceFields },
        authMode: 'cloud_basic',
        cron,
        syncDeletions,
        status,
        ranges: nextRanges,
      }),
    );
  };

  const requestChooseType = (): void => {
    if (pending) return;
    if (dirty) setConfirmSwitch(true);
    else setStep('choose');
  };

  const buildConfig = (): Record<string, unknown> => {
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
        // ref 属于每个 range，多仓库时不能把第一条写进公共 config。
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
  };

  const buildInput = (): KnowledgeSourceInput => {
    const common = { name: name.trim(), syncCron, ranges: normalized };
    const secrets = credential ? { [credential.key]: secret } : {};
    // 服务端 Zod 才是信任边界；这里只按所选 type 组装对应 wire 形状。
    return { ...common, type, config: buildConfig(), secrets } as KnowledgeSourceInput;
  };

  const buildPatch = (target: KnowledgeSource) => {
    // 填了新凭证说明已修复 auth_error：自动恢复启用；留空则保留原状态。
    const patchStatus =
      status === 'auth_error'
        ? secret !== ''
          ? 'active'
          : undefined
        : status === target.status
          ? undefined
          : status;
    return {
      name: name.trim(),
      ...(patchStatus === undefined ? {} : { status: patchStatus }),
      syncCron,
      ranges: normalized,
      ...(type === 'feed' ? {} : { config: buildConfig() }),
      // 空值不提交，服务端保留原凭证；填了才是轮换。
      ...(credential && secret !== '' ? { secrets: { [credential.key]: secret } } : {}),
    };
  };

  const secretInput =
    credential === null ? null : (
      <Field className="gap-1.5" data-invalid={submitted && secretIssue !== null}>
        <FieldLabel htmlFor="knowledge-source-secret">
          {credential.label} {secretRequired ? <RequiredMark /> : null}
        </FieldLabel>
        <Input
          id="knowledge-source-secret"
          type="password"
          value={secret}
          autoComplete="off"
          disabled={pending}
          aria-invalid={submitted && secretIssue !== null}
          aria-describedby={submitted && secretIssue ? 'knowledge-source-secret-error' : undefined}
          onChange={(event) => setSecret(event.target.value)}
          placeholder={editing ? (source.hasSecret ? '留空保持原凭证' : '填写凭证') : '填写凭据'}
        />
        <FieldError id="knowledge-source-secret-error">{submitted ? secretIssue : null}</FieldError>
        {type === 'github' ? (
          <FieldDescription>需要 Contents 只读权限；私有仓库还需 Metadata 只读。</FieldDescription>
        ) : credential.description ? (
          <FieldDescription>{credential.description}</FieldDescription>
        ) : null}
      </Field>
    );

  return (
    <Dialog open onOpenChange={guardedOpenChange(pending, guard.close)}>
      <DialogShell
        title={editing ? '编辑来源' : '新建来源'}
        closeDisabled={pending}
        className="max-w-190 sm:max-w-190"
      >
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            setSubmitted(true);
            if (hasSubmitIssue) return;
            if (source) {
              update.mutate(
                { sourceId: source.id, patch: buildPatch(source) },
                {
                  onSuccess: (result) => {
                    const revoked = result.disabledDocumentIds?.length ?? 0;
                    toastSuccess(
                      revoked > 0 ? `来源已更新，${revoked} 个文档立即撤权` : '来源已更新',
                    );
                    guard.finish();
                  },
                  onError: toastError,
                },
              );
              return;
            }
            create.mutate(buildInput(), {
              onSuccess: () => {
                toastSuccess('来源已创建');
                guard.finish();
              },
              onError: toastError,
            });
          }}
        >
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
                    data-invalid={submitted && nameIssue !== null}
                  >
                    <FieldLabel htmlFor="source-name">
                      名称 <RequiredMark />
                    </FieldLabel>
                    <Input
                      id="source-name"
                      value={name}
                      maxLength={120}
                      disabled={pending}
                      aria-invalid={submitted && nameIssue !== null}
                      aria-describedby={submitted && nameIssue ? 'source-name-error' : undefined}
                      onChange={(event) => setName(event.target.value)}
                    />
                    <FieldError id="source-name-error">{submitted ? nameIssue : null}</FieldError>
                  </Field>
                  {editing ? (
                    <Field className="gap-1.5">
                      <FieldLabel htmlFor="knowledge-source-status">状态</FieldLabel>
                      <Select
                        value={status === 'auth_error' ? 'auth_error' : status}
                        disabled={pending}
                        onValueChange={(next) => {
                          if (next === 'active' || next === 'paused' || next === 'disabled') {
                            setStatus(next);
                          }
                        }}
                        items={[
                          ...(status === 'auth_error'
                            ? [{ value: 'auth_error', label: '凭证失效' }]
                            : []),
                          { value: 'active', label: '启用' },
                          { value: 'paused', label: '暂停' },
                          { value: 'disabled', label: '停用' },
                        ]}
                      >
                        <SelectTrigger id="knowledge-source-status" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {status === 'auth_error' ? (
                              <SelectItem value="auth_error">凭证失效</SelectItem>
                            ) : null}
                            <SelectItem value="active">启用</SelectItem>
                            <SelectItem value="paused">暂停</SelectItem>
                            <SelectItem value="disabled">停用</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  ) : null}
                  {type === 'feishu_wiki' || type === 'feishu_drive' ? (
                    <>
                      <Field
                        className="gap-1.5"
                        data-invalid={submitted && legacyIssues.appId !== null}
                      >
                        <FieldLabel htmlFor="source-app-id">
                          App ID <RequiredMark />
                        </FieldLabel>
                        <Input
                          id="source-app-id"
                          value={fields.appId}
                          disabled={pending}
                          aria-invalid={submitted && legacyIssues.appId !== null}
                          aria-describedby={
                            submitted && legacyIssues.appId ? 'source-app-id-error' : undefined
                          }
                          onChange={(event) =>
                            setFields((previous) => ({ ...previous, appId: event.target.value }))
                          }
                          className="font-mono"
                        />
                        <FieldError id="source-app-id-error">
                          {submitted ? legacyIssues.appId : null}
                        </FieldError>
                      </Field>
                      {secretInput}
                      <Field className="gap-1.5 sm:col-span-2">
                        <FieldLabel htmlFor="source-base-url">Base URL</FieldLabel>
                        <Input
                          id="source-base-url"
                          value={fields.baseUrl}
                          disabled={pending}
                          onChange={(event) =>
                            setFields((previous) => ({ ...previous, baseUrl: event.target.value }))
                          }
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
                          value={fields.baseUrl}
                          disabled={pending}
                          onChange={(event) =>
                            setFields((previous) => ({ ...previous, baseUrl: event.target.value }))
                          }
                          placeholder="https://api.github.com"
                          className="font-mono"
                        />
                      </Field>
                      {secretInput}
                    </>
                  ) : type === 'gitlab' ? (
                    <>
                      <Field
                        className="gap-1.5"
                        data-invalid={submitted && legacyIssues.baseUrl !== null}
                      >
                        <FieldLabel htmlFor="source-gitlab-url">
                          实例 URL <RequiredMark />
                        </FieldLabel>
                        <Input
                          id="source-gitlab-url"
                          value={fields.baseUrl}
                          disabled={pending}
                          aria-invalid={submitted && legacyIssues.baseUrl !== null}
                          aria-describedby={
                            submitted && legacyIssues.baseUrl
                              ? 'source-gitlab-url-error'
                              : undefined
                          }
                          onChange={(event) =>
                            setFields((previous) => ({ ...previous, baseUrl: event.target.value }))
                          }
                          placeholder="https://gitlab.example.com"
                          className="font-mono"
                        />
                        <FieldError id="source-gitlab-url-error">
                          {submitted ? legacyIssues.baseUrl : null}
                        </FieldError>
                      </Field>
                      {secretInput}
                    </>
                  ) : (
                    <>
                      {type === 'confluence' ? (
                        <Field className="gap-1.5 sm:col-span-2">
                          <FieldLabel htmlFor="source-confluence-auth">认证模式</FieldLabel>
                          <Select
                            value={authMode}
                            disabled={pending || editing}
                            onValueChange={(next) => {
                              if (!next || !isAuthMode(next)) return;
                              setAuthMode(next);
                              // 模式切换会换凭证类型，旧值不能带到新模式。
                              setSecret('');
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
                        </Field>
                      ) : null}
                      {specs.map((spec) => {
                        const error = fieldIssues[spec.key] ?? null;
                        const id = sourceFieldId(spec.key);
                        return (
                          <Field
                            key={spec.key}
                            className="gap-1.5"
                            data-invalid={submitted && error !== null}
                          >
                            <FieldLabel htmlFor={id}>
                              {spec.label}{' '}
                              {sourceFieldRequired(spec, authMode) ? <RequiredMark /> : null}
                            </FieldLabel>
                            <Input
                              id={id}
                              value={fields[spec.key]}
                              disabled={pending || (editing && spec.identity === true)}
                              aria-invalid={submitted && error !== null}
                              aria-describedby={submitted && error ? `${id}-error` : undefined}
                              onChange={(event) =>
                                setFields((previous) => ({
                                  ...previous,
                                  [spec.key]: event.target.value,
                                }))
                              }
                              placeholder={spec.placeholder}
                              className="font-mono"
                            />
                            <FieldError id={`${id}-error`}>{submitted ? error : null}</FieldError>
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
                <RangeRows
                  type={type}
                  ranges={ranges}
                  disabled={pending}
                  errors={ranges.map((_, index) =>
                    submitted
                      ? (rowIssues[index] ?? { externalId: null, ref: null, paths: null })
                      : { externalId: null, ref: null, paths: null },
                  )}
                  onChange={setRanges}
                />
                {issue ? <FieldError id="knowledge-source-ranges-error">{issue}</FieldError> : null}
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="knowledge-source-cron">同步 cron（UTC）</FieldLabel>
                  <Input
                    id="knowledge-source-cron"
                    value={cron}
                    disabled={pending}
                    onChange={(event) => setCron(event.target.value)}
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
                    <Switch
                      id="knowledge-source-sync-deletions"
                      checked={syncDeletions}
                      disabled={pending}
                      onCheckedChange={(checked) => setSyncDeletions(checked)}
                    />
                    <FieldLabel htmlFor="knowledge-source-sync-deletions">
                      远端删除时停用文档
                    </FieldLabel>
                  </Field>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={guard.close} disabled={pending}>
                  取消
                </Button>
                <Button type="submit" disabled={pending} aria-busy={pending}>
                  {pending ? (editing ? '保存中…' : '创建中…') : editing ? '保存' : '创建'}
                </Button>
              </div>
            </>
          )}
          {step === 'choose' ? (
            <div className="flex justify-end">
              <Button variant="outline" onClick={guard.close} disabled={pending}>
                取消
              </Button>
            </div>
          ) : null}
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
