import { businessIdSchema, dataDomainIdentityInputSchema } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useFieldArray } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { PageSection } from '../../components/page.js';
import { RequiredMark } from '../../components/required-mark.js';
import { SearchInput } from '../../components/search-input.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Field, FieldDescription, FieldError, FieldLabel } from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { can } from '../../lib/access.js';
import type { DataDomainIdentity } from '../../lib/api.js';
import { errorMessage } from '../../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../../lib/dialog-guard.js';
import { useFormBlocker } from '../../lib/form.js';
import { formatRelative } from '../../lib/format.js';
import {
  accountQuery,
  meQuery,
  useDataDomainIdentities,
  useRemoveDataDomainIdentity,
  useUpsertDataDomainIdentity,
} from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';
import { useDebouncedValue } from '../../lib/use-debounced-value.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import {
  KeyValueRowEditor,
  keyValueRowIssues,
  refineKeyValueRows,
  rowsToRecord,
} from './key-value-rows.js';

const propertyRowMessages = {
  emptyKey: (index: number) => `第 ${index + 1} 行：请填写属性名`,
  duplicate: (index: number) => `第 ${index + 1} 行：属性名重复，请合并`,
};

const identityFormSchema = z
  .object({
    businessId: businessIdSchema,
    properties: z.array(z.object({ key: z.string(), value: z.string() })),
  })
  .superRefine((values, ctx) => {
    const { keyType, valueType } = dataDomainIdentityInputSchema.shape.properties;
    refineKeyValueRows(ctx, {
      path: 'properties',
      rows: values.properties,
      issues: keyValueRowIssues(values.properties, propertyRowMessages),
      emptyMessage: '请至少填写一项属性',
      keyType,
      valueType,
      skipEmptyRows: false,
    });
  });

type FormValues = z.infer<typeof identityFormSchema>;

function identityToForm(identity: DataDomainIdentity): FormValues {
  const rows = Object.entries(identity.properties).map(([key, value]) => ({ key, value }));
  return {
    businessId: identity.businessId,
    properties: rows.length > 0 ? rows : [{ key: '', value: '' }],
  };
}

const emptyForm: FormValues = {
  businessId: '',
  properties: [{ key: '', value: '' }],
};

