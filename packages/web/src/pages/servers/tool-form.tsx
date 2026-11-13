import type { ApiTool, ApiToolInput } from '@agentport/shared';
import { Plus } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { RequiredMark } from '../../components/required-mark.js';
import { SourceEditor } from '../../components/source-editor.js';
import { Button } from '../../components/ui/button.js';
import { Field, FieldError, FieldLabel } from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { useFormBlocker } from '../../lib/form.js';
import { useCreateTool, useUpdateTool } from '../../lib/queries.js';
import { validateToolInput } from '../../lib/resource-form.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import { approvalOptions } from './shared.js';

interface ToolFormValues {
  name: string;
  description: string;
  method: ApiToolInput['method'];
  pathTemplate: string;
  inputSchema: string;
  paramsIn: ApiToolInput['paramsIn'];
  approvalMode: ApiToolInput['approvalMode'];
}

const blankSchemaText = '{\n  "type": "object",\n  "properties": {}\n}';

const blankToolForm: ToolFormValues = {
  name: '',
  description: '',
  method: 'GET',
  pathTemplate: '/',
  inputSchema: blankSchemaText,
  paramsIn: 'query',
  approvalMode: 'allow',
};

/** validateToolInput 只读 form 的标量字段，schema 文本单独传入。 */
function toolPayload(values: ToolFormValues): ApiToolInput {
  return {
    name: values.name,
    description: values.description,
    method: values.method,
    pathTemplate: values.pathTemplate,
    inputSchema: {},
    paramsIn: values.paramsIn,
    approvalMode: values.approvalMode,
  };
}

const toolFormSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    pathTemplate: z.string(),
    inputSchema: z.string(),
    paramsIn: z.enum(['query', 'body']),
    approvalMode: z.enum(['allow', 'ask', 'deny']),
  })
  .superRefine((values, ctx) => {
    const result = validateToolInput(toolPayload(values), values.inputSchema);
    if (result.data) return;
    for (const [key, message] of Object.entries(result.errors)) {
      ctx.addIssue({ code: 'custom', path: [key], message });
    }
  });

function toolToForm(tool: ApiTool): ToolFormValues {
  return {
    name: tool.name,
    description: tool.description,
    method: tool.method,
    pathTemplate: tool.pathTemplate,
    inputSchema: JSON.stringify(tool.inputSchema, null, 2),
    paramsIn: tool.paramsIn,
    approvalMode: tool.approvalMode,
  };
}

