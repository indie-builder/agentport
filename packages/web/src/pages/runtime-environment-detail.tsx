import type {
  RuntimeEnvironmentVersionStatus,
  RuntimeEnvironmentVersionSummary,
} from '@agentport/shared';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  CircleAlert,
  CircleCheck,
  Clock,
  Hammer,
  LoaderCircle,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { FilterSelect } from '../components/filter-select.js';
import { Page, PageHeader, PageNote, PageSection } from '../components/page.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Dialog } from '../components/ui/dialog.js';
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { Textarea } from '../components/ui/textarea.js';
import { useFormBlocker } from '../lib/form.js';
import { formatRelative, shortId } from '../lib/format.js';
import {
  useBuildRuntimeEnvironment,
  useDeleteRuntimeEnvironment,
  usePublishRuntimeEnvironment,
  useRuntimeEnvironment,
  useRuntimeEnvironmentVersion,
  useRuntimeEnvironmentVersions,
  useUpdateRuntimeEnvironment,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';

type BuildStatus = RuntimeEnvironmentVersionStatus;

const statusMeta: Record<
  BuildStatus,
  { label: string; icon: typeof CircleCheck; className: string }
> = {
  queued: { label: '排队中', icon: Clock, className: 'text-muted-foreground' },
  building: { label: '构建中', icon: LoaderCircle, className: 'text-fg' },
  ready: { label: '就绪', icon: CircleCheck, className: 'text-success' },
  failed: { label: '失败', icon: CircleAlert, className: 'text-danger' },
};

const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'queued', label: '排队中' },
  { value: 'building', label: '构建中' },
  { value: 'ready', label: '就绪' },
  { value: 'failed', label: '失败' },
];

function StatusLabel({ status }: { status: BuildStatus }) {
  const meta = statusMeta[status];
  const Icon = meta.icon;
  return (
    <span className={`flex items-center gap-1.5 ${meta.className}`}>
      <Icon
        className={status === 'building' ? 'size-3.5 animate-spin' : 'size-3.5'}
        aria-hidden="true"
      />
      {meta.label}
    </span>
  );
}