function BusinessUserPicker({
  selected,
  enabled,
  onSelect,
}: {
  selected: string;
  enabled: boolean;
  onSelect: (businessId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const settled = useDebouncedValue(query.trim(), 300);
  const accounts = useQuery({
    ...accountQuery({ q: settled, limit: 20, offset: 0 }),
    enabled,
  });
  return (
    <div className="flex flex-col gap-2">
      <SearchInput
        inputId="data-domain-identity-business"
        label="搜索业务用户"
        placeholder="搜索姓名或业务 ID…"
        value={query}
        onChange={setQuery}
      />
      {accounts.isPending ? <LoadingState rows={2} /> : null}
      {accounts.isError ? (
        <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : null}
      {accounts.data && accounts.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">没有匹配的业务用户。</p>
      ) : null}
      <fieldset aria-label="可选择的业务用户" className="flex max-h-48 flex-col overflow-y-auto">
        {(accounts.data?.items ?? []).map((account) => (
          <Button
            key={account.businessId}
            type="button"
            variant={account.businessId === selected ? 'secondary' : 'outline'}
            className="h-auto justify-start py-2"
            aria-pressed={account.businessId === selected}
            onClick={() => onSelect(account.businessId)}
          >
            <span className="flex min-w-0 flex-col items-start gap-0.5 text-left">
              <span className="truncate">{account.name || account.businessId}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {account.businessId}
                {account.status === 'active' ? '' : ' · 已停用'}
              </span>
            </span>
          </Button>
        ))}
      </fieldset>
    </div>
  );
}

function IdentityDialog({
  dataDomainId,
  identity,
  canReadAccounts,
  getReturnFocus,
  onClose,
}: {
  dataDomainId: string;
  identity: DataDomainIdentity | null;
  canReadAccounts: boolean;
  getReturnFocus: () => HTMLElement | null;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClose);
  const upsert = useUpsertDataDomainIdentity();
  const form = useZodForm(identityFormSchema, {
    defaultValues: identity ? identityToForm(identity) : emptyForm,
  });
  const { register, control, setValue, watch, handleSubmit, formState } = form;
  const { fields, append, remove } = useFieldArray({ control, name: 'properties' });
  const { errors, isDirty } = formState;
  const businessId = watch('businessId');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saved, setSaved] = useState(false);
  const pending = upsert.isPending;
  const dirty = !saved && isDirty;
  const blocker = useFormBlocker(dirty, !saved && pending, { ignoreSamePath: true });
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);

  const finish = (): void => {
    blockerRef.current.reset?.();
    onClose();
  };
  const close = (): void => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else finish();
  };

  const submit = handleSubmit(async (values) => {
    if (pending) return;
    setSubmitError(null);
    try {
      await upsert.mutateAsync({
        id: dataDomainId,
        businessId: values.businessId,
        properties: rowsToRecord(values.properties),
      });
      setSaved(true);
      blockerRef.current.reset?.();
      toastSuccess(identity ? '已保存身份属性' : '已添加身份属性');
      dialog.finish(onClose);
    } catch (error) {
      setSubmitError(errorMessage(error));
    }
  });

  const keyError = (index: number): string | undefined => errors.properties?.[index]?.key?.message;
  const valueError = (index: number): string | undefined =>
    errors.properties?.[index]?.value?.message;
  const propertiesError = errors.properties?.root?.message ?? errors.properties?.message;

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, close)}
    >
      <DialogShell
        title={identity ? `编辑身份 · ${identity.businessId}` : '新增身份'}
        finalFocus={getReturnFocus}
        closeDisabled={pending}
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={close}>
              取消
            </Button>
            <Button
              type="submit"
              form="data-domain-identity-form"
              disabled={pending || (identity !== null && !isDirty)}
              aria-busy={pending}
            >
              {pending ? '保存中…' : identity ? '保存更改' : '添加'}
            </Button>
          </div>
        }
      >
        <form
          id="data-domain-identity-form"
          className="flex min-w-0 flex-col gap-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldError>{submitError}</FieldError>
          <Field data-disabled={pending} data-invalid={Boolean(errors.businessId)}>
            <FieldLabel htmlFor="data-domain-identity-business">
              业务用户
              <RequiredMark />
            </FieldLabel>
            {identity ? (
              <Input
                id="data-domain-identity-business"
                value={identity.businessId}
                readOnly
                className="font-mono"
              />
            ) : canReadAccounts ? (
              <BusinessUserPicker
                selected={businessId}
                enabled={canReadAccounts}
                onSelect={(next) => setValue('businessId', next, { shouldDirty: true })}
              />
            ) : (
              <Input
                {...register('businessId')}
                id="data-domain-identity-business"
                placeholder="业务 ID"
                autoComplete="off"
                className="font-mono"
                disabled={pending}
                aria-invalid={Boolean(errors.businessId)}
              />
            )}
            <FieldError>{errors.businessId?.message}</FieldError>
          </Field>
          <Field data-disabled={pending} data-invalid={Boolean(errors.properties)}>
            <FieldLabel>属性</FieldLabel>
            <KeyValueRowEditor
              rows={fields}
              prefix="data-domain-identity"
              keyAriaLabel="属性名"
              valueAriaLabel="属性值"
              removeLabel="属性"
              addLabel="添加属性"
              rootErrorId="data-domain-identity-properties-error"
              rootError={propertiesError}
              disabled={pending}
              registerKey={(index) => register(`properties.${index}.key` as const)}
              registerValue={(index) => register(`properties.${index}.value` as const)}
              keyError={keyError}
              valueError={valueError}
              onAppend={() => append({ key: '', value: '' })}
              onRemove={remove}
            />
            <FieldDescription>
              属性用于把业务用户映射到数据域中的身份过滤条件；属性名不能重复。
            </FieldDescription>
          </Field>
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
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title="放弃未保存的更改？"
          description={pending ? '正在保存，请等待请求完成。' : '离开后填写的内容会丢失。'}
          confirmLabel="放弃并离开"
          confirmDisabled={pending}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}

