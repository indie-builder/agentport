import {
  type ConnectorCatalogItem,
  type Server,
  type ServerInput,
  serverInputSchema,
} from '@agentport/shared';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { RequiredMark } from '../../components/required-mark.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group.js';
import { ApiError, api } from '../../lib/api.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { fieldErrors, useFormBlocker } from '../../lib/form.js';
import { useCreateServer, useUpdateServer } from '../../lib/queries.js';
import { parsePairs } from '../../lib/resource-form.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import { type Kind, kindMeta } from './shared.js';

/** 用户可创建的类型；knowledge 由知识库生命周期生成，不在连接器页出现。 */
const creatableKinds = ['stdio', 'http', 'generated'] as const;

function formatPairs(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

interface ServerFormValues {
  kind: Kind | null;
  name: string;
  description: string;
  command: string;
  args: string;
  url: string;
  baseUrl: string;
  pairs: string;
}

const emptyForm: ServerFormValues = {
  kind: null,
  name: '',
  description: '',
  command: '',
  args: '',
  url: '',
  baseUrl: '',
  pairs: '',
};

/** 校验与 payload 构造共用同一份扁平表单值，先解析 KEY=value 再交给共享 schema。 */
function buildServerInput(values: ServerFormValues, pairs: Record<string, string>): ServerInput {
  const common = { name: values.name, description: values.description };
  if (values.kind === 'stdio') {
    return {
      ...common,
      kind: 'stdio',
      command: values.command,
      args: values.args
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      env: pairs,
    };
  }
  // http 与 generated 的地址属于不同字段：PATCH 与表单都按 kind 取用，不能互相顶替。
  if (values.kind === 'http') {
    return { ...common, kind: 'http', url: values.url, headers: pairs };
  }
  return { ...common, kind: 'generated', baseUrl: values.baseUrl, headers: pairs };
}

const serverFormSchema = z
  .object({
    kind: z.enum(['stdio', 'http', 'generated']).nullable(),
    name: z.string(),
    description: z.string(),
    command: z.string(),
    args: z.string(),
    url: z.string(),
    baseUrl: z.string(),
    pairs: z.string(),
  })
  .superRefine((values, ctx) => {
    if (!values.kind) return;
    let pairs: Record<string, string>;
    try {
      pairs = parsePairs(values.pairs, values.kind === 'stdio' ? 'env' : 'headers');
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['pairs'],
        message: error instanceof Error ? error.message : '请检查 KEY=value 格式',
      });
      return;
    }
    const parsed = serverInputSchema.safeParse(buildServerInput(values, pairs));
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: 'custom',
        path: issue.path as (string | number)[],
        message: Object.values(fieldErrors([issue]))[0] ?? issue.message,
      });
    }
  });

function serverToForm(server: Server): ServerFormValues {
  // 知识库连接不在连接器列表中出现，也没有对应表单。
  if (server.kind === 'knowledge') return emptyForm;
  const common = { kind: server.kind, name: server.name, description: server.description };
  switch (server.kind) {
    case 'stdio':
      return {
        ...common,
        command: server.command,
        args: server.args.join('\n'),
        url: '',
        baseUrl: '',
        pairs: formatPairs(server.env),
      };
    case 'http':
      return {
        ...common,
        command: '',
        args: '',
        url: server.url,
        baseUrl: '',
        pairs: formatPairs(server.headers),
      };
    case 'generated':
      return {
        ...common,
        command: '',
        args: '',
        url: '',
        baseUrl: server.baseUrl,
        pairs: formatPairs(server.headers),
      };
  }
}

function catalogToForm(item: ConnectorCatalogItem): ServerFormValues {
  // 名称用 slug：目录里的展示名可能含大写或括号，过不了 name 的 slug 校验。
  const common = { kind: item.kind, name: item.slug, description: item.description };
  if (item.kind === 'stdio') {
    return {
      ...emptyForm,
      ...common,
      command: item.command ?? '',
      args: (item.args ?? []).join('\n'),
    };
  }
  return { ...emptyForm, ...common, url: item.url ?? '' };
}

