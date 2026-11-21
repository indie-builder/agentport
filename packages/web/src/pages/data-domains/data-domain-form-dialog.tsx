import { dataDomainInputSchema } from '@agentport/contract/data-domains';
import { dataDomainQueryApprovalModeSchema } from '@agentport/shared';
import { useEffect, useRef, useState } from 'react';
import { useFieldArray } from 'react-hook-form';
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
  FieldGroup,
  FieldLabel,
} from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group.js';
import type { DataDomain, DataDomainInput, DataDomainPatch } from '../../lib/api.js';
import { errorMessage } from '../../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../../lib/dialog-guard.js';
import { fieldErrors, useFormBlocker } from '../../lib/form.js';
import {
  useCreateDataDomain,
  useTestDataDomainConnection,
  useUpdateDataDomain,
} from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import {
  KeyValueRowEditor,
  keyValueRowIssues,
  refineKeyValueRows,
  rowsToRecord,
} from './key-value-rows.js';

const connectionRowMessages = {
  emptyKey: (index: number) => `第 ${index + 1} 行：请填写配置项名称`,
  duplicate: (index: number, previous: number) =>
    `第 ${index + 1} 行：与第 ${previous + 1} 行重复，请合并`,
};

const dataDomainFormSchema = (requireConnection: boolean) =>
  z
    .object({
      name: dataDomainInputSchema.shape.name,
      slug: dataDomainInputSchema.shape.slug,
      description: dataDomainInputSchema.shape.description,
      datasource: dataDomainInputSchema.shape.datasource,
      connection: z.array(z.object({ key: z.string(), value: z.string() })),
      queryApprovalMode: dataDomainQueryApprovalModeSchema,
    })
    .superRefine((values, ctx) => {
      const { keyType, valueType } = dataDomainInputSchema.shape.connection;
      refineKeyValueRows(ctx, {
        path: 'connection',
        rows: values.connection,
        issues: keyValueRowIssues(values.connection, connectionRowMessages),
        emptyMessage: requireConnection ? '请至少填写一项连接配置' : null,
        keyType,
        valueType,
        skipEmptyRows: true,
      });
    });

type FormValues = z.infer<ReturnType<typeof dataDomainFormSchema>>;

function domainToForm(domain: DataDomain): FormValues {
  return {
    name: domain.name,
    slug: domain.slug,
    description: domain.description,
    datasource: domain.datasource,
    connection: [{ key: '', value: '' }],
    queryApprovalMode: domain.queryApprovalMode,
  };
}

const emptyForm: FormValues = {
  name: '',
  slug: '',
  description: '',
  datasource: 'duckdb',
  connection: [{ key: '', value: '' }],
  queryApprovalMode: 'off',
};