export function DataDomainIdentities({
  dataDomainId,
  canUpdate,
}: {
  dataDomainId: string;
  canUpdate: boolean;
}) {
  const me = useQuery(meQuery);
  const canReadAccounts = can(me.data, 'accounts.read');
  const identities = useDataDomainIdentities(dataDomainId);
  const accounts = useQuery({
    ...accountQuery({ q: '', limit: 100, offset: 0 }),
    enabled: canUpdate && canReadAccounts,
  });
  const remove = useRemoveDataDomainIdentity();
  const [editing, setEditing] = useState<DataDomainIdentity | null | undefined>(undefined);
  const [removing, setRemoving] = useState<DataDomainIdentity | null>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLElement | null>(null);
  const removeTriggerRef = useRef<HTMLElement | null>(null);
  const accountNames = new Map(
    (accounts.data?.items ?? []).map((account) => [account.businessId, account.name]),
  );

  return (
    <PageSection
      title="身份与权限"
      actions={
        canUpdate ? (
          <Button
            ref={addTriggerRef}
            onClick={(event) => {
              rowTriggerRef.current = event.currentTarget;
              setEditing(null);
            }}
          >
            <Plus data-icon="inline-start" /> 新增身份
          </Button>
        ) : undefined
      }
    >
      {identities.isPending ? <LoadingState rows={3} /> : null}
      {identities.isError ? (
        <ErrorState error={identities.error} onRetry={() => void identities.refetch()} />
      ) : null}
      {identities.data?.length === 0 ? (
        <p className="border-y py-5 text-sm text-muted-foreground">
          还没有配置身份属性。配置后，查询会按当前业务用户自动应用对应过滤条件。
        </p>
      ) : null}
      {identities.data && identities.data.length > 0 ? (
        <Table aria-label="身份属性">
          <TableHeader>
            <TableRow>
              <TableHead>业务用户</TableHead>
              <TableHead>属性</TableHead>
              <TableHead>更新时间</TableHead>
              {canUpdate ? <TableHead className="text-right">操作</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {identities.data.map((identity) => {
              const name = accountNames.get(identity.businessId);
              return (
                <TableRow key={identity.businessId}>
                  <TableCell>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      {name ? <span className="truncate">{name}</span> : null}
                      <code className="font-mono text-xs text-muted-foreground">
                        {identity.businessId}
                      </code>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex max-w-2xl flex-wrap gap-x-3 gap-y-1">
                      {Object.entries(identity.properties).map(([key, value]) => (
                        <code
                          key={key}
                          className="min-w-0 font-mono text-xs text-fg [overflow-wrap:anywhere]"
                        >
                          <span className="text-muted-foreground">{key}=</span>
                          {value || '—'}
                        </code>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatRelative(identity.updatedAt)}
                  </TableCell>
                  {canUpdate ? (
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(event) => {
                            rowTriggerRef.current = event.currentTarget;
                            setEditing(identity);
                          }}
                        >
                          编辑
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={(event) => {
                            removeTriggerRef.current = event.currentTarget;
                            setRemoving(identity);
                          }}
                        >
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}

      {editing !== undefined ? (
        <IdentityDialog
          dataDomainId={dataDomainId}
          identity={editing}
          canReadAccounts={canReadAccounts}
          getReturnFocus={() =>
            rowTriggerRef.current?.isConnected
              ? rowTriggerRef.current
              : addTriggerRef.current?.isConnected
                ? addTriggerRef.current
                : null
          }
          onClose={() => setEditing(undefined)}
        />
      ) : null}

      {removing ? (
        <ConfirmDialog
          open
          title="删除身份属性"
          description={`删除业务用户 ${removing.businessId} 的全部身份属性，此操作不可撤销。`}
          onClose={() => setRemoving(null)}
          finalFocus={() =>
            removeTriggerRef.current?.isConnected ? removeTriggerRef.current : null
          }
          onConfirm={async () => {
            await remove.mutateAsync({ id: dataDomainId, businessId: removing.businessId });
            toastSuccess('已删除身份属性');
          }}
        />
      ) : null}
    </PageSection>
  );
}