export function ServerFormDialog({
  server,
  initial = null,
  onClose: onClosed,
  onSaved,
  getReturnFocus,
  readOnly = false,
}: {
  server: Server | null;
  initial?: ConnectorCatalogItem | null;
  onClose: () => void;
  onSaved: (server: Server, created: boolean) => void;
  getReturnFocus: () => HTMLElement | null;
  readOnly?: boolean | undefined;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const creating = server === null;
  // 只读只限制既有定义的修改；新建仍由 servers.create 放行。
  const viewOnly = readOnly && !creating;
  const prefill = creating && initial ? catalogToForm(initial) : null;
  const create = useCreateServer();
  const update = useUpdateServer();
  const { register, handleSubmit, reset, setValue, clearErrors, watch, formState } = useZodForm(
    serverFormSchema,
    { defaultValues: server ? serverToForm(server) : (prefill ?? emptyForm) },
  );
  const { errors, isDirty } = formState;
  const kind = watch('kind');
  const watched = watch();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [baseline, setBaseline] = useState(server);
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [reloading, setReloading] = useState(false);
  const dirty = isDirty;

  const pending = create.isPending || update.isPending || reloading;
  const blocker = useFormBlocker(dirty, pending);
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);
  // 成功后由父级关闭弹层：先取消期间被拦下的离开，否则它的 resolver 一直挂着。
  const settle = (): void => {
    blockerRef.current.reset?.();
  };
  const finish = (): void => {
    settle();
    onClose();
  };
  const reload = async (): Promise<void> => {
    if (!baseline || pending) return;
    setReloading(true);
    try {
      const latest = (await api.servers()).find((item) => item.id === baseline.id);
      if (!latest) throw new Error('该连接器已不存在，请关闭配置并刷新列表');
      setBaseline(latest);
      reset(serverToForm(latest));
      setConflict(false);
      setConfirmReload(false);
    } catch (error) {
      toastError(error);
    } finally {
      setReloading(false);
    }
  };
  // 半填的配置不能因为 Esc / 点遮罩就消失：脏时先确认；请求中一律不能关闭。
  const close = (): void => {
    if (pending) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    finish();
  };

  const submit = handleSubmit((values) => {
    if (!values.kind || pending || viewOnly) return;
    const pairs = parsePairs(values.pairs, values.kind === 'stdio' ? 'env' : 'headers');
    const parsed = serverInputSchema.safeParse(buildServerInput(values, pairs));
    if (!parsed.success) return;
    if (baseline) {
      update.mutate(
        { id: baseline.id, input: parsed.data, expectedUpdatedAt: baseline.updatedAt },
        {
          onSuccess: (saved) => {
            settle();
            toastSuccess('Server 已更新');
            dialog.finish(() => onSaved(saved, false));
          },
          onError: (error) => {
            if (error instanceof ApiError && error.status === 409) {
              setConflict(true);
              toastError(new Error('配置已被修改；当前草稿已保留，请加载最新配置后重新编辑。'));
              return;
            }
            toastError(error);
          },
        },
      );
    } else {
      create.mutate(parsed.data, {
        onSuccess: (saved) => {
          settle();
          toastSuccess('Server 已创建');
          dialog.finish(() => onSaved(saved, true));
        },
        onError: (error) => toastError(error),
      });
    }
  });

  const urlLabel = kind === 'http' ? 'URL' : 'Base URL';
  const urlError = errors.url?.message ?? errors.baseUrl?.message;

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={(next, details) => {
        if (next) return;
        if (pending || dirty) details.cancel();
        close();
      }}
    >
      <DialogShell
        title={
          creating ? '新建连接器' : viewOnly ? `查看「${server.name}」` : `编辑「${server.name}」`
        }
        {...(!creating
          ? { description: viewOnly ? '只读查看，不能修改或保存。' : '来源类型不可修改。' }
          : {})}
        finalFocus={getReturnFocus}
        closeDisabled={pending}
      >
        {conflict ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
            <p>配置已被修改，当前草稿已保留。加载最新配置会放弃此草稿。</p>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setConfirmReload(true)}
            >
              加载最新配置
            </Button>
          </div>
        ) : null}
        <ConfirmDialog
          open={confirmReload}
          onClose={() => {
            if (!pending) setConfirmReload(false);
          }}
          title="放弃草稿并加载最新配置？"
          description="当前未保存的更改会丢失。加载失败时会保留当前草稿。"
          confirmLabel="放弃并加载"
          confirmDisabled={pending}
          onConfirm={reload}
        />
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {creating ? (
            <FieldSet className="gap-2.5" disabled={pending} data-disabled={pending}>
              <FieldLegend variant="label" className="mb-2.5 text-muted-foreground">
                来源类型
              </FieldLegend>
              <ToggleGroup
                disabled={pending}
                aria-label="来源类型"
                variant="outline"
                value={kind ? [kind] : []}
                onValueChange={(values) => {
                  const next = values[0];
                  if (next === 'stdio' || next === 'http' || next === 'generated') {
                    setValue('kind', next, { shouldDirty: true });
                    clearErrors();
                  }
                }}
                className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3"
              >
                {creatableKinds.map((value) => (
                  <ToggleGroupItem
                    key={value}
                    value={value}
                    className="h-auto min-w-0 flex-col items-start gap-1 whitespace-normal px-3 py-2.5 text-left"
                  >
                    <span>{kindMeta[value].label}</span>
                    <span className="text-sm font-normal text-muted-foreground">
                      {kindMeta[value].newHint}
                    </span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FieldSet>
          ) : null}

          {kind === null ? null : (
            <>
              <Field
                data-disabled={pending}
                className="gap-1.5"
                data-invalid={Boolean(errors.name)}
              >
                <FieldLabel htmlFor="server-name">
                  名称
                  <RequiredMark />
                </FieldLabel>
                <Input
                  {...register('name')}
                  value={watched.name}
                  disabled={pending}
                  readOnly={viewOnly}
                  id="server-name"
                  placeholder="filesystem"
                  aria-required
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? 'server-name-error' : 'server-name-hint'}
                />
                {errors.name ? (
                  <FieldError id="server-name-error">{errors.name.message}</FieldError>
                ) : (
                  <FieldDescription id="server-name-hint">
                    小写字母、数字、- 和 _。
                  </FieldDescription>
                )}
              </Field>

              <Field
                data-disabled={pending}
                className="gap-1.5"
                data-invalid={Boolean(errors.description)}
              >
                <FieldLabel htmlFor="server-desc">描述</FieldLabel>
                <Input
                  {...register('description')}
                  value={watched.description}
                  disabled={pending}
                  readOnly={viewOnly}
                  id="server-desc"
                  aria-invalid={Boolean(errors.description)}
                  aria-describedby={errors.description ? 'server-desc-error' : undefined}
                  placeholder="一句话说明它提供什么能力"
                />
                <FieldError id="server-desc-error">{errors.description?.message}</FieldError>
              </Field>

              {kind === 'stdio' ? (
                <>
                  <Field
                    data-disabled={pending}
                    className="gap-1.5"
                    data-invalid={Boolean(errors.command)}
                  >
                    <FieldLabel htmlFor="server-command">
                      命令
                      <RequiredMark />
                    </FieldLabel>
                    <Input
                      {...register('command')}
                      value={watched.command}
                      disabled={pending}
                      readOnly={viewOnly}
                      id="server-command"
                      placeholder="npx"
                      className="font-mono"
                      aria-required
                      aria-invalid={Boolean(errors.command)}
                      aria-describedby={errors.command ? 'server-command-error' : undefined}
                    />
                    <FieldError id="server-command-error">{errors.command?.message}</FieldError>
                  </Field>
                  <Field data-disabled={pending} className="gap-1.5">
                    <FieldLabel htmlFor="server-args">参数（每行一个）</FieldLabel>
                    <Textarea
                      {...register('args')}
                      value={watched.args}
                      disabled={pending}
                      readOnly={viewOnly}
                      id="server-args"
                      rows={2}
                      // Keep configuration values compact and monospaced for literal editing.
                      className="font-mono text-xs"
                      placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/tmp'}
                    />
                  </Field>
                  <Field
                    data-disabled={pending}
                    className="gap-1.5"
                    data-invalid={Boolean(errors.pairs)}
                  >
                    <FieldLabel htmlFor="server-env">环境变量（每行 KEY=value）</FieldLabel>
                    <Textarea
                      {...register('pairs')}
                      value={watched.pairs}
                      disabled={pending}
                      readOnly={viewOnly}
                      id="server-env"
                      aria-invalid={Boolean(errors.pairs)}
                      aria-describedby={errors.pairs ? 'server-env-error' : 'server-env-hint'}
                      rows={2}
                      // Keep configuration values compact and monospaced for literal editing.
                      className="font-mono text-xs"
                      placeholder="TOKEN=…"
                    />
                    <FieldError id="server-env-error">{errors.pairs?.message}</FieldError>
                    <FieldDescription id="server-env-hint">
                      {viewOnly
                        ? '密钥只以 •••• 显示。'
                        : '保存后密钥只以 •••• 返回；保持 •••• 不动即沿用原值。'}
                    </FieldDescription>
                  </Field>
                </>
              ) : (
                <>
                  <Field
                    data-disabled={pending}
                    className="gap-1.5"
                    data-invalid={Boolean(urlError)}
                  >
                    <FieldLabel htmlFor="server-url">
                      {urlLabel}
                      <RequiredMark />
                    </FieldLabel>
                    <Input
                      {...register(kind === 'http' ? 'url' : 'baseUrl')}
                      value={kind === 'http' ? watched.url : watched.baseUrl}
                      disabled={pending}
                      readOnly={viewOnly}
                      id="server-url"
                      placeholder={
                        kind === 'http' ? 'https://example.com/mcp' : 'https://api.example.com/v1'
                      }
                      className="font-mono text-xs"
                      aria-required
                      aria-invalid={Boolean(urlError)}
                      aria-describedby={urlError ? 'server-url-error' : 'server-url-hint'}
                    />
                    {urlError ? (
                      <FieldError id="server-url-error">{urlError}</FieldError>
                    ) : (
                      <FieldDescription id="server-url-hint">
                        {kind === 'http'
                          ? 'MCP 端点地址，平台直接与它通信。'
                          : '上游 API 的根地址；工具路径会拼在它后面。'}
                      </FieldDescription>
                    )}
                  </Field>
                  <Field
                    data-disabled={pending}
                    className="gap-1.5"
                    data-invalid={Boolean(errors.pairs)}
                  >
                    <FieldLabel htmlFor="server-headers">Headers（每行 KEY=value）</FieldLabel>
                    <Textarea
                      {...register('pairs')}
                      value={watched.pairs}
                      disabled={pending}
                      readOnly={viewOnly}
                      id="server-headers"
                      aria-invalid={Boolean(errors.pairs)}
                      aria-describedby={
                        errors.pairs ? 'server-headers-error' : 'server-headers-hint'
                      }
                      rows={2}
                      // Keep configuration values compact and monospaced for literal editing.
                      className="font-mono text-xs"
                      placeholder="Authorization=Bearer …"
                    />
                    <FieldError id="server-headers-error">{errors.pairs?.message}</FieldError>
                    <FieldDescription id="server-headers-hint">
                      {viewOnly
                        ? '密钥只以 •••• 显示。'
                        : '保存后密钥只以 •••• 返回；保持 •••• 不动即沿用原值。'}
                    </FieldDescription>
                  </Field>
                  {kind === 'generated' && !viewOnly ? (
                    <p className="rounded-item bg-chip p-3 text-sm text-muted-foreground">
                      保存后会直接打开工具编辑，把上游 HTTP API 的端点声明成 MCP 工具。
                    </p>
                  ) : null}
                </>
              )}
            </>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close} disabled={pending}>
              {viewOnly ? '关闭' : '取消'}
            </Button>
            {viewOnly ? null : (
              <Button
                type="submit"
                disabled={pending || kind === null || (!creating && !isDirty)}
                aria-busy={pending}
              >
                {pending ? '保存中…' : creating ? '创建' : '保存更改'}
              </Button>
            )}
          </div>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后这个 Server 的修改会丢失，密钥需要重新填写。"
          confirmLabel="放弃并关闭"
          confirmDisabled={pending}
          onConfirm={async () => {
            if (!pending) finish();
          }}
        />
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title="放弃未保存的更改？"
          description={pending ? '正在保存，请等待请求完成。' : '离开后连接器配置的修改会丢失。'}
          confirmLabel="放弃并离开"
          confirmDisabled={pending}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}
