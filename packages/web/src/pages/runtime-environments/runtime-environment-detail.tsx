import type {
  RuntimeEnvironmentVersionStatus,
  RuntimeEnvironmentVersionSummary,
} from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { EllipsisVertical, Hammer, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { BackLink } from '../../components/back-link.js';
import { CodeBlock } from '../../components/code-block.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { CopyButton } from '../../components/copy-button.js';
import { type DataColumn, DataTable } from '../../components/data-table.js';
import { FilterSelect } from '../../components/filter-select.js';
import { InspectorSheet } from '../../components/inspector-sheet.js';
import { Page, PageBody, PageHeader, PageTopbar } from '../../components/page.js';
import { RecordRows } from '../../components/record-rows.js';
import { SourceEditor } from '../../components/source-editor.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { BuildStatusLabel } from '../../components/status-badge.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { Field, FieldError, FieldLabel } from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { SegmentedToggle } from '../../components/view-toggle.js';
import { can } from '../../lib/access.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { useFormBlocker } from '../../lib/form.js';
import { formatRelative, shortId } from '../../lib/format.js';
import {
  meQuery,
  useBuildRuntimeEnvironment,
  useDeleteRuntimeEnvironment,
  usePublishRuntimeEnvironment,
  useRuntimeEnvironment,
  useRuntimeEnvironmentVersion,
  useRuntimeEnvironmentVersions,
  useUpdateRuntimeEnvironment,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';

type BuildStatus = RuntimeEnvironmentVersionStatus;
type DetailTab = 'versions' | 'dockerfile';
type InspectorView = 'log' | 'dockerfile';

const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'queued', label: '排队中' },
  { value: 'building', label: '构建中' },
  { value: 'ready', label: '就绪' },
  { value: 'failed', label: '失败' },
];

const inspectorViewOptions: readonly { value: InspectorView; label: string }[] = [
  { value: 'log', label: '构建日志' },
  { value: 'dockerfile', label: 'Dockerfile 快照' },
];

const runtimeEnvironmentFormSchema = z.object({
  name: z.string().superRefine((value, ctx) => {
    if (value.trim() === '') ctx.addIssue({ code: 'custom', message: '不能为空，请填写后再保存' });
  }),
  dockerfile: z.string(),
});
type RuntimeEnvironmentFormValues = z.infer<typeof runtimeEnvironmentFormSchema>;