export function RuntimeEnvironmentDetailPage() {
  const { environmentId } = useParams({
    from: '/_shell/runtime-environments/$environmentId',
  });
  const search = useSearch({ from: '/_shell/runtime-environments/$environmentId' });
  const navigate = useNavigate({ from: '/runtime-environments/$environmentId' });
  const environment = useRuntimeEnvironment(environmentId);
  const versions = useRuntimeEnvironmentVersions(environmentId);
  const selectedVersion = useRuntimeEnvironmentVersion(environmentId, search.version ?? '');
  const update = useUpdateRuntimeEnvironment();
  const build = useBuildRuntimeEnvironment();
  const publish = usePublishRuntimeEnvironment();
  const remove = useDeleteRuntimeEnvironment();
  const [name, setName] = useState('');
  const [dockerfile, setDockerfile] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // 删除成功后实体已不存在，草稿无需再保护；用状态确保重渲染后 guard 立即解除。
  const [leaving, setLeaving] = useState(false);
  const logTriggerRef = useRef<HTMLElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  // 线上指针变化也会刷新环境；有未保存草稿时不能被这次刷新盖掉。
  const savedRef = useRef<{ id: string; name: string; dockerfile: string } | null>(null);
  const draftRef = useRef({ name, dockerfile });
  draftRef.current = { name, dockerfile };

  useEffect(() => {
    const data = environment.data;
    if (!data) return;
    const saved = { id: data.id, name: data.name, dockerfile: data.dockerfile };
    const previous = savedRef.current;
    // 同实体仍有草稿时，后台刷新不能推进基线：否则服务器值偶合草稿后会被误判为无草稿，后续刷新覆盖草稿。
    const editing =
      previous !== null &&
      previous.id === saved.id &&
      (draftRef.current.name !== previous.name ||
        draftRef.current.dockerfile !== previous.dockerfile);
    if (editing) return;
    setName(saved.name);
    setDockerfile(saved.dockerfile);
    setNameError(null);
    savedRef.current = saved;
  }, [environment.data]);

  const updateSearch = (patch: {
    status?: BuildStatus | undefined;
    version?: string | undefined;
  }): void => {
    void navigate({
      to: '/runtime-environments/$environmentId',
      params: { environmentId },
      search: (current) => ({ ...current, ...patch }),
      replace: true,
    });
  };

  const dirty =
    !leaving &&
    Boolean(
      savedRef.current &&
        (name !== savedRef.current.name || dockerfile !== savedRef.current.dockerfile),
    );
  const pending = update.isPending || remove.isPending;
  const blocker = useFormBlocker(dirty, pending, { ignoreSamePath: true });
  // 成功回调读不到拦截发生后的 blocker 实例：用 ref 拿最新一次再结算。
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

  if (environment.isPending) {
    return (
      <Page>
        <PageHeader title="运行环境" />
        <LoadingState rows={4} />
      </Page>
    );
  }

  if (environment.data === undefined) {
    return (
      <Page>
        <PageHeader title="运行环境" />
        <ErrorState error={environment.error} onRetry={() => void environment.refetch()} />
      </Page>
    );
  }

  const current = environment.data;

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('不能为空，请填写后再保存');
      return;
    }
    setNameError(null);
    try {
      const saved = await update.mutateAsync({
        id: current.id,
        patch: { name: trimmed, dockerfile },
      });
      // 保存返回值可能被服务端规范化（如去掉首尾空格）；草稿与基线一起同步，避免永久 dirty。
      savedRef.current = { id: saved.id, name: saved.name, dockerfile: saved.dockerfile };
      setName(saved.name);
      setDockerfile(saved.dockerfile);
      toastSuccess('已保存');
    } catch (error) {
      toastError(error);
    }
  };

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

  const publishVersion = (version: RuntimeEnvironmentVersionSummary): void => {
    publish.mutate(
      { id: current.id, versionId: version.id },
      {
        onSuccess: () => toastSuccess('线上版本已更新，只影响之后创建的容器'),
        onError: (error) => toastError(error),
      },
    );
  };

  const deleteEnvironment = async (): Promise<void> => {
    await remove.mutateAsync(current.id);
    // 删除成功后实体已不存在；先结算期间被拦下的离开，再解除草稿保护返回列表。
    blockerRef.current.reset?.();
    setLeaving(true);
    toastSuccess('已删除运行环境');
    // 忽略 blocker 的旧快照，避免刚解除的草稿拦截抢先拦住这次返回。
    void navigate({ to: '/runtime-environments', ignoreBlocker: true });
  };

  return (
    <Page>
      <PageHeader
        title={current.name}
        eyebrow={current.isDefault ? <Badge variant="secondary">默认</Badge> : null}
        actions={
          <>
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link to="/runtime-environments" />}
            >
              返回列表
            </Button>
            <Button onClick={startBuild} disabled={build.isPending}>
              <Hammer data-icon="inline-start" />
              {build.isPending ? '提交中…' : '构建新版本'}
            </Button>
            <Button
              ref={deleteTriggerRef}
              variant="destructive"
              disabled={current.isDefault}
              title={current.isDefault ? '默认运行环境不能删除' : undefined}
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 data-icon="inline-start" /> 删除
            </Button>
          </>
        }
      />

      {environment.isError ? (
        <ErrorState error={environment.error} onRetry={() => void environment.refetch()} />
      ) : null}

      <PageSection title="配置">
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <FieldGroup>
            <Field
              orientation="horizontal"
              className="gap-3"
              data-disabled={update.isPending}
              data-invalid={Boolean(nameError)}
            >
              <FieldContent>
                <FieldLabel htmlFor="runtime-environment-name">名称</FieldLabel>
                <FieldError id="runtime-environment-name-error">{nameError}</FieldError>
              </FieldContent>
              <Input
                id="runtime-environment-name"
                value={name}
                maxLength={64}
                autoComplete="off"
                disabled={update.isPending}
                aria-required="true"
                aria-invalid={Boolean(nameError)}
                aria-describedby={nameError ? 'runtime-environment-name-error' : undefined}
                className="w-64"
                onChange={(event) => {
                  setName(event.currentTarget.value);
                  setNameError(null);
                }}
              />
            </Field>
            <Field data-disabled={update.isPending}>
              <FieldLabel htmlFor="runtime-environment-dockerfile">Dockerfile</FieldLabel>
              <Textarea
                id="runtime-environment-dockerfile"
                value={dockerfile}
                rows={18}
                spellCheck={false}
                disabled={update.isPending}
                className="font-mono text-xs leading-relaxed"
                onChange={(event) => setDockerfile(event.currentTarget.value)}
              />
            </Field>
          </FieldGroup>
          <div className="flex justify-end">
            <Button type="submit" disabled={!dirty || update.isPending}>
              {update.isPending ? '保存中…' : '保存更改'}
            </Button>
          </div>
        </form>
      </PageSection>

      <PageSection
        title="版本"
        actions={
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
        }
      >
        {versions.isPending ? <LoadingState rows={3} /> : null}
        {versions.isError ? (
          <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
        ) : null}
        {versions.data && versions.data.length === 0 ? (
          <PageNote
            icon={<Hammer className="size-4" aria-hidden="true" />}
            title="还没有构建版本"
            action={<Button onClick={startBuild}>构建新版本</Button>}
          />
        ) : null}
        {versions.data && versions.data.length > 0 && shownVersions.length === 0 ? (
          <PageNote
            title="该状态下没有构建版本"
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>版本</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>镜像</TableHead>
                <TableHead>开始</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownVersions.map((version) => {
                const online = version.id === current.onlineVersionId;
                return (
                  <TableRow key={version.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-xs text-muted-foreground">
                          {shortId(version.id)}
                        </code>
                        {online ? <Badge variant="secondary">线上</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusLabel status={version.status} />
                    </TableCell>
                    <TableCell>
                      {version.imageId ? (
                        <code
                          className="font-mono text-xs text-muted-foreground"
                          title={version.imageId}
                        >
                          {shortId(version.imageId)}
                        </code>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatRelative(version.startedAt ?? version.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(event) => {
                            logTriggerRef.current = event.currentTarget;
                            updateSearch({ version: version.id });
                          }}
                        >
                          日志
                        </Button>
                        {version.status === 'ready' && !online ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={publish.isPending}
                            onClick={() => publishVersion(version)}
                          >
                            <RotateCcw data-icon="inline-start" /> 设为线上
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
      </PageSection>

      {search.version ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) updateSearch({ version: undefined });
          }}
        >
          <DialogShell
            title={`版本详情 · ${shortId(search.version)}`}
            closeDisabled={false}
            finalFocus={() => (logTriggerRef.current?.isConnected ? logTriggerRef.current : null)}
            className="max-w-3xl sm:max-w-3xl"
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
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">状态</dt>
                  <dd>
                    <StatusLabel status={selectedVersion.data.status} />
                  </dd>
                  <dt className="text-muted-foreground">版本 ID</dt>
                  <dd className="min-w-0 font-mono text-fg [overflow-wrap:anywhere]">
                    {selectedVersion.data.id}
                  </dd>
                  <dt className="text-muted-foreground">镜像</dt>
                  <dd className="min-w-0 font-mono text-fg [overflow-wrap:anywhere]">
                    {selectedVersion.data.imageId ?? '—'}
                  </dd>
                  <dt className="text-muted-foreground">开始</dt>
                  <dd className="text-fg">
                    {formatRelative(
                      selectedVersion.data.startedAt ?? selectedVersion.data.createdAt,
                    )}
                  </dd>
                  <dt className="text-muted-foreground">完成</dt>
                  <dd className="text-fg">
                    {selectedVersion.data.finishedAt
                      ? formatRelative(selectedVersion.data.finishedAt)
                      : '—'}
                  </dd>
                </dl>
                {selectedVersion.data.error ? (
                  <div className="flex flex-col gap-1.5">
                    <ErrorState error={new Error(selectedVersion.data.error)} title="构建失败" />
                    <p className="text-xs text-muted-foreground">
                      检查 Dockerfile 并保存更改，再点「构建新版本」重试。
                    </p>
                  </div>
                ) : null}
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="runtime-environment-version-dockerfile">
                      Dockerfile 快照
                    </FieldLabel>
                    <Textarea
                      id="runtime-environment-version-dockerfile"
                      readOnly
                      rows={10}
                      spellCheck={false}
                      value={selectedVersion.data.dockerfile}
                      className="font-mono text-xs leading-relaxed"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="runtime-environment-version-log">构建日志</FieldLabel>
                    <Textarea
                      id="runtime-environment-version-log"
                      readOnly
                      rows={16}
                      spellCheck={false}
                      value={selectedVersion.data.buildLog}
                      placeholder={
                        selectedVersion.data.status === 'queued' ||
                        selectedVersion.data.status === 'building'
                          ? '构建还没有输出日志'
                          : '没有日志'
                      }
                      className="min-h-72 font-mono text-xs leading-relaxed"
                    />
                    {selectedVersion.data.logTruncated ? (
                      <p className="text-xs text-muted-foreground">日志已截断，仅保留最近部分。</p>
                    ) : null}
                  </Field>
                </FieldGroup>
              </div>
            ) : null}
          </DialogShell>
        </Dialog>
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