/** 同一个表单用于新增与编辑；编辑时提交按钮换成「保存更改」。 */
export function ToolForm({
  serverId,
  tool,
  disabled,
  onDirtyChange,
  onPendingChange,
  onDone,
  onCancel,
}: {
  serverId: string;
  tool: ApiTool | null;
  disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const create = useCreateTool(serverId);
  const update = useUpdateTool(serverId);
  const { register, control, handleSubmit, reset, watch, formState } = useZodForm(toolFormSchema, {
    defaultValues: tool ? toolToForm(tool) : blankToolForm,
  });
  const { errors, isDirty } = formState;
  const watched = watch();

  // 只有这个表单自己的保存会改变可关闭状态；行内开关不算。
  const formPending = create.isPending || update.isPending;
  const pending = disabled || formPending;
  const dirty = isDirty;
  const blocker = useFormBlocker(dirty, pending);
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);
  // 父级关闭弹层会卸载表单并摘掉 blocker：先取消期间被拦下的离开，否则它的 resolver 一直挂着。
  const settle = (): void => {
    blockerRef.current.reset?.();
  };
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onPendingChange(formPending);
  }, [formPending, onPendingChange]);
  // 提交成功后父级会卸载本表单；卸载时清掉父级的脏/请求中状态。
  useEffect(
    () => () => {
      onDirtyChange(false);
      onPendingChange(false);
    },
    [onDirtyChange, onPendingChange],
  );
  // 父级切换工具或放弃编辑也会直接卸载表单：卸载时结算被拦下的导航，避免 resolver 挂起。
  useEffect(() => () => blockerRef.current.reset?.(), []);

  const submit = handleSubmit((values) => {
    if (pending) return;
    const result = validateToolInput(toolPayload(values), values.inputSchema);
    if (!result.data) return;
    const payload = result.data;

    if (!tool) {
      create.mutate(payload, {
        onSuccess: () => {
          settle();
          reset(blankToolForm);
          toastSuccess('工具已添加');
        },
        onError: (error) => toastError(error),
      });
      return;
    }

    // 一次 PATCH 完成：工具 id 不变，运行中的审批与外键引用不会断。
    update.mutate(
      { toolId: tool.id, patch: payload },
      {
        onSuccess: () => {
          settle();
          toastSuccess('工具已更新');
          onDone();
        },
        onError: (error) => toastError(error),
      },
    );
  });

  const methodOptions = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => ({
    value: method,
    label: method,
  }));
  const paramsOptions = [
    { value: 'query', label: 'query' },
    { value: 'body', label: 'body' },
  ];

  return (
    <form
      className="grid gap-3 border-t pt-5 sm:grid-cols-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      noValidate
    >
      <div className="flex items-baseline justify-between gap-2 sm:col-span-6">
        <h3 className="text-base font-medium text-fg">
          {tool ? `编辑工具 ${tool.name}` : '添加工具'}
        </h3>
        {tool ? (
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={pending}>
            取消编辑
          </Button>
        ) : null}
      </div>
      <Field
        data-disabled={pending}
        className="gap-1.5 sm:col-span-2"
        data-invalid={Boolean(errors.name)}
      >
        <FieldLabel htmlFor={`tool-name-${serverId}`}>
          名称
          <RequiredMark />
        </FieldLabel>
        <Input
          {...register('name')}
          value={watched.name}
          disabled={pending}
          id={`tool-name-${serverId}`}
          placeholder="list-users"
          aria-required
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? `tool-name-error-${serverId}` : undefined}
        />
        <FieldError id={`tool-name-error-${serverId}`}>{errors.name?.message}</FieldError>
      </Field>
      <Field data-disabled={pending} className="gap-1.5">
        <FieldLabel htmlFor={`tool-method-${serverId}`}>方法</FieldLabel>
        <Controller
          control={control}
          name="method"
          render={({ field }) => (
            <Select
              disabled={pending}
              value={field.value}
              onValueChange={(next) => {
                if (next !== null) field.onChange(next);
              }}
              items={methodOptions}
            >
              <SelectTrigger id={`tool-method-${serverId}`} ref={field.ref} onBlur={field.onBlur}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {methodOptions.map((option) => (
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
      <Field
        data-disabled={pending}
        className="gap-1.5 sm:col-span-2"
        data-invalid={Boolean(errors.pathTemplate)}
      >
        <FieldLabel htmlFor={`tool-path-${serverId}`}>
          路径
          <RequiredMark />
        </FieldLabel>
        <Input
          {...register('pathTemplate')}
          value={watched.pathTemplate}
          disabled={pending}
          id={`tool-path-${serverId}`}
          placeholder="/users/{id}"
          aria-required
          aria-invalid={Boolean(errors.pathTemplate)}
          aria-describedby={errors.pathTemplate ? `tool-path-error-${serverId}` : undefined}
        />
        <FieldError id={`tool-path-error-${serverId}`}>{errors.pathTemplate?.message}</FieldError>
      </Field>
      <Field data-disabled={pending} className="gap-1.5">
        <FieldLabel htmlFor={`tool-params-${serverId}`}>参数位置</FieldLabel>
        <Controller
          control={control}
          name="paramsIn"
          render={({ field }) => (
            <Select
              disabled={pending}
              value={field.value}
              onValueChange={(next) => {
                if (next !== null) field.onChange(next);
              }}
              items={paramsOptions}
            >
              <SelectTrigger id={`tool-params-${serverId}`} ref={field.ref} onBlur={field.onBlur}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {paramsOptions.map((option) => (
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
      <Field
        data-disabled={pending}
        className="gap-1.5 sm:col-span-5"
        data-invalid={Boolean(errors.description)}
      >
        <FieldLabel htmlFor={`tool-desc-${serverId}`}>描述</FieldLabel>
        <Input
          {...register('description')}
          value={watched.description}
          disabled={pending}
          id={`tool-desc-${serverId}`}
          aria-invalid={Boolean(errors.description)}
          aria-describedby={errors.description ? `tool-desc-error-${serverId}` : undefined}
          placeholder="告诉智能体这个工具做什么、何时用"
        />
        <FieldError id={`tool-desc-error-${serverId}`}>{errors.description?.message}</FieldError>
      </Field>
      <Field
        data-disabled={pending}
        className="gap-1.5 sm:col-span-5"
        data-invalid={Boolean(errors.inputSchema)}
      >
        <FieldLabel htmlFor={`tool-schema-${serverId}`}>inputSchema (JSON)</FieldLabel>
        <Controller
          control={control}
          name="inputSchema"
          render={({ field }) => (
            <SourceEditor
              id={`tool-schema-${serverId}`}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              language="json"
              aria-label="inputSchema (JSON)"
              aria-invalid={Boolean(errors.inputSchema)}
              aria-describedby={errors.inputSchema ? `tool-schema-error-${serverId}` : undefined}
              disabled={pending}
              className="min-h-40"
            />
          )}
        />
        <FieldError id={`tool-schema-error-${serverId}`}>{errors.inputSchema?.message}</FieldError>
      </Field>
      <Field data-disabled={pending} className="gap-1.5 sm:col-span-2">
        <FieldLabel htmlFor={`tool-approval-${serverId}`}>审批策略</FieldLabel>
        <Controller
          control={control}
          name="approvalMode"
          render={({ field }) => (
            <Select
              disabled={pending}
              value={field.value}
              onValueChange={(next) => {
                if (next !== null) field.onChange(next);
              }}
              items={approvalOptions}
            >
              <SelectTrigger id={`tool-approval-${serverId}`} ref={field.ref} onBlur={field.onBlur}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {approvalOptions.map((option) => (
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
      <div className="flex items-start pt-2">
        <Button type="submit" size="sm" disabled={pending || !watched.name}>
          {pending ? (
            '保存中…'
          ) : tool ? (
            '保存更改'
          ) : (
            <>
              <Plus /> 添加
            </>
          )}
        </Button>
      </div>
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="放弃未保存的更改？"
        description={pending ? '正在保存，请等待请求完成。' : '离开后工具配置的修改会丢失。'}
        confirmLabel="放弃并离开"
        confirmDisabled={pending}
        onConfirm={async () => blocker.proceed()}
      />
    </form>
  );
}