export function DataDomainFormDialog({
  domain,
  canTest,
  onClose: onClosed,
  onSaved,
  getReturnFocus,
}: {
  domain: DataDomain | null;
  canTest: boolean;
  onClose: () => void;
  onSaved: (domain: DataDomain, created: boolean) => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const creating = domain === null;
  const create = useCreateDataDomain();
  const update = useUpdateDataDomain();
  const test = useTestDataDomainConnection();
  const pending = create.isPending || update.isPending;
  const form = useZodForm(dataDomainFormSchema(creating), {
    defaultValues: domain ? domainToForm(domain) : emptyForm,
  });
  const { register, control, getValues, setValue, reset, watch, handleSubmit, formState } = form;
  const { fields, append, remove } = useFieldArray({ control, name: 'connection' });
  const { errors, isDirty } = formState;
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    error?: string | undefined;
  } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saved, setSaved] = useState(false);
  const busy = pending || test.isPending;
  const dirty = !saved && isDirty;
  const blocker = useFormBlocker(dirty, !saved && busy, { ignoreSamePath: true });
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);
  useEffect(() => {
    const subscription = watch((_values, { name }) => {
      if (name === 'datasource' || name?.startsWith('connection')) setTestResult(null);
    });
    return () => subscription.unsubscribe();
  }, [watch]);

  const runTest = async (): Promise<void> => {
    const values = getValues();
    const rows = values.connection;
    const rowIssue = keyValueRowIssues(rows, connectionRowMessages)[0];
    if (rowIssue) {
      setTestResult({ ok: false, error: rowIssue.message });
      return;
    }
    const connection = rowsToRecord(rows);
    if (Object.keys(connection).length === 0) {
      setTestResult({ ok: false, error: '请先填写连接配置' });
      return;
    }
    const parsed = dataDomainInputSchema.shape.connection.safeParse(connection);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setTestResult({
        ok: false,
        error: issue ? (Object.values(fieldErrors([issue]))[0] ?? issue.message) : '请检查连接配置',
      });
      return;
    }
    const datasource = dataDomainInputSchema.shape.datasource.safeParse(values.datasource);
    if (!datasource.success) {
      const issue = datasource.error.issues[0];
      setTestResult({
        ok: false,
        error: issue ? (Object.values(fieldErrors([issue]))[0] ?? issue.message) : '请填写数据源',
      });
      return;
    }
    setTestResult(null);
    try {
      setTestResult(
        await test.mutateAsync({ datasource: datasource.data, connection: parsed.data }),
      );
    } catch (error) {
      setTestResult({ ok: false, error: errorMessage(error) });
    }
  };

  const finish = (): void => {
    blockerRef.current.reset?.();
    onClose();
  };
  const close = (): void => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else finish();
  };

  const submit = handleSubmit(async (values) => {
    if (busy) return;
    const connection = rowsToRecord(values.connection);
    setSubmitError(null);
    try {
      if (domain) {
        const patch: DataDomainPatch = {
          name: values.name,
          slug: values.slug,
          description: values.description,
          datasource: values.datasource,
          queryApprovalMode: values.queryApprovalMode,
          ...(Object.keys(connection).length > 0 ? { connection } : {}),
        };
        const updated = await update.mutateAsync({ id: domain.id, patch });
        reset(domainToForm(updated));
        setSaved(true);
        blockerRef.current.reset?.();
        toastSuccess('已保存');
        dialog.finish(() => onSaved(updated, false));
        return;
      }
      const input: DataDomainInput = {
        name: values.name,
        slug: values.slug,
        description: values.description,
        datasource: values.datasource,
        connection,
        queryApprovalMode: values.queryApprovalMode,
      };
      const created = await create.mutateAsync(input);
      reset(domainToForm(created));
      setSaved(true);
      blockerRef.current.reset?.();
      toastSuccess(`已创建「${created.name}」`);
      dialog.finish(() => onSaved(created, true));
    } catch (error) {
      setSubmitError(errorMessage(error));
    }
  });

  const keyError = (index: number): string | undefined => errors.connection?.[index]?.key?.message;
  const valueError = (index: number): string | undefined =>
    errors.connection?.[index]?.value?.message;
  const connectionError = errors.connection?.root?.message ?? errors.connection?.message;

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(busy, close)}
    >
      <DialogShell
        title={creating ? '新建数据域' : `编辑「${domain?.name ?? ''}」`}
        finalFocus={getReturnFocus}
        closeDisabled={busy}
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              取消
            </Button>
            <Button
              type="submit"
              form="data-domain-form"
              disabled={busy || (!creating && !isDirty)}
              aria-busy={pending}
            >
              {pending ? '保存中…' : creating ? '创建' : '保存更改'}
            </Button>
          </div>
        }
      >
        <form
          id="data-domain-form"
          className="flex flex-col gap-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldError>{submitError}</FieldError>
          <FieldGroup>
            <Field data-disabled={busy} data-invalid={Boolean(errors.name)}>
              <FieldLabel htmlFor="data-domain-name">
                名称
                <RequiredMark />
              </FieldLabel>
              <Input
                id="data-domain-name"
                {...register('name')}
                maxLength={64}
                autoComplete="off"
                disabled={busy}
                aria-required="true"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'data-domain-name-error' : undefined}
              />
              <FieldError id="data-domain-name-error">{errors.name?.message}</FieldError>
            </Field>
            <Field data-disabled={busy} data-invalid={Boolean(errors.slug)}>
              <FieldLabel htmlFor="data-domain-slug">
                标识
                <RequiredMark />
              </FieldLabel>
              <Input
                id="data-domain-slug"
                {...register('slug')}
                maxLength={61}
                autoComplete="off"
                placeholder="sales-db"
                className="font-mono"
                disabled={busy}
                aria-required="true"
                aria-invalid={Boolean(errors.slug)}
                aria-describedby={errors.slug ? 'data-domain-slug-error' : 'data-domain-slug-hint'}
              />
              {errors.slug ? (
                <FieldError id="data-domain-slug-error">{errors.slug.message}</FieldError>
              ) : (
                <FieldDescription id="data-domain-slug-hint">
                  小写字母、数字、- 和 _。
                </FieldDescription>
              )}
            </Field>
            <Field data-disabled={busy} data-invalid={Boolean(errors.description)}>
              <FieldLabel htmlFor="data-domain-description">描述</FieldLabel>
              <Textarea
                id="data-domain-description"
                {...register('description')}
                rows={3}
                disabled={busy}
                aria-invalid={Boolean(errors.description)}
                aria-describedby={errors.description ? 'data-domain-description-error' : undefined}
              />
              <FieldError id="data-domain-description-error">
                {errors.description?.message}
              </FieldError>
            </Field>
            <Field data-disabled={busy} data-invalid={Boolean(errors.datasource)}>
              <FieldLabel htmlFor="data-domain-datasource">
                数据源
                <RequiredMark />
              </FieldLabel>
              <Input
                id="data-domain-datasource"
                {...register('datasource')}
                maxLength={64}
                autoComplete="off"
                className="font-mono"
                disabled={busy}
                aria-required="true"
                aria-invalid={Boolean(errors.datasource)}
                aria-describedby={errors.datasource ? 'data-domain-datasource-error' : undefined}
              />
              <FieldError id="data-domain-datasource-error">
                {errors.datasource?.message}
              </FieldError>
            </Field>
            <Field data-disabled={busy} data-invalid={Boolean(errors.connection)}>
              <FieldLabel>
                连接配置
                {creating ? <RequiredMark /> : null}
              </FieldLabel>
              <KeyValueRowEditor
                rows={fields}
                prefix="data-domain-connection"
                keyAriaLabel="配置名"
                valueAriaLabel="配置值"
                removeLabel="连接配置"
                addLabel="添加配置项"
                rootErrorId="data-domain-connection-error"
                rootError={connectionError}
                disabled={busy}
                registerKey={(index) => register(`connection.${index}.key` as const)}
                registerValue={(index) => register(`connection.${index}.value` as const)}
                keyError={keyError}
                valueError={valueError}
                onAppend={() => append({ key: '', value: '' })}
                onRemove={remove}
                extraActions={
                  canTest ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-busy={test.isPending}
                      onClick={() => void runTest()}
                    >
                      {test.isPending ? '测试中…' : '测试连接'}
                    </Button>
                  ) : null
                }
              />
              {testResult ? (
                <p
                  role="status"
                  className={testResult.ok ? 'text-sm text-success' : 'text-sm text-danger'}
                >
                  {testResult.ok ? '连接成功' : `连接失败：${testResult.error ?? '未知错误'}`}
                </p>
              ) : null}
              {domain ? (
                <FieldDescription>连接配置不回显；留空则保留现有配置。</FieldDescription>
              ) : null}
            </Field>
            <Field data-disabled={busy}>
              <FieldLabel>查询审批</FieldLabel>
              <ToggleGroup
                disabled={busy}
                aria-label="查询审批模式"
                variant="outline"
                value={[watch('queryApprovalMode')]}
                onValueChange={(values) => {
                  const next = values[0];
                  if (next === 'off' || next === 'all') {
                    setValue('queryApprovalMode', next, { shouldDirty: true });
                  }
                }}
              >
                <ToggleGroupItem value="off">关闭</ToggleGroupItem>
                <ToggleGroupItem value="all">每次查询需审批</ToggleGroupItem>
              </ToggleGroup>
            </Field>
          </FieldGroup>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后填写的内容会丢失。"
          confirmLabel="放弃并关闭"
          confirmDisabled={busy}
          onConfirm={async () => {
            if (!busy) finish();
          }}
        />
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title="放弃未保存的更改？"
          description={
            pending
              ? '正在保存，请等待请求完成。'
              : test.isPending
                ? '正在测试连接，请等待请求完成。'
                : '离开后填写的内容会丢失。'
          }
          confirmLabel="放弃并离开"
          confirmDisabled={busy}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}
