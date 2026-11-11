import type { Agent, AgentInput } from '@agentport/shared';
import { useNavigate } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { type ComponentProps, useEffect, useState } from 'react';
import { type Control, useController } from 'react-hook-form';
import digitalTwinPortrait from '../../assets/agents/digital-twin.png';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DialogShell } from '../../components/dialog-shell.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/motion-collapsible.js';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Textarea } from '../../components/ui/textarea.js';
import { ApiError } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { useFormBlocker } from '../../lib/form.js';
import { useCreateAgent, useDuplicateAgent } from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import {
  type AgentDraft,
  agentCreateFormSchema,
  draftFromInput,
  duplicateFormSchema,
  emptyInput,
  inputFromDraft,
  models,
  roleOptions,
} from './shared.js';

export function CreateAgentDialog({
  onClose,
  onCreated,
  finalFocus,
  initialRole = '通用助手',
}: {
  onClose: () => void;
  onCreated: (agent: Agent) => void;
  finalFocus: ComponentProps<typeof DialogShell>['finalFocus'];
  initialRole?: AgentInput['role'];
}) {
  const create = useCreateAgent();
  const rhf = useZodForm(agentCreateFormSchema, {
    defaultValues: draftFromInput({
      ...emptyInput,
      role: initialRole,
      name: initialRole === '数字分身' ? '我的分身' : '',
    }),
  });
  // defaultValues 覆盖全部字段；把 schema 输入的可选类型收敛回完整草稿。
  const control = rhf.control as unknown as Control<AgentDraft, unknown, AgentDraft>;
  const errors = rhf.formState.errors;
  const roleField = useController({ control, name: 'role' }).field;
  const isTwin = roleField.value === '数字分身';
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [created, setCreated] = useState<Agent | null>(null);
  const dirty = rhf.formState.isDirty;
  const blocker = useFormBlocker(!created && dirty, !created && create.isPending);
  useEffect(() => {
    if (created) onCreated(created);
  }, [created, onCreated]);
  const close = (): void => {
    if (create.isPending) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const submit = rhf.handleSubmit(
    (draft) => {
      if (create.isPending) return;
      const generatedSlug = draft.name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^[-_]+|[-_]+$/g, '')
        .slice(0, 64);
      const input = inputFromDraft({
        ...draft,
        slug: draft.slug || generatedSlug || `agent-${crypto.randomUUID().slice(0, 8)}`,
      });
      create.mutate(input, {
        onSuccess: (agent) => {
          toastSuccess('专家已创建');
          setCreated(agent);
        },
        onError: (error) => toastError(error),
      });
    },
    (invalid) => {
      // 标识或模型出错时展开高级设置，错误字段才看得见。
      if (invalid.model || invalid.slug) setAdvancedOpen(true);
    },
  );

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (create.isPending) {
          details.cancel();
          return;
        }
        if (!next) close();
      }}
    >
      <DialogShell
        title={isTwin ? '创建数字分身' : '新建专家'}
        description="连接器与运行限制可在创建后配置。"
        closeDisabled={create.isPending}
        finalFocus={finalFocus}
      >
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            return submit();
          }}
        >
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field
              data-disabled={create.isPending}
              className={cn(
                'gap-1.5',
                isTwin && 'grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 sm:col-span-2',
              )}
              data-invalid={Boolean(errors.name)}
            >
              {isTwin ? (
                <img
                  src={digitalTwinPortrait}
                  alt=""
                  className="row-span-3 size-16 rounded-full object-cover"
                />
              ) : null}
              <FieldLabel htmlFor="new-agent-name">
                名称
                <RequiredMark />
              </FieldLabel>
              <Input
                {...rhf.register('name')}
                disabled={create.isPending}
                id="new-agent-name"
                aria-required="true"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'new-agent-name-error' : undefined}
                placeholder="客服助手"
              />
              <FieldError id="new-agent-name-error">{errors.name?.message}</FieldError>
            </Field>
            <Field
              data-disabled={create.isPending}
              className="gap-1.5"
              data-invalid={Boolean(errors.role)}
            >
              <FieldLabel htmlFor="new-agent-role">角色</FieldLabel>
              <Select
                disabled={create.isPending}
                value={roleField.value}
                items={roleOptions}
                onValueChange={(role) => {
                  if (role === null) return;
                  roleField.onChange(role);
                  if (role === '数字分身') {
                    rhf.setValue('name', rhf.getValues('name') || '我的分身', {
                      shouldDirty: true,
                    });
                  }
                }}
              >
                <SelectTrigger
                  id="new-agent-role"
                  className="w-full min-w-0"
                  aria-invalid={Boolean(errors.role)}
                  aria-describedby={errors.role ? 'new-agent-role-error' : undefined}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {roleOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldError id="new-agent-role-error">{errors.role?.message}</FieldError>
            </Field>
          </FieldGroup>
          <Field data-disabled={create.isPending} className="gap-1.5">
            <FieldLabel htmlFor="new-agent-prompt">
              {isTwin ? '工作背景与表达方式' : '职责与工作方式'}
            </FieldLabel>
            <Textarea
              {...rhf.register('systemPrompt')}
              disabled={create.isPending}
              id="new-agent-prompt"
              rows={6}
              // Keep compact monospace code text instead of the base prose typography.
              className="font-mono text-xs"
            />
          </Field>
          <Collapsible
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            className="rounded-item border"
          >
            <CollapsibleTrigger
              type="button"
              className="flex w-full cursor-pointer items-center gap-1.5 rounded-item px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight
                className={cn(
                  'size-3.5 shrink-0 transition-transform',
                  advancedOpen && 'rotate-90',
                )}
                aria-hidden="true"
              />
              高级设置
            </CollapsibleTrigger>
            <CollapsibleContent keepMounted animated>
              <div className="flex flex-col gap-3 border-t p-3">
                <Field data-disabled={create.isPending} className="gap-1.5">
                  <FieldLabel htmlFor="new-agent-model">模型</FieldLabel>
                  {/* 网关模型名不是白名单：输入任意 ID，建议值只做补全。 */}
                  <Input
                    {...rhf.register('model')}
                    disabled={create.isPending}
                    id="new-agent-model"
                    list="new-agent-models"
                    className="font-mono"
                  />
                  <datalist id="new-agent-models">
                    {models.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                </Field>
                <Field
                  data-disabled={create.isPending}
                  className="gap-1.5"
                  data-invalid={Boolean(errors.slug)}
                >
                  <FieldLabel htmlFor="new-agent-slug">标识（可选）</FieldLabel>
                  <Input
                    {...rhf.register('slug')}
                    disabled={create.isPending}
                    id="new-agent-slug"
                    placeholder="support-bot"
                    // Keep monospace for the technical slug instead of the base sans-serif input.
                    className="font-mono"
                    aria-invalid={Boolean(errors.slug)}
                    aria-describedby={errors.slug ? 'new-agent-slug-error' : 'new-agent-slug-hint'}
                  />
                  {errors.slug ? (
                    <FieldError id="new-agent-slug-error">{errors.slug?.message}</FieldError>
                  ) : (
                    <FieldDescription id="new-agent-slug-hint">
                      留空时由名称自动生成；仅支持小写字母、数字、- 和 _，创建后不可修改。
                    </FieldDescription>
                  )}
                </Field>
              </div>
            </CollapsibleContent>
          </Collapsible>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={close} disabled={create.isPending}>
              取消
            </Button>
            <Button type="submit" disabled={create.isPending} aria-busy={create.isPending}>
              {create.isPending ? '创建中…' : '创建'}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后新专家的配置会丢失。"
          confirmLabel="放弃并关闭"
          confirmDisabled={create.isPending}
          onConfirm={async () => {
            if (!create.isPending) onClose();
          }}
        />
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title="放弃未保存的更改？"
          description={
            create.isPending ? '正在保存，请等待请求完成。' : '离开后新专家的配置会丢失。'
          }
          confirmLabel="放弃并离开"
          confirmDisabled={create.isPending}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}

export function DuplicateAgentDialog({
  agent,
  onClose,
  getReturnFocus,
}: {
  agent: Agent;
  onClose: () => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const navigate = useNavigate();
  const duplicate = useDuplicateAgent();
  const [initial] = useState(() => ({
    name: `${agent.name} 副本`.slice(0, 128),
    slug: `${agent.slug}-copy`.slice(0, 64),
  }));
  const rhf = useZodForm(duplicateFormSchema, { defaultValues: initial });
  const errors = rhf.formState.errors;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [created, setCreated] = useState<Agent | null>(null);
  const dirty = rhf.formState.isDirty;
  const blocker = useFormBlocker(!created && dirty, !created && duplicate.isPending);
  // 先落成功状态再离开：blocker 下一次渲染才释放，直接 navigate 会被拦下。
  useEffect(() => {
    if (!created) return;
    onClose();
    void navigate({ to: '/agents/$agentId', params: { agentId: created.id } });
  }, [created, navigate, onClose]);
  const close = (): void => {
    if (duplicate.isPending) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const submit = rhf.handleSubmit((values) => {
    if (duplicate.isPending) return;
    duplicate.mutate(
      { id: agent.id, ...values },
      {
        onSuccess: (createdAgent) => {
          toastSuccess('已克隆专家');
          setCreated(createdAgent);
        },
        onError: (error) => {
          if (
            error instanceof ApiError &&
            error.status === 409 &&
            error.code === 'CONFLICT' &&
            !error.retryable
          ) {
            rhf.setError('slug', { type: 'server', message: '该 slug 已被占用' });
            return;
          }
          toastError(error);
        },
      },
    );
  });

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (duplicate.isPending) {
          details.cancel();
          return;
        }
        if (!next) close();
      }}
    >
      <DialogShell
        title="克隆专家"
        description="不包含子专家、记忆与历史记录。"
        closeDisabled={duplicate.isPending}
        finalFocus={getReturnFocus}
      >
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            return submit();
          }}
        >
          <FieldGroup className="grid gap-3 sm:grid-cols-2">
            <Field
              data-disabled={duplicate.isPending}
              className="gap-1.5 sm:col-span-2"
              data-invalid={Boolean(errors.name)}
            >
              <FieldLabel htmlFor="duplicate-agent-name">
                名称
                <RequiredMark />
              </FieldLabel>
              <Input
                {...rhf.register('name')}
                disabled={duplicate.isPending}
                id="duplicate-agent-name"
                aria-required="true"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'duplicate-agent-name-error' : undefined}
              />
              <FieldError id="duplicate-agent-name-error">{errors.name?.message}</FieldError>
            </Field>
            <Field
              data-disabled={duplicate.isPending}
              className="gap-1.5 sm:col-span-2"
              data-invalid={Boolean(errors.slug)}
            >
              <FieldLabel htmlFor="duplicate-agent-slug">
                Slug
                <RequiredMark />
              </FieldLabel>
              <Input
                {...rhf.register('slug')}
                disabled={duplicate.isPending}
                id="duplicate-agent-slug"
                className="font-mono"
                aria-required="true"
                aria-invalid={Boolean(errors.slug)}
                aria-describedby={errors.slug ? 'duplicate-agent-slug-error' : undefined}
              />
              <FieldError id="duplicate-agent-slug-error">{errors.slug?.message}</FieldError>
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={close} disabled={duplicate.isPending}>
              取消
            </Button>
            <Button type="submit" disabled={duplicate.isPending} aria-busy={duplicate.isPending}>
              {duplicate.isPending ? '克隆中…' : '克隆'}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后克隆信息会丢失。"
          confirmLabel="放弃并关闭"
          confirmDisabled={duplicate.isPending}
          onConfirm={async () => {
            if (!duplicate.isPending) onClose();
          }}
        />
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title="放弃未保存的更改？"
          description="离开后克隆信息会丢失。"
          confirmLabel="放弃并离开"
          confirmDisabled={duplicate.isPending}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}