export function RuntimeEnvironmentDetailPage() {
  const { environmentId } = useParams({
    from: '/_shell/runtime-environments/$environmentId',
  });
  const search = useSearch({ from: '/_shell/runtime-environments/$environmentId' });
  const navigate = useNavigate();
  const me = useQuery(meQuery);
  const canUpdate = can(me.data, 'runtime_environments.update');
  const canBuild = can(me.data, 'runtime_environments.build');
  const canPublish = can(me.data, 'runtime_environments.publish');
  const canDelete = can(me.data, 'runtime_environments.delete');
  const backTo = search.backTo ?? '/runtime-environments';
  const activeTab: DetailTab = search.tab ?? 'versions';
  const environment = useRuntimeEnvironment(environmentId);
  const versions = useRuntimeEnvironmentVersions(environmentId);
  const selectedVersion = useRuntimeEnvironmentVersion(environmentId, search.version ?? '');
  const update = useUpdateRuntimeEnvironment();
  const build = useBuildRuntimeEnvironment();
  const publish = usePublishRuntimeEnvironment();
  const remove = useDeleteRuntimeEnvironment();
  const form = useZodForm(runtimeEnvironmentFormSchema, {
    defaultValues: { name: '', dockerfile: '' },
  });
  const { control, register, reset, handleSubmit, formState } = form;
  const nameError = formState.errors.name?.message;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [inspectorView, setInspectorView] = useState<InspectorView>('log');
  const logTriggerRef = useRef<HTMLElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const baselineIdRef = useRef<string | null>(null);
  const readIsDirty = useEffectEvent(() => form.formState.isDirty);

  useEffect(() => {
    const data = environment.data;
    if (!data) return;
    if (baselineIdRef.current === data.id && readIsDirty()) return;
    reset({ name: data.name, dockerfile: data.dockerfile });
    baselineIdRef.current = data.id;
  }, [environment.data, reset]);

  const updateSearch = (patch: {
    status?: BuildStatus | undefined;
    version?: string | undefined;
    tab?: DetailTab | undefined;
  }): void => {
    void navigate({
      from: '/runtime-environments/$environmentId',
      to: '/runtime-environments/$environmentId',
      params: { environmentId },
      search: (prev) => ({ ...prev, ...patch }),
      replace: true,
    });
  };

  const openVersionInspector = (versionId: string, trigger: HTMLElement): void => {
    setInspectorView('log');
    logTriggerRef.current = trigger;
    updateSearch({ version: versionId });
  };

  const publishVersion = (version: RuntimeEnvironmentVersionSummary): void => {
    if (!environment.data) return;
    publish.mutate(
      { id: environment.data.id, versionId: version.id },
      {
        onSuccess: () => toastSuccess('线上版本已更新，只影响之后创建的容器'),
        onError: (error) => toastError(error),
      },
    );
  };

  const openVersionInspectorRef = useRef(openVersionInspector);
  openVersionInspectorRef.current = openVersionInspector;
  const publishVersionRef = useRef(publishVersion);
  publishVersionRef.current = publishVersion;

  const versionDialog = useDialogClose(
    () => updateSearch({ version: undefined }),
    search.version !== undefined,
  );
  const dirty = !leaving && formState.isDirty;
  const pending = update.isPending || remove.isPending;
  const blocker = useFormBlocker(dirty, pending, { ignoreSamePath: true });
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);

  const shownVersions = useMemo(() => {
    const list = [...(versions.data ?? [])].sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    );
    return search.status ? list.filter((version) => version.status === search.status) : list;
  }, [versions.data, search.status]);

  const onlineVersionId = environment.data?.onlineVersionId ?? null;
  const versionColumns = useMemo<DataColumn<RuntimeEnvironmentVersionSummary>[]>(
    () => [
      {
        id: 'version',
        header: '版本',
        locked: true,
        width: 'minmax(150px,1.2fr)',
        sortValue: (version) => version.id,
        cell: (version) => (
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs text-fg">{shortId(version.id)}</code>
            {version.id === onlineVersionId ? <Badge variant="secondary">线上</Badge> : null}
          </div>
        ),
      },
      {
        id: 'status',
        header: '状态',
        width: 'minmax(100px,0.8fr)',
        sortValue: (version) => version.status,
        cell: (version) => <BuildStatusLabel status={version.status} />,
      },
      {
        id: 'image',
        header: '镜像',
        width: 'minmax(130px,1fr)',
        sortValue: (version) => version.imageId,
        cell: (version) =>
          version.imageId ? (
            <code className="font-mono text-xs text-muted-foreground" title={version.imageId}>
              {shortId(version.imageId)}
            </code>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'startedAt',
        header: '开始',
        width: 'minmax(120px,0.9fr)',
        sortValue: (version) => Date.parse(version.startedAt ?? version.createdAt),
        cell: (version) => (
          <span className="text-muted-foreground">
            {formatRelative(version.startedAt ?? version.createdAt)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '操作',
        locked: true,
        align: 'end',
        width: 'minmax(160px,1fr)',
        cell: (version) => {
          const online = version.id === onlineVersionId;
          return (
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                aria-label={`查看版本 ${shortId(version.id)} 的构建日志`}
                onClick={(event) => {
                  event.stopPropagation();
                  openVersionInspectorRef.current(version.id, event.currentTarget);
                }}
              >
                日志
              </Button>
              {canPublish && version.status === 'ready' && !online ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={publish.isPending}
                  onClick={(event) => {
                    event.stopPropagation();
                    publishVersionRef.current(version);
                  }}
                >
                  <RotateCcw data-icon="inline-start" /> 设为线上
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [canPublish, onlineVersionId, publish.isPending],
  );

  if (environment.isPending) {
    return (
      <Page>
        <PageTopbar>
          <PageHeader title="运行环境" />
        </PageTopbar>
        <PageBody>
          <LoadingState rows={4} />
        </PageBody>
      </Page>
    );
  }

  if (environment.data === undefined) {
    return (
      <Page>
        <PageTopbar>
          <PageHeader title="运行环境" />
        </PageTopbar>
        <PageBody>
          <ErrorState error={environment.error} onRetry={() => void environment.refetch()} />
        </PageBody>
      </Page>
    );
  }

  const current = environment.data;

  const save = handleSubmit(async (values: RuntimeEnvironmentFormValues) => {
    if (!canUpdate) return;
    try {
      const saved = await update.mutateAsync({
        id: current.id,
        patch: { name: values.name.trim(), dockerfile: values.dockerfile },
      });
      reset({ name: saved.name, dockerfile: saved.dockerfile });
      baselineIdRef.current = saved.id;
      toastSuccess('已保存');
    } catch (error) {
      toastError(error);
    }
  });

  const startBuild = (): void => {
    if (dirty) {
      toastError(new Error('请先保存配置，再构建新版本。'));
      return;
    }
    build.mutate(current.id, {
      onSuccess: () => toastSuccess('已提交构建'),
      onError: (error) => toastError(error),
    });
  };

  const deleteEnvironment = async (): Promise<void> => {
    await remove.mutateAsync(current.id);
    blockerRef.current.reset?.();
    setLeaving(true);
    toastSuccess('已删除运行环境');
    void navigate({ href: backTo, ignoreBlocker: true });
  };

  const canPublishSelected =
    canPublish &&
    selectedVersion.data?.status === 'ready' &&
    selectedVersion.data.id !== current.onlineVersionId;

  return (
    <Page>
      <Tabs
        value={activeTab}
        onValueChange={(next, details) => {
          details.cancel();
          if (next === activeTab || (next !== 'versions' && next !== 'dockerfile')) return;
          updateSearch({ tab: next });
        }}
        className="min-h-0 flex-1 gap-4"
      >
        <PageTopbar>
          <PageHeader
            title={current.name}
            eyebrow={
              <div className="flex flex-wrap items-center gap-1.5">
                {current.isDefault ? <Badge variant="secondary">默认</Badge> : null}
                {current.onlineVersionId ? (
                  <Badge variant="outline" className="font-mono">
                    线上 {shortId(current.onlineVersionId)}
                  </Badge>
                ) : (
                  <Badge variant="outline">未发布线上版本</Badge>
                )}
              </div>
            }
            leading={
              <BackLink to={backTo} label={search.backTo ? '返回来源' : '返回运行环境列表'} />
            }
            actions={
              canBuild || canDelete ? (
                <>
                  {canBuild ? (
                    <Button onClick={startBuild} disabled={build.isPending}>
                      <Hammer data-icon="inline-start" />
                      {build.isPending ? '提交中…' : '构建新版本'}
                    </Button>
                  ) : null}
                  {canDelete ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            ref={deleteTriggerRef}
                            variant="ghost"
                            size="icon"
                            aria-label="运行环境操作"
                          >
                            <EllipsisVertical />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end">
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={current.isDefault}
                            title={current.isDefault ? '默认运行环境不能删除' : undefined}
                            onSelect={() => setConfirmingDelete(true)}
                          >
                            <Trash2 aria-hidden="true" /> 删除
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </>
              ) : undefined
            }
          />
          <div className="border-b border-line">
            <TabsList variant="line" aria-label="运行环境分区">
              <TabsTrigger value="versions">
                版本与构建
                {versions.data !== undefined ? (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {versions.data.length}
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="dockerfile">
                Dockerfile 配置
                {dirty ? (
                  <>
                    <span
                      className="size-1.5 rounded-full bg-fg"
                      title="有未保存更改"
                      aria-hidden="true"
                    />
                    <span className="sr-only">（有未保存更改）</span>
                  </>
                ) : null}
              </TabsTrigger>
            </TabsList>
          </div>
        </PageTopbar>

        <PageBody>
          {environment.isError ? (
            <ErrorState error={environment.error} onRetry={() => void environment.refetch()} />
          ) : null}

          <TabsContent value="versions" className="flex min-w-0 flex-col gap-4">
            {activeTab === 'versions' ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <FilterSelect
                    value={search.status ?? 'all'}
                    onValueChange={(next) =>
                      updateSearch({
                        status: next === 'all' ? undefined : (next as BuildStatus),
                      })
                    }
                    options={statusOptions}
                    label="按构建状态筛选"
                    className="w-36"
                  />
                </div>

                {versions.isPending ? <LoadingState rows={3} /> : null}
                {versions.isError ? (
                  <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
                ) : null}
                {versions.data && versions.data.length === 0 ? (
                  <EmptyState
                    variant="stage"
                    scale="section"
                    icon={<Hammer className="size-5" aria-hidden="true" />}
                    title="构建第一个镜像版本"
                    description="保存 Dockerfile 配置后触发构建，就绪版本可设为线上环境。"
                    action={
                      canBuild ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={startBuild}
                          disabled={build.isPending}
                        >
                          构建新版本
                        </Button>
                      ) : undefined
                    }
                  />
                ) : null}
                {versions.data && versions.data.length > 0 && shownVersions.length === 0 ? (
                  <EmptyState
                    variant="filter"
                    scale="section"
                    title="该状态下没有构建版本"
                    activeFilters={
                      search.status
                        ? [
                            {
                              key: 'status',
                              label: '状态',
                              value:
                                statusOptions.find((option) => option.value === search.status)
                                  ?.label ?? search.status,
                              onRemove: () => updateSearch({ status: undefined }),
                            },
                          ]
                        : undefined
                    }
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => updateSearch({ status: undefined })}
                      >
                        清除筛选
                      </Button>
                    }
                  />
                ) : null}

                {shownVersions.length > 0 ? (
                  <DataTable
                    rows={shownVersions}
                    columns={versionColumns}
                    rowKey={(version) => version.id}
                    rowLabel={(version) => `版本 ${shortId(version.id)}`}
                    label="构建版本列表"
                    storageKey="pace.runtime-environment.versions-columns"
                    hideRowCount
                    onRowClick={(version, trigger) => openVersionInspector(version.id, trigger)}
                  />
                ) : null}
              </>
            ) : null}
          </TabsContent>

          <TabsContent value="dockerfile" className="flex min-h-0 flex-1 flex-col">
            {activeTab === 'dockerfile' ? (
              <form className="flex min-h-0 flex-1 flex-col gap-4" onSubmit={save}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <Field
                    orientation="horizontal"
                    className="w-auto items-start gap-3"
                    data-disabled={update.isPending}
                    data-invalid={Boolean(nameError)}
                  >
                    <FieldLabel htmlFor="runtime-environment-name" className="h-8 shrink-0">
                      名称
                    </FieldLabel>
                    <div className="flex flex-col gap-1">
                      <Input
                        {...register('name')}
                        id="runtime-environment-name"
                        maxLength={64}
                        autoComplete="off"
                        readOnly={!canUpdate}
                        disabled={update.isPending}
                        aria-required="true"
                        aria-invalid={Boolean(nameError)}
                        aria-describedby={nameError ? 'runtime-environment-name-error' : undefined}
                        className="w-64"
                      />
                      <FieldError id="runtime-environment-name-error">{nameError}</FieldError>
                    </div>
                  </Field>
                  {canUpdate ? (
                    <div className="flex items-center gap-3">
                      {dirty ? (
                        <span className="text-xs text-muted-foreground">有未保存更改</span>
                      ) : null}
                      <Button type="submit" disabled={!dirty || update.isPending}>
                        {update.isPending ? '保存中…' : '保存更改'}
                      </Button>
                    </div>
                  ) : null}
                </div>
                <Field className="flex min-h-0 flex-1 flex-col" data-disabled={update.isPending}>
                  <FieldLabel htmlFor="runtime-environment-dockerfile">Dockerfile</FieldLabel>
                  <Controller
                    control={control}
                    name="dockerfile"
                    render={({ field }) => (
                      <SourceEditor
                        id="runtime-environment-dockerfile"
                        language="text"
                        aria-label="Dockerfile"
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        readOnly={!canUpdate}
                        disabled={update.isPending}
                        className="min-h-[360px] flex-1"
                      />
                    )}
                  />
                </Field>
              </form>
            ) : null}
          </TabsContent>
        </PageBody>
      </Tabs>

      {search.version ? (
        <InspectorSheet
          open={versionDialog.open}
          onOpenChange={(next) => {
            if (!next) versionDialog.close();
          }}
          onOpenChangeComplete={versionDialog.onOpenChangeComplete}
          size="lg"
          title={`版本 ${shortId(search.version)}`}
          eyebrow={
            selectedVersion.data ? <BuildStatusLabel status={selectedVersion.data.status} /> : null
          }
          finalFocus={() => (logTriggerRef.current?.isConnected ? logTriggerRef.current : null)}
          footer={
            canPublishSelected ? (
              <div className="flex justify-end">
                <Button
                  disabled={publish.isPending}
                  onClick={() => {
                    if (selectedVersion.data) publishVersion(selectedVersion.data);
                  }}
                >
                  <RotateCcw data-icon="inline-start" /> 设为线上
                </Button>
              </div>
            ) : undefined
          }
        >
          {selectedVersion.isPending ? <LoadingState rows={3} /> : null}
          {selectedVersion.isError ? (
            <ErrorState
              error={selectedVersion.error}
              onRetry={() => void selectedVersion.refetch()}
            />
          ) : null}
          {selectedVersion.data ? (
            <div className="flex flex-col gap-4">
              <RecordRows
                rows={[
                  {
                    label: '版本 ID',
                    value: (
                      <span className="inline-flex max-w-full items-center justify-end gap-1">
                        <span
                          className="truncate font-mono text-xs"
                          title={selectedVersion.data.id}
                        >
                          {selectedVersion.data.id}
                        </span>
                        <CopyButton value={selectedVersion.data.id} label="复制版本 ID" />
                      </span>
                    ),
                  },
                  {
                    label: '镜像',
                    value: selectedVersion.data.imageId ? (
                      <span className="inline-flex max-w-full items-center justify-end gap-1">
                        <span
                          className="truncate font-mono text-xs"
                          title={selectedVersion.data.imageId}
                        >
                          {selectedVersion.data.imageId}
                        </span>
                        <CopyButton value={selectedVersion.data.imageId} label="复制镜像 ID" />
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    ),
                  },
                  {
                    label: '开始时间',
                    value: formatRelative(
                      selectedVersion.data.startedAt ?? selectedVersion.data.createdAt,
                    ),
                  },
                  {
                    label: '完成时间',
                    value: selectedVersion.data.finishedAt
                      ? formatRelative(selectedVersion.data.finishedAt)
                      : '—',
                  },
                ]}
              />

              {selectedVersion.data.error ? (
                <div
                  role="alert"
                  className="flex flex-col gap-1 rounded-item border border-danger/20 bg-danger-soft px-3 py-2.5 text-sm"
                >
                  <p className="font-medium text-danger [overflow-wrap:anywhere]">
                    {selectedVersion.data.error}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    检查 Dockerfile 并保存更改，再点「构建新版本」重试。
                  </p>
                </div>
              ) : null}

              <div className="flex flex-col gap-3">
                <div>
                  <SegmentedToggle
                    label="切换版本详情内容"
                    value={inspectorView}
                    options={inspectorViewOptions}
                    onChange={setInspectorView}
                  />
                </div>
                {inspectorView === 'log' ? (
                  <div className="flex flex-col gap-2">
                    {selectedVersion.data.buildLog ? (
                      <CodeBlock
                        code={selectedVersion.data.buildLog}
                        maxHeight="55dvh"
                        copyLabel="复制日志"
                      />
                    ) : (
                      <div className="rounded-item border border-line bg-sunken px-3 py-6 text-center text-xs text-muted-foreground">
                        {selectedVersion.data.status === 'queued' ||
                        selectedVersion.data.status === 'building'
                          ? '构建还没有输出日志'
                          : '没有日志'}
                      </div>
                    )}
                    {selectedVersion.data.logTruncated ? (
                      <p className="text-xs text-muted-foreground">日志已截断，仅保留最近部分。</p>
                    ) : null}
                  </div>
                ) : (
                  <CodeBlock
                    code={selectedVersion.data.dockerfile}
                    lineNumbers
                    maxHeight="55dvh"
                    copyLabel="复制 Dockerfile"
                  />
                )}
              </div>
            </div>
          ) : null}
        </InspectorSheet>
      ) : null}

      {confirmingDelete ? (
        <ConfirmDialog
          open
          title="删除运行环境"
          description={`删除「${current.name}」及其全部构建版本记录，此操作不可撤销。`}
          onClose={() => setConfirmingDelete(false)}
          onConfirm={deleteEnvironment}
          finalFocus={() =>
            deleteTriggerRef.current?.isConnected ? deleteTriggerRef.current : null
          }
        />
      ) : null}
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="放弃未保存的更改？"
        description={
          update.isPending
            ? '正在保存，请等待请求完成。'
            : remove.isPending
              ? '正在删除，请等待请求完成。'
              : '离开后运行环境配置的修改会丢失。'
        }
        confirmLabel="放弃并离开"
        confirmDisabled={pending}
        onConfirm={async () => blocker.proceed()}
      />
    </Page>
  );
}
