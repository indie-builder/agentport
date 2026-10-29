import {
  DEFAULT_RUNTIME_DOCKERFILE,
  type RuntimeEnvironment,
  type RuntimeEnvironmentInput,
} from '@agentport/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Box, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { Page, PageHeader, PageToolbar } from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { SearchInput } from '../components/search-input.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Dialog } from '../components/ui/dialog.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../components/ui/field.js';
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
import { useCreateRuntimeEnvironment, useRuntimeEnvironments } from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';

export function RuntimeEnvironmentsPage() {
  const environments = useRuntimeEnvironments();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/runtime-environments/' });
  const [creating, setCreating] = useState(false);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const query = search.q ?? '';

  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (environments.data ?? [])
      .filter((environment) => environment.name.toLocaleLowerCase().includes(needle))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }, [environments.data, query]);

  const openCreate = (): void => setCreating(true);

  return (
    <Page>
      <PageHeader
        title="运行环境"
        actions={
          <Button ref={createTriggerRef} onClick={openCreate}>
            <Plus data-icon="inline-start" /> 新建环境
          </Button>
        }
      />
      <PageToolbar>
        <SearchInput
          className="w-56"
          label="搜索运行环境"
          placeholder="搜索运行环境"
          value={query}
          onChange={(next) => {
            void navigate({
              to: '/runtime-environments',
              search: (current) => ({ ...current, q: next || undefined }),
              replace: true,
            });
          }}
        />
      </PageToolbar>

      {environments.isPending ? <LoadingState rows={4} /> : null}
      {environments.isError ? (
        <ErrorState error={environments.error} onRetry={() => void environments.refetch()} />
      ) : null}

      {environments.data && environments.data.length === 0 ? (
        <EmptyState
          icon={<Box className="size-5" />}
          title="新建第一个运行环境"
          action={
            <Button variant="outline" size="sm" onClick={openCreate}>
              新建环境
            </Button>
          }
        />
      ) : null}

      {environments.data && environments.data.length > 0 && shown.length === 0 ? (
        <EmptyState
          title="没有匹配的运行环境"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigate({
                  to: '/runtime-environments',
                  search: (current) => ({ ...current, q: undefined }),
                  replace: true,
                });
              }}
            >
              清除筛选
            </Button>
          }
        />
      ) : null}

      {shown.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>线上版本</TableHead>
              <TableHead>更新时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((environment) => (
              <TableRow key={environment.id}>
                <TableCell>
                  <div className="flex min-w-0 items-center gap-2">
                    <Link
                      to="/runtime-environments/$environmentId"
                      params={{ environmentId: environment.id }}
                      className="min-w-0 truncate font-medium text-fg hover:underline"
                    >
                      {environment.name}
                    </Link>
                    {environment.isDefault ? <Badge variant="secondary">默认</Badge> : null}
                  </div>
                </TableCell>
                <TableCell>
                  {environment.onlineVersionId ? (
                    <code className="font-mono text-xs text-muted-foreground">
                      {shortId(environment.onlineVersionId)}
                    </code>
                  ) : (
                    <span className="text-muted-foreground">未发布</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatRelative(environment.updatedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      {creating ? (
        <CreateEnvironmentDialog
          getReturnFocus={() =>
            createTriggerRef.current?.isConnected ? createTriggerRef.current : null
          }
          onClose={() => setCreating(false)}
          onCreated={(environment) => {
            setCreating(false);
            void navigate({
              to: '/runtime-environments/$environmentId',
              params: { environmentId: environment.id },
              ignoreBlocker: true,
            });
          }}
        />
      ) : null}
    </Page>
  );
}

function CreateEnvironmentDialog({
  onClose,
  onCreated,
  getReturnFocus,
}: {
  onClose: () => void;
  onCreated: (environment: RuntimeEnvironment) => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const create = useCreateRuntimeEnvironment();
  const pending = create.isPending;
  const [name, setName] = useState('');
  const [dockerfile, setDockerfile] = useState(DEFAULT_RUNTIME_DOCKERFILE);
  const [nameError, setNameError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [created, setCreated] = useState(false);
  const dirty = !created && (name !== '' || dockerfile !== DEFAULT_RUNTIME_DOCKERFILE);
  // 成功回调读不到拦截发生后的 blocker 实例：用 ref 拿最新一次再结算。
  const blocker = useFormBlocker(dirty, !created && pending, { ignoreSamePath: true });
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);
  // 关闭会卸载弹层并摘掉 blocker：先取消期间被拦下的离开，否则它的 resolver 一直挂着。
  const finish = (): void => {
    blockerRef.current.reset?.();
    onClose();
  };
  // 半填的配置不能因为 Esc / 点遮罩 / 关闭按钮就消失：脏时先确认；请求中一律不能关闭。
  const close = (): void => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else finish();
  };

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('不能为空，请填写后再创建');
      return;
    }
    setNameError(null);
    const input: RuntimeEnvironmentInput = { name: trimmed, dockerfile };
    try {
      const environment = await create.mutateAsync(input);
      // 实体已创建，草稿无需再保护；结算期间被拦下的离开后再进入详情。
      setCreated(true);
      blockerRef.current.reset?.();
      toastSuccess(`已创建「${environment.name}」`);
      onCreated(environment);
    } catch (error) {
      toastError(error);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) close();
      }}
    >
      <DialogShell title="新建运行环境" finalFocus={getReturnFocus} closeDisabled={pending}>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup>
            <Field data-invalid={Boolean(nameError)}>
              <FieldLabel htmlFor="runtime-environment-name">
                名称
                <RequiredMark />
              </FieldLabel>
              <Input
                id="runtime-environment-name"
                value={name}
                maxLength={64}
                autoComplete="off"
                disabled={pending}
                aria-required="true"
                aria-invalid={Boolean(nameError)}
                aria-describedby={nameError ? 'runtime-environment-name-error' : undefined}
                onChange={(event) => {
                  setName(event.currentTarget.value);
                  setNameError(null);
                }}
              />
              <FieldError id="runtime-environment-name-error">{nameError}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="runtime-environment-dockerfile">Dockerfile</FieldLabel>
              <Textarea
                id="runtime-environment-dockerfile"
                value={dockerfile}
                rows={14}
                spellCheck={false}
                disabled={pending}
                className="font-mono text-xs leading-relaxed"
                onChange={(event) => setDockerfile(event.currentTarget.value)}
              />
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={close}>
              取消
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? '创建中…' : '创建'}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后填写的内容会丢失。"
          confirmLabel="放弃并关闭"
          confirmDisabled={pending}
          onConfirm={async () => {
            if (!pending) finish();
          }}
        />
        {/* 路由离开/刷新与弹层关闭共用同一确认文案；取消保留草稿，确认才真正离开。 */}
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title="放弃未保存的更改？"
          description={pending ? '正在创建，请等待请求完成。' : '离开后填写的内容会丢失。'}
          confirmLabel="放弃并离开"
          confirmDisabled={pending}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}
