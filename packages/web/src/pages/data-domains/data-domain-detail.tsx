import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  CircleAlert,
  CircleCheck,
  Clock,
  Database,
  EllipsisVertical,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackLink } from '../../components/back-link.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DialogShell } from '../../components/dialog-shell.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageSection,
  PageTopbar,
} from '../../components/page.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { Badge } from '../../components/ui/badge.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { Field, FieldDescription, FieldError, FieldLabel } from '../../components/ui/field.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { Textarea } from '../../components/ui/textarea.js';
import { can } from '../../lib/access.js';
import type { DataDomainVersion } from '../../lib/api.js';
import { errorMessage } from '../../lib/api.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { useFormBlocker } from '../../lib/form.js';
import { formatBytes, formatRelative, shortId } from '../../lib/format.js';
import {
  dataDomainBuildShouldPoll,
  meQuery,
  useCreateDataDomainVersion,
  useDataDomain,
  useDataDomainVersion,
  useDataDomainVersions,
  useDeleteDataDomain,
  useGenerateDataDomainMdl,
  usePublishDataDomain,
  useServers,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { DataDomainApprovals } from './data-domain-approvals.js';
import { DataDomainEnrichment } from './data-domain-enrichment.js';
import { DataDomainFormDialog } from './data-domain-form-dialog.js';
import { DataDomainIdentities } from './data-domain-identities.js';
import { DataDomainQueryLogs } from './data-domain-query-logs.js';

type BuildStatus = DataDomainVersion['status'];

const statusMeta: Record<
  BuildStatus,
  { label: string; icon: typeof CircleCheck; className: string }
> = {
  queued: { label: '排队中', icon: Clock, className: 'text-muted-foreground' },
  building: { label: '构建中', icon: LoaderCircle, className: 'text-fg' },
  ready: { label: '就绪', icon: CircleCheck, className: 'text-success' },
  failed: { label: '失败', icon: CircleAlert, className: 'text-danger' },
};

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

const buildFileAccept = '.json,.yaml,.yml,.txt,.md,.csv,.toml,.sql';
const importFileMaxBytes = 512 * 1024;
const importTotalMaxBytes = 800 * 1024;
const importBodyMaxBytes = 1024 * 1024 - 4 * 1024;

export function DataDomainDetailPage() {
  const { dataDomainId } = useParams({ from: '/_shell/data-domains/$dataDomainId' });
  const search = useSearch({ from: '/_shell/data-domains/$dataDomainId' });
  const navigate = useNavigate();
  const me = useQuery(meQuery);
  const domain = useDataDomain(dataDomainId);
  const versions = useDataDomainVersions(dataDomainId);
  const selectedVersion = useDataDomainVersion(dataDomainId, search.version ?? '');
  const publish = usePublishDataDomain();
  const remove = useDeleteDataDomain();
  const createVersion = useCreateDataDomainVersion();
  const generateMdl = useGenerateDataDomainMdl();
  const canUpdate = can(me.data, 'data_domains.update');
  const canDelete = can(me.data, 'data_domains.delete');
  const canBuild = can(me.data, 'data_domains.build');
  const canPublish = can(me.data, 'data_domains.publish');
  const canTest = can(me.data, 'data_domains.create');
  const canReadServers = can(me.data, 'servers.read');
  const servers = useServers(canReadServers);
  const backTo = search.backTo ?? '/data-domains';
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [publishing, setPublishing] = useState<DataDomainVersion | null>(null);
  const [projectFiles, setProjectFiles] = useState<Record<string, string>>({});
  const [importError, setImportError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [loadedDomainId, setLoadedDomainId] = useState(dataDomainId);
  if (loadedDomainId !== dataDomainId) {
    setLoadedDomainId(dataDomainId);
    setProjectFiles({});
    setImportError(null);
    setReading(false);
    setEditing(false);
  }
  const fileInputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const editTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const logTriggerRef = useRef<HTMLElement | null>(null);
  const publishTriggerRef = useRef<HTMLElement | null>(null);
  const importDirty = Object.keys(projectFiles).length > 0;
  const importPending = reading || createVersion.isPending;
  const importBlocker = useFormBlocker(importDirty, importPending, { ignoreSamePath: true });
  const blockerRef = useRef(importBlocker);
  useEffect(() => {
    blockerRef.current = importBlocker;
  }, [importBlocker]);

  const updateSearch = (patch: { version?: string | undefined }): void => {
    void navigate({
      to: '/data-domains/$dataDomainId',
      params: { dataDomainId },
      search: { ...search, ...patch },
      replace: true,
    });
  };

  const versionDialog = useDialogClose(
    () => updateSearch({ version: undefined }),
    search.version !== undefined,
  );
  const setDirectoryInput = useCallback((node: HTMLInputElement | null) => {
    directoryInputRef.current = node;
    node?.setAttribute('webkitdirectory', '');
  }, []);
  const shownVersions = useMemo(
    () =>
      [...(versions.data ?? [])].sort(
        (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
      ),
    [versions.data],
  );
  const readyVersions = useMemo(
    () => shownVersions.filter((version) => version.status === 'ready'),
    [shownVersions],
  );

  if (domain.isPending) {
    return (
      <Page>
        <PageTopbar>
          <PageHeader title="数据域" />
        </PageTopbar>
        <PageBody>
          <LoadingState rows={4} />
        </PageBody>
      </Page>
    );
  }

  if (domain.data === undefined) {
    return (
      <Page>
        <PageTopbar>
          <PageHeader title="数据域" />
        </PageTopbar>
        <PageBody>
          <ErrorState error={domain.error} onRetry={() => void domain.refetch()} />
        </PageBody>
      </Page>
    );
  }

  const current = domain.data;
  const connector = servers.data?.find(
    (server) => server.kind === 'data_domain' && server.config.dataDomainId === current.id,
  );
  const connectorName = connector?.name ?? `dd-${current.slug}`;

  const addFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    const withPaths = files.map((file) => ({
      file,
      path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    }));
    const roots = new Set(withPaths.map(({ path }) => path.split('/')[0] ?? ''));
    const stripRoot = roots.size === 1 && withPaths.every(({ path }) => path.includes('/'));
    const entries = withPaths.map(({ file, path }) => ({
      file,
      path: stripRoot ? path.slice(path.indexOf('/') + 1) : path,
    }));
    const blocked = entries.find(({ path }) => {
      const name = path.split('/').at(-1);
      return name === '.env' || name === 'profiles.yml';
    });
    if (blocked) {
      setImportError(`不能导入 ${blocked.path}：凭据文件请留在本地`);
      return;
    }
    const paths = entries.map((entry) => entry.path);
    const duplicate = paths.find(
      (path, index) => paths.indexOf(path) !== index || Object.hasOwn(projectFiles, path),
    );
    if (duplicate) {
      setImportError(`文件重名：${duplicate}，请重命名后再导入`);
      return;
    }
    const oversized = entries.find(({ file }) => file.size > importFileMaxBytes);
    if (oversized) {
      setImportError(`${oversized.path} 超过单文件 ${formatBytes(importFileMaxBytes)} 上限`);
      return;
    }
    const existingBytes = Object.values(projectFiles).reduce(
      (total, content) => total + new TextEncoder().encode(content).length,
      0,
    );
    const addedBytes = entries.reduce((total, { file }) => total + file.size, 0);
    if (existingBytes + addedBytes > importTotalMaxBytes) {
      setImportError(
        `待构建文件合计超过 ${formatBytes(importTotalMaxBytes)} 上限，请减少文件后重试`,
      );
      return;
    }
    setReading(true);
    setImportError(null);
    try {
      const contents = await Promise.all(
        entries.map(async ({ file, path }) => [path, await file.text()] as const),
      );
      setProjectFiles((values) => ({ ...values, ...Object.fromEntries(contents) }));
    } catch {
      setImportError('读取文件失败，请重试');
    } finally {
      setReading(false);
    }
  };

  const removeFile = (name: string): void => {
    setImportError(null);
    setProjectFiles((values) =>
      Object.fromEntries(Object.entries(values).filter(([key]) => key !== name)),
    );
  };

  const submitBuild = async (): Promise<void> => {
    if (Object.keys(projectFiles).length === 0) return;
    if (new TextEncoder().encode(JSON.stringify({ projectFiles })).length > importBodyMaxBytes) {
      setImportError(`提交内容超过 ${formatBytes(importBodyMaxBytes)} 上限，请减少文件后重试`);
      return;
    }
    setImportError(null);
    try {
      await createVersion.mutateAsync({ id: current.id, projectFiles });
      setProjectFiles({});
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (directoryInputRef.current) directoryInputRef.current.value = '';
      blockerRef.current.reset?.();
      toastSuccess('已提交构建');
    } catch (error) {
      setImportError(errorMessage(error));
    }
  };

  const generateDraft = (): void => {
    generateMdl.mutate(current.id, {
      onSuccess: () => toastSuccess('已提交结构反射，正在生成草稿版本'),
      onError: (error) => toastError(error),
    });
  };

  const deleteDomain = async (): Promise<void> => {
    await remove.mutateAsync(current.id);
    blockerRef.current.reset?.();
    toastSuccess('已删除数据域');
    void navigate({ href: backTo, ignoreBlocker: true });
  };

  const building = reading || createVersion.isPending;
  const interacting = building || generateMdl.isPending || publish.isPending || remove.isPending;

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          title={current.name}
          eyebrow={
            current.onlineVersionId ? (
              <Badge variant="secondary">在线 {shortId(current.onlineVersionId)}</Badge>
            ) : (
              <Badge variant="outline">未发布</Badge>
            )
          }
          description={`${current.slug} · ${current.datasource}`}
          leading={<BackLink to={backTo} label={search.backTo ? '返回来源' : '返回数据域列表'} />}
          actions={
            canUpdate || canDelete ? (
              <>
                {canUpdate ? (
                  <Button
                    ref={editTriggerRef}
                    disabled={interacting}
                    onClick={() => setEditing(true)}
                  >
                    <Pencil data-icon="inline-start" /> 编辑
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
                          aria-label="更多操作"
                          disabled={interacting}
                        >
                          <EllipsisVertical aria-hidden="true" />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end" sideOffset={4} className="w-44">
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={interacting}
                        onSelect={() => setConfirmingDelete(true)}
                      >
                        <Trash2 /> 删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </>
            ) : undefined
          }
        />
      </PageTopbar>

      <PageBody>
        {domain.isError ? (
          <ErrorState error={domain.error} onRetry={() => void domain.refetch()} />
        ) : null}

        <PageSection title="配置" divided={false}>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">标识</dt>
            <dd className="min-w-0">
              <code className="font-mono text-xs text-fg [overflow-wrap:anywhere]">
                {current.slug}
              </code>
            </dd>
            <dt className="text-muted-foreground">数据源</dt>
            <dd className="font-mono text-xs text-fg">{current.datasource}</dd>
            <dt className="text-muted-foreground">查询审批</dt>
            <dd className="text-fg">
              {current.queryApprovalMode === 'all' ? '每次查询需审批' : '关闭'}
            </dd>
            <dt className="text-muted-foreground">连接器</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-2">
              <code className="font-mono text-xs text-fg">{connectorName}</code>
              <Link
                to="/servers"
                search={{ q: connectorName, kind: 'data_domain' }}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                去连接器查看
              </Link>
            </dd>
            {current.description ? (
              <>
                <dt className="text-muted-foreground">描述</dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words text-fg">
                  {current.description}
                </dd>
              </>
            ) : null}
          </dl>
          <p className="text-sm text-muted-foreground">
            在「专家编辑 → 连接器」中勾选 {connectorName}，专家即可通过该数据域查询。
          </p>
        </PageSection>

        <DataDomainIdentities dataDomainId={current.id} canUpdate={canUpdate} />

        <DataDomainApprovals dataDomainId={current.id} canUpdate={canUpdate} />

        <DataDomainQueryLogs dataDomainId={current.id} />

        <PageSection title="版本">
          {versions.isPending ? <LoadingState rows={3} /> : null}
          {versions.isError ? (
            <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
          ) : null}
          {versions.data && versions.data.length === 0 ? (
            <PageNote
              icon={<Upload className="size-4" aria-hidden="true" />}
              title="还没有构建版本"
            />
          ) : null}
          {shownVersions.length > 0 ? (
            <Table aria-label="构建版本列表">
              <TableHeader>
                <TableRow>
                  <TableHead>版本</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>更新时间</TableHead>
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
                          {online ? <Badge variant="secondary">在线</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusLabel status={version.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatRelative(version.updatedAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`查看版本 ${shortId(version.id)} 的构建日志`}
                            onClick={(event) => {
                              logTriggerRef.current = event.currentTarget;
                              updateSearch({ version: version.id });
                            }}
                          >
                            日志
                          </Button>
                          {canPublish && version.status === 'ready' && !online ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={interacting}
                              title="切换为在线版本（用于发布/回退）"
                              aria-label="切换为在线版本（用于发布/回退）"
                              onClick={(event) => {
                                publishTriggerRef.current = event.currentTarget;
                                setPublishing(version);
                              }}
                            >
                              <RotateCcw data-icon="inline-start" /> 切换为在线版本
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

        {canBuild ? (
          <PageSection title="导入 Wren 项目文件并构建">
            <Field data-disabled={interacting} data-invalid={Boolean(importError)}>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={buildFileAccept}
                aria-label="选择 Wren 项目文件"
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  void addFiles(files);
                }}
              />
              <input
                ref={setDirectoryInput}
                type="file"
                multiple
                aria-label="选择 Wren 项目文件夹"
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  void addFiles(files);
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={interacting}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload data-icon="inline-start" /> 选择文件
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={interacting}
                  onClick={() => directoryInputRef.current?.click()}
                >
                  选择文件夹
                </Button>
                <Button
                  type="button"
                  disabled={
                    interacting || Object.keys(projectFiles).length === 0 || importError !== null
                  }
                  aria-busy={createVersion.isPending}
                  onClick={() => void submitBuild()}
                >
                  {createVersion.isPending ? '提交中…' : '构建新版本'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={interacting}
                  aria-busy={generateMdl.isPending}
                  onClick={generateDraft}
                >
                  <Database data-icon="inline-start" />{' '}
                  {generateMdl.isPending ? '提交中…' : '从数据库生成 MDL 草稿'}
                </Button>
              </div>
              <FieldDescription>
                多选文件或选择整个项目文件夹；目录层级会保留。单个文件不超过{' '}
                {formatBytes(importFileMaxBytes)}，合计不超过 {formatBytes(importTotalMaxBytes)}
                ，提交后由构建队列处理。
              </FieldDescription>
            </Field>
            {Object.keys(projectFiles).length > 0 ? (
              <ul aria-label="待构建文件" className="border-t">
                {Object.entries(projectFiles).map(([name, content]) => (
                  <li
                    key={name}
                    className="flex items-center gap-3 border-b py-1.5 text-sm last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={name}>
                      {name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatBytes(new TextEncoder().encode(content).length)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`移除 ${name}`}
                      disabled={interacting}
                      onClick={() => removeFile(name)}
                    >
                      <X />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <FieldError>{importError}</FieldError>
          </PageSection>
        ) : null}

        <PageSection title="语义补全">
          <DataDomainEnrichment
            key={current.id}
            dataDomainId={current.id}
            readyVersions={readyVersions}
            canBuild={canBuild}
          />
        </PageSection>
      </PageBody>

      {editing ? (
        <DataDomainFormDialog
          domain={current}
          canTest={canTest}
          getReturnFocus={() =>
            editTriggerRef.current?.isConnected ? editTriggerRef.current : null
          }
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      ) : null}

      {search.version ? (
        <Dialog
          open={versionDialog.open}
          onOpenChange={(next) => {
            if (!next) versionDialog.close();
          }}
          onOpenChangeComplete={versionDialog.onOpenChangeComplete}
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
                  <dt className="text-muted-foreground">更新时间</dt>
                  <dd className="text-fg">{formatRelative(selectedVersion.data.updatedAt)}</dd>
                </dl>
                <Field>
                  <FieldLabel htmlFor="data-domain-version-log">构建日志</FieldLabel>
                  <Textarea
                    id="data-domain-version-log"
                    readOnly
                    rows={16}
                    spellCheck={false}
                    value={selectedVersion.data.logTail}
                    placeholder={
                      dataDomainBuildShouldPoll([selectedVersion.data])
                        ? '构建还没有输出日志'
                        : selectedVersion.data.status === 'failed'
                          ? '构建失败，没有输出日志'
                          : '没有日志'
                    }
                    className="min-h-72 font-mono text-xs leading-5"
                  />
                  {selectedVersion.data.logTruncated ? (
                    <p className="text-sm text-muted-foreground">日志已截断，仅保留最近部分。</p>
                  ) : null}
                </Field>
              </div>
            ) : null}
          </DialogShell>
        </Dialog>
      ) : null}
      {confirmingDelete ? (
        <ConfirmDialog
          open
          title="删除数据域"
          description={`删除「${current.name}」及其全部构建版本记录，此操作不可撤销。`}
          onClose={() => setConfirmingDelete(false)}
          onConfirm={deleteDomain}
          finalFocus={() =>
            deleteTriggerRef.current?.isConnected ? deleteTriggerRef.current : null
          }
        />
      ) : null}
      {publishing ? (
        <ConfirmDialog
          open
          title="切换在线版本"
          description={`将在线版本切换为 ${shortId(publishing.id)}。可用于发布新版本或回退到旧版本，切换后新查询立即使用该版本。`}
          confirmLabel="切换"
          tone="default"
          onClose={() => setPublishing(null)}
          onConfirm={async () => {
            await publish.mutateAsync({ id: current.id, versionId: publishing.id });
            toastSuccess('已切换在线版本');
          }}
          finalFocus={() =>
            publishTriggerRef.current?.isConnected ? publishTriggerRef.current : null
          }
        />
      ) : null}
      <ConfirmDialog
        open={importBlocker.status === 'blocked'}
        onClose={() => importBlocker.reset?.()}
        title="放弃待构建文件？"
        description={importPending ? '正在读取或提交文件，请等待完成。' : '离开后已选文件会丢失。'}
        confirmLabel="放弃并离开"
        confirmDisabled={importPending}
        onConfirm={async () => importBlocker.proceed()}
      />
    </Page>
  );
}
